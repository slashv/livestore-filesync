import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise, queryDb } from "@livestore/livestore"
import { makeWsSync } from "@livestore/sync-cf/client"
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { events, schema, SyncPayload, tables } from "./livestore/schema.js"

// Use the same store ID across old/new clients, with separate local directories.
const [url, storeId, directory, writeId, expectedIds] = process.argv.slice(2)
assert(url && storeId && directory && writeId && expectedIds)
await mkdir(directory, { recursive: true })
const authToken = "dev-token-change-in-production"
const store = await createStorePromise({
  adapter: makeAdapter({
    storage: { type: "fs", baseDirectory: resolve(directory) },
    sync: { backend: makeWsSync({ url: `${url}/sync` }), onSyncError: "shutdown" }
  }),
  schema,
  storeId,
  syncPayloadSchema: SyncPayload,
  syncPayload: { authToken }
})
const bytes = (id: string) => Buffer.from(`staged rollout ${id}`)
const sign = async (operation: string, key: string) => {
  const response = await fetch(`${url}/api/v1/sign/${operation}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  })
  assert(response.ok, `sign ${operation}: ${response.status}`)
  return response.json() as Promise<{ url: string; method: string; headers?: Record<string, string> }>
}
try {
  if (writeId !== "-") {
    const key = `${storeId}/${writeId}`
    const signed = await sign("upload", key)
    assert((await fetch(signed.url, { method: signed.method, headers: signed.headers ?? {}, body: bytes(writeId) })).ok)
    const now = new Date()
    store.commit(events.fileCreated({ id: writeId, path: key, contentHash: writeId, createdAt: now, updatedAt: now }))
    store.commit(events.fileUpdated({ id: writeId, path: key, remoteKey: key, contentHash: writeId, updatedAt: now }))
  }
  const ids = expectedIds.split(",")
  const deadline = Date.now() + 20_000
  while (
    !ids.every((id) => store.query(queryDb(tables.files.where({ id }).first()))?.remoteKey) && Date.now() < deadline
  ) {
    await new Promise((done) => setTimeout(done, 100))
  }
  for (const id of ids) {
    const row = store.query(queryDb(tables.files.where({ id }).first()))
    assert(row?.remoteKey, `synced event for ${id}`)
    const signed = await sign("download", row.remoteKey)
    const response = await fetch(signed.url, { headers: signed.headers ?? {} })
    assert(response.ok)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes(id))
  }
  // Give the push acknowledgment time to persist before closing the sender.
  await new Promise((done) => setTimeout(done, 1500))
  console.log(`Rollout passed: ${url}, ${writeId}, ${ids.join(",")}`)
} finally {
  await store.shutdownPromise()
}
