/**
 * In-memory RemoteStorage implementation for testing
 *
 * @module
 */

import { Effect, Layer, Ref } from "effect"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"
import { RemoteStorage, type DownloadOptions, type RemoteStorageConfig, type RemoteStorageService, type UploadOptions } from "./RemoteStorage.js"

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

  /**
   * Delay each upload by this many milliseconds (for testing timing)
   */
  uploadDelayMs?: number

  /**
   * Delay each download by this many milliseconds (for testing timing)
   */
  downloadDelayMs?: number
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
    uploadOptions: UploadOptions
  ): Effect.Effect<{ key: string; etag?: string }, UploadError> =>
    Effect.gen(function* () {
      const options = yield* Ref.get(optionsRef)

      if (options.offline || options.failUploads) {
        return yield* Effect.fail(
          new UploadError({
            message: "Upload failed: network unavailable"
          })
        )
      }

      // Simulate progress for upload with delay
      const totalSize = file.size
      const delayMs = options.uploadDelayMs ?? 0

      if (delayMs > 0 && uploadOptions.onProgress) {
        // Simulate chunked upload progress
        const chunks = 4
        const chunkDelay = delayMs / chunks
        for (let i = 1; i <= chunks; i++) {
          yield* Effect.sleep(`${chunkDelay} millis`)
          uploadOptions.onProgress({
            loaded: Math.min(Math.round((totalSize * i) / chunks), totalSize),
            total: totalSize
          })
        }
      } else if (delayMs > 0) {
        yield* Effect.sleep(`${delayMs} millis`)
      }

      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (error) =>
          new UploadError({
            message: "Failed to read file data",
            cause: error
          })
      })

      const key = uploadOptions.key

      yield* Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        newStore.set(key, {
          data: new Uint8Array(buffer),
          mimeType: file.type || "application/octet-stream",
          name: file.name
        })
        return newStore
      })

      return { key }
    })

  const download = (key: string, downloadOptions?: DownloadOptions): Effect.Effect<File, DownloadError> =>
    Effect.gen(function* () {
      const options = yield* Ref.get(optionsRef)

      if (options.offline || options.failDownloads) {
        return yield* Effect.fail(
          new DownloadError({
            message: "Download failed: network unavailable",
            url: key
          })
        )
      }

      const store = yield* Ref.get(storeRef)
      const entry = store.get(key)

      if (!entry) {
        return yield* Effect.fail(
          new DownloadError({
            message: "File not found",
            url: key
          })
        )
      }

      const totalSize = entry.data.byteLength
      const delayMs = options.downloadDelayMs ?? 0

      // Simulate progress for download with delay
      if (delayMs > 0 && downloadOptions?.onProgress) {
        const chunks = 4
        const chunkDelay = delayMs / chunks
        for (let i = 1; i <= chunks; i++) {
          yield* Effect.sleep(`${chunkDelay} millis`)
          downloadOptions.onProgress({
            loaded: Math.min(Math.round((totalSize * i) / chunks), totalSize),
            total: totalSize
          })
        }
      } else if (delayMs > 0) {
        yield* Effect.sleep(`${delayMs} millis`)
      }

      // Cast Uint8Array buffer to ArrayBuffer for File compatibility
      const buffer = entry.data.buffer.slice(
        entry.data.byteOffset,
        entry.data.byteOffset + entry.data.byteLength
      ) as ArrayBuffer
      return new File([buffer], entry.name, { type: entry.mimeType })
    })

  const deleteFile = (key: string): Effect.Effect<void, DeleteError> =>
    Effect.gen(function* () {
      const options = yield* Ref.get(optionsRef)

      if (options.offline) {
        return yield* Effect.fail(
          new DeleteError({
            message: "Delete failed: network unavailable",
            path: key
          })
        )
      }

      yield* Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        newStore.delete(key)
        return newStore
      })
    })

  const getDownloadUrl = (key: string): Effect.Effect<string, DownloadError> =>
    Effect.gen(function* () {
      const options = yield* Ref.get(optionsRef)
      if (options.offline || options.failDownloads) {
        return yield* Effect.fail(
          new DownloadError({
            message: "Download signing failed: network unavailable",
            url: key
          })
        )
      }
      return `${options.baseUrl || baseUrl}/${key}`
    })

  const checkHealth = (): Effect.Effect<boolean, never> =>
    Effect.gen(function* () {
      const options = yield* Ref.get(optionsRef)
      return !options.offline
    })

  const getConfig = (): RemoteStorageConfig => ({
    signerBaseUrl: baseUrl
  })

  return {
    upload,
    download,
    delete: deleteFile,
    getDownloadUrl,
    checkHealth,
    getConfig
  }
}

/**
 * Create a Layer with an in-memory RemoteStorage for testing
 */
export const RemoteStorageMemory: Layer.Layer<RemoteStorage> = Layer.effect(
  RemoteStorage,
  Effect.gen(function* () {
    const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
    const optionsRef = yield* Ref.make<MemoryRemoteStorageOptions>({})
    return makeMemoryRemoteStorage(storeRef, optionsRef)
  })
)

/**
 * Create a scoped Layer with access to the underlying refs for testing
 */
export const makeRemoteStorageMemoryWithRefs = Effect.gen(function* () {
  const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
  const optionsRef = yield* Ref.make<MemoryRemoteStorageOptions>({})
  return {
    service: makeMemoryRemoteStorage(storeRef, optionsRef),
    storeRef,
    optionsRef
  }
})
