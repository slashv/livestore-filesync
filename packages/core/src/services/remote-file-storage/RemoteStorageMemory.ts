/**
 * In-memory RemoteStorage implementation for testing
 *
 * @module
 */

import { Effect, Layer, Ref } from "effect"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"
import { RemoteStorage, type RemoteStorageConfig, type RemoteStorageService } from "./RemoteStorage.js"

/**
 * In-memory file storage state
 */
interface MemoryFileEntry {
  data: Uint8Array
  mimeType: string
  name: string
}

type MemoryFileStore = Map<string, MemoryFileEntry>

/**
 * Options for the memory remote storage
 */
export interface MemoryRemoteStorageOptions {
  /**
   * Simulate network being offline
   */
  offline?: boolean

  /**
   * Simulate upload failures
   */
  failUploads?: boolean

  /**
   * Simulate download failures
   */
  failDownloads?: boolean

  /**
   * Base URL to use for generated URLs
   */
  baseUrl?: string
}

/**
 * Create an in-memory RemoteStorage implementation for testing
 */
export const makeMemoryRemoteStorage = (
  storeRef: Ref.Ref<MemoryFileStore>,
  optionsRef: Ref.Ref<MemoryRemoteStorageOptions>
): RemoteStorageService => {
  const baseUrl = "https://test-storage.local"

  const upload = (
    file: File,
    uploadOptions: { key?: string } = {}
  ): Effect.Effect<string, UploadError> =>
    Effect.gen(function*() {
      const options = yield* Ref.get(optionsRef)

      if (options.offline || options.failUploads) {
        return yield* Effect.fail(
          new UploadError({
            message: "Upload failed: network unavailable"
          })
        )
      }

      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (error) =>
          new UploadError({
            message: "Failed to read file data",
            cause: error
          })
      })

      const key = uploadOptions.key ?? crypto.randomUUID()
      const url = `${options.baseUrl || baseUrl}/${key}`

      yield* Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        newStore.set(url, {
          data: new Uint8Array(buffer),
          mimeType: file.type || "application/octet-stream",
          name: file.name
        })
        return newStore
      })

      return url
    })

  const download = (url: string): Effect.Effect<File, DownloadError> =>
    Effect.gen(function*() {
      const options = yield* Ref.get(optionsRef)

      if (options.offline || options.failDownloads) {
        return yield* Effect.fail(
          new DownloadError({
            message: "Download failed: network unavailable",
            url
          })
        )
      }

      const store = yield* Ref.get(storeRef)
      const entry = store.get(url)

      if (!entry) {
        return yield* Effect.fail(
          new DownloadError({
            message: "File not found",
            url
          })
        )
      }

      // Cast Uint8Array buffer to ArrayBuffer for File compatibility
      const buffer = entry.data.buffer.slice(
        entry.data.byteOffset,
        entry.data.byteOffset + entry.data.byteLength
      ) as ArrayBuffer
      return new File([buffer], entry.name, { type: entry.mimeType })
    })

  const deleteFile = (url: string): Effect.Effect<void, DeleteError> =>
    Effect.gen(function*() {
      const options = yield* Ref.get(optionsRef)

      if (options.offline) {
        return yield* Effect.fail(
          new DeleteError({
            message: "Delete failed: network unavailable",
            path: url
          })
        )
      }

      yield* Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        newStore.delete(url)
        return newStore
      })
    })

  const checkHealth = (): Effect.Effect<boolean, never> =>
    Effect.gen(function*() {
      const options = yield* Ref.get(optionsRef)
      return !options.offline
    })

  const getConfig = (): RemoteStorageConfig => ({
    baseUrl
  })

  return {
    upload,
    download,
    delete: deleteFile,
    checkHealth,
    getConfig
  }
}

/**
 * Create a Layer with an in-memory RemoteStorage for testing
 */
export const RemoteStorageMemory: Layer.Layer<RemoteStorage> = Layer.effect(
  RemoteStorage,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
    const optionsRef = yield* Ref.make<MemoryRemoteStorageOptions>({})
    return makeMemoryRemoteStorage(storeRef, optionsRef)
  })
)

/**
 * Create a scoped Layer with access to the underlying refs for testing
 */
export const makeRemoteStorageMemoryWithRefs = Effect.gen(function*() {
  const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
  const optionsRef = yield* Ref.make<MemoryRemoteStorageOptions>({})
  return {
    service: makeMemoryRemoteStorage(storeRef, optionsRef),
    storeRef,
    optionsRef
  }
})
