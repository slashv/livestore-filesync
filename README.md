# Livestore-Filesync

Local-first file sync for LiveStore apps. Files write to OPFS first, are content-addressable by SHA-256, and sync to any HTTP backend in the background. Initialize once with the core singleton helpers and import file operations anywhere.

What you use:
- Core singleton helpers (`initFileSync`, `saveFile`, `readFile`, etc.)
- Schema helper to add file tables/events/materializers to your LiveStore schema
- File system adapters: `@livestore-filesync/opfs` for browsers, `@effect/platform-node` for Node
- Service worker helper to serve `/livestore-filesync-files/*` from OPFS before falling back to remote

## Packages

- `@livestore-filesync/core` — framework-agnostic API, schema helper, service worker utilities
- `@livestore-filesync/opfs` — OPFS filesystem layer for browsers (implements `@effect/platform` FileSystem)
- `@livestore-filesync/cf-worker-utils` — Cloudflare Worker composition helpers (e.g. route handler composition, dev R2 signer/data-plane)
- `@livestore-filesync/s3-signer` — lightweight S3-compatible signer Worker

## Install

```bash
# Web app (React/Vue/etc)
pnpm add @livestore-filesync/core @livestore-filesync/opfs @livestore/livestore @effect/platform effect

# Node
pnpm add @livestore-filesync/core @effect/platform @effect/platform-node @livestore/livestore effect
```

## How it works (short version)

- Files are stored locally in OPFS and named by SHA-256 so duplicates collapse automatically.
- Remote sync is **key-based** and uses a **signer** to mint short-lived URLs against an S3-compatible object store (for upload/download) and to perform deletes.
- Schema helper adds a `files` table plus local-only state; you merge it with your own tables/events.
- Service worker helper can proxy `/livestore-filesync-files/*` to OPFS before falling back to remote; alternatively the UI can call `resolveFileUrl(fileId)` to get a usable URL without relying on the service worker.

## React quick start (see `examples/react-filesync`)

1) Extend your schema with the bundled file sync tables/events:

```typescript
import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { createFileSyncSchema } from '@livestore-filesync/core/schema'

const fileSyncSchema = createFileSyncSchema()

const uiState = State.SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({
    selectedFileId: Schema.optional(Schema.String),
    isUploading: Schema.Boolean,
    online: Schema.Boolean
  }),
  default: { id: SessionIdSymbol, value: { selectedFileId: undefined, isUploading: false, online: true } }
})

export const tables = { ...fileSyncSchema.tables, uiState }
export const events = { ...fileSyncSchema.events, uiStateSet: uiState.set }

const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})

const state = State.SQLite.makeState({ tables, materializers })
export const schema = makeSchema({ events, state })
export const SyncPayload = Schema.Struct({ authToken: Schema.String })
```

2) Wire LiveStore and initialize FileSync once:

```tsx
import { useEffect } from 'react'
import { LiveStoreProvider, useStore } from '@livestore/react'
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import LiveStoreWorker from './livestore.worker.ts?worker'
import { initFileSync, startFileSync, stopFileSync, disposeFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { schema, SyncPayload } from './livestore/schema'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker
})
const authToken = import.meta.env.VITE_AUTH_TOKEN
const headers = { Authorization: `Bearer ${authToken}` }

const FileSyncProvider = ({ children }) => {
  const { store } = useStore()

  initFileSync(store, {
    fileSystem: opfsLayer(),
    remote: { signerBaseUrl: '/api', headers }
  })

  useEffect(() => {
    startFileSync()
    return () => {
      stopFileSync()
      void disposeFileSync()
    }
  }, [store])

  return children
}

<LiveStoreProvider
  schema={schema}
  adapter={adapter}
  storeId="react_filesync_store"
  syncPayloadSchema={SyncPayload}
  syncPayload={{ authToken }}
>
  <FileSyncProvider>
    <Gallery />
  </FileSyncProvider>
</LiveStoreProvider>
```

3) Use the sync API anywhere after initialization:

```tsx
import { saveFile, getFileUrl } from '@livestore-filesync/core'
import { useStore } from '@livestore/react'
import { queryDb } from '@livestore/livestore'
import { tables } from './livestore/schema'

const { store } = useStore()
const files = store.useQuery(queryDb(tables.files.where({ deletedAt: null })))

const onFile = async (file: File) => {
  const result = await saveFile(file)
  const url = await getFileUrl(result.fileId)
  console.log({ result, url })
}
```

## Vue quick start (see `examples/vue-filesync`)

1) Extend schema (same pattern as React):

```typescript
import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { createFileSyncSchema } from '@livestore-filesync/core/schema'

const fileSyncSchema = createFileSyncSchema()

const uiState = State.SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({
    selectedFileId: Schema.optional(Schema.String),
    isUploading: Schema.Boolean,
    online: Schema.Boolean
  }),
  default: { id: SessionIdSymbol, value: { selectedFileId: undefined, isUploading: false, online: true } }
})

export const tables = { ...fileSyncSchema.tables, uiState }
export const events = { ...fileSyncSchema.events, uiStateSet: uiState.set }
const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})
const state = State.SQLite.makeState({ tables, materializers })
export const schema = makeSchema({ events, state })
```

