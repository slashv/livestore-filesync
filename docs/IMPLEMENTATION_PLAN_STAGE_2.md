# Stage 2

## Simplify framework adapters

The current Vue and React adapters re-implement way too much custom code. These should be super light. The only component they should really need to implement is the FileSyncProvider and even that should be extremely light weight. If you look at vue-livestore-filesync/src/components/file-sync-provider.vue you can see how simple it is for Vue.

We do not want any custom composables / hooks. The only methods that we should need and that should be imported from the core library are saveFile, deleteFile, updateFile and readFile. For now we don't want any additional logic around these, instead in the examples we can use a similar strategy to how we do it in vue-livestore-filesync/src/components/images.vue

The framework adapters should not need to use Effect. The example applications should definately not use Effect.

## Simplify the example apps

Keep these as simple as realistically possible. Using the patterns we developed in the vue-livestore-filesync reference implementation is a good start. If we can simplify even further that would be good.

## Include Cloudflare remote storage endpoints import

In the reference implementation we have vue-livestore-filesync/src/workers/cloudflare-sync.ts which combines the regular LiveStore sync backend worker with a set of storage endpoints. For apps that use this package we should provide an import so that they can easily add these endpoints to their existing cloudflare worker.

--------

# Implementation Plan

## Overview

Move sync orchestration from framework adapters to core, expose promise-based API, and create Cloudflare package.

**Current State → Target State:**
| Package | Current Lines | Target Lines |
|---------|---------------|--------------|
| Vue Adapter | 1,213 | ~80 |
| React Adapter | 1,036 | ~90 |
| Cloudflare | N/A | ~200 (new) |

---

## Phase 1: Core Package - New `createFileSync()` API

### New Files

**`packages/core/src/api/createFileSync.ts`**

```typescript
export interface FileSyncConfig {
  store: FileSyncStore
  schema: FileSyncSchema
  remote: { baseUrl: string; authHeaders?: () => HeadersInit }
  options?: {
    maxConcurrentDownloads?: number
    maxConcurrentUploads?: number
    onEvent?: (e: FileSyncEvent) => void
  }
}

export interface FileSyncStore {
  query: <T>(q: unknown) => T
  commit: (event: unknown) => void
  subscribe: (q: unknown, opts: { onUpdate: (result: unknown) => void }) => () => void
}

export interface FileSyncInstance {
  start: () => void
  stop: () => void
  saveFile: (file: File) => Promise<{ fileId: string; path: string; contentHash: string }>
  updateFile: (fileId: string, file: File) => Promise<{ fileId: string; path: string; contentHash: string }>
  deleteFile: (fileId: string) => Promise<void>
  readFile: (path: string) => Promise<File>
  getFileUrl: (path: string) => Promise<string | null>
  isOnline: () => boolean
}

export function createFileSync(config: FileSyncConfig): FileSyncInstance
```

**Implementation:** Port logic from:
- `vue-livestore-filesync/src/services/file-sync.ts` - Two-pass reconciliation, queue management, connectivity
- `vue-livestore-filesync/src/services/file-storage.ts` - saveFile, updateFile, deleteFile

Use Effect internally, expose Promise API via ManagedRuntime.

**`packages/core/src/api/httpAdapter.ts`** - Built-in HTTP adapter for remote storage.

### Tasks
- [ ] Create `createFileSync.ts` with FileSyncInstance implementation
- [ ] Create `httpAdapter.ts` for remote storage
- [ ] Update `packages/core/src/index.ts` exports
- [ ] Add tests for new API

---

## Phase 2: Simplified Vue Adapter

### New Structure (~80 lines total)
```
packages/vue/src/
  index.ts              (~15 lines)
  FileSyncProvider.vue  (~45 lines)
  context.ts            (~20 lines)
```

### FileSyncProvider.vue
```vue
<script setup lang="ts">
import { onMounted, onUnmounted, provide } from 'vue'
import { useStore } from 'vue-livestore'
import { createFileSync } from '@livestore-filesync/core'
import { FileSyncKey } from './context'

const props = defineProps<{
  schema: any
  remoteUrl: string
  authHeaders?: () => HeadersInit
}>()

const { store } = useStore()
const fileSync = createFileSync({
  store,
  schema: props.schema,
  remote: { baseUrl: props.remoteUrl, authHeaders: props.authHeaders }
})

provide(FileSyncKey, fileSync)
onMounted(() => fileSync.start())
onUnmounted(() => fileSync.stop())
</script>

<template><slot /></template>
```

