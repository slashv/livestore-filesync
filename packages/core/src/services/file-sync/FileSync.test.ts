import { Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore } from "../../../test/helpers/livestore.js"
import { makeStoredPath } from "../../utils/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import {
  makeRemoteStorageMemoryWithRefs,
  RemoteStorage,
  type MemoryRemoteStorageOptions
} from "../remote-file-storage/index.js"
import { FileSync, FileSyncLive } from "./index.js"

const createRuntime = async (deps: Parameters<typeof FileSyncLive>[0], options: MemoryRemoteStorageOptions = {}) => {
  const { service, optionsRef } = await Effect.runPromise(makeRemoteStorageMemoryWithRefs)
  await Effect.runPromise(Ref.set(optionsRef, options))

  const remoteLayer = Layer.succeed(RemoteStorage, service)
  const baseLayer = Layer.mergeAll(Layer.scope, LocalFileStorageMemory, remoteLayer)
  const fileSyncLayer = Layer.provide(baseLayer)(
    FileSyncLive(deps, {
      executorConfig: {
        maxConcurrentDownloads: 1,
        maxConcurrentUploads: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterMs: 0,
        maxRetries: 0
      },
      healthCheckIntervalMs: 50,
      gcDelayMs: 10
    })
  )

  const mainLayer = Layer.mergeAll(baseLayer, fileSyncLayer)
  return { runtime: ManagedRuntime.make(mainLayer) }
}

describe("FileSync", () => {
  it("marks remote-only files for download", async () => {
    const { deps, store, events, shutdown } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "remote-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "remote-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteUrl: "https://remote.test/file",
        contentHash: "remote-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.downloadStatus).toBe("queued")
      expect(state[fileId]?.uploadStatus).toBe("done")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("marks local-only files for upload", async () => {
    const { deps, store, events, shutdown } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "local-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "local-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(localStorage.writeFile(path, new File(["local"], "local.txt")))
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.uploadStatus).toBe("queued")
      expect(state[fileId]?.downloadStatus).toBe("done")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("queues download when local hash mismatches remote", async () => {
    const { deps, store, events, shutdown } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "remote-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "remote-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteUrl: "https://remote.test/file",
        contentHash: "remote-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(localStorage.writeFile(path, new File(["local"], "local.txt")))
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.downloadStatus).toBe("queued")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("emits online and offline events", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())
    const events: string[] = []
    const unsubscribe = fileSync.onEvent((event) => {
      events.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(fileSync.setOnline(true))

      expect(events).toContain("offline")
      expect(events).toContain("online")
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})
