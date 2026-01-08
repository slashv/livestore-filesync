import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore } from "../../../test/helpers/livestore.js"
import { makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { FileSyncLive } from "../file-sync/index.js"
import { LocalFileStateManagerLive } from "../local-file-state/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { RemoteStorageMemory } from "../remote-file-storage/index.js"
import { FileStorage, FileStorageLive } from "./index.js"

const createRuntime = (deps: Parameters<typeof FileSyncLive>[0]) => {
  const localFileStateManagerLayer = LocalFileStateManagerLive(deps)
  const baseLayer = Layer.mergeAll(Layer.scope, LocalFileStorageMemory, localFileStateManagerLayer, RemoteStorageMemory)
  const fileSyncLayer = Layer.provide(baseLayer)(
    FileSyncLive(deps, {
      executorConfig: {
        maxConcurrentDownloads: 1,
        maxConcurrentUploads: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterMs: 0,
        maxRetries: 0
      }
    })
  )
  const fileStorageLayer = Layer.provide(Layer.mergeAll(baseLayer, fileSyncLayer))(
    FileStorageLive(deps)
  )
  const mainLayer = Layer.mergeAll(baseLayer, fileSyncLayer, fileStorageLayer)
  return ManagedRuntime.make(mainLayer)
}

describe("FileStorage", () => {
  it("saves files and records metadata", async () => {
    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileStorage.saveFile(new File(["data"], "data.txt")), scope))

      const files = store.query(
        deps.schema.queryDb(tables.files.select())
      )
      expect(files).toHaveLength(1)
      const saved = files[0]!
      expect(saved.path).toBe(makeStoredPath(deps.storeId, saved.contentHash))

      const exists = await runtime.runPromise(localStorage.fileExists(saved.path))
      expect(exists).toBe(true)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("updates files and cleans up old paths", async () => {
    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const initial = await runtime.runPromise(
        Scope.extend(fileStorage.saveFile(new File(["data"], "data.txt")), scope)
      )
      const updated = await runtime.runPromise(
        Scope.extend(fileStorage.updateFile(initial.fileId, new File(["next"], "next.txt")), scope)
      )

      expect(updated.path).not.toBe(initial.path)
      const oldExists = await runtime.runPromise(localStorage.fileExists(initial.path))
      const newExists = await runtime.runPromise(localStorage.fileExists(updated.path))
      expect(oldExists).toBe(false)
      expect(newExists).toBe(true)

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: initial.fileId }))
      )
      expect(records[0]?.path).toBe(updated.path)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("deletes files and marks records deleted", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const saved = await runtime.runPromise(
        Scope.extend(fileStorage.saveFile(new File(["data"], "data.txt")), scope)
      )
      store.commit(
        events.fileUpdated({
          id: saved.fileId,
          path: saved.path,
          remoteKey: stripFilesRoot(saved.path),
          contentHash: saved.contentHash,
          updatedAt: new Date()
        })
      )

      await runtime.runPromise(Scope.extend(fileStorage.deleteFile(saved.fileId), scope))

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: saved.fileId }))
      )
      expect(records[0]?.deletedAt).not.toBeNull()

      const exists = await runtime.runPromise(localStorage.fileExists(saved.path))
      expect(exists).toBe(false)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("prefers local file URLs and falls back to remote URLs", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const saved = await runtime.runPromise(
        Scope.extend(fileStorage.saveFile(new File(["data"], "data.txt")), scope)
      )
      const localUrl = await runtime.runPromise(
        Scope.extend(fileStorage.getFileUrl(saved.fileId), scope)
      )

      expect(localUrl?.startsWith("file://")).toBe(true)
      expect(localUrl).toContain(saved.path)

      const remoteId = crypto.randomUUID()
      const remotePath = makeStoredPath(deps.storeId, "remote-hash")
      store.commit(
        events.fileCreated({
          id: remoteId,
          path: remotePath,
          contentHash: "remote-hash",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )
      store.commit(
        events.fileUpdated({
          id: remoteId,
          path: remotePath,
          remoteKey: stripFilesRoot(remotePath),
          contentHash: "remote-hash",
          updatedAt: new Date()
        })
      )

      const remoteUrl = await runtime.runPromise(
        Scope.extend(fileStorage.getFileUrl(remoteId), scope)
      )
      expect(remoteUrl).toBe(`https://test-storage.local/${stripFilesRoot(remotePath)}`)

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: remoteId }))
      )
      expect(records[0]?.path).toBe(remotePath)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})