### Tasks
- [ ] Create `FileSyncProvider.vue` (new simple component)
- [ ] Create `context.ts` (provide/inject)
- [ ] Rewrite `index.ts` (minimal exports)
- [ ] Delete `FileSyncProvider.ts` (777 lines)
- [ ] Delete `composables.ts` (228 lines)
- [ ] Simplify or delete `types.ts`

---

## Phase 3: Simplified React Adapter

### New Structure (~90 lines total)
```
packages/react/src/
  index.ts              (~15 lines)
  FileSyncProvider.tsx  (~55 lines)
  context.tsx           (~20 lines)
```

### FileSyncProvider.tsx
```tsx
import { createContext, useContext, useEffect, useMemo } from 'react'
import { useStore } from '@livestore/react'
import { createFileSync, type FileSyncInstance } from '@livestore-filesync/core'

const FileSyncContext = createContext<FileSyncInstance | null>(null)

export function FileSyncProvider({ children, schema, remoteUrl, authHeaders }) {
  const { store } = useStore()
  const fileSync = useMemo(() => createFileSync({
    store, schema,
    remote: { baseUrl: remoteUrl, authHeaders }
  }), [store, schema, remoteUrl])

  useEffect(() => { fileSync.start(); return () => fileSync.stop() }, [fileSync])

  return <FileSyncContext.Provider value={fileSync}>{children}</FileSyncContext.Provider>
}

export const useFileSync = () => {
  const ctx = useContext(FileSyncContext)
  if (!ctx) throw new Error('useFileSync must be used within FileSyncProvider')
  return ctx
}
```

### Tasks
- [ ] Rewrite `FileSyncProvider.tsx` (~55 lines)
- [ ] Create `context.tsx` (Context + hook)
- [ ] Rewrite `index.ts` (minimal exports)
- [ ] Delete `hooks.ts` (216 lines)
- [ ] Simplify or delete `types.ts`

---

## Phase 4: New `@livestore-filesync/cloudflare` Package

### Structure
```
packages/cloudflare/
  package.json
  tsconfig.json
  src/
    index.ts        - Main exports
    handler.ts      - createFileSyncHandler()
    routes/
      upload.ts
      download.ts
      delete.ts
      health.ts
    utils/
      cors.ts
      auth.ts
    types.ts
```

### API
```typescript
export function createFileSyncHandler(config?: {
  basePath?: string       // default: '/api'
  bucketBinding?: string  // default: 'FILE_BUCKET'
  authTokenEnv?: string   // default: 'WORKER_AUTH_TOKEN'
}): (request: Request, env: FileSyncEnv) => Promise<Response | null>
```

### Usage
```typescript
import { createFileSyncHandler } from '@livestore-filesync/cloudflare'
import { makeWorker } from '@livestore/sync-cf/cf-worker'

const fileSyncHandler = createFileSyncHandler()
const livestoreWorker = makeWorker({ ... })

export default {
  async fetch(request, env, ctx) {
    const fileResponse = await fileSyncHandler(request, env)
    if (fileResponse) return fileResponse
    return livestoreWorker.fetch(request, env, ctx)
  }
}
```

### Tasks
- [ ] Create package structure and package.json
- [ ] Implement `createFileSyncHandler()` (port from `vue-livestore-filesync/src/workers/cloudflare-sync.ts`)
- [ ] Add to workspace in root package.json

---

## Phase 5: Simplify Example Apps

### Vue Example
Remove Effect imports and complex adapter setup:
```vue
<FileSyncProvider :schema="fileSyncSchema" remote-url="/api">
  <Gallery />
</FileSyncProvider>
```

### React Example
Same pattern - simple props, no Effect.

### Tasks
- [ ] Simplify Vue example app
- [ ] Simplify React example app
- [ ] Test both examples end-to-end

---

## Implementation Order

1. Core: `createFileSync()` API
2. Vue adapter simplification
3. React adapter simplification
4. Cloudflare package
5. Example apps
6. Final testing

## Key Reference Files

**Port logic from:**
- `vue-livestore-filesync/src/services/file-sync.ts` (302 lines)
- `vue-livestore-filesync/src/services/file-storage.ts` (57 lines)
- `vue-livestore-filesync/src/workers/cloudflare-sync.ts` (154 lines)

**Delete:**
- `packages/vue/src/FileSyncProvider.ts` (777 lines)
- `packages/vue/src/composables.ts` (228 lines)
- `packages/react/src/hooks.ts` (216 lines)