2) Create a local FileSyncProvider component:

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { initFileSync, startFileSync, stopFileSync, disposeFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const props = defineProps<{ headers?: Record<string, string>; authToken?: string }>()

const { store } = useStore()

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api', headers: props.headers, authToken: props.authToken }
})

onMounted(() => startFileSync())
onUnmounted(() => {
  stopFileSync()
  void disposeFileSync()
})
</script>

<template>
  <slot />
</template>
```

3) Use the sync API:

```vue
<script setup lang="ts">
import { saveFile, getFileUrl } from '@livestore-filesync/core'

const save = async (file: File) => {
  const result = await saveFile(file)
  const url = await getFileUrl(result.fileId)
  console.log({ result, url })
}
</script>
```

## Node.js usage (see `examples/node-filesync`)

For Node.js, use `@effect/platform-node` directly as the filesystem adapter:

```typescript
import { NodeFileSystem } from '@effect/platform-node'
import { createFileSync } from '@livestore-filesync/core'
import { queryDb } from '@livestore/livestore'
import { tables, events } from './schema'

const fileSync = createFileSync({
  store,
  schema: { tables, events, queryDb },
  fileSystem: NodeFileSystem.layer,
  remote: { signerBaseUrl: 'https://api.example.com' }
})

fileSync.start()
const result = await fileSync.saveFile(file)
await fileSync.stop()
```

## Extending the schema (framework agnostic)

`createFileSyncSchema` (from `@livestore-filesync/core/schema`) returns `{ tables, events, createMaterializers }`. Merge `tables` and `events` into your app schema and pass `createMaterializers(tables)` into `State.SQLite.materializers`. This is the same pattern shown in both example apps and works in any LiveStore runtime.

## Service worker helper

Use `@livestore-filesync/core/worker` to serve cached files and prefetch:

```typescript
// sw.ts
import { initFileSyncServiceWorker } from '@livestore-filesync/core/worker'

initFileSyncServiceWorker({
  pathPrefix: '/livestore-filesync-files/',
  cacheRemoteResponses: true,
  getRemoteUrl: async (path) => `https://cdn.example.com/${path}`
})
```

Register from the main thread:

```typescript
import { registerFileSyncServiceWorker, prefetchFiles } from '@livestore-filesync/core/worker'

await registerFileSyncServiceWorker({ scriptUrl: '/sw.js' })
await prefetchFiles(['/livestore-filesync-files/example'])
```

## Core API (singleton or instance)

Singleton helpers (recommended for apps with a single store):

```typescript
import { initFileSync, startFileSync, saveFile } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: 'https://api.example.com/api' }
})
startFileSync()
const result = await saveFile(file)
```

Create a dedicated instance when you need multiple stores or custom wiring:

```typescript
import { createFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { queryDb } from '@livestore/livestore'

const fileSync = createFileSync({
  store,
  schema: { tables, events, queryDb },
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: 'https://api.example.com/api', headers: { Authorization: `Bearer ${token}` } }
})

fileSync.start()
const result = await fileSync.saveFile(file)
await fileSync.stop()
```

## Sync backend configuration (S3-compatible)

`@livestore-filesync/core` expects a **signer service** to mint short-lived URLs (and delete objects) for any S3-compatible backend (AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2 S3 API, etc.).

### Client config (web app)

Pass the signer base URL to `initFileSync` / `createFileSync`:

```ts
import { layer as opfsLayer } from '@livestore-filesync/opfs'

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: {
    signerBaseUrl: "/api",
    authToken: import.meta.env.VITE_AUTH_TOKEN
  }
})
```

### Signer API contract

Your signer must implement:
- `GET /health`
- `POST /v1/sign/upload` `{ key, contentType?, contentLength? } -> { method, url, headers?, expiresAt }`
- `POST /v1/sign/download` `{ key } -> { url, headers?, expiresAt }`
- `POST /v1/delete` `{ key } -> 204`

### Default server-side helpers in this repo

- `@livestore-filesync/s3-signer`: a lightweight Worker intended to be deployed as the **production signer** for any S3-compatible backend (mints real presigned URLs).
- `@livestore-filesync/cf-worker-utils`: small Cloudflare Worker composition helpers. It includes `createFilesyncR2DevHandler(...)` which is convenient for **local dev** when you have an `R2Bucket` binding (it exposes the signer routes under `/api/*` and serves the file data plane under `/livestore-filesync-files/*`).

## Requirements

- Browser with OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+) for `@livestore-filesync/opfs`
- Effect 3.x
- @effect/platform 0.92+

## License

MIT
