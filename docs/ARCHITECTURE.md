# Core package architecture

This document focuses on the services in `@livestore-filesync/core` and how they compose.
The services are wired together as Effect layers inside `createFileSync` and the singleton helpers.

## Services

- `FileSystem`: provided by Effect 4's `effect/FileSystem`. This is a low-level read/write/list
  interface. Users must provide a compatible implementation:
  - For browsers: use `@livestore-filesync/opfs` which provides an OPFS-backed implementation
  - For Node.js: use `@effect/platform-node` (`NodeFileSystem.layer`)

- `LocalFileStorage`: wraps `FileSystem` with file-centric helpers (read/write bytes, object URLs,
  directory listing) and metadata handling. Swapping the `FileSystem` layer changes the local
  storage backend without touching higher layers.

- `LocalFileStateManager` (internal): centralized manager for all `localFileState` table mutations. Uses an internal
  lock to ensure atomic read-modify-write operations, preventing race conditions when multiple
  concurrent operations try to update the state. Diff-based operations (`atomicUpdate`,
  `mergeFiles`, `replaceState`) batch multiple row changes into a single `store.commit(...events)`
  transaction to reduce event churn.

- `RemoteStorage`: remote storage abstraction for upload/download/delete/health checks.
  The built-in implementation is signer-backed and targets S3-compatible object storage via a signer
  API (`GET /health`, `POST /v1/sign/upload`, `POST /v1/sign/download`, `POST /v1/delete`) that mints
  short-lived URLs. Alternative backends are still possible by supplying a custom `RemoteStorageAdapter`.
  When `remote: false` is configured, FileSync uses an internal disabled adapter and the orchestration
  layer avoids remote calls entirely.

- `SyncExecutor` (internal): manages upload/download queues with concurrency limits and retry/backoff logic.
  Worker fibers are tracked and can be restarted via `ensureWorkers()` if they exit unexpectedly.

- `FileSync`: orchestration service and primary CRUD API. Tracks online state, consumes the
  LiveStore event stream for file events, updates local state incrementally, schedules transfers
  through `SyncExecutor`, updates remote URLs, and runs health checks. It also handles `saveFile`,
  `updateFile`, `deleteFile`, and `resolveFileUrl`, always writing locally first. In local-only mode
  it still writes and resolves local files, but skips health checks and upload/download/delete work.

## Transfer validity and queue ownership

`FileSync` owns version validity: each attempt captures content hash, local path and remote
key, and rejects completion or failure updates if that identity changed or the row was deleted.
Uploads hash local bytes before sending; downloads hash received bytes before writing.
A download rechecks after the adapter write, removes an unreferenced stale path, and commits
local availability only for the current version. Publication finishes even if cancellation
arrives during a filesystem write that cannot be aborted. Metadata-only edits are preserved
when the upload remote key is committed.

`SyncExecutor` owns concurrency, cancellation, retries and completion accounting. It permits
one active transfer per file and direction. Enqueueing that direction during an active attempt
coalesces into one follow-up attempt, which reads the latest row. Priority entries share queue
identity, so old priority entries cannot consume a newly enqueued request. Cancelling downloads
interrupts active work and its retry delay as well as invalidating queued requests.

Superseded attempts reconcile the latest row without marking it failed or complete. Checksum
failures on a current version use the existing retry/error policy.

### Shared blob lifetime

`BlobOwnership` owns local cleanup for CRUD, tombstone events, bootstrap and transfer
finalization. A local path is owned while any non-deleted row references it or an active
transfer leases it. The last transfer releases its lease and attempts cleanup, including
stale downloads and uploads. Cleanup queries current rows rather than a bootstrap snapshot.
A per-instance mutex serializes cleanup with local writes and their metadata publication;
upload reads also wait for pending cleanup. These operations finish across cancellation.
Cleanup keeps a byte snapshot and rechecks ownership before and after adapter deletion,
restoring it when synced metadata or a new transfer acquires ownership during the delete.
Read failures retain bytes; filesystem failures remain best effort and may leave orphaned
bytes or prevent restoration. This is not an atomic filesystem/LiveStore transaction.

The mutex is scoped to one FileSync instance, not a cross-tab or cross-process lock. Synced
metadata can arrive outside it; the post-delete check handles references visible when deletion
settles. References arriving later must download retained remote bytes. In local-only mode,
applications must re-save bytes for such later references. Independent instances sharing a
filesystem are not covered by serialization and should not be treated as globally coordinated GC.

Remote objects are never automatically deleted by FileSync, even when the last locally known
owner is deleted or an upload becomes stale. Offline devices can have unseen references;
local row scans cannot prove global non-ownership. RemoteStorage.delete and the signer delete
endpoint remain available for application/server-authoritative garbage collection. No server
reference registry or remote GC is provided, so retained remote storage can grow over time.

