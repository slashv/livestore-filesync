import { makePersistedAdapter } from "@livestore/adapter-web"
import { useStore } from "@livestore/react"
import { unstable_batchedUpdates as batchUpdates } from "react-dom"

import LiveStoreSharedWorker from "../livestore.shared-worker.ts?sharedworker"
import LiveStoreWorker from "../livestore.worker.ts?worker"
import { schema, SyncPayload } from "./schema.ts"

const urlParams = new URLSearchParams(window.location.search)

export const storeId = urlParams.get("storeId") || "react_filesync_store_8"

export const healthCheckIntervalMs = urlParams.get("healthCheckIntervalMs")
  ? Number(urlParams.get("healthCheckIntervalMs"))
  : undefined

export const localOnlyFileSync = urlParams.get("localOnly") === "1"

const adapter = makePersistedAdapter({
  storage: { type: "opfs" },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker
})

export const authToken = import.meta.env.VITE_AUTH_TOKEN ?? "dev-token-change-in-production"

export const getAuthHeaders = () => ({
  Authorization: `Bearer ${authToken}`
})

export const useAppStore = () =>
  useStore({
    schema,
    adapter,
    storeId,
    batchUpdates,
    syncPayloadSchema: SyncPayload,
    syncPayload: { authToken }
  })
