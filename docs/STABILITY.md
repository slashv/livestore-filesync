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

3. **Stream stall detection**: If the stream fiber is alive but hasn't processed any events while upstream head has advanced beyond the last processed cursor, and the stall threshold has been exceeded, the stream is restarted. This handles the case where the stream is technically alive but no longer advancing.

**Recovery events:**
| Event | Reason | Description |
|-------|--------|-------------|
| `sync:heartbeat-recovery` | `stream-dead` | Heartbeat detected and restarted a dead event stream |
| `sync:heartbeat-recovery` | `stuck-queue` | Heartbeat detected and recovered a stuck queue |
| `sync:heartbeat-recovery` | `stream-stalled` | Heartbeat detected a stalled stream (alive but not advancing) |

**Files changed:**
- `packages/core/src/services/file-sync/FileSync.ts` - Heartbeat implementation
- `packages/core/src/types/index.ts` - Added heartbeat recovery event type
- `docs/ARCHITECTURE.md` - Added heartbeat documentation

---

### 3. Stream Stall Watchdog

**Problem:** The event stream fiber could be alive but no longer advancing. The heartbeat liveness check only detects dead fibers, not stalled streams. If the stream keeps running but stops emitting events (e.g., due to a subtle bug or race condition), sync can stall with no recovery.

**Solution:** Track the last processed batch timestamp and cursor. On each heartbeat tick, check if:
- The upstream head has advanced beyond the last processed cursor
- Enough time has passed since the last processed batch (exceeds threshold)

If both conditions are met, the stream is considered stalled and is restarted.

**Configuration:**
```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    streamStallThresholdMs: 30000 // Default: 30000 (30 seconds). Set to 0 to disable.
  }
})
```

**Implementation details:**
- `lastBatchAtRef` tracks when the last event batch was processed (epoch ms)
- `lastBatchCursorRef` tracks the cursor after the last processed batch
- `checkStreamStall()` runs on each heartbeat tick (only when running, leader, and online)
- Skip stall checks when:
  - Stall detection is disabled (`streamStallThresholdMs <= 0`)
  - We're offline
  - No batches have been processed yet (`lastBatchAt === 0`)
  - Time since last batch is below threshold
  - Upstream head equals last processed cursor (no new work)

**Files changed:**
- `packages/core/src/services/file-sync/FileSync.ts` - Added stall detection logic
- `packages/core/src/types/index.ts` - Added `stream-stalled` reason to heartbeat recovery event

---

### 4. Executor Worker Liveness (ensureWorkers)

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

### Task 3: Stream Stall Watchdog

**File:** `tasks/03_stability_stream-stall-watchdog.md`
**Status:** DONE

**Goal:** Detect when the event stream is alive but no longer advancing while upstream head moves, and restart the stream automatically to recover from a stalled cursor.

**Implementation summary:**
- Added `lastBatchAtRef` and `lastBatchCursorRef` refs to track last processed batch (`FileSync.ts:309-310`)
- Updated `handleEventBatch()` to set these refs after cursor persistence (`FileSync.ts:861-862`)
- Created `checkStreamStall()` function that runs on each heartbeat tick (`FileSync.ts:1159-1191`)
- Added `streamStallThresholdMs` config option with 30 second default (`FileSync.ts:222-230`, `FileSync.ts:266`)
- Added `stream-stalled` reason to `sync:heartbeat-recovery` event type (`types/index.ts:105`)

**Edge cases handled:**
- Only checks when running, isLeader, and online
- Skips stall checks when upstream head equals cursor (no new work)
- Skips stall checks when no batches have been processed yet
- Disabled when `streamStallThresholdMs` is set to 0

**Tests added:**
- Heartbeat detects stalled stream when upstream advances but cursor does not
- No false positives when upstream head has not advanced
- Stream stall detection is disabled when `streamStallThresholdMs` is 0

---

### 5. Stability Improvements (Batch)

**Branch:** `fix/stability-improvements`

A systematic set of 10 stability fixes identified through deep analysis of error handling, sync edge cases, and type safety. Each fix has its own commit with tests.

#### Completed Fixes

