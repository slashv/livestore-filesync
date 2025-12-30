# Service Test Coverage Plan

## Scope
- Core services in `packages/core/src/services` (FileSystem, LocalFileStorage, RemoteStorage, SyncExecutor, FileSync, FileStorage).
- Integration tests stay in `packages/core/test`.
- E2E tests stay in `tests/e2e/tests`.

## Current coverage snapshot
- FileSystem (OPFS): no direct tests.
- LocalFileStorage: `packages/core/test/LocalFileStorage.test.ts` exercises the in-memory implementation (read/write/bytes/exists/delete/listing).
- RemoteStorage: `packages/core/test/RemoteStorage.test.ts` covers the in-memory adapter (upload/download/delete/health, offline/fail uploads).
- SyncExecutor: `packages/core/test/SyncExecutor.test.ts` covers enqueueing, dedup, pause/resume, retry limits, inflight/queued counts, awaitIdle.
- FileSync: no unit tests; partial integration via `packages/core/test/FileStorageRemoteDelete.test.ts` (delete during upload).
- FileStorage: no unit tests; partial integration via `packages/core/test/FileStorageRemoteDelete.test.ts`.
- E2E: `tests/e2e/tests/file-sync.spec.ts` covers end-to-end UI + remote sync flows.

## Target test layout
- Add service-level tests in each service folder:
  - `packages/core/src/services/file-system/OpfsFileSystem.test.ts`
  - `packages/core/src/services/local-file-storage/LocalFileStorage.test.ts`
  - `packages/core/src/services/remote-file-storage/RemoteStorage.test.ts`
  - `packages/core/src/services/sync-executor/SyncExecutor.test.ts`
  - `packages/core/src/services/file-sync/FileSync.test.ts`
  - `packages/core/src/services/file-storage/FileStorage.test.ts`
- Keep integration tests in `packages/core/test`.
- Keep e2e tests in `tests/e2e/tests`.
- Update `packages/core/vitest.config.ts` to include `src/services/**/**/*.test.ts` in addition to `test/**/*.test.ts`.

## Testing strategy by service

### FileSystem (OPFS)
- Use a jsdom environment and a minimal mock of `navigator.storage.getDirectory`.
- Cover path normalization and `baseDirectory` resolution.
- Verify `readFile`, `writeFile`, `readDirectory`, `makeDirectory`, `remove`.
- Validate `exists` and `stat` behavior for files and directories (including NotFound mapping).
- Assert `FileSystemError` fields (operation/path) on failures.

### LocalFileStorage
- Exercise `LocalFileStorageLive` with a fake/in-memory FileSystem service.
- Cover metadata handling (`.meta.json` creation, read fallback when missing/invalid).
- Verify `listFiles` filters metadata files and recurses into nested directories.
- Confirm delete removes file + metadata and `getFileUrl` returns an object URL.

### RemoteStorage
- Move or mirror memory adapter tests into the service folder.
- Add missing branches: `failDownloads`, `delete` offline, `baseUrl` override.
- Add HTTP adapter tests with mocked `fetch`:
  - Authorization/header handling.
  - `key` behavior in `FormData`.
  - Error mapping when responses are non-OK.
  - `checkHealth` returns false on errors.

### SyncExecutor
- Move current tests into the service folder.
- Add concurrency-limit tests (max concurrent uploads/downloads).
- Add idle resolution checks after errors and after pause/resume cycles.

### FileSync
- Use in-memory LiveStore + `LocalFileStorageMemory` + `RemoteStorageMemory`.
- Reconciliation cases:
  - Remote-only file -> download pending.
  - Local-only file -> upload pending.
  - Local hash mismatch -> download pending.
- Event emission coverage (upload/download start/complete/error, online/offline).
- Online/offline transitions and health-check loop.
- GC cleanup for deleted files when idle (use short `gcDelayMs` or TestClock).

### FileStorage
- Use in-memory LiveStore + memory storage layers.
- `saveFile` creates record, writes local file, queues upload.
- `updateFile` no-op for same hash; new hash rewrites path and cleans old file.
- `deleteFile` soft deletes and removes local file (best-effort remote delete).
- `getFileUrl` prefers local when available and falls back to remote URL.

## Implementation sequencing
1. Update `packages/core/vitest.config.ts` to include service-level tests.
2. Add shared test helpers (fake FileSystem, LiveStore setup) under `packages/core/test/helpers`.
3. Implement service-level unit tests per folder, starting with the missing services.
4. Keep `packages/core/test` for cross-service integration scenarios.

## Open questions
- Confirm whether adapter packages (`packages/adapter-node`) should get their own service-level tests. If yes, add a follow-up plan for Node FileSystem adapter behavior.
