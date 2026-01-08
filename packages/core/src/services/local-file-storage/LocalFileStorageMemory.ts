/**
 * In-memory LocalFileStorage implementation for testing
 *
 * This provides a mock implementation that stores files in memory
 * rather than using OPFS, making it suitable for Node.js testing.
 *
 * @module
 */

import { Effect, Layer, Ref } from "effect"
import type { DirectoryNotFoundError } from "../../errors/index.js"
import { FileNotFoundError, StorageError } from "../../errors/index.js"
import { parsePath } from "../../utils/path.js"
import { LocalFileStorage, type LocalFileStorageService } from "./LocalFileStorage.js"

/**
 * In-memory file storage state
 */
interface MemoryFileEntry {
  data: Uint8Array
  mimeType: string
  lastModified: number
}

type MemoryFileStore = Map<string, MemoryFileEntry>

/**
 * Create an in-memory LocalFileStorage implementation
 */
export const makeMemoryLocalFileStorage = (
  storeRef: Ref.Ref<MemoryFileStore>
): LocalFileStorageService => {
  const writeFile = (path: string, file: File): Effect.Effect<void, StorageError> =>
    Effect.gen(function*() {
      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (error) =>
          new StorageError({
            message: `Failed to read file data: ${path}`,
            cause: error
          })
      })

      yield* Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        newStore.set(path, {
          data: new Uint8Array(buffer),
          mimeType: file.type || "application/octet-stream",
          lastModified: file.lastModified || Date.now()
        })
        return newStore
      })
    })

  const writeBytes = (
    path: string,
    data: Uint8Array,
    mimeType = "application/octet-stream"
  ): Effect.Effect<void, StorageError> =>
    Ref.update(storeRef, (store) => {
      const newStore = new Map(store)
      newStore.set(path, {
        data: new Uint8Array(data),
        mimeType,
        lastModified: Date.now()
      })
      return newStore
    })

  const readFile = (path: string): Effect.Effect<File, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const store = yield* Ref.get(storeRef)
      const entry = store.get(path)

      if (!entry) {
        return yield* Effect.fail(new FileNotFoundError({ path }))
      }

      const { filename } = parsePath(path)
      // Cast Uint8Array buffer to ArrayBuffer for File compatibility
      const buffer = entry.data.buffer.slice(
        entry.data.byteOffset,
        entry.data.byteOffset + entry.data.byteLength
      ) as ArrayBuffer
      return new File([buffer], filename, {
        type: entry.mimeType,
        lastModified: entry.lastModified
      })
    })

  const readBytes = (path: string): Effect.Effect<Uint8Array, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const store = yield* Ref.get(storeRef)
      const entry = store.get(path)

      if (!entry) {
        return yield* Effect.fail(new FileNotFoundError({ path }))
      }

      return entry.data
    })

  const fileExists = (path: string): Effect.Effect<boolean, StorageError> =>
    Effect.gen(function*() {
      const store = yield* Ref.get(storeRef)
      return store.has(path)
    })

  const deleteFile = (path: string): Effect.Effect<void, StorageError> =>
    Ref.update(storeRef, (store) => {
      const newStore = new Map(store)
      newStore.delete(path)
      return newStore
    })

  const getFileUrl = (path: string): Effect.Effect<string, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const file = yield* readFile(path)
      return URL.createObjectURL(file)
    })

  const listFiles = (
    directory: string
  ): Effect.Effect<Array<string>, DirectoryNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const store = yield* Ref.get(storeRef)
      const prefix = directory === "" ? "" : directory.endsWith("/") ? directory : `${directory}/`
      const files: Array<string> = []

      for (const path of store.keys()) {
        if (prefix === "" || path.startsWith(prefix)) {
          files.push(path)
        }
      }

      // If directory doesn't exist and has no files, check if it should error
      if (files.length === 0 && directory !== "") {
        // For memory impl, we'll just return empty array
        // In real OPFS, this would check if the directory exists
      }

      return files
    })

  return {
    writeFile,
    writeBytes,
    readFile,
    readBytes,
    fileExists,
    deleteFile,
    getFileUrl,
    listFiles
  }
}

/**
 * Create a Layer with an in-memory LocalFileStorage for testing
 */
export const LocalFileStorageMemory: Layer.Layer<LocalFileStorage> = Layer.effect(
  LocalFileStorage,
  Effect.gen(function*() {
    const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
    return makeMemoryLocalFileStorage(storeRef)
  })
)

/**
 * Create a scoped Layer with access to the underlying store ref for testing
 */
export const makeLocalFileStorageMemoryWithStore = Effect.gen(function*() {
  const storeRef = yield* Ref.make<MemoryFileStore>(new Map())
  return {
    service: makeMemoryLocalFileStorage(storeRef),
    storeRef
  }
})