1. **Emit callback safety** (`88599b2`): Wrapped each `onEvent` callback invocation in try/catch so one throwing subscriber doesn't crash the sync engine or prevent other subscribers from receiving events.

2. **Effect.tryPromise for preprocessors** (`ba817e5`): Changed `Effect.promise(() => applyPreprocessor(...))` to `Effect.tryPromise` so preprocessor failures produce a typed `StorageError` instead of a fiber-crashing defect.

3. **Atomic enqueue deduplication** (`75f0d56`): Changed non-atomic `Ref.get` + `Ref.update` to `Ref.modify` in `enqueueDownload`/`enqueueUpload`/`prioritizeDownload`, preventing races where two concurrent fibers double-enqueue the same file.

4. **Per-event error handling in batch processing** (`3acaf78`): Previously the entire batch was wrapped in a single try/catch. Now each event is wrapped individually so a failure in event 3 of 5 doesn't replay events 1-2.

5. **goOffline preserves error states** (`5c60b65`): `goOffline()` now only resets `inProgress` transfers to `queued`. Files that failed for non-network reasons (corrupt, too large) are no longer infinitely retried.

6. **Log/emit on retry exhaustion** (`66af9dd`): When all retries are exhausted in `SyncExecutor.processTask`, an `Effect.logWarning` is emitted and the new `onTaskComplete` callback notifies FileSync, which emits a `transfer:exhausted` event.

7. **Interrupt in-flight on leadership loss** (`e061982`): `stopSyncLoop()` now calls `executor.interruptInflight()` to cancel running transfer fibers before they commit conflicting state. Interrupted transfers are reset from `inProgress` to `queued`.

8. **Cancel pending downloads on deleteFile** (`0c69564`): `deleteFile()` now calls `executor.cancelDownload(fileId)` to prevent a queued download from completing after the file is deleted.

9. **Signer response validation** (`7570d31`): Upload/download signer responses are now validated at runtime instead of trusting `as` casts. Invalid responses produce clear error messages.

10. **Emit sync:error on start() failure** (`656213f`): `createFileSync.start()` now emits a `sync:error` event with `context: "start"` when initialization fails, making boot failures visible to event listeners.

#### New Event Type

| Event | Fields | Description |
|-------|--------|-------------|
| `transfer:exhausted` | `kind`, `fileId`, `error` | A transfer failed after all retries were exhausted |

#### New SyncExecutor APIs

- `onTaskComplete` callback parameter on `makeSyncExecutor` — called after each task (success or failure)
- `interruptInflight()` method — interrupts all running transfer fibers, returns metadata about what was interrupted

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
    +-- stopSyncLoop() ──> executor.pause() + executor.interruptInflight()
    |                       + reset inProgress → queued + stopEventStream()
    |
    +-- handleEventBatch() ──> per-event error handling, cursor always advances
    |                          updates lastBatchAtRef, lastBatchCursorRef
    |
    +-- deleteFile() ──> executor.cancelDownload() + deleteFileRecord()
    |
    +-- goOffline() ──> only resets inProgress (preserves error states)
    |
    +-- emit() ──> try/catch per callback (one bad subscriber can't crash sync)
    |
    +-- startHeartbeat() ──> periodic tick (every 15s by default)
                                |
                                +-- Check stream fiber liveness (stream-dead)
                                +-- Check stuck queue (stuck-queue)
                                +-- Check stream stall (stream-stalled)
                                +-- Emit sync:heartbeat-recovery events
                                |
                                +──> executor.resume() / startEventStream()

[SyncExecutor]
    |
    +-- ensureWorkers() ──> restart dead worker fibers
    +-- interruptInflight() ──> cancel all running transfer fibers
    +-- onTaskComplete callback ──> notifies FileSync of success/failure
    +-- Atomic enqueue deduplication via Ref.modify
    |
    +-- Worker fiber refs ──> downloadWorkerFiberRef, uploadWorkerFiberRef
    +-- Inflight fiber tracking ──> inflightFibersRef (for interrupt support)
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
    case 'transfer:exhausted':
      console.error(`${event.kind} for ${event.fileId} failed after all retries:`, event.error)
      break
  }
})
```
