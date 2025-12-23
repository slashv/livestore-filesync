/**
 * OPFS-backed FileSystem implementation (browser)
 *
 * @module
 */

import { Effect, Layer } from "effect"
import { FileSystemError } from "../../errors/index.js"
import { joinPath, parsePath } from "../../utils/path.js"
import {
  FileSystem,
  type FileSystemMakeDirectoryOptions,
  type FileSystemRemoveOptions,
  type FileSystemService,
  type FileSystemStat
} from "./FileSystem.js"

export interface OpfsFileSystemOptions {
  readonly baseDirectory?: string
}

const normalizePath = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/")

const resolvePath = (baseDirectory: string | undefined, path: string): string => {
  const normalized = normalizePath(path)
  if (!baseDirectory) return normalized
  return joinPath(baseDirectory, normalized)
}

const getOPFSRoot = (): Effect.Effect<FileSystemDirectoryHandle, FileSystemError> =>
  Effect.tryPromise({
    try: () => navigator.storage.getDirectory(),
    catch: (cause) =>
      new FileSystemError({
        message: "Origin Private File System is not available in this environment",
        operation: "getRoot",
        cause
      })
  })

const getDirectoryHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
  recursive: boolean
): Effect.Effect<FileSystemDirectoryHandle, FileSystemError> => {
  if (path === "" || path === ".") {
    return Effect.succeed(root)
  }

  const segments = normalizePath(path).split("/").filter((s) => s.length > 0)

  return Effect.reduce(
    segments,
    root,
    (current, segment, index) =>
      Effect.tryPromise({
        try: () =>
          current.getDirectoryHandle(segment, {
            create: create && (recursive || index === segments.length - 1)
          }),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to access directory: ${path}`,
            operation: "getDirectoryHandle",
            path,
            cause
          })
      })
  )
}

const getFileHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Effect.Effect<FileSystemFileHandle, FileSystemError> => {
  const { directory, filename } = parsePath(path)

  return Effect.gen(function* () {
    const dirHandle = yield* getDirectoryHandle(root, directory, create, true)
    return yield* Effect.tryPromise({
      try: () => dirHandle.getFileHandle(filename, { create }),
      catch: (cause) =>
        new FileSystemError({
          message: `Failed to access file: ${path}`,
          operation: "getFileHandle",
          path,
          cause
        })
    })
  })
}

export const makeOpfsFileSystem = (
  options: OpfsFileSystemOptions = {}
): FileSystemService => {
  const baseDirectory = options.baseDirectory

  const readFile = (path: string): Effect.Effect<Uint8Array, FileSystemError> =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const fileHandle = yield* getFileHandle(root, resolvedPath, false)

      const file = yield* Effect.tryPromise({
        try: () => fileHandle.getFile(),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to read file: ${resolvedPath}`,
            operation: "readFile",
            path: resolvedPath,
            cause
          })
      })

      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to read file bytes: ${resolvedPath}`,
            operation: "readFile",
            path: resolvedPath,
            cause
          })
      })

      return new Uint8Array(buffer)
    })

  const writeFile = (path: string, data: Uint8Array): Effect.Effect<void, FileSystemError> =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const fileHandle = yield* getFileHandle(root, resolvedPath, true)

      yield* Effect.tryPromise({
        try: async () => {
          const writable = await fileHandle.createWritable()
          try {
            const buffer = data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            ) as ArrayBuffer
            await writable.write(new Blob([buffer], { type: "application/octet-stream" }))
          } finally {
            await writable.close()
          }
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to write file: ${resolvedPath}`,
            operation: "writeFile",
            path: resolvedPath,
            cause
          })
      })
    })

  const readDirectory = (path: string): Effect.Effect<ReadonlyArray<string>, FileSystemError> =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const dirHandle = yield* getDirectoryHandle(root, resolvedPath, false, true)

      return yield* Effect.tryPromise({
        try: async () => {
          const entries: string[] = []
          const iterator = (dirHandle as any).entries() as AsyncIterable<
            [string, FileSystemHandle]
          >
          for await (const [name] of iterator) {
            entries.push(name)
          }
          return entries
        },
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to read directory: ${resolvedPath}`,
            operation: "readDirectory",
            path: resolvedPath,
            cause
          })
      })
    })

  const makeDirectory = (
    path: string,
    options: FileSystemMakeDirectoryOptions = {}
  ): Effect.Effect<void, FileSystemError> =>
    Effect.gen(function* () {
      if (path === "" || path === ".") return
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      yield* getDirectoryHandle(root, resolvedPath, true, options.recursive ?? true)
    })

  const remove = (
    path: string,
    options: FileSystemRemoveOptions = {}
  ): Effect.Effect<void, FileSystemError> =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)
      const dirHandle = yield* getDirectoryHandle(root, directory, false, true)

      yield* Effect.tryPromise({
        try: () => dirHandle.removeEntry(filename, { recursive: options.recursive ?? false }),
        catch: (cause) =>
          new FileSystemError({
            message: `Failed to remove path: ${resolvedPath}`,
            operation: "remove",
            path: resolvedPath,
            cause
          })
      })
    })

  const exists = (path: string): Effect.Effect<boolean, FileSystemError> =>
    Effect.gen(function* () {
      if (path === "" || path === ".") return true
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)

      const parent = yield* getDirectoryHandle(root, directory, false, true).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      )

      if (!parent) return false

      const fileExists = yield* Effect.tryPromise({
        try: () => parent.getFileHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return Effect.succeed(false)
          }
          return Effect.fail(
            new FileSystemError({
              message: `Failed to check file existence: ${resolvedPath}`,
              operation: "exists",
              path: resolvedPath,
              cause
            })
          )
        })
      )

      if (fileExists) return true

      return yield* Effect.tryPromise({
        try: () => parent.getDirectoryHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return Effect.succeed(false)
          }
          return Effect.fail(
            new FileSystemError({
              message: `Failed to check directory existence: ${resolvedPath}`,
              operation: "exists",
              path: resolvedPath,
              cause
            })
          )
        })
      )
    })

  const stat = (path: string): Effect.Effect<FileSystemStat, FileSystemError> =>
    Effect.gen(function* () {
      if (path === "" || path === ".") {
        return { type: "directory" as const }
      }

      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)

      const parent = yield* getDirectoryHandle(root, directory, false, true)

      const fileHandle = yield* Effect.tryPromise({
        try: () => parent.getFileHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => true),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return Effect.succeed(false)
          }
          return Effect.fail(
            new FileSystemError({
              message: `Failed to stat path: ${resolvedPath}`,
              operation: "stat",
              path: resolvedPath,
              cause
            })
          )
        })
      )

      if (fileHandle) {
        return { type: "file" as const }
      }

      return yield* Effect.tryPromise({
        try: () => parent.getDirectoryHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => ({ type: "directory" as const })),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return Effect.fail(
              new FileSystemError({
                message: `Path not found: ${resolvedPath}`,
                operation: "stat",
                path: resolvedPath,
                cause
              })
            )
          }
          return Effect.fail(
            new FileSystemError({
              message: `Failed to stat path: ${resolvedPath}`,
              operation: "stat",
              path: resolvedPath,
              cause
            })
          )
        })
      )
    })

  return {
    readFile,
    writeFile,
    readDirectory,
    makeDirectory,
    remove,
    exists,
    stat
  }
}

export const FileSystemOpfsLive = (
  options: OpfsFileSystemOptions = {}
): Layer.Layer<FileSystem> =>
  Layer.succeed(FileSystem, makeOpfsFileSystem(options))