## Remote Modes

FileSync has two explicit remote modes:

- **Remote-backed**: the default mode. `initFileSync` uses `/api` when `remote` is omitted, and
  `createFileSync` requires a signer config. Empty `remoteKey` means the local file should upload;
  remote keys allow other clients to download.
- **Local-only**: enabled with `remote: false`. `saveFile()` and `updateFile()` keep `remoteKey` as
  `""`, write `localFileState` as `uploadStatus: "done"` and `downloadStatus: "done"` when local
  bytes exist, and never calls `/health`, `/v1/sign/upload`, `/v1/sign/download`, or `/v1/delete`.
  `triggerSync()` and `retryErrors()` are no-ops/harmless for remote transfers in this mode.

## File Preprocessors

FileSync supports file preprocessing via MIME-type based preprocessors. When a file is saved or
updated, the system checks if a preprocessor is configured for that file's MIME type and applies
the transformation before storing. Preprocessors may return either a `File` or
`{ file, metadata }`; metadata is synced on the `files` row as `metadataJson`.

### How Preprocessors Work

```text
[User calls saveFile(file)]
         |
         v
[Match MIME type to preprocessor]
         |
    +-----------+
    | Match?    |
    +-----------+
    |           |
   Yes          No
    |           |
    v           |
[Apply preprocessor] |
         |           |
         +-----+-----+
               |
               v
[Normalize file + metadata]
               |
               v
[Hash processed file]
               |
               v
[Write to local storage]
               |
               v
[Create/update file record with metadataJson]
               |
               v
[Queue for upload]
```

### Pattern Matching Priority

When looking up a preprocessor, patterns are checked in this order:

1. **Exact match**: `'image/png'` matches only `image/png`
2. **Wildcard subtype**: `'image/*'` matches `image/png`, `image/jpeg`, etc.
3. **Universal wildcard**: `'*'` or `'*/*'` matches any MIME type

The first matching preprocessor is used.

### Configuration

Preprocessors are configured via the `options.preprocessors` map:

```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    preprocessors: {
      'image/*': async (file) => resizeImage(file, { maxDimension: 1500 }),
      'image/webp': async (file) => ({
        file,
        metadata: {
          mimeType: file.type,
          sizeBytes: file.size,
          image: { width: 1200, height: 800 }
        }
      }),
      'video/mp4': async (file) => compressVideo(file)
    }
  }
})
```

### File Metadata

File metadata is stored on the synced `files` table as `metadataJson`, nullable for older rows and for preprocessors that return only `File`. Use `getFileMetadata(fileRecord)` or `parseFileMetadata(metadataJson)` from core instead of parsing this column in app code.

The built-in metadata shape is intentionally small:

```typescript
type FileMetadata = {
  mimeType?: string
  sizeBytes?: number
  image?: { width: number; height: number }
  custom?: Record<string, unknown>
}
```

Metadata belongs to the row's current `contentHash`. `saveFile()` persists metadata with `v1.FileCreated`; content-changing `updateFile()` persists replacement metadata with `v1.FileUpdated`; remote-key-only updates preserve existing metadata. Existing synced update events that omit the metadata field also preserve existing metadata.

### Implementation Notes

- Preprocessors run synchronously in the main thread by default
- For heavy processing (e.g., video), consider using Web Workers
- The preprocessed file is what gets hashed and stored (both locally and remotely)
- Preprocessor metadata describes the final stored file, not the original input
- Preprocessing errors will cause the `saveFile` operation to fail

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

Local-only usage for guest/unauthenticated sessions:

```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: false
})
```

### Node.js usage

The filesystem layer below runs on Effect 4. The Node adapter is temporarily pinned to immutable
`livestore-contrib` commit `7003f4e0673c2254a327c9fb4d816cbdd55d8d09`, which supplies the
current core `StateHead` service. Workspace overrides resolve the adapter's repository-local
LiveStore dependencies to the same `63cb2f26` npm snapshot cohort. The Node example smoke test
creates and shuts down a store; the Git dependency should be replaced with the corresponding
composite snapshot after contrib publishes it.

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

```text
[App API]
   |
   v
[FileSync] <-------------------------------> [LiveStore store + schema]
   |  \                                          (files table + local state)
   |   \
   |    v
   |  [SyncExecutor] ----> [RemoteStorage] ---> Remote backend
   |
   v
[LocalFileStorage] ----> [FileSystem (OPFS/Node/custom)]
```

