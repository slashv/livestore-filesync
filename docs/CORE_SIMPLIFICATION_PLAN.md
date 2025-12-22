# Core FileSync Simplification Plan

## Goals

- Keep Effect for correctness, testing, and dependency management.
- Eliminate duplicate sync logic and type definitions.
- Converge on the single-file clarity of `vue-livestore-filesync/src/services/file-sync.ts`.
- Preserve a minimal Promise-based API for framework adapters.

## Current duplication and divergence

- Two sync engines:
  - `packages/core/src/api/createFileSync.ts` (Promise API with its own queue and reconciliation).
  - `packages/core/src/services/file-sync/FileSync.ts` (Effect service with a different flow).
- Two executors:
  - `packages/core/src/api/createFileSync.ts` has `createSyncExecutor`.
  - `packages/core/src/services/sync-executor/SyncExecutor.ts` is a separate Effect queue.
- Two file operation layers:
  - `packages/core/src/api/createFileSync.ts` implements save/update/delete/read.
  - `packages/core/src/services/file-storage/FileStorage.ts` implements the same.
- Two type sets:
  - `packages/core/src/api/createFileSync.ts` defines Sync* types.
  - `packages/core/src/types/index.ts` defines core types with different shapes.
- `packages/core/src/api/FileSyncClient.ts` overlaps with Local/Remote storage services but is not used by LiveStore sync.

These divergences make behavior drift likely (status fields, online handling, retries, and state reconciliation differ across implementations).

## Recommended direction

Use a single Effect-based sync implementation and wrap it with a small Promise adapter:

- **Single source of truth:** keep `FileSync` (Effect service) as the sync engine.
- **Thin Promise API:** rework `createFileSync` to only:
  - build LiveStore adapter(s) for FileSync/FileStorage,
  - wire layers and runtime,
  - expose Promise methods and lifecycle hooks.
- **Single executor:** keep `SyncExecutor` (Effect) and delete the inline queue in `createFileSync`.
- **Canonical types:** move all public sync types to `packages/core/src/types/index.ts` and reuse them everywhere.
- **Prune API surface:** remove `FileSyncClient` (LiveStore is always used).

## Target architecture (minimal)

- `services/` (Effect): `LocalFileStorage`, `RemoteStorage`, `SyncExecutor`, `FileSync`, `FileStorage`.
- `api/createFileSync.ts`: LiveStore adapter + Effect runtime + Promise wrapper.
- `types/index.ts`: single exported type surface for sync state and events.
- `api/index.ts`: export only the minimal Promise API (plus types).

## Plan of attack

### 1) Consolidate sync behavior in `FileSync`

- Port the two-pass reconciliation logic and GC cleanup from `packages/core/src/api/createFileSync.ts` into `packages/core/src/services/file-sync/FileSync.ts`.
- Keep Effect-based offline handling and health checks, but align event emissions and status transitions with the reference implementation.

### 2) Remove duplicate queue implementation

- Delete `createSyncExecutor` from `packages/core/src/api/createFileSync.ts`.
- Use `SyncExecutor` inside `FileSync` only.
- If `SyncExecutor` is too heavy, simplify it rather than maintaining two separate queues.

### 3) Create a small LiveStore adapter

- Add a helper (e.g. `packages/core/src/api/livestoreAdapter.ts`) to build:
  - `FileSyncStore` adapter (get files, local state, subscribe, update remote URL).
  - `FileStorageStore` adapter (create/update/delete file rows, generate IDs).
- This keeps LiveStore-specific logic in one place and removes duplication from `createFileSync`.

### 4) Refactor `createFileSync` into a thin wrapper

- Instantiate layers: `LocalFileStorageLive`, `RemoteStorageLive`, `FileSyncLive`, `FileStorageLive`, and the LiveStore adapters.
- Expose a Promise API by running Effect methods through a single runtime.
- Keep the browser connectivity event wiring in this file (window-specific), but call `FileSync.setOnline` instead of re-implementing the logic.

### 5) Normalize types and exports

- Replace `Sync*` types in `createFileSync` with shared types from `packages/core/src/types/index.ts`.
- Align `TransferStatus`, `LocalFilesState`, and event shapes across the codebase.
- Update `packages/core/src/api/index.ts` and `packages/core/src/index.ts` exports accordingly.

### 6) Remove `FileSyncClient`

- Delete `packages/core/src/api/FileSyncClient.ts` and its exports.
- Update any docs and examples to use `createFileSync` only.

### 7) Testing strategy (Effect-friendly)

- Unit tests for `FileSync` around:
  - two-pass reconciliation,
  - upload/download enqueueing,
  - offline/online transitions,
  - GC cleanup.
- Minimal integration test for `createFileSync` using in-memory storage layers.

## Decisions to confirm

- Online/offline handling: keep window event listeners in `createFileSync`; call `FileSync.setOnline`.
- `SyncExecutor`: keep retries/backoff.
