import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore, waitFor } from "../../../test/helpers/livestore.js"
import { DownloadError } from "../../errors/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { HashServiceLive } from "../hash/index.js"
import { LocalFileStateManagerLive } from "../local-file-state/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { RemoteStorage, type RemoteStorageService } from "../remote-file-storage/index.js"
import { FileSync, FileSyncLive } from "./index.js"

const barrier = () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    wait: Effect.promise(async () => {
      enter()
      await released
    })
  }
}

const setup = async (blockedKind: "upload" | "download", blockWrite = false, localOnly = false) => {
  const testStore = await createTestStore()
  const { deps, events, store, tables } = testStore
  const gate = barrier()
  const writeGate = barrier()
  const remoteFiles = new Map<string, File>()
  const uploads: Array<string> = []
  const downloads: Array<string> = []
  const remote: RemoteStorageService = {
    upload: (file, options) =>
      Effect.gen(function*() {
        uploads.push(options.key)
        if (blockedKind === "upload" && uploads.length === 1) yield* gate.wait
        remoteFiles.set(options.key, file)
        return { key: options.key }
      }),
    download: (key) =>
      Effect.gen(function*() {
        downloads.push(key)
        const file = remoteFiles.get(key)
        if (blockedKind === "download" && downloads.length === 1) yield* gate.wait
        if (!file) return yield* Effect.fail(new DownloadError({ message: "Missing remote file", url: key }))
        return file
      }),
    delete: (key) =>
      Effect.sync(() => {
        remoteFiles.delete(key)
      }),
    getDownloadUrl: (key) => Effect.succeed(`https://example.test/${key}`),
    checkHealth: () => Effect.succeed(true),
    getConfig: () => ({ signerBaseUrl: "https://example.test" })
  }
  const storageLayer = Layer.effect(
    LocalFileStorage,
    Effect.gen(function*() {
      const storage = yield* LocalFileStorage
      let writes = 0
      return {
        ...storage,
        writeFile: (path: string, file: File) =>
          Effect.gen(function*() {
            if (blockWrite && writes++ === 0) yield* writeGate.wait
            return yield* storage.writeFile(path, file)
          })
      }
    })
  ).pipe(Layer.provide(LocalFileStorageMemory))
  const base = Layer.mergeAll(
    HashServiceLive,
    storageLayer,
    LocalFileStateManagerLive(deps),
    Layer.succeed(RemoteStorage, remote)
  )
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    base,
    FileSyncLive(deps, {
      remoteMode: localOnly ? "local-only" : "remote",
      executorConfig: {
        maxConcurrentDownloads: 1,
        maxConcurrentUploads: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterMs: 0
      }
    }).pipe(Layer.provide(base))
  ))
  const fileSync = await runtime.runPromise(FileSync)
  const localStorage = await runtime.runPromise(LocalFileStorage)
  const scope = await runtime.runPromise(Scope.make())
  const seed = async (content: string, id = crypto.randomUUID(), create = true) => {
    const file = new File([content], "file.txt")
    const contentHash = await runtime.runPromise(hashFile(file))
    const path = makeStoredPath(deps.storeId, contentHash)
    const remoteKey = stripFilesRoot(path)
    remoteFiles.set(remoteKey, file)
    if (create) {
      store.commit(events.fileCreated({ id, path, contentHash, createdAt: new Date(), updatedAt: new Date() }))
    }
    store.commit(events.fileUpdated({ id, path, contentHash, remoteKey, updatedAt: new Date() }))
    return { fileId: id, path, contentHash, remoteKey }
  }
  return {
    ...testStore,
    gate,
    writeGate,
    remoteFiles,
    uploads,
    downloads,
    runtime,
    fileSync,
    localStorage,
    seed,
    record: (id: string) => store.query(deps.schema.queryDb(tables.files.where({ id })))[0]!,
    state: async (id: string) => (await runtime.runPromise(fileSync.getLocalFilesState()))[id],
    start: () => runtime.runPromise(Scope.provide(fileSync.start(), scope)),
    async close() {
      gate.release()
      writeGate.release()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await testStore.shutdown()
    }
  }
}

