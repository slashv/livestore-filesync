/**
 * LocalFileStorage Service
 *
 * Provides an Effect-based abstraction over the Origin Private File System (OPFS).
 * This service handles all local file operations including reading, writing,
 * deleting, and listing files stored in OPFS.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import {
  DirectoryNotFoundError,
  FileNotFoundError,
  OPFSNotAvailableError,
  StorageError
} from "../../errors/index.js"
import { joinPath, parsePath } from "../../utils/path.js"

/**
 * LocalFileStorage service interface
 */
export interface LocalFileStorageService {
  /**
   * Write a file to OPFS at the specified path
   * Creates parent directories as needed
   */
  readonly writeFile: (path: string, file: File) => Effect.Effect<void, StorageError>

  /**
   * Write raw bytes to OPFS at the specified path
   * Creates parent directories as needed
   */
  readonly writeBytes: (path: string, data: Uint8Array, mimeType?: string) => Effect.Effect<void, StorageError>

  /**
   * Read a file from OPFS
   */
  readonly readFile: (path: string) => Effect.Effect<File, FileNotFoundError | StorageError>

  /**
   * Read raw bytes from OPFS
   */
  readonly readBytes: (path: string) => Effect.Effect<Uint8Array, FileNotFoundError | StorageError>

  /**
   * Check if a file exists in OPFS
   */
  readonly fileExists: (path: string) => Effect.Effect<boolean, StorageError>

  /**
   * Delete a file from OPFS
   */
  readonly deleteFile: (path: string) => Effect.Effect<void, StorageError>

  /**
   * Get an object URL for a file (for use in img.src, etc.)
   * Caller is responsible for revoking the URL when done
   */
  readonly getFileUrl: (path: string) => Effect.Effect<string, FileNotFoundError | StorageError>

  /**
   * List all files in a directory
   */
  readonly listFiles: (directory: string) => Effect.Effect<string[], DirectoryNotFoundError | StorageError>

  /**
   * Get the OPFS root directory handle
   */
  readonly getRoot: () => Effect.Effect<FileSystemDirectoryHandle, OPFSNotAvailableError>

  /**
   * Ensure a directory exists, creating it if necessary
   */
  readonly ensureDirectory: (path: string) => Effect.Effect<FileSystemDirectoryHandle, StorageError>
}

/**
 * LocalFileStorage service tag
 */
export class LocalFileStorage extends Context.Tag("LocalFileStorage")<
  LocalFileStorage,
  LocalFileStorageService
>() {}

/**
 * Get the OPFS root directory handle
 */
const getOPFSRoot = (): Effect.Effect<FileSystemDirectoryHandle, OPFSNotAvailableError> =>
  Effect.tryPromise({
    try: () => navigator.storage.getDirectory(),
    catch: () => OPFSNotAvailableError.default
  })

/**
 * Navigate to a directory handle from a path, optionally creating directories
 */
const getDirectoryHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Effect.Effect<FileSystemDirectoryHandle, DirectoryNotFoundError | StorageError> => {
  if (path === "" || path === ".") {
    return Effect.succeed(root)
  }

  const segments = path.split("/").filter((s) => s.length > 0)

  return Effect.reduce(
    segments,
    root,
    (currentDir, segment) =>
      Effect.tryPromise({
        try: () => currentDir.getDirectoryHandle(segment, { create }),
        catch: (error) => {
          if (error instanceof DOMException && error.name === "NotFoundError") {
            return new DirectoryNotFoundError({ path })
          }
          return new StorageError({
            message: `Failed to access directory: ${path}`,
            cause: error
          })
        }
      })
  )
}

/**
 * Get a file handle from a path
 */
const getFileHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Effect.Effect<FileSystemFileHandle, FileNotFoundError | StorageError> => {
  const { directory, filename } = parsePath(path)

  return Effect.gen(function*() {
    const dirHandle = yield* getDirectoryHandle(root, directory, create).pipe(
      Effect.catchTag("DirectoryNotFoundError", () =>
        Effect.fail(new FileNotFoundError({ path }))
      )
    )

    return yield* Effect.tryPromise({
      try: () => dirHandle.getFileHandle(filename, { create }),
      catch: (error) => {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return new FileNotFoundError({ path })
        }
        return new StorageError({
          message: `Failed to access file: ${path}`,
          cause: error
        })
      }
    })
  })
}

/**
 * Create the live LocalFileStorage service implementation
 */
