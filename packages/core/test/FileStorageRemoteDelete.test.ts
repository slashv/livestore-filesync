import { Deferred, Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise, makeSchema, queryDb, State } from "@livestore/livestore"
import { createFileSyncSchema } from "../src/schema/index.js"
import {
  FileStorage,
  FileStorageLive,
  FileSync,
  FileSyncLive,
  LocalFileStorageMemory,
  makeRemoteStorageMemoryWithRefs,
  RemoteStorage
} from "../src/services/index.js"
import { sanitizeStoreId } from "../src/utils/index.js"
import type { LiveStoreDeps } from "../src/livestore/types.js"

describe("FileStorage remote delete", () => {
  it("deletes the remote file if the file is deleted during an in-flight upload", async () => {
    const adapter = makeAdapter({ storage: { type: "in-memory" } })
    const fileSyncSchema = createFileSyncSchema()
    const { tables, events, createMaterializers } = fileSyncSchema
    const materializers = State.SQLite.materializers(events, createMaterializers(tables))
    const state = State.SQLite.makeState({ tables, materializers })
    const schema = makeSchema({ events, state })
    const storeId = `test-store-${Date.now()}`
    const store = await createStorePromise({ adapter, schema, storeId })
    const deps: LiveStoreDeps = {
      store: store as LiveStoreDeps["store"],
      schema: { tables, events, queryDb },
      storeId: sanitizeStoreId(store.storeId)
    }

    const { service: remoteService, storeRef } =
      await Effect.runPromise(makeRemoteStorageMemoryWithRefs)
    const uploadStarted = await Effect.runPromise(Deferred.make<void>())
    const allowUpload = await Effect.runPromise(Deferred.make<void>())

    const remoteWithDelay = {
      ...remoteService,
      upload: (file: File, options?: { key?: string }) =>
        Effect.gen(function*() {
          yield* Deferred.succeed(uploadStarted, undefined)
          yield* Deferred.await(allowUpload)
          return yield* remoteService.upload(file, options)
        })
    }

    const RemoteStorageLayer = Layer.succeed(RemoteStorage, remoteWithDelay)
    const BaseLayer = Layer.mergeAll(Layer.scope, LocalFileStorageMemory, RemoteStorageLayer)
    const FileSyncLayer = Layer.provide(BaseLayer)(
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
    const FileStorageLayer = Layer.provide(Layer.mergeAll(BaseLayer, FileSyncLayer))(
      FileStorageLive(deps)
    )
    const MainLayer = Layer.mergeAll(BaseLayer, FileSyncLayer, FileStorageLayer)
    const runtime = ManagedRuntime.make(MainLayer)

    const fileSync = await runtime.runPromise(
      Effect.gen(function*() {
        return yield* FileSync
      })
    )
    const fileStorage = await runtime.runPromise(
      Effect.gen(function*() {
        return yield* FileStorage
      })
    )

    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))

      let targetFileId = ""
      const uploadCompleted = new Promise<void>((resolve) => {
        const unsubscribe = fileSync.onEvent((event) => {
          if (event.type === "upload:complete" && event.fileId === targetFileId) {
            unsubscribe()
            resolve()
          }
        })
      })

      const file = new File(["hello world"], "hello.txt", { type: "text/plain" })
      const result = await runtime.runPromise(fileStorage.saveFile(file))
      targetFileId = result.fileId

      await Effect.runPromise(Deferred.await(uploadStarted))
      await runtime.runPromise(fileStorage.deleteFile(targetFileId))

      await Effect.runPromise(Deferred.succeed(allowUpload, undefined))
      await uploadCompleted

      const remoteStore = await Effect.runPromise(Ref.get(storeRef))
      expect(remoteStore.size).toBe(0)
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await store.shutdownPromise()
    }
  })
})
