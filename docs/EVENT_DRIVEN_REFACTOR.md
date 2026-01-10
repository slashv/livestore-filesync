# Event-driven refactor

This document summarizes the event-stream refactor that replaces the previous reconciliation loop with LiveStore’s `store.eventsStream` API.

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

- **FileCreated**: If the local file exists, set local state and enqueue upload.
- **FileUpdated**:
  - If local file missing and `remoteKey` exists → queue download.
  - If local hash mismatches and `remoteKey` exists → queue download.
  - If local hash mismatches and `remoteKey` empty → queue upload.
  - If local hash matches and `remoteKey` empty → queue upload.
- **FileDeleted**: Delete local file and remove local state.

## Remaining tasks / follow-ups

- **Remove `as any`** in `FileSync` for `includeClientOnly` once LiveStore exposes it in `StoreEventsOptions`.
- **Public docs**: consider documenting the cursor table and batch processing contract in the main docs site.
- **Schema versioning**: if schema versioning is introduced later, add a migration for `fileSyncCursor`.
- **Telemetry**: optional log/metrics for cursor advancement and batch size if needed.
