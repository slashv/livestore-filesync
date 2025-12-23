# livestore-filesync

Local-first file sync for LiveStore apps. Files write to OPFS first, are content-addressable by SHA-256, and sync to any HTTP backend in the background. React and Vue adapters start sync when mounted and expose the same API you get from the core package.

What you use:
- Providers for React and Vue with `useFileSync`
- Schema helper to add file tables/events/materializers to your LiveStore schema
- File system adapters for web (OPFS) and Node
- Service worker helper to serve `/files/*` from OPFS before falling back to remote

## Packages

- `@livestore-filesync/core` — framework-agnostic API, schema helper, service worker utilities
- `@livestore-filesync/react` — React provider + schema preset
- `@livestore-filesync/vue` — Vue provider + schema preset
- `@livestore-filesync/adapter-web` — OPFS filesystem layer for browsers
- `@livestore-filesync/adapter-node` — filesystem layer for Node/CLI tooling

## Install

```bash
# React (web)
pnpm add @livestore-filesync/react @livestore-filesync/adapter-web @livestore/react @livestore/adapter-web @livestore/livestore effect

# Vue (web)
pnpm add @livestore-filesync/vue @livestore-filesync/adapter-web vue-livestore @livestore/adapter-web @livestore/livestore effect

# Core only (headless usage or custom runtime)
pnpm add @livestore-filesync/core effect
```

## How it works (short version)

- Files are stored locally in OPFS and named by SHA-256 so duplicates collapse automatically.
- Remote sync uses simple HTTP endpoints under `remoteUrl` with optional `authHeaders`.
- Schema helper adds a `files` table plus local-only state; you merge it with your own tables/events.
- Service worker helper can proxy `/files/*` to OPFS before hitting remote storage.

## React quick start (see `examples/react-filesync`)

1) Extend your schema with the bundled file sync tables/events:

```typescript
import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { fileSyncSchema } from '@livestore-filesync/react/schema'

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

2) Wire LiveStore and FileSync providers:

```tsx
import { LiveStoreProvider } from '@livestore/react'
import { FileSyncProvider } from '@livestore-filesync/react'
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import LiveStoreWorker from './livestore.worker.ts?worker'
import { makeAdapter as makeFileSystemAdapter } from '@livestore-filesync/adapter-web'
import { schema, SyncPayload } from './livestore/schema'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker
})
const fileSystem = makeFileSystemAdapter()
const authToken = import.meta.env.VITE_AUTH_TOKEN
const getAuthHeaders = () => ({ Authorization: `Bearer ${authToken}` })

<LiveStoreProvider
  schema={schema}
  adapter={adapter}
  storeId="react_filesync_store"
  syncPayloadSchema={SyncPayload}
  syncPayload={{ authToken }}
>
  <FileSyncProvider fileSystem={fileSystem} authHeaders={getAuthHeaders} remoteUrl="/api/files">
    <Gallery />
  </FileSyncProvider>
</LiveStoreProvider>
```

3) Use the sync API anywhere under the provider:

```tsx
import { useFileSync } from '@livestore-filesync/react'
import { useStore } from '@livestore/react'
import { queryDb } from '@livestore/livestore'
import { tables } from './livestore/schema'

const fileSync = useFileSync()
const { store } = useStore()
const files = store.useQuery(queryDb(tables.files.where({ deletedAt: null })))

const onFile = async (file: File) => {
  const result = await fileSync.saveFile(file)
  const url = await fileSync.getFileUrl(result.path)
  console.log({ result, url })
}
```

## Vue quick start (see `examples/vue-filesync`)

1) Extend schema (same pattern as React):

```typescript
import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { fileSyncSchema } from '@livestore-filesync/vue'

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

2) Wire providers:

```vue
<script setup lang="ts">
import { LiveStoreProvider } from 'vue-livestore'
import { FileSyncProvider } from '@livestore-filesync/vue'
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import LiveStoreWorker from './livestore.worker.ts?worker'
import { makeAdapter as makeFileSystemAdapter } from '@livestore-filesync/adapter-web'
import { schema } from './livestore/schema'

const adapter = makePersistedAdapter({ storage: { type: 'opfs' }, worker: LiveStoreWorker, sharedWorker: LiveStoreSharedWorker })
const fileSystem = makeFileSystemAdapter()
const authToken = import.meta.env.VITE_AUTH_TOKEN
const storeOptions = { schema, adapter, storeId: 'vue_filesync_store', syncPayload: { authToken } }
const getAuthHeaders = () => ({ Authorization: `Bearer ${authToken}` })
</script>

<template>
  <LiveStoreProvider :options="storeOptions">
    <FileSyncProvider :file-system="fileSystem" :auth-headers="getAuthHeaders" remote-url="/api/files">
      <Gallery />
    </FileSyncProvider>
  </LiveStoreProvider>
</template>
```

3) Use the sync API:

```vue
<script setup lang="ts">
import { useFileSync } from '@livestore-filesync/vue'

const fileSync = useFileSync()
const save = async (file: File) => {
  const result = await fileSync.saveFile(file)
  const url = await fileSync.getFileUrl(result.path)
  console.log({ result, url })
}
</script>
```

## Extending the schema (framework agnostic)

`createFileSyncSchema` (from `@livestore-filesync/core/schema`) returns `{ tables, events, createMaterializers }`. Merge `tables` and `events` into your app schema and pass `createMaterializers(tables)` into `State.SQLite.materializers`. This is the same pattern shown in both example apps and works in any LiveStore runtime.

## Service worker helper

Use `@livestore-filesync/core/worker` to serve cached files and prefetch:

```typescript
// sw.ts
import { initFileSyncServiceWorker } from '@livestore-filesync/core/worker'

initFileSyncServiceWorker({
  pathPrefix: '/files/',
  cacheRemoteResponses: true,
  getRemoteUrl: async (path) => `https://cdn.example.com/files/${path}`
})
```

Register from the main thread:

```typescript
import { registerFileSyncServiceWorker, prefetchFiles } from '@livestore-filesync/core/worker'

await registerFileSyncServiceWorker({ scriptUrl: '/sw.js' })
await prefetchFiles(['/files/example'])
```

## Core API (headless usage)

You can skip the React/Vue providers and call the core factory directly:

```typescript
import { createFileSync } from '@livestore-filesync/core'
import { queryDb } from '@livestore/livestore'

const fileSync = createFileSync({
  store,
  schema: { tables, events, queryDb },
  remote: { baseUrl: 'https://api.example.com/files', authHeaders: () => ({ Authorization: `Bearer ${token}` }) }
})

fileSync.start()
const result = await fileSync.saveFile(file)
await fileSync.stop()
```

## Remote storage expectations

Default remote adapter issues HTTP calls against `remoteUrl`:
- `POST /files` with file body returns `{ id, path, contentHash, remoteUrl? }`
- `GET /files/:id` returns file body
- `DELETE /files/:id` removes remote file

Swap in your own HTTP endpoint or adapter if those routes differ.

## Requirements

- Browser with OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+) for the web adapters
- Effect 3.x

## License

MIT
