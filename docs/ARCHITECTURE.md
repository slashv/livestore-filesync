# Core package architecture

This document focuses on the services in `@livestore-filesync/core` and how they compose.
The services are wired together as Effect layers inside `createFileSync` and the singleton helpers.

## Services

- `FileSystem`: re-exported from `@effect/platform/FileSystem`. This is a low-level read/write/list
  interface. Users must provide a compatible implementation:
  - For browsers: use `@livestore-filesync/opfs` which provides an OPFS-backed implementation
  - For Node.js: use `@effect/platform-node` (`NodeFileSystem.layer`)
- `LocalFileStorage`: wraps `FileSystem` with file-centric helpers (read/write bytes, object URLs,
  directory listing) and metadata handling. Swapping the `FileSystem` layer changes the local
  storage backend without touching higher layers.
- `RemoteStorage`: remote storage abstraction for upload/download/delete/health checks.
  The built-in implementation is signer-backed and targets S3-compatible object storage via a signer
  API (`GET /health`, `POST /v1/sign/upload`, `POST /v1/sign/download`, `POST /v1/delete`) that mints
  short-lived URLs. Alternative backends are still possible by supplying a custom `RemoteStorageAdapter`.
- `SyncExecutor`: manages upload/download queues with concurrency limits and retry/backoff logic.
- `FileSync`: orchestration service. Tracks online state, reconciles LiveStore file records with
  local state, schedules transfers through `SyncExecutor`, updates remote URLs, and runs GC/health
  checks.
- `FileStorage`: high-level API used by `saveFile`, `updateFile`, `deleteFile`, and `getFileUrl`.
  It hashes content, writes to local storage, updates LiveStore records, and triggers `FileSync`.

## FileSystem requirement

The `fileSystem` parameter is **required** when calling `initFileSync` or `createFileSync`.
The core package does not bundle any filesystem implementation to keep it framework-agnostic.

### Browser usage

```typescript
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' }
})
```

### Node.js usage

```typescript
import { createFileSync } from '@livestore-filesync/core'
import { NodeFileSystem } from '@effect/platform-node'

createFileSync({
  store,
  schema,
  fileSystem: NodeFileSystem.layer,
  remote: { signerBaseUrl: 'https://api.example.com' }
})
```

## How the services fit together

Text diagram (arrows show the main direction of calls):

[App API]
   |
   v
[FileStorage] <-------------------------------> [LiveStore store + schema]
   |  \                                          (files table + local state)
   |   \
   |    v
   |  [FileSync] ----> [SyncExecutor] ----> [RemoteStorage] ---> Remote backend
   |      |
   |      v
   +--> [LocalFileStorage] ----> [FileSystem (OPFS/Node/custom)]

Notes:
- `FileStorage` is the primary entry point for CRUD; it always writes locally first.
- `FileSync` handles background uploads/downloads and keeps metadata in the LiveStore tables.
- `LocalFileStorage` is the only layer that touches the filesystem adapter directly.
- `RemoteStorage` is the only layer that knows about the remote backend API.

## Layer dependency graph

This mirrors the Effect layer wiring in `createFileSync`:

[FileSystemLive (user-provided)] -----------+
                                            |
                                            v
[LocalFileStorageLive] <--------- Layer.provide(FileSystemLive)
                                            |
                                            v
[RemoteStorageLive] -----------------------+
                                            |
                                            v
[BaseLayer] = mergeAll(Layer.scope, FileSystemLive, LocalFileStorageLayer, RemoteStorageLive)
                                            |
                                            v
[FileSyncLive(deps, config)] <--- Layer.provide(BaseLayer)
                                            |
                                            v
[FileStorageLive(deps)] <--------- Layer.provide(mergeAll(BaseLayer, FileSyncLayer))
                                            |
                                            v
[MainLayer] = mergeAll(BaseLayer, FileSyncLayer, FileStorageLayer)