const make = (): LocalFileStorageService => {
  const getRoot = () => getOPFSRoot()

  const ensureDirectory = (path: string): Effect.Effect<FileSystemDirectoryHandle, StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )
      return yield* getDirectoryHandle(root, path, true).pipe(
        Effect.mapError((e) =>
          e._tag === "StorageError"
            ? e
            : new StorageError({ message: e.message })
        )
      )
    })

  const writeFile = (path: string, file: File): Effect.Effect<void, StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const fileHandle = yield* getFileHandle(root, path, true).pipe(
        Effect.mapError((e) =>
          e._tag === "StorageError"
            ? e
            : new StorageError({ message: e.message })
        )
      )

      yield* Effect.tryPromise({
        try: async () => {
          const writable = await fileHandle.createWritable()
          try {
            await writable.write(file)
          } finally {
            await writable.close()
          }
        },
        catch: (error) =>
          new StorageError({
            message: `Failed to write file: ${path}`,
            cause: error
          })
      })
    })

  const writeBytes = (
    path: string,
    data: Uint8Array,
    mimeType = "application/octet-stream"
  ): Effect.Effect<void, StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const fileHandle = yield* getFileHandle(root, path, true).pipe(
        Effect.mapError((e) =>
          e._tag === "StorageError"
            ? e
            : new StorageError({ message: e.message })
        )
      )

      yield* Effect.tryPromise({
        try: async () => {
          const writable = await fileHandle.createWritable()
          try {
            // Cast Uint8Array to ArrayBuffer for Blob compatibility
            const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
            await writable.write(new Blob([buffer], { type: mimeType }))
          } finally {
            await writable.close()
          }
        },
        catch: (error) =>
          new StorageError({
            message: `Failed to write bytes: ${path}`,
            cause: error
          })
      })
    })

  const readFile = (path: string): Effect.Effect<File, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const fileHandle = yield* getFileHandle(root, path, false)

      return yield* Effect.tryPromise({
        try: () => fileHandle.getFile(),
        catch: (error) =>
          new StorageError({
            message: `Failed to read file: ${path}`,
            cause: error
          })
      })
    })

  const readBytes = (path: string): Effect.Effect<Uint8Array, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const file = yield* readFile(path)
      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (error) =>
          new StorageError({
            message: `Failed to read file bytes: ${path}`,
            cause: error
          })
      })
      return new Uint8Array(buffer)
    })

  const fileExists = (path: string): Effect.Effect<boolean, StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const result = yield* getFileHandle(root, path, false).pipe(
        Effect.map(() => true),
        Effect.catchTag("FileNotFoundError", () => Effect.succeed(false))
      )

      return result
    })

  const deleteFile = (path: string): Effect.Effect<void, StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const { directory, filename } = parsePath(path)

      const dirHandle = yield* getDirectoryHandle(root, directory, false).pipe(
        Effect.catchTag("DirectoryNotFoundError", () => Effect.succeed(root))
      )

      yield* Effect.tryPromise({
        try: () => dirHandle.removeEntry(filename),
        catch: (error) => {
          // Ignore NotFoundError - file already doesn't exist
          if (error instanceof DOMException && error.name === "NotFoundError") {
            return
          }
          throw error
        }
      }).pipe(
        Effect.catchAll((error) =>
          Effect.fail(
            new StorageError({
              message: `Failed to delete file: ${path}`,
              cause: error
            })
          )
        )
      )
    })

  const getFileUrl = (path: string): Effect.Effect<string, FileNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const file = yield* readFile(path)
      return URL.createObjectURL(file)
    })

  const listFiles = (
    directory: string
  ): Effect.Effect<string[], DirectoryNotFoundError | StorageError> =>
    Effect.gen(function*() {
      const root = yield* getOPFSRoot().pipe(
        Effect.mapError((e) => new StorageError({ message: e.message }))
      )

      const dirHandle = yield* getDirectoryHandle(root, directory, false)

      return yield* Effect.tryPromise({
        try: async () => {
          const files: string[] = []
          // Cast to iterable - FileSystemDirectoryHandle is iterable in browsers
          const entries = (dirHandle as any).entries() as AsyncIterable<[string, FileSystemHandle]>
          for await (const [name, handle] of entries) {
            if (handle.kind === "file") {
              files.push(joinPath(directory, name))
            } else if (handle.kind === "directory") {
              // Recursively list files in subdirectories
              const subFiles = await listFilesRecursive(
                handle as FileSystemDirectoryHandle,
                joinPath(directory, name)
              )
              files.push(...subFiles)
            }
          }
          return files
        },
        catch: (error) =>
          new StorageError({
            message: `Failed to list files in directory: ${directory}`,
            cause: error
          })
      })
    })

  return {
    writeFile,
    writeBytes,
    readFile,
    readBytes,
    fileExists,
    deleteFile,
    getFileUrl,
    listFiles,
    getRoot,
    ensureDirectory
  }
}

/**
 * Helper function to recursively list files
 */
const listFilesRecursive = async (
  dirHandle: FileSystemDirectoryHandle,
  basePath: string
): Promise<string[]> => {
  const files: string[] = []
  // Cast to iterable - FileSystemDirectoryHandle is iterable in browsers
  const entries = (dirHandle as any).entries() as AsyncIterable<[string, FileSystemHandle]>
  for await (const [name, handle] of entries) {
    const fullPath = joinPath(basePath, name)
    if (handle.kind === "file") {
      files.push(fullPath)
    } else if (handle.kind === "directory") {
      const subFiles = await listFilesRecursive(handle as FileSystemDirectoryHandle, fullPath)
      files.push(...subFiles)
    }
  }
  return files
}

/**
 * Live layer for LocalFileStorage using OPFS
 */
export const LocalFileStorageLive = Layer.succeed(LocalFileStorage, make())
