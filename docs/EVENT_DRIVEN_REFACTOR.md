# Event-driven refactor

This document summarizes the event-stream refactor that replaces the previous reconciliation loop with LiveStore's `store.eventsStream` API.

## What changed

- **Stream-driven sync**: `FileSync` now consumes the LiveStore event stream filtered to file events and processes them in batches.
- **Shared cursor**: A new client document, `fileSyncCursor`, stores the last processed event sequence so any leader tab can resume the stream.
- **Bootstrap step**: On startup, the leader bootstraps file state from the `files` table before streaming events.
- **Immediate delete handling**: `v1.FileDeleted` events delete local files immediately and remove local state entries.
- **Configuration cleanup**: `gcDelayMs` was removed since periodic cleanup is no longer used.

## New schema additions

- `tables.fileSyncCursor` client document with default id `global`
- `events.fileSyncCursorSet` for updating cursor state

## Event handling rules

- **FileCreated**: If the local file exists, set local state and enqueue upload (event stream is the only automatic trigger).
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

On startup, files stuck in `error` state are automatically re-queued:

- Files with `uploadStatus: "error"` are reset to `queued` and re-enqueued for upload
- Files with `downloadStatus: "error"` are reset to `queued` and re-enqueued for download
- `lastSyncError` is cleared when retrying
- `sync:error-retry-start` event is emitted with the list of file IDs being retried

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

1. **Idempotent state updates**: `resolveTransferStatus` preserves active transfer states (`queued`, `inProgress`)
2. **Deduplicated queues**: `SyncExecutor` uses sets to track queued file IDs, preventing duplicate enqueues
3. **Hash-based decisions**: Upload/download decisions are based on comparing `localHash` vs `contentHash` and checking `remoteKey` existence

The cursor is only updated after all events in a batch are successfully processed. If processing fails, the cursor is not updated, allowing the batch to be re-processed on the next attempt.

## Remaining tasks / follow-ups

- **Remove `as any`** in `FileSync` for `includeClientOnly` once LiveStore exposes it in `StoreEventsOptions`.
- **Public docs**: consider documenting the cursor table and batch processing contract in the main docs site.
- **Schema versioning**: if schema versioning is introduced later, add a migration for `fileSyncCursor`.
- **Telemetry**: optional log/metrics for cursor advancement and batch size if needed.
