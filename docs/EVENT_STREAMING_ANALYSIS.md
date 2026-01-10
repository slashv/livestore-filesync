# Event Streaming Analysis: Reliability and Consistency Concerns

This document provides a deep analysis of the "event streaming" approach compared to the current hybrid approach used in livestore-filesync. It evaluates reliability, consistency, and trade-offs to help inform architectural decisions.

## Executive Summary

The current system uses a **hybrid approach**:
1. **LiveStore synced events** (`v1.FileCreated`, `v1.FileUpdated`, `v1.FileDeleted`) for persistent, cross-client state
2. **Callback-based events** (`FileSyncEvent`) for ephemeral, UI-focused notifications

An alternative **pure event streaming approach** would rely entirely on LiveStore's event sourcing and reactivity, eliminating the callback layer. While this feels "safer" due to its simplicity and single source of truth, there are significant reliability and consistency concerns that must be addressed.

---

## Current Architecture Overview

### Two-Layer Event Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application Layer                         │
├─────────────────────────────────────────────────────────────────┤
│  FileSyncEvent Callbacks (ephemeral)                            │
│  ├── sync:start / sync:complete                                 │
│  ├── upload:start / upload:progress / upload:complete / error   │
│  ├── download:start / download:progress / download:complete     │
│  └── online / offline                                           │
├─────────────────────────────────────────────────────────────────┤
│                      LiveStore Events (persistent)               │
│  ├── v1.FileCreated  → files table insert                       │
│  ├── v1.FileUpdated  → files table update (remoteKey, hash)     │
│  ├── v1.FileDeleted  → files table soft delete                  │
│  └── localFileStateSet → client document (per-client state)     │
└─────────────────────────────────────────────────────────────────┘
```

### Current State Management

| State Type | Storage | Scope | Purpose |
|------------|---------|-------|---------|
| `files` table | LiveStore SQLite | Synced across all clients | File metadata (path, contentHash, remoteKey) |
| `localFileState` | LiveStore client document | Per-client | Transfer status, local hash, sync errors |
| In-memory refs | Effect Ref | Per-tab, ephemeral | Online status, active transfers, queues |
| Callback registry | Effect Ref | Per-tab, ephemeral | UI event subscriptions |

---

## Event Streaming Approach: What It Would Look Like

A "pure event streaming" approach would:

1. **Eliminate callback-based events** entirely
2. **Store all state transitions as LiveStore events**
3. **Derive UI state from materialized views** via LiveStore reactivity
4. **Remove in-memory state tracking** where possible

### Proposed Event Schema (Event Streaming)

```typescript
// Additional events for pure event sourcing
const streamingEvents = {
  // Transfer lifecycle events (would be synced or client-scoped)
  'v1.TransferStarted': { fileId, kind: 'upload' | 'download', startedAt },
  'v1.TransferProgress': { fileId, kind, loaded, total, timestamp },
  'v1.TransferCompleted': { fileId, kind, completedAt },
  'v1.TransferFailed': { fileId, kind, error, failedAt },

  // Connectivity events
  'v1.ConnectivityChanged': { online: boolean, changedAt }
}
```

---

## Deep Analysis: Reliability Concerns

### 1. Progress Event Frequency and Storage Overhead

**Current Approach:**
- Progress events (`upload:progress`, `download:progress`) are fire-and-forget callbacks
- Called multiple times per second during transfers (every ~100KB chunk)
- Zero persistence overhead

**Event Streaming Approach:**
- Every progress update would need to be stored as an event
- A 100MB file upload could generate 1000+ progress events
- **Concern**: This creates massive event log bloat

**Reliability Impact:**
```
Risk Level: HIGH
Issue: Event log grows unboundedly during large transfers
Impact:
  - SQLite write amplification
  - Sync payload explosion (events synced to other clients)
  - Memory pressure during materialization
  - Potential for event ordering conflicts
```

**Mitigation Strategies:**
- Use client-scoped events (not synced) for progress
- Throttle progress events to 1/second max
- Store only start/complete/error, not intermediate progress
- Consider a separate ephemeral stream for progress

### 2. Event Ordering and Causality

**Current Approach:**
- LiveStore events have built-in causal ordering via Merkle-DAG
- Callback events are synchronous within the Effect fiber
- State transitions (pending → queued → inProgress → done) are atomic

**Event Streaming Approach:**
- All state transitions become discrete events
- Risk of event reordering during sync

**Potential Ordering Issues:**
```typescript
// Scenario: Two clients working on same file

