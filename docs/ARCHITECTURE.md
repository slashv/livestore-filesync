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
- `LocalFileStateManager`: centralized manager for all `localFilesState` mutations. Uses an internal
  lock to ensure atomic read-modify-write operations, preventing race conditions when multiple
  concurrent operations try to update the state. All state changes go through this service.
- `RemoteStorage`: remote storage abstraction for upload/download/delete/health checks.
  The built-in implementation is signer-backed and targets S3-compatible object storage via a signer
  API (`GET /health`, `POST /v1/sign/upload`, `POST /v1/sign/download`, `POST /v1/delete`) that mints
  short-lived URLs. Alternative backends are still possible by supplying a custom `RemoteStorageAdapter`.
- `SyncExecutor`: manages upload/download queues with concurrency limits and retry/backoff logic.
- `FileSync`: orchestration service. Tracks online state, reconciles LiveStore file records with
  local state, schedules transfers through `SyncExecutor`, updates remote URLs, and runs GC/health
  checks. Uses `LocalFileStateManager` for all state mutations.
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
[FileStorageLive(deps)] <--------- Layer.provide(mergeAll(BaseLayer, FileSyncLayer))
                                            |
                                            v
[MainLayer] = mergeAll(BaseLayer, FileSyncLayer, FileStorageLayer)

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
  getFileUrl,
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
const url = await getFileUrl(result.fileId)

// Cleanup on app unmount
stopFileSync()
await disposeFileSync()
```

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
const url = await fileSync.getFileUrl(result.fileId)

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
client document tracking what each client has locally.

### getFileDisplayState

```typescript
import { getFileDisplayState } from '@livestore-filesync/core'

const displayState = getFileDisplayState(file, localFilesState)

// displayState contains:
// - canDisplay: boolean  - true if file is available (local copy OR remote)
// - hasLocalCopy: boolean - true if local hash matches file's content hash
// - isUploaded: boolean   - true if remoteKey is set
// - isUploading: boolean  - true if upload is in progress/queued
// - isDownloading: boolean - true if download is in progress/queued
```

### UI Pattern

```tsx
// React example
const [localFileState] = store.useClientDocument(tables.localFileState)
const { canDisplay, isUploading } = getFileDisplayState(file, localFileState?.localFiles ?? {})

return canDisplay
  ? <img src={`/${file.path}`} />
  : <Placeholder>{isUploading ? 'Uploading...' : 'Waiting...'}</Placeholder>
```

This ensures:
- Originating client displays immediately (has local copy)
- Other clients show placeholder until upload completes
- Correct version is displayed after edits (hash comparison)

## Multi-Tab Coordination

In browser environments, multiple tabs may be open to the same LiveStore store. LiveStore uses a
SharedWorker and Web Locks API to elect a single "leader" tab that runs the SQLite database.
Non-leader tabs proxy their operations through the SharedWorker.

**FileSync follows this same pattern**: only the leader tab runs the sync loop. This prevents
race conditions where multiple tabs try to reconcile state, enqueue transfers, and update
`localFileState` simultaneously.

### How It Works

1. **Leader Election**: LiveStore's `ClientSession` exposes a `lockStatus` SubscriptionRef that
   indicates whether the current tab holds the leader lock (`'has-lock'` or `'no-lock'`).

2. **Leader-Only Sync Loop**: The `FileSync` service subscribes to `lockStatus.changes`:
   - When a tab becomes leader, it starts the sync loop (subscribes to file changes, reconciles
     state, enqueues transfers)
   - When a tab loses leadership, it stops the sync loop

3. **All Tabs Can Still Operate**: Non-leader tabs can still call `saveFile`, `updateFile`, and
   `deleteFile`. These operations commit events to LiveStore, which syncs them to the leader tab
   via the SharedWorker. The leader's sync loop then handles the actual upload/download.

### Implementation Details

The `FileSync` service tracks leadership state with:
- `isLeaderRef`: Whether this tab is currently the leader
- `leaderWatcherFiberRef`: Background fiber watching for leadership changes

```typescript
// Simplified flow
const watchLeadership = () =>
  clientSession.lockStatus.changes.pipe(
    Stream.tap((status) => {
      if (status === 'has-lock' && !wasLeader) {
        // Became leader - start sync loop
        startSyncLoop()
      } else if (status === 'no-lock' && wasLeader) {
        // Lost leadership - stop sync loop
        stopSyncLoop()
      }
    }),
    Stream.runDrain
  )
```

This ensures:
- No duplicate sync operations across tabs
- Automatic failover when the leader tab closes
- Consistent state management via the leader's sync loop

## Sync Status

The `getSyncStatus()` utility derives aggregate sync status from the `localFileState` client document.
Since `localFileState` is reactive via LiveStore, applications can subscribe to it and compute
sync status on each update.

### getSyncStatus

```typescript
import { getSyncStatus } from '@livestore-filesync/core'

// The function takes the localFiles map and returns aggregate status
const status = getSyncStatus(localFilesState)

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

function SyncIndicator() {
  const [localFileState] = store.useClientDocument(tables.localFileState)
  const status = getSyncStatus(localFileState?.localFiles ?? {})

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
import { useClientDocument } from 'vue-livestore'
import { getSyncStatus } from '@livestore-filesync/core'
import { tables } from './schema'

const localFileState = useClientDocument(tables.localFileState)
const syncStatus = computed(() => getSyncStatus(localFileState.value?.localFiles ?? {}))
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
  queryDb(tables.localFileState.get()),
  (state) => {
    const status = getSyncStatus(state.localFiles)
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

## Download Prioritization

When syncing files from remote storage, the default behavior downloads all files in FIFO order.
However, applications often need to prioritize visible/needed files over background downloads.
FileSync provides automatic and manual prioritization mechanisms.

**Important:** Download prioritization only works with the `resolveFileUrl()` approach, not with
the service worker approach. The service worker operates independently and fetches files on-demand
when the browser requests them, bypassing the download queue entirely.

### Automatic Prioritization (resolveFileUrl only)

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

### Service Worker vs resolveFileUrl

The two URL resolution approaches have different download behaviors:

| Aspect | Service Worker | resolveFileUrl() |
|--------|----------------|------------------|
| **Download trigger** | On-demand when browser requests file | Background sync loop |
| **Prioritization** | N/A (immediate fetch) | Yes (queue-based) |
| **Queue integration** | None (bypasses queue) | Full integration |
| **Best for** | Simple apps, immediate display | Large galleries, controlled loading |

If you need download prioritization (e.g., for a photo gallery where visible images should
load first), use `resolveFileUrl()`. If you prefer simpler component code and don't need
queue control, use the service worker.

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