Notes:
- `FileSync` is the primary entry point for CRUD; it writes locally first and the leader event stream queues sync.
- `FileSync` handles background uploads/downloads and keeps metadata in the LiveStore tables.
- With `remote: false`, the `SyncExecutor` and `RemoteStorage` transfer path is disabled for file
  records and local state remains stable without queued/error upload states.
- `LocalFileStorage` is the only layer that touches the filesystem adapter directly.
- `RemoteStorage` is the only layer that knows about the remote backend API.

## Layer dependency graph

This mirrors the Effect layer wiring in `createFileSync`:

```text
[FileSystemLive (user-provided)] -----------+
                                            |
                                            v
[LocalFileStorageLive] <--------- Layer.provide(FileSystemLive)
                                            |
                                            v
[LocalFileStateManagerLive(deps)] ---------+
                                            |
                                            v
[RemoteStorageLive] -----------------------+
                                            |
                                            v
[BaseLayer] = mergeAll(Layer.scope, FileSystemLive, LocalFileStorageLayer,
                       LocalFileStateManagerLayer, RemoteStorageLive)
                                            |
                                            v
[FileSyncLive(deps, config)] <--- Layer.provide(BaseLayer)
                                            |
                                            v
[MainLayer] = mergeAll(BaseLayer, FileSyncLayer)
```

## API Usage: Singleton vs Instance

The core package provides two ways to use the file sync API.

### Singleton helpers (recommended for most apps)

For apps with a single LiveStore store, use the singleton helpers. Initialize once, then import
the file operations anywhere in your app:

```typescript
import {
  initFileSync,
  startFileSync,
  stopFileSync,
  disposeFileSync,
  saveFile,
  resolveFileUrl,
  deleteFile
} from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

// Initialize once (typically in your app's root component or setup)
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' }
})

startFileSync()

// Use anywhere after initialization
const result = await saveFile(file)
const url = await resolveFileUrl(result.fileId)

// Cleanup on app unmount
stopFileSync()
await disposeFileSync()
```

`initFileSync` is idempotent for overlapping mounts of the same user/store lifecycle. Each call
retains the singleton and returns a disposer; the singleton is only disposed after the last returned
disposer runs. This avoids React remount or page-refresh races tearing down the active sync loop.

### Instance API (for advanced use cases)

When you need multiple file sync instances (e.g., multiple stores) or want explicit dependency
injection, use `createFileSync` to get a dedicated instance:

```typescript
import { createFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { queryDb } from '@livestore/livestore'
import { tables, events } from './schema'

const fileSync = createFileSync({
  store,
  schema: { tables, events, queryDb },
  fileSystem: opfsLayer(),
  remote: {
    signerBaseUrl: '/api',
    headers: { Authorization: `Bearer ${token}` }
  }
})

fileSync.start()

const result = await fileSync.saveFile(file)
const url = await fileSync.resolveFileUrl(result.fileId)

await fileSync.stop()
await fileSync.dispose()
```

The instance API returns the same methods as the singleton helpers, scoped to that specific
instance. This is useful for:

- Apps with multiple LiveStore stores that each need their own file sync
- Testing scenarios where you want isolated instances
- Server-side rendering or other environments where global state is problematic

## Type System Design

Types are derived from Effect Schema definitions to ensure a single source of truth and prevent
drift between TypeScript types and the actual LiveStore schema.

### Schema as Source of Truth

The `schema/index.ts` module exports Effect Schema objects that define the shape of all stored data:

```typescript
// Schema definitions (source of truth)
export const TransferStatusSchema = Schema.Literal("pending", "queued", "inProgress", "done", "error")
export const LocalFileStateSchema = Schema.Struct({ ... })
export const LocalFilesStateSchema = Schema.Record({ key: Schema.String, value: LocalFileStateSchema })
```

### Types Derived from Schema

The `types/index.ts` module imports these schemas and derives TypeScript types:

```typescript
// Derived types (no manual duplication)
export type TransferStatus = typeof TransferStatusSchema.Type
export type LocalFileState = typeof LocalFileStateSchema.Type
export type FileRecord = FileSyncTables["files"]["rowSchema"]["Type"]
```

### Mutable Variants

Effect Schema produces readonly types by default. For internal operations that require mutation
(like sync reconciliation), mutable variants are created:

```typescript
const LocalFilesStateMutableSchema = Schema.mutable(LocalFilesStateSchema)
export type LocalFilesStateMutable = typeof LocalFilesStateMutableSchema.Type
```

### Benefits

- **Single source of truth**: Schema definitions are canonical; types are derived
- **No drift**: TypeScript types cannot diverge from the actual LiveStore schema
- **Type safety**: Effect Schema provides runtime validation if needed
- **Flexibility**: Both readonly and mutable variants available as needed

