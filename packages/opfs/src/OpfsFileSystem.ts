/**
 * OPFS-backed FileSystem implementation for @effect/platform
 *
 * Provides an Origin Private File System (OPFS) implementation
 * that conforms to Effect Platform's FileSystem interface.
 *
 * @module
 */

import { Data, Effect, Layer, Option, Stream } from "effect"
import { SystemError, type SystemErrorReason } from "@effect/platform/Error"
import { FileSystem, Size } from "@effect/platform/FileSystem"
import type * as FS from "@effect/platform/FileSystem"

export interface OpfsFileSystemOptions {
  readonly baseDirectory?: string
}

/**
 * Error thrown when OPFS is not available in the current environment
 */
export class OPFSNotAvailableError extends Data.TaggedError("OPFSNotAvailableError")<{
  readonly message: string
}> {
  static readonly default = new OPFSNotAvailableError({
    message: "Origin Private File System is not available in this environment"
  })
}

const normalizePath = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/")

const joinPath = (base: string, path: string): string => {
  if (!base) return path
  if (!path) return base
  return `${base}/${path}`
}

const parsePath = (path: string): { directory: string; filename: string } => {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash === -1) {
    return { directory: "", filename: normalized }
  }
  return {
    directory: normalized.slice(0, lastSlash),
    filename: normalized.slice(lastSlash + 1)
  }
}

const resolvePath = (baseDirectory: string | undefined, path: string): string => {
  const normalized = normalizePath(path)
  if (!baseDirectory) return normalized
  return joinPath(baseDirectory, normalized)
}

const makeSystemError = (
  method: string,
  reason: SystemErrorReason,
  path: string,
  cause?: unknown
): SystemError =>
  new SystemError({
    reason,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    ...(cause !== undefined ? { cause } : {})
  })

const getOPFSRoot = (): Effect.Effect<FileSystemDirectoryHandle, SystemError> =>
  Effect.tryPromise({
    try: () => navigator.storage.getDirectory(),
    catch: (cause) =>
      makeSystemError("getRoot", "Unknown", "", cause)
  })

const getDirectoryHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
  recursive: boolean
): Effect.Effect<FileSystemDirectoryHandle, SystemError> => {
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
        catch: (cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return makeSystemError("getDirectoryHandle", "NotFound", path, cause)
          }
          return makeSystemError("getDirectoryHandle", "Unknown", path, cause)
        }
      })
  )
}

const getFileHandle = (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Effect.Effect<FileSystemFileHandle, SystemError> => {
  const { directory, filename } = parsePath(path)

  return Effect.gen(function* () {
    const dirHandle = yield* getDirectoryHandle(root, directory, create, true)
    return yield* Effect.tryPromise({
      try: () => dirHandle.getFileHandle(filename, { create }),
      catch: (cause) => {
        if (cause instanceof DOMException && cause.name === "NotFoundError") {
          return makeSystemError("getFileHandle", "NotFound", path, cause)
        }
        return makeSystemError("getFileHandle", "Unknown", path, cause)
      }
    })
  })
}

const makeFileInfo = (type: FS.File.Type, size = 0): FS.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: Size(size),
  blksize: Option.none(),
  blocks: Option.none()
})

/**
 * Create an OPFS-backed FileSystem implementation
 */