describe("FileSync transfer content versions", () => {
  it("follows a replacement remote key while a download of the same hash is active", async () => {
    const t = await setup("download")
    try {
      const file = await t.seed("same content")
      await t.start()
      await t.gate.entered
      const remoteKey = "replacement-key"
      t.remoteFiles.set(remoteKey, t.remoteFiles.get(file.remoteKey)!)
      t.store.commit(t.events.fileUpdated({
        id: file.fileId,
        path: file.path,
        contentHash: file.contentHash,
        remoteKey,
        updatedAt: new Date()
      }))
      t.gate.release()
      await waitFor(() => t.state(file.fileId), (state) => state?.downloadStatus === "done")
      expect(t.downloads).toEqual([file.remoteKey, remoteKey])
      expect(await (await t.runtime.runPromise(t.localStorage.readFile(file.path))).text()).toBe("same content")
    } finally {
      await t.close()
    }
  })

  it("uploads the latest edit without attaching the old upload's key to it", async () => {
    const t = await setup("upload")
    try {
      const first = await t.runtime.runPromise(t.fileSync.saveFile(new File(["first"], "file.txt")))
      await t.start()
      await t.gate.entered
      const latest = await t.runtime.runPromise(t.fileSync.updateFile(first.fileId, new File(["latest"], "file.txt")))
      const invalidKeys: Array<string> = []
      const unsubscribe = t.store.subscribe(
        t.deps.schema.queryDb(t.tables.files.where({ id: first.fileId })),
        (rows) => {
          const row = rows[0]
          if (
            row?.contentHash === latest.contentHash && row.remoteKey && row.remoteKey !== stripFilesRoot(latest.path)
          ) {
            invalidKeys.push(row.remoteKey)
          }
        }
      )
      try {
        t.gate.release()
        await waitFor(() => t.state(first.fileId), (state) => state?.uploadStatus === "done")
        expect(invalidKeys).toEqual([])
        expect(t.record(first.fileId)).toMatchObject({
          contentHash: latest.contentHash,
          remoteKey: stripFilesRoot(latest.path)
        })
        expect(await t.remoteFiles.get(stripFilesRoot(latest.path))?.text()).toBe("latest")
        expect(await (await t.runtime.runPromise(t.localStorage.readFile(latest.path))).text()).toBe("latest")
        expect(await t.state(first.fileId)).toMatchObject({
          path: latest.path,
          localHash: latest.contentHash,
          lastSyncError: ""
        })
        expect(t.uploads).toEqual([stripFilesRoot(first.path), stripFilesRoot(latest.path)])
      } finally {
        unsubscribe()
      }
    } finally {
      await t.close()
    }
  })

  it("discards an old download and downloads the newer remote version", async () => {
    const t = await setup("download")
    try {
      const first = await t.seed("first")
      const sentinel = await t.seed("sentinel")
      await t.start()
      await t.gate.entered
      const latest = await t.seed("latest", first.fileId, false)
      t.gate.release()
      await waitFor(
        () => t.state(first.fileId),
        (state) => state?.localHash === latest.contentHash && state.downloadStatus === "done"
      )
      expect(await t.runtime.runPromise(t.localStorage.fileExists(first.path))).toBe(false)
      expect(await (await t.runtime.runPromise(t.localStorage.readFile(latest.path))).text()).toBe("latest")
      expect(t.record(first.fileId)).toMatchObject({ contentHash: latest.contentHash, remoteKey: latest.remoteKey })
      expect(t.downloads).toContain(latest.remoteKey)
      await waitFor(() => t.state(sentinel.fileId), (state) => state?.downloadStatus === "done")
    } finally {
      await t.close()
    }
  })

  it("preserves a local edit made while the old version is downloading", async () => {
    const t = await setup("download")
    try {
      const first = await t.seed("first")
      const sentinel = await t.seed("sentinel")
      await t.start()
      await t.gate.entered
      const latest = await t.runtime.runPromise(
        t.fileSync.updateFile(first.fileId, new File(["local edit"], "file.txt"))
      )
      t.gate.release()
      // A following download is a queue barrier: the stale download has settled by the time it completes.
      await waitFor(() => t.state(sentinel.fileId), (state) => state?.downloadStatus === "done")
      await waitFor(() => t.state(first.fileId), (state) => state?.uploadStatus === "done")
      expect(await t.state(first.fileId)).toMatchObject({
        path: latest.path,
        localHash: latest.contentHash,
        downloadStatus: "done"
      })
      expect(await t.runtime.runPromise(t.localStorage.fileExists(first.path))).toBe(false)
      expect(await (await t.runtime.runPromise(t.localStorage.readFile(latest.path))).text()).toBe("local edit")
      expect(t.record(first.fileId).remoteKey).toBe(stripFilesRoot(latest.path))
      expect(await t.remoteFiles.get(stripFilesRoot(latest.path))?.text()).toBe("local edit")
    } finally {
      await t.close()
    }
  })

  it("does not recreate deleted bytes or state after an in-flight download", async () => {
    const t = await setup("download")
    try {
      const first = await t.seed("first")
      const sentinel = await t.seed("sentinel")
      await t.start()
      await t.gate.entered
      await t.runtime.runPromise(t.fileSync.deleteFile(first.fileId))
      t.gate.release()
      await waitFor(() => t.state(sentinel.fileId), (state) => state?.downloadStatus === "done")
      expect(await t.state(first.fileId)).toBeUndefined()
      expect(await t.runtime.runPromise(t.localStorage.fileExists(first.path))).toBe(false)
      expect(t.record(first.fileId).deletedAt).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it("cleans up a download deleted while its local write is already in progress", async () => {
    const t = await setup("download", true)
    try {
      const first = await t.seed("first")
      const sentinel = await t.seed("sentinel")
      await t.start()
      await t.gate.entered
      t.gate.release()
      await t.writeGate.entered
      // Commit the tombstone directly: deletion processing may wait for the nonabortable write.
      t.store.commit(t.events.fileDeleted({ id: first.fileId, deletedAt: new Date() }))
      t.writeGate.release()
      await waitFor(() => t.state(sentinel.fileId), (state) => state?.downloadStatus === "done")
      expect(await t.state(first.fileId)).toBeUndefined()
      expect(await t.runtime.runPromise(t.localStorage.fileExists(first.path))).toBe(false)
      expect(t.record(first.fileId).deletedAt).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it("rejects corrupt downloaded bytes and converges after an explicit retry", async () => {
    const t = await setup("download")
    try {
      const file = await t.seed("expected")
      t.remoteFiles.set(file.remoteKey, new File(["corrupt"], "file.txt"))
      await t.start()
      await t.gate.entered
      t.gate.release()
      await waitFor(() => t.state(file.fileId), (state) => state?.downloadStatus === "error")
      expect(await t.runtime.runPromise(t.localStorage.fileExists(file.path))).toBe(false)
      expect(t.record(file.fileId)).toMatchObject({ contentHash: file.contentHash, remoteKey: file.remoteKey })
      expect((await t.state(file.fileId))?.localHash).not.toBe(file.contentHash)
      t.remoteFiles.set(file.remoteKey, new File(["expected"], "file.txt"))
      expect(await t.runtime.runPromise(t.fileSync.retryErrors())).toContain(file.fileId)
      await waitFor(() => t.state(file.fileId), (state) => state?.downloadStatus === "done")
      expect(await (await t.runtime.runPromise(t.localStorage.readFile(file.path))).text()).toBe("expected")
      expect(await t.state(file.fileId)).toMatchObject({
        localHash: file.contentHash,
        uploadStatus: "done",
        lastSyncError: ""
      })
      expect(t.downloads).toEqual([file.remoteKey, file.remoteKey])
      expect(t.uploads).toEqual([])
    } finally {
      await t.close()
    }
  })
})

describe("FileSync shared blob ownership", () => {
  for (const localOnly of [false, true]) {
    for (const operation of ["delete", "update"] as const) {
      it(`preserves identical-content survivors after ${operation} (${localOnly ? "local" : "remote"})`, async () => {
        const t = await setup("upload", false, localOnly)
        try {
          t.gate.release()
          const first = await t.runtime.runPromise(t.fileSync.saveFile(new File(["shared"], "one.txt")))
          const survivor = await t.runtime.runPromise(t.fileSync.saveFile(new File(["shared"], "two.txt")))
          expect(first.path).toBe(survivor.path)
          await t.start()
          await waitFor(() => t.state(survivor.fileId), (state) => state?.uploadStatus === "done")
          if (operation === "delete") await t.runtime.runPromise(t.fileSync.deleteFile(first.fileId))
          else await t.runtime.runPromise(t.fileSync.updateFile(first.fileId, new File(["replacement"], "one.txt")))
          expect(await t.runtime.runPromise(t.fileSync.resolveFileUrl(survivor.fileId))).toBeTruthy()
          expect(await (await t.runtime.runPromise(t.localStorage.readFile(survivor.path))).text()).toBe("shared")
          if (!localOnly) {
            expect(await t.remoteFiles.get(stripFilesRoot(survivor.path))?.text()).toBe("shared")
          }
          // Last local owner can be reclaimed, but unseen offline remote owners remain possible.
          await t.runtime.runPromise(t.fileSync.deleteFile(survivor.fileId))
          await waitFor(() => t.runtime.runPromise(t.localStorage.fileExists(survivor.path)), (exists) => !exists)
          if (!localOnly) expect(t.remoteFiles.has(stripFilesRoot(survivor.path))).toBe(true)
        } finally {
          await t.close()
        }
      })
    }
  }

  it("retains a stale upload after deletion for owners on offline devices", async () => {
    const t = await setup("upload")
    try {
      const first = await t.runtime.runPromise(t.fileSync.saveFile(new File(["shared"], "one.txt")))
      await t.start()
      await t.gate.entered
      await t.runtime.runPromise(t.fileSync.deleteFile(first.fileId))
      expect(await t.runtime.runPromise(t.localStorage.fileExists(first.path))).toBe(true)
      t.gate.release()
      await waitFor(() => t.runtime.runPromise(t.localStorage.fileExists(first.path)), (exists) => !exists)
      expect(await t.remoteFiles.get(stripFilesRoot(first.path))?.text()).toBe("shared")
      expect(t.record(first.fileId).remoteKey).toBe("")
    } finally {
      await t.close()
    }
  })
})
