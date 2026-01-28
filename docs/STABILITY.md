# Stability Features

This document describes the stability and self-healing mechanisms implemented in FileSync to ensure robust operation in production environments.

## Recent Feature Implementations

### 1. Stale Transfer Recovery Gating

**Commit:** `cf1f839` - fix: gate stale transfer recovery to run once per start() lifecycle

**Problem:** `recoverStaleTransfers()` was running every time `startEventStream()` was called. Mid-session stream restarts (from `syncNow()`, heartbeat recoveries, etc.) could incorrectly flip legitimate `inProgress` transfers back to `queued`, causing state corruption when `applyFileState()` keeps `queued` even if the file is already in sync.

**Solution:** 
- Added `staleRecoveryDoneRef` boolean to track whether recovery has run
- Created `maybeRecoverStaleTransfers()` wrapper that checks the flag before running
- Moved recovery from `startEventStream()` to `startSyncLoop()`
- Recovery now runs only once when the FileSync service becomes leader

**Behavior change:** Cold-start recovery still works correctly (recovering stuck `inProgress`/`error` transfers from a crashed session), while mid-session stream restarts no longer corrupt legitimate in-flight transfers.

**Files changed:**
- `packages/core/src/services/file-sync/FileSync.ts` - Added gating logic
- `docs/ARCHITECTURE.md` - Updated stale recovery documentation

---

### 2. Heartbeat Monitoring System

**Commit:** `221d3cf` - heartbeat v1

**Problem:** Silent failures could leave the sync system in a stuck state with no automatic recovery:
- Event stream fiber could die or exhaust retries, leaving sync stalled
- Worker fibers could exit unexpectedly, leaving queued items stuck

**Solution:** Background heartbeat loop that periodically verifies liveness and recovers from failures.

**Configuration:**
```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    heartbeatIntervalMs: 15000 // Default: 15000 (15 seconds). Set to 0 to disable.
  }
})
```

**Heartbeat checks (leader-only):**

1. **Event stream liveness**: If the stream fiber is dead (null ref or exited), it is restarted via `startEventStream()`.

2. **Stuck queue detection**: If there are queued items with nothing inflight for 2 consecutive heartbeats (and the executor is not paused and is online), the executor is resumed to unblock processing.

**Recovery events:**
| Event | Reason | Description |
|-------|--------|-------------|
| `sync:heartbeat-recovery` | `stream-dead` | Heartbeat detected and restarted a dead event stream |
| `sync:heartbeat-recovery` | `stuck-queue` | Heartbeat detected and recovered a stuck queue |

**Files changed:**
- `packages/core/src/services/file-sync/FileSync.ts` - Heartbeat implementation
- `packages/core/src/types/index.ts` - Added heartbeat recovery event type
- `docs/ARCHITECTURE.md` - Added heartbeat documentation

---

### 3. Executor Worker Liveness (ensureWorkers)

**Related task:** `02_stability_executor-worker-liveness.md`

**Problem:** Download/upload workers were started once in `start()` and never tracked. If a worker fiber exited (unexpected error, interrupt), there was no recovery path - `resume()` only toggled the `paused` flag.

**Solution:**
- Track worker fibers in refs (`downloadWorkerFiberRef`, `uploadWorkerFiberRef`)
- Added `ensureWorkers()` method that starts missing or exited workers
- Made `start()` idempotent by using `ensureWorkers()` internally
- Heartbeat stuck-queue recovery calls `ensureWorkers()` to restart dead workers

**Implementation:** `packages/core/src/services/sync-executor/SyncExecutor.ts:427`

```typescript
const ensureWorkers = (): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const downloadFiber = yield* Ref.get(downloadWorkerFiberRef)
    const uploadFiber = yield* Ref.get(uploadWorkerFiberRef)
    // Start workers if they don't exist or have exited
    if (!downloadFiber || Option.isSome(yield* Fiber.poll(downloadFiber))) {
      yield* startDownloadWorker()
    }
    if (!uploadFiber || Option.isSome(yield* Fiber.poll(uploadFiber))) {
      yield* startUploadWorker()
    }
  })
```

---

## Completed Stability Tasks

### Task 1: Stale Transfer Recovery Gating

**File:** `tasks/01_stability_stale-recovery-gating.md`  
**Status:** DONE

**Goal:** Avoid resetting legitimate `inProgress` transfers to `queued` during mid-session stream restarts while preserving safety on cold start.

**Implementation summary:**
- Added `staleRecoveryDoneRef` boolean ref to track whether stale recovery has run (`FileSync.ts:287`)
- Created `maybeRecoverStaleTransfers()` function that only runs recovery once per `start()` lifecycle (`FileSync.ts:906-912`)
- Removed the `recoverStaleTransfers()` call from `startEventStream()` - it no longer runs on every stream restart
- Added `maybeRecoverStaleTransfers()` to `startSyncLoop()` (`FileSync.ts:1017`) - ensures recovery runs once when becoming leader
- Updated `docs/ARCHITECTURE.md` "Stale Transfer Recovery" section with clarified documentation

**Edge cases handled:**
- If a tab takes leadership later, it still runs the one-time recovery for that lifecycle
- Recovery only affects cold-start scenarios, not ongoing transfers

---

### Task 2: Executor Worker Liveness

**File:** `tasks/02_stability_executor-worker-liveness.md`  
**Status:** DONE (implemented as part of heartbeat v1)

**Goal:** Ensure download/upload workers cannot silently die and leave the queue stuck. Provide a way to re-create workers when the executor is resumed or when heartbeat detects a stuck queue.

**Implementation summary:**
- Track worker fibers in refs: `downloadWorkerFiberRef`, `uploadWorkerFiberRef`
- Added `ensureWorkers()` that starts missing or exited workers
- Made `start()` idempotent via `ensureWorkers()` inside `start()`
- From `FileSync` heartbeat stuck-queue recovery, `executor.resume()` implicitly triggers worker activity

**Tests added:**
- `ensureWorkers()` starts workers when they are not running
- `ensureWorkers()` is a no-op when paused
- Queued work is processed after `ensureWorkers()` restarts workers

---

## Architecture Integration

These stability features integrate with the existing FileSync architecture:

```text
[FileSync]
    |
    +-- start() ──> maybeRecoverStaleTransfers() (once per lifecycle)
    |
    +-- startSyncLoop() ──> startEventStream()
    |                          |
    |                          +-- Stream error recovery (exponential backoff)
    |                          +-- Fiber ref tracking for heartbeat
    |
    +-- startHeartbeat() ──> periodic tick (every 15s by default)
                                |
                                +-- Check stream fiber liveness
                                +-- Check stuck queue (2 consecutive intervals)
                                +-- Emit sync:heartbeat-recovery events
                                |
                                +──> executor.resume() / startEventStream()

[SyncExecutor]
    |
    +-- ensureWorkers() ──> restart dead worker fibers
    |
    +-- Worker fiber refs ──> downloadWorkerFiberRef, uploadWorkerFiberRef
```

## Monitoring

Subscribe to stability-related events for observability:

```typescript
import { onFileSyncEvent } from '@livestore-filesync/core'

onFileSyncEvent((event) => {
  switch (event.type) {
    case 'sync:heartbeat-recovery':
      console.log(`Heartbeat recovery: ${event.reason}`)
      break
    case 'sync:stream-error':
      console.warn(`Stream error (attempt ${event.attempt}):`, event.error)
      break
    case 'sync:stream-exhausted':
      console.error(`Stream gave up after ${event.attempts} attempts`)
      break
    case 'sync:recovery':
      console.log(`Recovered from ${event.from}`)
      break
  }
})
```