## Display State Utilities

When displaying files in the UI, apps need to know whether a file can be displayed and its current
sync status. The `getFileDisplayState` utility combines the synced file record with client-local
state to provide this information.

### The Problem

Files sync via LiveStore, but the file content may not be immediately available:

1. **Originating client**: Has the file in local OPFS storage, can display immediately
2. **Other clients**: Receive the file record via sync, but must wait for upload to complete before
   they can download and display it

The `files` table contains synced metadata (including `remoteKey`), while `localFileState` is a
client-local SQLite table tracking what each client has locally (one row per file).

### getFileDisplayState

```typescript
import { getFileDisplayState } from '@livestore-filesync/core'

// Query just this file's local state row
const localFileState = store.useQuery(
  queryDb(tables.localFileState.where({ fileId: file.id }).first())
)
const displayState = getFileDisplayState(file, localFileState ?? undefined)

// displayState contains:
// - canDisplay: boolean  - true if file is available (local copy OR remote)
// - hasLocalCopy: boolean - true if local hash matches file's content hash
// - isUploaded: boolean   - true if remoteKey is set
// - isUploading: boolean  - true if upload is in progress/queued
// - isDownloading: boolean - true if download is in progress/queued
```

### UI Pattern

```tsx
// React example — per-file query for targeted reactivity
import { getFileDisplayState } from '@livestore-filesync/core'
import { queryDb } from '@livestore/livestore'

// Query only this file's local state row (not all rows)
const localFileState = store.useQuery(
  queryDb(tables.localFileState.where({ fileId: file.id }).first())
)
const { canDisplay, isUploading } = getFileDisplayState(file, localFileState ?? undefined)

return canDisplay
  ? <img src={`/${file.path}`} />
  : <Placeholder>{isUploading ? 'Uploading...' : 'Waiting...'}</Placeholder>
```

This ensures:
- Originating client displays immediately (has local copy)
- Other clients show placeholder until upload completes
- Correct version is displayed after edits (hash comparison)
- Each component only re-renders when its own file's state changes (not when any file changes)

## Multi-Tab Coordination

In browser environments, multiple tabs may be open to the same LiveStore store. LiveStore uses a
SharedWorker and Web Locks API to elect a single "leader" tab that runs the SQLite database.
Non-leader tabs proxy their operations through the SharedWorker.

**FileSync follows this same pattern**: only the leader tab runs the event stream processor.
This prevents race conditions where multiple tabs try to enqueue transfers and mutate
`localFileState` simultaneously.

### How It Works

1. **Leader Election**: LiveStore's `ClientSession` exposes a `lockStatus` SubscriptionRef that
   indicates whether the current tab holds the leader lock (`'has-lock'` or `'no-lock'`).

2. **Leader-Only Event Stream**: The `FileSync` service subscribes before reading the current lock:
   - When a tab becomes leader, it starts the LiveStore file-event stream and processes batches
     of `v1.FileCreated`, `v1.FileUpdated`, and `v1.FileDeleted` events
   - When a tab loses leadership, it invalidates transfer publication, interrupts active work,
     stops the stream, and persists interrupted work as queued

3. **Shared Cursor**: A shared client document (`fileSyncCursor`) stores the last processed
   event sequence so new leaders resume from the right point.

4. **All Tabs Can Still Operate**: Non-leader tabs can still call `saveFile`, `updateFile`, and
   `deleteFile`. These operations commit events to LiveStore, which syncs them to the leader tab
   via the SharedWorker. The leader stream then handles upload/download work.

### Implementation Details

The `FileSync` service tracks leadership state with:
- `isLeaderRef`: Whether this tab is currently the leader
- `leaderWatcherFiberRef`: Background fiber watching for leadership changes

Each start owns a nested scope containing the actual leadership watcher, workers, and
background fibers. `stop()` invalidates the run, interrupts owned work, and closes that scope.
Old caller-scope finalizers compare ownership before stopping anything, so they cannot stop
a restarted run. Worker creation is serialized, and transfer fibers belong to the worker
scope rather than detached execution. Publication checks both captured generation and the
current lock; health and heartbeat recovery must also pass the running-leader gate.

