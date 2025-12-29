# Core package architecture

This document focuses on the services in `@livestore-filesync/core` and how they compose.
The services are wired together as Effect layers inside `createFileSync` and the singleton helpers.

## Services

- `FileSystem`: low-level read/write/list interface. Core ships an OPFS-backed implementation
  (`FileSystemOpfsLive`), while adapter packages can supply alternatives (for example the Node
  filesystem from `@livestore-filesync/adapter-node`).
- `LocalFileStorage`: wraps `FileSystem` with file-centric helpers (read/write bytes, object URLs,
  directory listing) and metadata handling. Swapping the `FileSystem` layer changes the local
  storage backend without touching higher layers.
- `RemoteStorage`: pluggable adapter for upload/download/delete/health checks. The default adapter
  is HTTP (`POST /upload`, `GET/DELETE {url}`, `GET /health`), and other backends can be supplied
  via a custom adapter (the Cloudflare worker package shows one approach). Static headers/auth tokens
  are applied by core so uploads do not rely on the service worker.
- `SyncExecutor`: manages upload/download queues with concurrency limits and retry/backoff logic.
- `FileSync`: orchestration service. Tracks online state, reconciles LiveStore file records with
  local state, schedules transfers through `SyncExecutor`, updates remote URLs, and runs GC/health
  checks.
- `FileStorage`: high-level API used by `saveFile`, `updateFile`, `deleteFile`, and `getFileUrl`.
  It hashes content, writes to local storage, updates LiveStore records, and triggers `FileSync`.

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
   +--> [LocalFileStorage] ----> [FileSystem (OPFS)]

Notes:
- `FileStorage` is the primary entry point for CRUD; it always writes locally first.
- `FileSync` handles background uploads/downloads and keeps metadata in the LiveStore tables.
- `LocalFileStorage` is the only layer that touches the filesystem adapter directly.
- `RemoteStorage` is the only layer that knows about the remote backend API.

## Layer dependency graph

This mirrors the Effect layer wiring in `createFileSync`:

[FileSystemLive] ----------------------+
                                       |
                                       v
[LocalFileStorageLive] <--------- Layer.provide(FileSystemLive)
                                       |
                                       v
[RemoteStorageLive] -------------------+
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
