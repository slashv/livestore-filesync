# Event-driven refactor

This document summarizes the event-stream refactor that replaces the previous reconciliation loop with LiveStore's `store.eventsStream` API.

## What changed

- **Stream-driven sync**: `FileSync` now consumes the LiveStore event stream filtered to file events and processes them in batches.
- **Shared cursor**: A new client document, `fileSyncCursor`, stores the last processed event sequence so any leader tab can resume the stream.
- **Conditional bootstrap**: The leader bootstraps from the `files` table only when needed (root cursor or empty `localFileState`). Warm restarts reuse existing state.
- **Batched local state writes**: `localFileState` diff updates are committed as a single `store.commit(...events)` transaction when possible, instead of one commit per row.
- **Immediate delete handling**: `v1.FileDeleted` events reclaim unowned local bytes through `BlobOwnership` and remove local state entries. Shared paths and active transfers retain their bytes; remote blobs are retained for server-managed GC.
- **Configuration cleanup**: `gcDelayMs` was removed since periodic cleanup is no longer used.

## New schema additions

- `tables.fileSyncCursor` client document with default id `global`
- `events.fileSyncCursorSet` for updating cursor state

## Event handling rules

- **FileCreated**: If the local file exists, set local state and enqueue upload.
- **FileUpdated**:
  - If local file missing and `remoteKey` exists → queue download.
  - If local hash mismatches and `remoteKey` exists → queue download.
  - If local hash mismatches and `remoteKey` empty → queue upload.
  - If local hash matches and `remoteKey` empty → queue upload.
- **FileDeleted**: Delete local file and remove local state.

## Error Handling and Recovery

### Stream Recovery

The event stream automatically recovers from errors using exponential backoff:

- **Retry attempts**: Configurable via `maxStreamRecoveryAttempts` (default: 5)
- **Backoff timing**: Exponential from `streamRecoveryBaseDelayMs` (default: 1s) to `streamRecoveryMaxDelayMs` (default: 60s)
- **Recovery events**: `sync:stream-error` emitted on each failure, `sync:recovery` on successful recovery
- **Exhaustion**: `sync:stream-exhausted` emitted when max attempts reached

### Error State Auto-Retry

On startup, files stuck in `error` state are automatically reset to `queued`:

- Files with `uploadStatus: "error"` are reset to `queued`
- Files with `downloadStatus: "error"` are reset to `queued`
- `lastSyncError` is cleared when retrying
- `sync:error-retry-start` event is emitted with the list of file IDs being retried

Queued transfers are re-enqueued when `syncNow()` is called (or via `retryErrors()` for explicit
manual retries).

### Manual Retry API

Applications can manually retry files in error state:

```typescript
// Retry all files in error state
const retriedFileIds = await fileSync.retryErrors()
// or with singleton API
const retriedFileIds = await retryErrors()
```

### Sync Events for Error Visibility

New events provide visibility into errors and recovery:

| Event | Description |
|-------|-------------|
| `sync:error` | General error during event processing (includes `context` field) |
| `sync:stream-error` | Event stream error (includes `attempt` number) |
| `sync:stream-exhausted` | Max stream recovery attempts reached |
| `sync:recovery` | Successful recovery (includes `from`: "stream-error" or "error-retry") |
| `sync:error-retry-start` | Auto/manual retry started (includes `fileIds` array) |

### Configuration Options

```typescript
interface FileSyncConfig {
  // ... existing options ...
  
  /** Maximum stream recovery attempts before giving up (default: 5) */
  maxStreamRecoveryAttempts?: number
  
  /** Base delay for stream recovery backoff in ms (default: 1000) */
  streamRecoveryBaseDelayMs?: number
  
  /** Maximum delay for stream recovery backoff in ms (default: 60000) */
  streamRecoveryMaxDelayMs?: number
}
```

## Re-processing Safety

Event batch re-processing is safe due to:

1. **Guarded state updates**: reconciliation checks captured metadata and local state before applying its patch.
2. **Rebuildable queues**: startup, leadership handoff and heartbeat derive missing work from durable rows; active attempts are not duplicated.
3. **Hash-based decisions**: upload/download decisions compare local bytes with current metadata, never an obsolete event payload.

Conditional bootstrap retains its upstream-head cursor policy. Before an event cursor advances,
failed inspections and rejected concurrent patches are persisted in the optional cursor `repairs`
array. Startup and heartbeat perform bounded targeted repairs; `retryErrors()` resets exhausted
inspection attempts. Successful repair commits state before clearing the repair ID. See
[ARCHITECTURE.md](./ARCHITECTURE.md#durable-work-and-reconciliation) for the recovery policy.

## Remaining tasks / follow-ups

- **Remove `as any`** in `FileSync` for `includeClientOnly` once LiveStore exposes it in `StoreEventsOptions`.
- **Public docs**: consider documenting the cursor table and batch processing contract in the main docs site.
- **Schema versioning**: if schema versioning is introduced later, add a migration for `fileSyncCursor`.
- **Telemetry**: optional log/metrics for cursor advancement and batch size if needed.
