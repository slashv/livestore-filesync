import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, makeSchema, queryDb, State } from "@livestore/livestore"
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect"
import { describe, expect, it } from "vitest"
import type { LiveStoreDeps } from "../src/livestore/types.js"
import { createFileSyncSchema } from "../src/schema/index.js"
import {
  FileSync,
  FileSyncLive,
  HashServiceLive,
  LocalFileStorageMemory,
  makeRemoteStorageMemoryWithRefs,
  RemoteStorage
} from "../src/services/index.js"
import { LocalFileStateManagerLive } from "../src/services/local-file-state/index.js"
import { LocalFileStorage } from "../src/services/local-file-storage/index.js"
import { sanitizeStoreId } from "../src/utils/index.js"
import { waitFor } from "./helpers/livestore.js"

describe("FileSync remote delete", () => {
  it("retains the remote file if the file is deleted during an in-flight upload", async () => {
    const adapter = makeInMemoryAdapter()
    const fileSyncSchema = createFileSyncSchema()
    const { createMaterializers, events, tables } = fileSyncSchema
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

    const { service: remoteService, storeRef } = await Effect.runPromise(makeRemoteStorageMemoryWithRefs)
    const uploadStarted = await Effect.runPromise(Deferred.make<void>())
    const allowUpload = await Effect.runPromise(Deferred.make<void>())

    let remoteDeletes = 0

    const remoteWithDelay = {
      ...remoteService,
      delete: (key: string) =>
        remoteService.delete(key).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              remoteDeletes++
            })
          )
        ),
      upload: (file: File, options: { key: string }) =>
        Effect.gen(function*() {
          yield* Deferred.succeed(uploadStarted, undefined)
          yield* Deferred.await(allowUpload)
          return yield* remoteService.upload(file, options)
        })
    }

    const RemoteStorageLayer = Layer.succeed(RemoteStorage, remoteWithDelay)
    const LocalFileStateManagerLayer = LocalFileStateManagerLive(deps)
    const BaseLayer = Layer.mergeAll(
      HashServiceLive,
      LocalFileStorageMemory,
      LocalFileStateManagerLayer,
      RemoteStorageLayer
    )
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
    const MainLayer = Layer.mergeAll(BaseLayer, FileSyncLayer)
    const runtime = ManagedRuntime.make(MainLayer)

    const fileSync = await runtime.runPromise(
      Effect.gen(function*() {
        return yield* FileSync
      })
    )

    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.provide(fileSync.start(), scope))

      let targetFileId = ""

      const file = new File(["hello world"], "hello.txt", { type: "text/plain" })
      const result = await runtime.runPromise(fileSync.saveFile(file))
      targetFileId = result.fileId

      await runtime.runPromise(fileSync.syncNow())
      await Effect.runPromise(Deferred.await(uploadStarted))
      await runtime.runPromise(fileSync.deleteFile(targetFileId))

      await Effect.runPromise(Deferred.succeed(allowUpload, undefined))
      const local = await runtime.runPromise(LocalFileStorage)
      await waitFor(() => runtime.runPromise(local.fileExists(result.path)), (exists) => !exists)

      const remoteStore = await Effect.runPromise(Ref.get(storeRef))
      expect(remoteStore.size).toBe(1)
      expect(remoteDeletes).toBe(0)
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await store.shutdownPromise()
    }
  })
})