// Client A timeline:          // Client B timeline:
t1: TransferStarted(upload)    t1: (receives file via sync)
t2: TransferProgress(50%)      t2: TransferStarted(download)
t3: TransferCompleted          t3: TransferCompleted
                               t4: (receives A's events)

// After sync merge, Client B sees:
// TransferStarted(download), TransferCompleted(download),
// TransferStarted(upload), TransferCompleted(upload)
//
// But the materializer now has inconsistent state -
// which transfer "won"?
```

**Reliability Impact:**
```
Risk Level: MEDIUM-HIGH
Issue: Concurrent transfer events from different clients can interleave
Impact:
  - State machine transitions may become invalid
  - "Ghost" transfers that appear stuck
  - Impossible to determine current true state
```

**Mitigation Strategies:**
- Use vector clocks or Lamport timestamps
- Make events idempotent with convergent state
- Include parent event references for strict ordering
- Scope transfer events to originating client

### 3. Recovery After Crash/Refresh

**Current Approach:**
- `recoverStaleTransfers()` resets `inProgress` → `pending` on startup
- In-memory state is rebuilt from persisted `localFileState`
- Clean separation: persistent state = truth, ephemeral state = derived

**Event Streaming Approach:**
- All state is in the event log
- Must replay events to recover state
- No clear "checkpoint" for where to resume

**Recovery Scenario:**
```typescript
// Event log before crash:
[TransferStarted(file1), TransferProgress(file1, 50%)]

// After page refresh:
// Q: Is file1 still uploading? (No - the transfer fiber died)
// Q: Should we resume from 50%? (Can't - no resumable upload support)
// Q: How do we know the transfer "failed"?

// Current approach: "inProgress" → "pending", retry from scratch
// Event streaming: Need to emit "TransferAbandoned" event somehow
```

**Reliability Impact:**
```
Risk Level: HIGH
Issue: No automatic recovery mechanism for interrupted transfers
Impact:
  - Orphaned "in progress" states in event log
  - Need external process to detect and emit cleanup events
  - Event log contains lies (transfers that never completed)
```

**Mitigation Strategies:**
- Startup routine that emits `TransferAbandoned` for stale transfers
- Use heartbeat events with TTL-based expiry
- Store transfer start time and use timeout-based recovery
- Maintain a "last known alive" timestamp per transfer

### 4. Multi-Tab Coordination

**Current Approach:**
- Leader election via Web Locks API
- Only leader runs sync loop
- Non-leader tabs can still commit events (synced via SharedWorker)
- `localFileState` is client-scoped (per browser, not per tab)

**Event Streaming Approach:**
- Events from all tabs go to same event log
- Harder to distinguish "my tab's transfer" from "other tab's transfer"

**Multi-Tab Scenario:**
```typescript
// Tab 1 (leader): starts upload
// Tab 2 (non-leader): user triggers same file update

// Event log sees:
[TransferStarted(file1, tab1), TransferStarted(file1, tab2)]

// Which one is the "real" transfer?
// Current approach: Leader tab owns transfers, others just commit metadata events
```

**Reliability Impact:**
```
Risk Level: MEDIUM
Issue: Multiple tabs may emit conflicting transfer events
Impact:
  - Duplicate transfers
  - Inconsistent progress reporting
  - Race conditions in state machine
```

**Mitigation Strategies:**
- Include tab/session ID in transfer events
- Use Web Locks to ensure only leader emits transfer events
- Filter events by session when materializing

### 5. Consistency of Derived State

**Current Approach:**
- `getSyncStatus()` derives aggregate state from `localFileState`
- Single source of truth: the client document
- Atomic updates via `LocalFileStateManager` semaphore

**Event Streaming Approach:**
- Must materialize state from potentially thousands of events
- No guarantee of consistent read during materialization

**Consistency Issue:**
```typescript
// Event log:
[FileCreated(f1), FileCreated(f2), TransferStarted(f1), TransferCompleted(f1)]

// Materializer processing events...
// At event 3: syncStatus shows f1 uploading, f2 pending
// At event 4: syncStatus shows f1 done, f2 pending

// But what if UI queries between events 3 and 4?
// The read is consistent but stale

// Worse: what if events arrive out of order from sync?
[FileCreated(f1), TransferCompleted(f1), TransferStarted(f1)]
// Materializer sees completion before start!
```

**Reliability Impact:**
```
Risk Level: MEDIUM
Issue: Eventual consistency means UI may show stale/incorrect state
Impact:
  - Progress bars that jump backwards
  - Files shown as "uploading" after completion
  - Confusing user experience
```

**Mitigation Strategies:**
- Use sequence numbers for strict ordering
- Implement "eventually consistent" UI patterns (optimistic updates)
- Batch event processing to ensure atomic state transitions

---

## Comparison Matrix

| Aspect | Current Hybrid | Pure Event Streaming |
|--------|----------------|---------------------|
| **Progress tracking** | ✅ Zero-cost callbacks | ⚠️ Event log bloat |
| **Crash recovery** | ✅ Automatic reset | ❌ Requires explicit cleanup events |
| **Event ordering** | ✅ Synchronous within fiber | ⚠️ Requires causal ordering |
| **Multi-tab safety** | ✅ Leader-only sync | ⚠️ Needs session scoping |
| **Consistency** | ✅ Single source of truth | ⚠️ Eventually consistent |
| **Debuggability** | ⚠️ Ephemeral events lost | ✅ Full audit trail |
| **State reconstruction** | ❌ Cannot replay | ✅ Full replay capability |
| **Complexity** | ⚠️ Two event systems | ✅ Single event system |
| **Storage overhead** | ✅ Minimal | ⚠️ Can be significant |

---

## Specific Code Concerns in Current Implementation

### 1. Fire-and-Forget Progress Events (FileSync.ts:409-421, 474-488)

```typescript
// Current pattern - safe but loses events on crash
Effect.runFork(
  emit({
    type: "download:progress",
    fileId,
    progress: { ... }
  })
)
```

**Concern**: If converted to persisted events, `Effect.runFork` could cause event loss.
**Recommendation**: Progress events should remain ephemeral or use a dedicated non-synced stream.

### 2. Atomic State Transitions (FileSync.ts:553-638)

The `reconcileLocalFileState()` function uses two-pass reconciliation:
- Pass 1: Atomic update (no I/O)
- Pass 2: Disk I/O for new files

**Concern**: In pure event streaming, this atomicity is harder to achieve.
**Recommendation**: Batch state-changing events and emit them atomically.

### 3. Status Preservation During Reconciliation (FileSync.ts:574-593)

```typescript
// CRITICAL: Preserve active transfer statuses
const preserveUploadStatus = activeStatuses.includes(existing.uploadStatus)
const preserveDownloadStatus = activeStatuses.includes(existing.downloadStatus)
```

**Concern**: This logic prevents clobbering in-flight transfers. In event streaming, this must be encoded in the event handlers.
**Recommendation**: Transfer events should include "generation" numbers to detect stale updates.

### 4. The `recoverStaleTransfers()` Pattern (FileSync.ts:686-714)

```typescript
// Recovery: Reset stale "inProgress" statuses to "pending"
const recoverStaleTransfers = (): Effect.Effect<void> =>
  stateManager.atomicUpdate((currentState) => {
    // ... reset inProgress → pending
  })
```

**Concern**: Event streaming would need explicit `TransferAbandoned` events instead of state mutation.
**Recommendation**: Implement startup reconciliation that emits cleanup events.

---

## Recommendations

### If Adopting Pure Event Streaming:

1. **Keep progress events ephemeral** - Don't persist `TransferProgress` events
2. **Implement causal ordering** - Use Lamport timestamps or include parent event refs
3. **Add session scoping** - Tag events with tab/session ID for multi-tab safety
4. **Design recovery events** - Add `TransferAbandoned` and `TransferRecovered` events
5. **Use client-scoped events for transfers** - Don't sync transfer lifecycle to other clients
6. **Implement generation numbers** - Detect and ignore stale state updates

### If Keeping Hybrid Approach (Recommended):

1. **Document the two-layer design clearly** - Developers need to understand the split
2. **Consider event history for debugging** - Optional ring buffer for recent events
3. **Keep transfer state in `localFileState`** - It's the right abstraction
4. **Use callbacks for real-time UI updates** - They're efficient and fit the use case
5. **Rely on LiveStore for persistence** - It already handles sync and consistency

---

## Conclusion

The current hybrid approach is **well-designed for the use case**. It correctly separates:
- **Persistent, synced state** (file metadata) via LiveStore events
- **Client-local state** (transfer status) via client documents
- **Ephemeral UI state** (progress, online status) via callbacks

A pure event streaming approach would provide better auditability and replayability, but introduces significant complexity around:
- Event ordering and causality
- Crash recovery
- Storage overhead
- Multi-tab coordination

**The "safer" feeling of event streaming is somewhat illusory** - it shifts complexity from explicit state management to implicit event ordering and materialization concerns. The current approach makes the trade-offs explicit and handles edge cases (crash recovery, multi-tab, progress tracking) correctly.

**Recommendation**: Keep the current hybrid approach. If auditability is needed, consider adding an optional event history buffer for debugging, but don't persist all events to LiveStore.

---

## Appendix: TODO.md Reference

The project TODO mentions:
> Review callbacks and events if they are necessary. Better to rely on livestore reactivity

This analysis supports the callbacks as necessary for:
1. Real-time progress updates (too frequent for persistence)
2. Online/offline notifications (ephemeral by nature)
3. Sync start/complete notifications (UI coordination)

The `localFileState` client document already leverages LiveStore reactivity for persistent state. The callbacks complement this by providing ephemeral, high-frequency updates that shouldn't be persisted.