export const makeOpfsFileSystem = (
  options: OpfsFileSystemOptions = {}
): FS.FileSystem => {
  const baseDirectory = options.baseDirectory

  const access: FS.FileSystem["access"] = (path, _options) =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)

      if (resolvedPath === "" || resolvedPath === ".") return

      // Try to get the parent directory - if it fails, the path doesn't exist
      const parent = yield* getDirectoryHandle(root, directory, false, true).pipe(
        Effect.catchAll(() => Effect.fail(makeSystemError("access", "NotFound", path)))
      )

      // Try file first
      const fileResult = yield* Effect.tryPromise({
        try: () => parent.getFileHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => true as const),
        Effect.catchAll(() => Effect.succeed(false as const))
      )

      if (fileResult) return

      // Try directory
      const dirResult = yield* Effect.tryPromise({
        try: () => parent.getDirectoryHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => true as const),
        Effect.catchAll(() => Effect.succeed(false as const))
      )

      if (!dirResult) {
        yield* Effect.fail(makeSystemError("access", "NotFound", path))
      }
    })

  const copy: FS.FileSystem["copy"] = (fromPath, toPath, _options) =>
    Effect.gen(function* () {
      const data = yield* readFile(fromPath)
      yield* writeFile(toPath, data)

      // Handle directories recursively
      const fromStat = yield* stat(fromPath)
      if (fromStat.type === "Directory") {
        const entries = yield* readDirectory(fromPath)
        for (const entry of entries) {
          yield* copy(joinPath(fromPath, entry), joinPath(toPath, entry))
        }
      }
    })

  const copyFile: FS.FileSystem["copyFile"] = (fromPath, toPath) =>
    Effect.gen(function* () {
      const data = yield* readFile(fromPath)
      yield* writeFile(toPath, data)
    })

  const chmod: FS.FileSystem["chmod"] = (_path, _mode) =>
    Effect.void // OPFS doesn't support chmod

  const chown: FS.FileSystem["chown"] = (_path, _uid, _gid) =>
    Effect.void // OPFS doesn't support chown

  const exists: FS.FileSystem["exists"] = (path) =>
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
          if (cause instanceof DOMException) {
            if (cause.name === "NotFoundError" || cause.name === "TypeMismatchError") {
              return Effect.succeed(false)
            }
          }
          return Effect.fail(makeSystemError("exists", "Unknown", path, cause))
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
          return Effect.fail(makeSystemError("exists", "Unknown", path, cause))
        })
      )
    })

  const link: FS.FileSystem["link"] = (_fromPath, _toPath) =>
    Effect.fail(makeSystemError("link", "Unknown", "", new Error("OPFS does not support hard links")))

  const makeDirectory: FS.FileSystem["makeDirectory"] = (path, options) =>
    Effect.gen(function* () {
      if (path === "" || path === ".") return
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      yield* getDirectoryHandle(root, resolvedPath, true, options?.recursive ?? true)
    })

  const makeTempDirectory: FS.FileSystem["makeTempDirectory"] = (options) =>
    Effect.gen(function* () {
      const prefix = options?.prefix ?? "tmp"
      const tempName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const tempPath = options?.directory ? joinPath(options.directory, tempName) : tempName
      yield* makeDirectory(tempPath, { recursive: true })
      return tempPath
    })

  const makeTempDirectoryScoped: FS.FileSystem["makeTempDirectoryScoped"] = (options) =>
    Effect.acquireRelease(
      makeTempDirectory(options),
      (path) => remove(path, { recursive: true }).pipe(Effect.ignore)
    )

  const makeTempFile: FS.FileSystem["makeTempFile"] = (options) =>
    Effect.gen(function* () {
      const prefix = options?.prefix ?? "tmp"
      const suffix = options?.suffix ?? ""
      const tempName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
      const tempPath = options?.directory ? joinPath(options.directory, tempName) : tempName
      yield* writeFile(tempPath, new Uint8Array(0))
      return tempPath
    })

  const makeTempFileScoped: FS.FileSystem["makeTempFileScoped"] = (options) =>
    Effect.acquireRelease(
      makeTempFile(options),
      (path) => remove(path).pipe(Effect.ignore)
    )

  const open: FS.FileSystem["open"] = (_path, _options) =>
    Effect.fail(makeSystemError("open", "Unknown", "", new Error("OPFS open() not implemented - use readFile/writeFile")))

  const readDirectory: FS.FileSystem["readDirectory"] = (path, options) =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const dirHandle = yield* getDirectoryHandle(root, resolvedPath, false, true)

      // Collect entries using tryPromise since we can't use for-await in Effect.gen
      const directEntries = yield* Effect.tryPromise({
        try: async () => {
          const entries: Array<{ name: string; kind: string }> = []
          const iterator = (dirHandle as any).entries() as AsyncIterable<[string, FileSystemHandle]>
          for await (const [name, handle] of iterator) {
            entries.push({ name, kind: handle.kind })
          }
          return entries
        },
        catch: (cause) => makeSystemError("readDirectory", "Unknown", path, cause)
      })

      // Process entries (handle recursion)
      const result: string[] = []
      for (const entry of directEntries) {
        result.push(entry.name)
        if (options?.recursive && entry.kind === "directory") {
          const subEntries = yield* readDirectory(joinPath(path, entry.name), options)
          result.push(...subEntries.map((e) => joinPath(entry.name, e)))
        }
      }

      return result
    })

  const readFile: FS.FileSystem["readFile"] = (path) =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const fileHandle = yield* getFileHandle(root, resolvedPath, false)

      const file = yield* Effect.tryPromise({
        try: () => fileHandle.getFile(),
        catch: (cause) => makeSystemError("readFile", "Unknown", path, cause)
      })

      const buffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (cause) => makeSystemError("readFile", "Unknown", path, cause)
      })

      return new Uint8Array(buffer)
    })

  const readFileString: FS.FileSystem["readFileString"] = (path, encoding) =>
    Effect.gen(function* () {
      const data = yield* readFile(path)
      return new TextDecoder(encoding).decode(data)
    })

  const readLink: FS.FileSystem["readLink"] = (path) =>
    Effect.fail(makeSystemError("readLink", "Unknown", path, new Error("OPFS does not support symbolic links")))

  const realPath: FS.FileSystem["realPath"] = (path) =>
    Effect.succeed(resolvePath(baseDirectory, path))

  const remove: FS.FileSystem["remove"] = (path, options) =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)
      
      const dirHandle = yield* getDirectoryHandle(root, directory, false, true).pipe(
        Effect.catchAll((error) => {
          if (options?.force) return Effect.succeed(null)
          return Effect.fail(error)
        })
      )

      if (!dirHandle) return

      yield* Effect.tryPromise({
        try: () => dirHandle.removeEntry(filename, { recursive: options?.recursive ?? false }),
        catch: (cause) => {
          if (options?.force && cause instanceof DOMException && cause.name === "NotFoundError") {
            return null
          }
          return makeSystemError("remove", "Unknown", path, cause)
        }
      }).pipe(
        Effect.catchAll((error) => {
          if (error === null) return Effect.void
          return Effect.fail(error)
        })
      )
    })

  const rename: FS.FileSystem["rename"] = (oldPath, newPath) =>
    Effect.gen(function* () {
      // OPFS doesn't have native rename, so copy + delete
      const data = yield* readFile(oldPath)
      yield* writeFile(newPath, data)
      yield* remove(oldPath)
    })

  const sink: FS.FileSystem["sink"] = (_path, _options) => {
    throw new Error("OPFS sink() not implemented - use writeFile")
  }

  const stat: FS.FileSystem["stat"] = (path) =>
    Effect.gen(function* () {
      if (path === "" || path === ".") {
        return makeFileInfo("Directory")
      }

      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const { directory, filename } = parsePath(resolvedPath)

      const parent = yield* getDirectoryHandle(root, directory, false, true)

      // Try as file first
      const fileHandle = yield* Effect.tryPromise({
        try: () => parent.getFileHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.flatMap((handle) =>
          Effect.tryPromise({
            try: async () => {
              const file = await handle.getFile()
              return makeFileInfo("File", file.size)
            },
            catch: (cause) => makeSystemError("stat", "Unknown", path, cause)
          })
        ),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException) {
            if (cause.name === "NotFoundError" || cause.name === "TypeMismatchError") {
              return Effect.succeed(null)
            }
          }
          if (cause instanceof SystemError) {
            return Effect.fail(cause)
          }
          return Effect.fail(makeSystemError("stat", "Unknown", path, cause))
        })
      )

      if (fileHandle) {
        return fileHandle
      }

      // Try as directory
      return yield* Effect.tryPromise({
        try: () => parent.getDirectoryHandle(filename),
        catch: (cause) => cause
      }).pipe(
        Effect.map(() => makeFileInfo("Directory")),
        Effect.catchAll((cause) => {
          if (cause instanceof DOMException && cause.name === "NotFoundError") {
            return Effect.fail(makeSystemError("stat", "NotFound", path, cause))
          }
          return Effect.fail(makeSystemError("stat", "Unknown", path, cause))
        })
      )
    })

  const stream: FS.FileSystem["stream"] = (path, _options) =>
    Stream.fromEffect(readFile(path)).pipe(Stream.flatMap(Stream.make))

  const symlink: FS.FileSystem["symlink"] = (_fromPath, _toPath) =>
    Effect.fail(makeSystemError("symlink", "Unknown", "", new Error("OPFS does not support symbolic links")))

  const truncate: FS.FileSystem["truncate"] = (path, length) =>
    Effect.gen(function* () {
      const root = yield* getOPFSRoot()
      const resolvedPath = resolvePath(baseDirectory, path)
      const fileHandle = yield* getFileHandle(root, resolvedPath, false)

      yield* Effect.tryPromise({
        try: async () => {
          const writable = await fileHandle.createWritable({ keepExistingData: true })
          try {
            await writable.truncate(Number(length ?? 0n))
          } finally {
            await writable.close()
          }
        },
        catch: (cause) => makeSystemError("truncate", "Unknown", path, cause)
      })
    })

  const utimes: FS.FileSystem["utimes"] = (_path, _atime, _mtime) =>
    Effect.void // OPFS doesn't support utimes

  const watch: FS.FileSystem["watch"] = (_path, _options) =>
    Stream.fail(makeSystemError("watch", "Unknown", "", new Error("OPFS does not support file watching")))

  const writeFile: FS.FileSystem["writeFile"] = (path, data, _options) =>
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
        catch: (cause) => makeSystemError("writeFile", "Unknown", path, cause)
      })
    })

  const writeFileString: FS.FileSystem["writeFileString"] = (path, data, options) =>
    writeFile(path, new TextEncoder().encode(data), options)

  return {
    access,
    copy,
    copyFile,
    chmod,
    chown,
    exists,
    link,
    makeDirectory,
    makeTempDirectory,
    makeTempDirectoryScoped,
    makeTempFile,
    makeTempFileScoped,
    open,
    readDirectory,
    readFile,
    readFileString,
    readLink,
    realPath,
    remove,
    rename,
    sink,
    stat,
    stream,
    symlink,
    truncate,
    utimes,
    watch,
    writeFile,
    writeFileString
  }
}

/**
 * Layer that provides the OPFS FileSystem implementation
 */
export const layer = (options: OpfsFileSystemOptions = {}): Layer.Layer<FS.FileSystem> =>
  Layer.succeed(FileSystem, makeOpfsFileSystem(options))

/**
 * Default OPFS FileSystem layer (no base directory)
 */
export const layerDefault: Layer.Layer<FS.FileSystem> = layer()
