import { makePersistedAdapter } from "@livestore/adapter-web"
import LiveStoreSharedWorker from "@livestore/adapter-web/shared-worker?sharedworker"
import { storeOptions, StoreRegistry } from "@livestore/livestore"
import { StoreRegistryProvider } from "@livestore/react"
import { unstable_batchedUpdates as batchUpdates } from "react-dom"

import { FileSyncProvider } from "./components/FileSyncProvider.tsx"
import { Gallery } from "./components/Gallery.tsx"
import { SyncStatus } from "./components/SyncStatus.tsx"
import LiveStoreWorker from "./livestore.worker.ts?worker"
import { schema, SyncPayload } from "./livestore/schema.ts"

// Allow storeId to be set via query param for testing isolation
const urlParams = new URLSearchParams(window.location.search)
// Bump default storeId when schema changes to avoid loading an incompatible persisted db in dev.
const storeId = urlParams.get("storeId") || "react_thumbnail_store_v2"

const adapter = makePersistedAdapter({
  storage: { type: "opfs" },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker
})

const authToken = import.meta.env.VITE_AUTH_TOKEN as string

const syncPayload = { authToken }

// Auth headers for file sync API
const getAuthHeaders = () => ({
  Authorization: `Bearer ${authToken}`
})

const storeRegistry = new StoreRegistry({ defaultOptions: { batchUpdates } })

// Thumbnail worker URL - Vite handles bundling (uses canvas processor)
const thumbnailWorkerUrl = new URL("./thumbnail.worker.ts", import.meta.url)

export const reactStoreOptions = storeOptions({
  schema,
  adapter,
  storeId,
  syncPayloadSchema: SyncPayload,
  syncPayload
})

export const App = () => (
  <StoreRegistryProvider storeRegistry={storeRegistry}>
    <FileSyncProvider
      authHeaders={getAuthHeaders}
      authToken={authToken}
      thumbnails={{ workerUrl: thumbnailWorkerUrl, sizes: { small: 256, medium: 512, large: 1024 }, format: "webp" }}
    >
      <div className="app-layout">
        <div className="main">
          <Gallery />
        </div>
        <SyncStatus />
      </div>
    </FileSyncProvider>
  </StoreRegistryProvider>
)