The public factory serializes lifecycle requests and singleton mount disposers capture their
originating generation. Replacement startup waits for retired instance cleanup. See
[instance lifecycle](STABILITY.md#instance-lifecycle-and-singleton-mounts) for configuration
refresh, failure/restart behavior, and physical cancellation limits.

This ensures:
- No duplicate sync operations across tabs
- Automatic failover when the leader tab closes
- Consistent state management via the leader's sync loop

## Sync Status

The `getSyncStatus()` utility derives aggregate sync status from the `localFileState` table rows.
Since `localFileState` is reactive via LiveStore, applications can subscribe to it and compute
sync status on each update. The function accepts rows directly from `useQuery` — no conversion needed.

### getSyncStatus

```typescript
import { getSyncStatus } from '@livestore-filesync/core'
import { queryDb } from '@livestore/livestore'

// Pass rows directly from the table query — no map conversion needed
const rows = store.query(queryDb(tables.localFileState.select()))
const status = getSyncStatus(rows)

// status contains:
// - uploadingCount: number     - files currently uploading
// - downloadingCount: number   - files currently downloading
// - queuedUploadCount: number  - files queued for upload
// - queuedDownloadCount: number - files queued for download
// - pendingUploadCount: number  - files pending upload (waiting to be queued)
// - pendingDownloadCount: number - files pending download (waiting to be queued)
// - errorCount: number         - files with sync errors
// - isSyncing: boolean         - true if any upload/download in progress
// - hasPending: boolean        - true if any files pending or queued
// - uploadingFileIds: string[] - IDs of files currently uploading
// - downloadingFileIds: string[] - IDs of files currently downloading
// - queuedUploadFileIds: string[] - IDs of files queued for upload
// - queuedDownloadFileIds: string[] - IDs of files queued for download
// - pendingUploadFileIds: string[] - IDs of files pending upload
// - pendingDownloadFileIds: string[] - IDs of files pending download
// - errors: SyncError[]        - files with errors and their messages
```

### Usage Examples

**React:**

```tsx
import { getSyncStatus } from '@livestore-filesync/core'
import { queryDb } from '@livestore/livestore'

function SyncIndicator() {
  // Pass rows directly to getSyncStatus — no map conversion needed
  const rows = store.useQuery(queryDb(tables.localFileState.select()))
  const status = useMemo(() => getSyncStatus(rows), [rows])

  if (status.isSyncing) {
    return (
      <div>
        Syncing: {status.uploadingCount} uploading, {status.downloadingCount} downloading
      </div>
    )
  }

  if (status.errorCount > 0) {
    return <div>Sync errors: {status.errors.map(e => e.error).join(', ')}</div>
  }

  return <div>All files synced</div>
}
```

**Vue:**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from 'vue-livestore'
import { queryDb } from '@livestore/livestore'
import { getSyncStatus } from '@livestore-filesync/core'
import { tables } from './schema'

// Pass rows directly — no map conversion needed
const rows = useQuery(queryDb(tables.localFileState.select()))
const syncStatus = computed(() => getSyncStatus(rows.value))
</script>

<template>
  <div v-if="syncStatus.isSyncing">
    Syncing: {{ syncStatus.uploadingCount }} uploading, {{ syncStatus.downloadingCount }} downloading
  </div>
  <div v-else-if="syncStatus.errorCount > 0">
    Sync errors: {{ syncStatus.errors.map(e => e.error).join(', ') }}
  </div>
  <div v-else>All files synced</div>
</template>
```

**Vanilla JS with store.subscribe:**

```typescript
import { queryDb } from '@livestore/livestore'
import { getSyncStatus } from '@livestore-filesync/core'
import { tables } from './schema'

const unsubscribe = store.subscribe(
  queryDb(tables.localFileState.select()),
  (rows) => {
    const status = getSyncStatus(rows)
    document.getElementById('sync-status').textContent =
      status.isSyncing ? `Syncing ${status.uploadingCount + status.downloadingCount} files...` : 'Synced'
  }
)

// Later, to unsubscribe:
unsubscribe()
```

## Transfer Progress

FileSync emits `upload:progress` and `download:progress` events during file transfers, allowing UI
components to display real-time progress (e.g., progress bars, percentage complete).

### Subscribing to Progress Events

```typescript
import {
  onFileSyncEvent,
  createActiveTransferProgress,
  updateActiveTransfers,
  removeActiveTransfer,
  computeTotalProgress,
  type ActiveTransfers
} from '@livestore-filesync/core'

let transfers: ActiveTransfers = {}

const unsubscribe = onFileSyncEvent((event) => {
  if (event.type === 'upload:progress' || event.type === 'download:progress') {
    const progress = createActiveTransferProgress(
      event.fileId,
      event.progress.kind,
      event.progress.loaded,
      event.progress.total
    )
    transfers = updateActiveTransfers(transfers, progress)
  } else if (
    event.type === 'upload:complete' ||
    event.type === 'upload:error' ||
    event.type === 'download:complete' ||
    event.type === 'download:error'
  ) {
    transfers = removeActiveTransfer(transfers, event.fileId)
  }
})

// Get aggregate progress stats
const { totalLoaded, totalSize, percent, count } = computeTotalProgress(transfers)
```

### Progress Event Structure

The `upload:progress` and `download:progress` events contain a `progress` object:

```typescript
interface TransferProgress {
  kind: "upload" | "download"  // Type of transfer
  fileId: string               // ID of file being transferred
  status: TransferStatus       // Current status (always "inProgress" for progress events)
  loaded: number               // Bytes transferred so far
  total: number                // Total bytes to transfer (may be 0 if unknown)
}
```

### Vue Example

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  onFileSyncEvent,
  createActiveTransferProgress,
  updateActiveTransfers,
  removeActiveTransfer,
  computeTotalProgress,
  type ActiveTransfers
} from '@livestore-filesync/core'

const activeTransfers = ref<ActiveTransfers>({})
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = onFileSyncEvent((event) => {
    if (event.type === 'upload:progress' || event.type === 'download:progress') {
      const progress = createActiveTransferProgress(
        event.fileId,
        event.progress.kind,
        event.progress.loaded,
        event.progress.total
      )
      activeTransfers.value = updateActiveTransfers(activeTransfers.value, progress)
    } else if (
      event.type === 'upload:complete' || event.type === 'upload:error' ||
      event.type === 'download:complete' || event.type === 'download:error'
    ) {
      activeTransfers.value = removeActiveTransfer(activeTransfers.value, event.fileId)
    }
  })
})

onUnmounted(() => unsubscribe?.())

const totalProgress = computed(() => computeTotalProgress(activeTransfers.value))
</script>

<template>
  <div v-if="totalProgress.count > 0">
    Transfer: {{ totalProgress.percent ?? '?' }}%
    ({{ totalProgress.totalLoaded }}/{{ totalProgress.totalSize }} bytes)
  </div>
</template>
```

### Implementation Notes

When an `onProgress` callback is provided, the underlying transfer mechanism changes:

- **Uploads**: Switches from `fetch()` to `XMLHttpRequest`. This is necessary because the Fetch API
  does not expose upload progress events. XHR's `upload.onprogress` event provides byte-level
  progress during the request body transmission.

- **Downloads**: Switches from `response.blob()` to streaming via `response.body.getReader()`.
  This allows tracking bytes as they arrive rather than waiting for the complete response.

When no `onProgress` callback is provided, the simpler `fetch()` API is used for both operations.
This fallback exists because:

- `fetch()` provides a cleaner, Promise-based API with better `AbortController` integration
- For uploads, XHR is only needed for its progress events (a feature `fetch` lacks)
- The simpler code path has fewer potential failure points

For most use cases, this implementation detail is transparent. However, be aware that:

- XHR uploads may behave slightly differently in edge cases (e.g., timeout handling)
- Streaming downloads accumulate chunks in memory before creating the final Blob

## Error Handling and Recovery

FileSync includes robust error handling and self-healing mechanisms for production reliability.

### Stream Recovery

The LiveStore event stream automatically recovers from transient errors using exponential backoff:

```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    maxStreamRecoveryAttempts: 5,    // Default: 5
    streamRecoveryBaseDelayMs: 1000, // Default: 1000 (1 second)
    streamRecoveryMaxDelayMs: 60000  // Default: 60000 (1 minute)
  }
})
```

When the event stream encounters an error:
1. A `sync:stream-error` event is emitted with the error and attempt number
2. The stream waits using exponential backoff (1s, 2s, 4s, 8s, 16s, ...)
3. On successful recovery, a `sync:recovery` event is emitted
4. If max attempts are reached, `sync:stream-exhausted` is emitted

### Durable Work and Reconciliation

`Reconciliation.ts` centralizes file inspection, guarded state patches, targeted repairs and
executor reconstruction. `localFileState` is authoritative for transfer work; executor queue
membership is a rebuildable cache. Warm startup reads durable local rows without scanning or
hashing every `files` row. Bootstrap remains conditional on a root cursor or empty local state.

Every leadership acquisition resets orphaned `inProgress` and `error` statuses to `queued` and
enqueues both those and pre-existing queued rows. Errors receive one normal bounded executor
retry cycle per acquisition. Heartbeat and `syncNow()` rebuild missing queued/interrupted work
without resetting errors or scheduling duplicate follow-ups for active attempts. New file events
can retry the affected file's error, so corrected remote keys are used immediately.

Inspection results are committed as a batch only where both the captured metadata and local
state still match. Rejected patches become targeted repair work. Deletion cleans both the current
metadata path and previous durable local path through `BlobOwnership`.

The optional `fileSyncCursor.repairs` array stores `{ fileId, attempts, retryErrors? }` entries. Existing cursor
documents without it remain valid. An inspection failure is persisted before advancing the event
cursor; successful repair publishes local state before retiring its entry. Startup and heartbeat
retry only these IDs. Inspection attempts are bounded at `max(2, executorConfig.maxRetries + 1)`
including the initial failure; counts and new-event retry intent survive restart. `retryErrors()` resets this budget as well
as retrying transfer errors. Disabled heartbeat leaves startup/manual retry as the repair trigger.
Inspection and repair reads are serialized so heartbeat cannot replay a repair completed by
manual retry. No-op reconciliation emits no local-state or repair-document changes.

### Manual Error Retry

Applications can manually retry files in error state:

```typescript
import { retryErrors } from '@livestore-filesync/core'

// Retry all files currently in error state
const retriedFileIds = await retryErrors()
console.log(`Retrying ${retriedFileIds.length} files`)
```

Or with the instance API:

```typescript
const retriedFileIds = await fileSync.retryErrors()
```

### Sync Events for Error Visibility

Subscribe to error events for monitoring and UI feedback:

```typescript
import { onFileSyncEvent } from '@livestore-filesync/core'

onFileSyncEvent((event) => {
  switch (event.type) {
    case 'sync:error':
      console.error('Sync error:', event.error, 'context:', event.context)
      break
    case 'sync:stream-error':
      console.warn(`Stream error (attempt ${event.attempt}):`, event.error)
      break
    case 'sync:stream-exhausted':
      console.error(`Stream gave up after ${event.attempts} attempts`)
      // Maybe show a "reconnect" button to user
      break
    case 'sync:recovery':
      console.log(`Recovered from ${event.from}`)
      break
    case 'sync:error-retry-start':
      console.log(`Retrying ${event.fileIds.length} files`)
      break
    case 'transfer:exhausted':
      console.error(`${event.kind} for ${event.fileId} failed after all retries:`, event.error)
      break
  }
})
```

### Error Events Reference

| Event | Fields | Description |
|-------|--------|-------------|
| `sync:error` | `error`, `context?` | General sync error (batch processing, bootstrap, start, etc.) |
| `sync:stream-error` | `error`, `attempt?` | Event stream error with retry attempt number |
| `sync:stream-exhausted` | `error`, `attempts` | Max recovery attempts reached |
| `sync:recovery` | `from` | Successful recovery ("stream-error" or "error-retry") |
| `sync:error-retry-start` | `fileIds` | Files being retried from error state |
| `sync:heartbeat-recovery` | `reason` | Heartbeat recovered dead stream or stuck queue |
| `transfer:exhausted` | `kind`, `fileId`, `error` | Transfer failed after all retries exhausted |

### Heartbeat Monitoring

FileSync includes a background heartbeat loop that periodically verifies the event stream and sync executor are alive, automatically recovering from silent failures (e.g., a stream that exhausted retries and stopped).

```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    heartbeatIntervalMs: 15000 // Default: 15000 (15 seconds). Set to 0 to disable.
  }
})
```

Every heartbeat interval, the following checks run (only when the current tab is the leader):

1. **Event stream liveness**: If the stream fiber is dead (null ref or exited), it is restarted via the same `startEventStream()` path, which interrupts any stale fiber first to prevent duplicates.
2. **Stuck queue detection**: If there are queued items with nothing inflight for 2 consecutive heartbeats (and the executor is not paused and is online), the executor's worker fibers are verified and restarted if dead via `ensureWorkers()`, then resumed to unblock processing. This handles cases where worker fibers may have silently died.
3. **Stream stall detection**: If the stream fiber is alive but hasn't processed any events while upstream head has advanced beyond the last processed cursor, and the stall threshold has been exceeded, the stream is restarted. This handles the case where the stream is technically alive but no longer advancing. See [STABILITY.md](./STABILITY.md) for details.

Recovery actions emit a `sync:heartbeat-recovery` event with a `reason` field (`"stream-dead"`, `"stuck-queue"`, or `"stream-stalled"`).

| Event | Fields | Description |
|-------|--------|-------------|
| `sync:heartbeat-recovery` | `reason` | Heartbeat detected and recovered a dead stream, stuck queue, or stalled stream |

## Download Prioritization

When syncing files from remote storage, the default behavior downloads all files in FIFO order.
However, applications often need to prioritize visible/needed files over background downloads.
FileSync provides automatic and manual prioritization mechanisms.

### Automatic Prioritization

By default, when `resolveFileUrl(fileId)` is called for a file that's queued for download,
that file is automatically moved to the front of the download queue. This means files that
are being displayed get downloaded first.

```typescript
// When rendering a gallery, visible images get priority automatically
const ImageCard = ({ file }) => {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    // This call automatically prioritizes the download if queued
    resolveFileUrl(file.id).then(setUrl)
  }, [file.id])

  return <img src={url ?? placeholderUrl} />
}
```

This behavior can be disabled via configuration:

```typescript
initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    autoPrioritizeOnResolve: false  // Disable auto-prioritization
  }
})
```

### Manual Prioritization

For cases where you want explicit control (e.g., preloading the next page), use
`prioritizeDownload()`:

```typescript
import { prioritizeDownload } from '@livestore-filesync/core'

// Preload files for the next page while user is on current page
const preloadNextPage = (fileIds: string[]) => {
  for (const id of fileIds) {
    prioritizeDownload(id)
  }
}
```

### Implementation Details

The download queue uses a two-queue priority system:

1. **High priority queue**: Processed first, populated by `prioritizeDownload()` calls
2. **Normal queue**: Standard FIFO queue, populated by the sync reconciliation loop

The worker always drains the high priority queue before processing the normal queue.
Deduplication ensures files aren't downloaded twice if they appear in both queues.

When prioritizing a file:
- If the file is already downloaded or in-flight, the call is a no-op
- If the file is already in the high priority queue, the call is a no-op
- If the file is in the normal queue, it's added to the high priority queue
  (the normal queue entry is skipped later via deduplication)

This approach provides O(1) prioritization without rebuilding the queue.

## Image Thumbnails Package (Optional)

The `@livestore-filesync/image` package provides client-side thumbnail generation as an
optional enhancement to FileSync. It uses wasm-vips in a dedicated web worker for high-quality
image resizing.

### Key Design Decisions

1. **Thumbnails are not synced**: Each client generates its own thumbnails locally. This avoids
   network traffic and allows different clients to have different size configurations.

2. **Leader-only generation**: Like FileSync, only the leader tab runs the thumbnail generation
   worker. This prevents duplicate work when multiple tabs are open.

3. **Content-hash based storage**: Thumbnails are stored at `thumbnails/{contentHash}/{sizeName}.{format}`.
   This means if two files have identical content, they share the same thumbnails.

4. **State in SQLite tables**: Thumbnail generation state is stored in `thumbnailState` and
   `thumbnailConfig` tables via client-only events. This persists across page refreshes, syncs
   across local tabs, and avoids Schema.Record rebase conflicts.

5. **Batched scan writes**: On startup and periodic scans, `ThumbnailService` reads existing
   `thumbnailState` rows for skip decisions, collects only changed per-file `thumbnailStateUpsert`
   writes in memory, commits them in a single transaction, then enqueues generation work. This
   reduces sync queue churn and avoids stale queued-state writes racing with generation updates.

### Services

- `ThumbnailWorkerClient`: Effect-based wrapper for worker communication with request/response
  correlation, timeouts, and cleanup.

- `LocalThumbnailStorage`: Stores/retrieves thumbnails from OPFS using the same `FileSystem`
  adapter as the core package.

- `ThumbnailService`: Main orchestration service. Watches files table, queues generation jobs,
  stores results, updates state, and handles cleanup.

### Layer Dependency Graph

```text
[FileSystemLive (user-provided)] -----------+
                                            |
                                            v
[ThumbnailWorkerClientLive(workerUrl)] ----+
                                            |
                                            v
[LocalThumbnailStorageLive] <----- Layer.provide(FileSystemLive)
                                            |
                                            v
[ThumbnailServiceLive(store, tables, events, config)] <--- Layer.provide(BaseLayer)
```

### API Usage

Like the core package, the thumbnails package provides both singleton and instance APIs:

**Singleton (recommended):**

```typescript
import { initThumbnails, resolveThumbnailUrl } from '@livestore-filesync/image/thumbnails'
import { tables } from './schema'

initThumbnails(store, {
  sizes: { small: 128, medium: 256 },
  format: 'webp',
  fileSystem: opfsLayer(),
  workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
  schema: { tables }
})

const url = await resolveThumbnailUrl(fileId, 'small')
```

**Instance:**

```typescript
import { createThumbnails } from '@livestore-filesync/image/thumbnails'

const thumbnails = createThumbnails({
  store,
  tables: thumbnailSchema.tables,
  events: thumbnailSchema.events,
  fileSystem: opfsLayer(),
  workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
  sizes: { small: 128, medium: 256 }
})

thumbnails.start()
const url = await thumbnails.resolveThumbnailUrl(fileId, 'small')
```

### Worker Setup

Applications must create their own worker file that imports the package's worker entry point:

```typescript
// thumbnail.worker.ts
import '@livestore-filesync/image/thumbnails/worker'
```

This approach allows the bundler (Vite, Webpack, etc.) to handle WASM loading and worker creation
correctly for the target environment.
