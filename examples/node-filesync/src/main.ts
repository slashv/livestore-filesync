import { env } from "node:process"

import { makeAdapter as makeLiveStoreAdapter } from "@livestore/adapter-node"
import { createStorePromise, queryDb } from "@livestore/livestore"
import { makeWsSync } from "@livestore/sync-cf/client"

import { makeAdapter as makeFileSystemAdapter } from "@livestore-filesync/adapter-node"
import { createFileSync } from "@livestore-filesync/core"

import { SyncPayload, events, schema, tables } from "./livestore/schema.js"

const storeId = env.STORE_ID ?? "vue_filesync_store"
const authToken = env.AUTH_TOKEN ?? "insecure-token-change-me"
const syncUrl = env.LIVESTORE_SYNC_URL ?? "http://localhost:60004/sync"
const fileSyncBaseUrl = env.FILESYNC_BASE_URL ?? "http://localhost:60004/api"

const adapter = makeLiveStoreAdapter({
  storage: { type: "fs", baseDirectory: "tmp/livestore" },
  sync: {
    backend: makeWsSync({ url: syncUrl }),
    onSyncError: "shutdown"
  }
})

const fileSystem = makeFileSystemAdapter({ baseDirectory: "tmp/filesync" })

const store = await createStorePromise({
  adapter,
  schema,
  storeId,
  syncPayloadSchema: SyncPayload,
  syncPayload: { authToken }
})

const fileSync = createFileSync({
  store,
  schema: {
    tables: tables,
    events: events,
    queryDb: queryDb
  },
  remote: {
    baseUrl: fileSyncBaseUrl,
    authHeaders: () => ({ Authorization: `Bearer ${authToken}` })
  },
  fileSystem
})

fileSync.start()

const file = new File(["Hello from node"], "hello.txt", { type: "text/plain" })
const result = await fileSync.saveFile(file)

console.log("Saved file", result)

await new Promise((resolve) => setTimeout(resolve, 1000))

await fileSync.dispose()
await store.shutdownPromise()
