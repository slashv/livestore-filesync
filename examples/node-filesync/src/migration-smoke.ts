import { NodeFileSystem } from "@effect/platform-node"
import { createFileSync } from "@livestore-filesync/core"
import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise, queryDb } from "@livestore/livestore"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"

import { events, schema, tables } from "./livestore/schema.js"

// Run seed with the old dependency checkout, then verify with the candidate.
const [mode, directory] = process.argv.slice(2)
assert(directory && (mode === "seed" || mode === "verify" || mode === "recover"))
const root = resolve(directory)
await mkdir(root, { recursive: true })
process.chdir(root)
const store = await createStorePromise({
  adapter: makeAdapter({ storage: { type: "fs", baseDirectory: resolve(root, "db") } }),
  schema,
  storeId: "dependency-migration"
})
const uploaded: Array<string> = []
const server = createServer(async (request, response) => {
  if (request.url === "/health") return void response.end("ok")
  if (request.url === "/v1/sign/upload") {
    response.setHeader("Content-Type", "application/json")
    return void response.end(
      JSON.stringify({ url: `${baseUrl}/upload`, method: "PUT", expiresAt: Date.now() + 60_000 })
    )
  }
  if (request.url === "/upload") {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    uploaded.push(Buffer.concat(chunks).toString())
    return void response.end()
  }
  response.statusCode = 404
  response.end()
})
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
const address = server.address()
assert(address && typeof address !== "string")
const baseUrl = `http://127.0.0.1:${address.port}`
const sync = createFileSync({
  store,
  schema: { tables, events, queryDb },
  remote: mode === "recover" ? { signerBaseUrl: baseUrl } : false,
  fileSystem: NodeFileSystem.layer
})
try {
  if (mode === "seed") {
    const pending = await sync.saveFile(new File(["pending bytes"], "pending.txt"))
    const edited = await sync.saveFile(new File(["original bytes"], "edited.txt"))
    await sync.updateFile(edited.fileId, new File(["offline replacement"], "edited.txt"))
    const cached = await sync.saveFile(new File(["cached bytes"], "cached.txt"))
    for (const [fileId, uploadStatus] of [[pending.fileId, "queued"], [edited.fileId, "inProgress"]] as const) {
      const row = store.query(queryDb(tables.localFileState.where({ fileId }).first()))!
      store.commit(events.localFileStateUpsert({ ...row, fileId, uploadStatus, downloadStatus: "done" }))
    }
    await writeFile(
      resolve(root, "expected.json"),
      JSON.stringify({
        files: store.query(queryDb(tables.files)),
        local: store.query(queryDb(tables.localFileState)),
        ids: [pending.fileId, edited.fileId, cached.fileId]
      })
    )
  } else {
    const expected = JSON.parse(await readFile(resolve(root, "expected.json"), "utf8"))
    const files = store.query(queryDb(tables.files))
    assert.deepEqual(JSON.parse(JSON.stringify(files)), expected.files, "synced metadata survives fingerprint rebuild")
    assert.deepEqual(
      JSON.parse(JSON.stringify(store.query(queryDb(tables.localFileState)))),
      expected.local,
      "pending and interrupted local state survives fingerprint rebuild"
    )
    for (const [index, bytes] of ["pending bytes", "offline replacement", "cached bytes"].entries()) {
      const row = files.find((file) => file.id === expected.ids[index])!
      assert.equal(await (await sync.readFile(row.path)).text(), bytes)
      assert(await sync.resolveFileUrl(row.id), "cached bytes remain resolvable")
    }
  }
  if (mode === "recover") {
    await sync.start()
    const deadline = Date.now() + 15_000
    while (!(uploaded.includes("pending bytes") && uploaded.includes("offline replacement")) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50))
    }
    assert(uploaded.includes("pending bytes"), "queued upload resumes after dependency upgrade")
    assert(uploaded.includes("offline replacement"), "interrupted offline edit uploads current bytes")
  }
  console.log(`Migration ${mode} passed`)
} finally {
  await sync.dispose()
  await store.shutdownPromise()
  await new Promise<void>((done) => server.close(() => done()))
}
