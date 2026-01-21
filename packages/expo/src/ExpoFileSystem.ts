/**
 * Expo-backed FileSystem implementation for @effect/platform
 *
 * Provides an Expo FileSystem implementation that conforms to
 * Effect Platform's FileSystem interface.
 *
 * @module
 */

import { SystemError, type SystemErrorReason } from "@effect/platform/Error"
import { FileSystem, Size } from "@effect/platform/FileSystem"
import type * as FS from "@effect/platform/FileSystem"
import { Data, Effect, Layer, Option, Stream } from "effect"

// Expo file system types (minimal interface we need)
interface ExpoFsFile {
  readonly uri: string
  readonly size: number | null
  readonly exists: boolean
  readonly type: "file" | "directory" | null
  readonly md5: string | null
  readonly creationTime: Date | null
  readonly modificationTime: Date | null
  bytes(): Promise<Uint8Array>
  bytesSync(): Uint8Array
  text(): Promise<string>
  textSync(): string
  base64(): Promise<string>
  write(content: string | Uint8Array): Promise<void>
  create(): Promise<void>
  delete(): Promise<void>
  copy(destination: ExpoFsFile | ExpoFsDirectory): Promise<void>
  move(destination: ExpoFsFile | ExpoFsDirectory): Promise<void>
}

interface ExpoFsDirectory {
  readonly uri: string
  readonly exists: boolean
  list(): Array<ExpoFsFile | ExpoFsDirectory>
  create(options?: { intermediates?: boolean }): Promise<void>
  delete(): Promise<void>
  copy(destination: ExpoFsDirectory): Promise<void>
  move(destination: ExpoFsDirectory): Promise<void>
}

interface ExpoFsPaths {
  readonly cache: ExpoFsDirectory | string | { uri: string }
  readonly document: ExpoFsDirectory | string | { uri: string }
}


interface ExpoFsModule {
  File?: new(...uris: (string | { uri: string } | ExpoFsDirectory)[]) => ExpoFsFile
  Directory?: new(...uris: (string | { uri: string } | ExpoFsDirectory)[]) => ExpoFsDirectory
  Paths?: ExpoFsPaths
  documentDirectory?: string | null
  cacheDirectory?: string | null
}

type ResolvedExpoFsModule = ExpoFsModule & {
  File: new(...uris: (string | { uri: string })[]) => ExpoFsFile
  Directory: new(...uris: (string | { uri: string })[]) => ExpoFsDirectory
}

export interface ExpoFileSystemOptions {
  /**
   * Base directory for all operations.
   * Defaults to Paths.document (persistent storage).
   * Can also be set to Paths.cache for temporary storage.
   */
  readonly baseDirectory?: string
}

/**
 * Error thrown when Expo FileSystem is not available
 */
export class ExpoFileSystemNotAvailableError extends Data.TaggedError(
  "ExpoFileSystemNotAvailableError"
)<{
  readonly message: string
}> {
  static readonly default = new ExpoFileSystemNotAvailableError({
    message: "Expo FileSystem is not available in this environment"
  })
}

let _fs: ResolvedExpoFsModule | null = null

const hasFsExports = (module: ExpoFsModule | undefined): boolean =>
  Boolean(module && (module.File || module.Directory || module.Paths || module.documentDirectory || module.cacheDirectory))

const normalizeFsModule = (module: ExpoFsModule | { default?: ExpoFsModule }): ExpoFsModule => {
  if ("default" in module && module.default && hasFsExports(module.default)) {
    return module.default
  }
  return module as ExpoFsModule
}

const importExpoFsModule = async (): Promise<ExpoFsModule> => {
  try {
    const module = (await import("expo-file-system")) as unknown as ExpoFsModule | { default?: ExpoFsModule }
    return normalizeFsModule(module)
  } catch (error) {
    console.warn("[ExpoFileSystem] Failed to import expo-file-system", error)
    throw error
  }
}

const getFs = async (): Promise<ResolvedExpoFsModule> => {
  if (!_fs) {
    const module = await importExpoFsModule()
    if (!module.File || !module.Directory || !module.Paths) {
      throw new Error("Expo file-system missing File/Directory/Paths")
    }
    _fs = module as ResolvedExpoFsModule
  }
  return _fs
}

const normalizePath = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/")

const getPathUri = (path: string | { uri: string } | ExpoFsDirectory): string => {
  if (typeof path === "string") return path
  if ("uri" in path) return path.uri
  return ""
}

const joinPath = (base: string | { uri: string } | ExpoFsDirectory, path: string): string => {
  const baseUri = getPathUri(base)
  if (!baseUri) return path
  if (!path) return baseUri
  // Remove trailing slash from base and leading slash from path
  const cleanBase = baseUri.replace(/\/$/, "")
  const cleanPath = path.replace(/^\//, "")
  return `${cleanBase}/${cleanPath}`
}


const resolvePath = (baseDirectory: string, path: string): string => {
  const normalized = normalizePath(path)
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

const makeFileInfo = (
  type: FS.File.Type,
  size = 0,
  mtime?: Date | null,
  birthtime?: Date | null
): FS.File.Info => ({
  type,
  mtime: mtime ? Option.some(mtime) : Option.none(),
  atime: Option.none(), // Expo doesn't provide access time
  birthtime: birthtime ? Option.some(birthtime) : Option.none(),
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
 * Create an Expo-backed FileSystem implementation
 */
export const makeExpoFileSystem = (options: ExpoFileSystemOptions = {}): FS.FileSystem => {
  // We need to initialize the base directory lazily since Paths isn't available until import
  let _baseDirectory: string | null = null

  const getBaseDirectory = async (): Promise<string> => {
    if (_baseDirectory !== null) {
      return _baseDirectory
    }
    const fs = await getFs()
    if (!fs.Paths) {
      throw new Error("Expo file-system Paths unavailable")
    }
    const baseDir = options.baseDirectory ?? fs.Paths.document
    _baseDirectory = getPathUri(baseDir)
    if (!_baseDirectory) {
      throw new Error("Expo file-system base directory unavailable")
    }
    return _baseDirectory
  }

  const access: FS.FileSystem["access"] = (path, _options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedPath = resolvePath(baseDir, path)

      const file = new fs.File(resolvedPath)
      if (file.exists) return

      const dir = new fs.Directory(resolvedPath)
      if (dir.exists) return

      yield* Effect.fail(makeSystemError("access", "NotFound", path))
    })

  const copy: FS.FileSystem["copy"] = (fromPath, toPath, _options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedFrom = resolvePath(baseDir, fromPath)
      const resolvedTo = resolvePath(baseDir, toPath)

      const sourceFile = new fs.File(resolvedFrom)
      if (sourceFile.exists) {
        const destFile = new fs.File(resolvedTo)
        yield* Effect.tryPromise({
          try: () => sourceFile.copy(destFile),
          catch: (cause) => makeSystemError("copy", "Unknown", fromPath, cause)
        })
        return
      }

      const sourceDir = new fs.Directory(resolvedFrom)
      if (sourceDir.exists) {
        const destDir = new fs.Directory(resolvedTo)
        yield* Effect.tryPromise({
          try: () => sourceDir.copy(destDir),
          catch: (cause) => makeSystemError("copy", "Unknown", fromPath, cause)
        })
        return
      }

      yield* Effect.fail(makeSystemError("copy", "NotFound", fromPath))
    })

  const copyFile: FS.FileSystem["copyFile"] = (fromPath, toPath) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedFrom = resolvePath(baseDir, fromPath)
      const resolvedTo = resolvePath(baseDir, toPath)

      const sourceFile = new fs.File(resolvedFrom)
      const destFile = new fs.File(resolvedTo)

      yield* Effect.tryPromise({
        try: () => sourceFile.copy(destFile),
        catch: (cause) => {
          if (!sourceFile.exists) {
            return makeSystemError("copyFile", "NotFound", fromPath, cause)
          }
          return makeSystemError("copyFile", "Unknown", fromPath, cause)
        }
      })
    })

  const chmod: FS.FileSystem["chmod"] = (_path, _mode) => Effect.void // Mobile doesn't support chmod

  const chown: FS.FileSystem["chown"] = (_path, _uid, _gid) => Effect.void // Mobile doesn't support chown

  const exists: FS.FileSystem["exists"] = (path) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const normalizedPath = normalizePath(path)

      // Build full path by joining base directory URI with the relative path
      const fullPath = normalizedPath
        ? `${baseDir.replace(/\/$/, "")}/${normalizedPath}`
        : baseDir

      const file = new fs.File(fullPath)
      if (file.exists) return true

      const dir = new fs.Directory(fullPath)
      return dir.exists
    })

  const link: FS.FileSystem["link"] = (_fromPath, _toPath) =>
    Effect.fail(
      makeSystemError("link", "Unknown", "", new Error("Expo does not support hard links"))
    )

  const makeDirectory: FS.FileSystem["makeDirectory"] = (path, options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const normalizedPath = normalizePath(path)

      // Build full path by joining base directory URI with the relative path
      const fullPath = normalizedPath
        ? `${baseDir.replace(/\/$/, "")}/${normalizedPath}`
        : baseDir

      const dir = new fs.Directory(fullPath)

      if (dir.exists) {
        return
      }

      yield* Effect.try({
        try: () => {
          // dir.create() may be sync or async depending on expo-file-system version
          const result = dir.create({ intermediates: options?.recursive ?? false })
          // If it returns a promise, we need to handle it, but Effect.try expects sync
          // For now, assume it's sync (expo-file-system v19 style)
          return result
        },
        catch: (cause) => makeSystemError("makeDirectory", "Unknown", path, cause)
      })
    })

  const makeTempDirectory: FS.FileSystem["makeTempDirectory"] = (options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const prefix = options?.prefix ?? "tmp"
      const tempName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
      if (!fs.Paths) {
        throw new Error("Expo file-system Paths unavailable")
      }
      const baseDir = options?.directory ?? fs.Paths.cache
      const tempPath = joinPath(baseDir, tempName)

      const dir = new fs.Directory(tempPath)
      yield* Effect.tryPromise({
        try: () => dir.create({ intermediates: true }),
        catch: (cause) => makeSystemError("makeTempDirectory", "Unknown", tempPath, cause)
      })

      return tempPath
    })

  const makeTempDirectoryScoped: FS.FileSystem["makeTempDirectoryScoped"] = (options) =>
    Effect.acquireRelease(makeTempDirectory(options), (path) => remove(path, { recursive: true }).pipe(Effect.ignore))

  const makeTempFile: FS.FileSystem["makeTempFile"] = (options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const prefix = options?.prefix ?? "tmp"
      const suffix = options?.suffix ?? ""
      const tempName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
      if (!fs.Paths) {
        throw new Error("Expo file-system Paths unavailable")
      }
      const baseDir = options?.directory ?? fs.Paths.cache
      const tempPath = joinPath(baseDir, tempName)

      const file = new fs.File(tempPath)
      yield* Effect.tryPromise({
        try: () => file.create(),
        catch: (cause) => makeSystemError("makeTempFile", "Unknown", tempPath, cause)
      })

      return tempPath
    })

  const makeTempFileScoped: FS.FileSystem["makeTempFileScoped"] = (options) =>
    Effect.acquireRelease(makeTempFile(options), (path) => remove(path).pipe(Effect.ignore))

  const open: FS.FileSystem["open"] = (_path, _options) =>
    Effect.fail(
      makeSystemError(
        "open",
        "Unknown",
        "",
        new Error("Expo open() not implemented - use readFile/writeFile")
      )
    )

  const readDirectory: FS.FileSystem["readDirectory"] = (path, options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedPath = resolvePath(baseDir, path)

      const dir = new fs.Directory(resolvedPath)
      if (!dir.exists) {
        yield* Effect.fail(makeSystemError("readDirectory", "NotFound", path))
      }

      const entries = dir.list()
      const result: Array<string> = []

      for (const entry of entries) {
        // Extract name from URI
        const name = entry.uri.split("/").pop() ?? ""
        result.push(name)

        // Handle recursion
        if (options?.recursive && "list" in entry) {
          const subEntries = yield* readDirectory(joinPath(path, name), options)
          for (const subEntry of subEntries) {
            result.push(joinPath(name, subEntry))
          }
        }
      }

      return result
    })

  const readFile: FS.FileSystem["readFile"] = (path) =>
    Effect.gen(function*() {
      console.log(`[ExpoFileSystem] readFile called with path: ${path}`)
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const normalizedPath = normalizePath(path)

      // Build full path by joining base directory URI with the relative path
      const fullPath = normalizedPath
        ? `${baseDir.replace(/\/$/, "")}/${normalizedPath}`
        : baseDir

      console.log(`[ExpoFileSystem] Full path: ${fullPath}`)
      const file = new fs.File(fullPath)
      console.log(`[ExpoFileSystem] File exists: ${file.exists}`)
      if (!file.exists) {
        console.log(`[ExpoFileSystem] File not found!`)
        return yield* Effect.fail(makeSystemError("readFile", "NotFound", path))
      }

      console.log(`[ExpoFileSystem] Calling file.bytes()...`)
      return yield* Effect.tryPromise({
        try: async () => {
          console.log(`[ExpoFileSystem] Inside try block, calling file.bytes()`)
          const result = await file.bytes()
          console.log(`[ExpoFileSystem] file.bytes() returned, length: ${result.length}`)
          return result
        },
        catch: (cause) => {
          console.error(`[ExpoFileSystem] file.bytes() failed:`, cause)
          return makeSystemError("readFile", "Unknown", path, cause)
        }
      })
    })

  const readFileString: FS.FileSystem["readFileString"] = (path, _encoding) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedPath = resolvePath(baseDir, path)

      const file = new fs.File(resolvedPath)
      if (!file.exists) {
        yield* Effect.fail(makeSystemError("readFileString", "NotFound", path))
      }

      return yield* Effect.tryPromise({
        try: () => file.text(),
        catch: (cause) => makeSystemError("readFileString", "Unknown", path, cause)
      })
    })

  const readLink: FS.FileSystem["readLink"] = (path) =>
    Effect.fail(
      makeSystemError(
        "readLink",
        "Unknown",
        path,
        new Error("Expo does not support symbolic links")
      )
    )

  const realPath: FS.FileSystem["realPath"] = (path) =>
    Effect.gen(function*() {
      const baseDir = yield* Effect.promise(getBaseDirectory)
      return resolvePath(baseDir, path)
    })

  const remove: FS.FileSystem["remove"] = (path, options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedPath = resolvePath(baseDir, path)

      // Try as file first
      const file = new fs.File(resolvedPath)
      if (file.exists) {
        yield* Effect.tryPromise({
          try: () => file.delete(),
          catch: (cause) => makeSystemError("remove", "Unknown", path, cause)
        })
        return
      }

      // Try as directory
      const dir = new fs.Directory(resolvedPath)
      if (dir.exists) {
        // Check if directory has contents and recursive not set
        if (!options?.recursive) {
          const contents = dir.list()
          if (contents.length > 0) {
            yield* Effect.fail(
              makeSystemError("remove", "Unknown", path, new Error("Directory not empty"))
            )
          }
        }
        yield* Effect.tryPromise({
          try: () => dir.delete(),
          catch: (cause) => makeSystemError("remove", "Unknown", path, cause)
        })
        return
      }

      // Not found - only fail if force is false
      if (!options?.force) {
        yield* Effect.fail(makeSystemError("remove", "NotFound", path))
      }
    })

  const rename: FS.FileSystem["rename"] = (oldPath, newPath) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedOld = resolvePath(baseDir, oldPath)
      const resolvedNew = resolvePath(baseDir, newPath)

      // Try as file first
      const file = new fs.File(resolvedOld)
      if (file.exists) {
        const destFile = new fs.File(resolvedNew)
        yield* Effect.tryPromise({
          try: () => file.move(destFile),
          catch: (cause) => makeSystemError("rename", "Unknown", oldPath, cause)
        })
        return
      }

      // Try as directory
      const dir = new fs.Directory(resolvedOld)
      if (dir.exists) {
        const destDir = new fs.Directory(resolvedNew)
        yield* Effect.tryPromise({
          try: () => dir.move(destDir),
          catch: (cause) => makeSystemError("rename", "Unknown", oldPath, cause)
        })
        return
      }

      yield* Effect.fail(makeSystemError("rename", "NotFound", oldPath))
    })

  const sink: FS.FileSystem["sink"] = (_path, _options) => {
    throw new Error("Expo sink() not implemented - use writeFile")
  }

  const stat: FS.FileSystem["stat"] = (path) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const normalizedPath = normalizePath(path)

      // Build full path by joining base directory URI with the relative path
      const fullPath = normalizedPath
        ? `${baseDir.replace(/\/$/, "")}/${normalizedPath}`
        : baseDir

      // Try as file first - check exists first, then type
      // Note: file.type may be null even for existing files in expo-file-system v19
      const file = new fs.File(fullPath)
      if (file.exists) {
        // If type is "file" or null (for files where type isn't determined), treat as file
        if (file.type === "file" || file.type === null) {
          return makeFileInfo("File", file.size ?? 0, file.modificationTime, file.creationTime)
        }
      }

      // Try as directory
      const dir = new fs.Directory(fullPath)
      if (dir.exists) {
        return makeFileInfo("Directory")
      }

      return yield* Effect.fail(makeSystemError("stat", "NotFound", path))
    })

  const stream: FS.FileSystem["stream"] = (path, _options) =>
    Stream.fromEffect(readFile(path)).pipe(Stream.flatMap(Stream.make))

  const symlink: FS.FileSystem["symlink"] = (_fromPath, _toPath) =>
    Effect.fail(
      makeSystemError("symlink", "Unknown", "", new Error("Expo does not support symbolic links"))
    )

  const truncate: FS.FileSystem["truncate"] = (path, length) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const resolvedPath = resolvePath(baseDir, path)

      const file = new fs.File(resolvedPath)
      if (!file.exists) {
        yield* Effect.fail(makeSystemError("truncate", "NotFound", path))
      }

      // Read current content, truncate, and write back
      const currentBytes = yield* Effect.tryPromise({
        try: () => file.bytes(),
        catch: (cause) => makeSystemError("truncate", "Unknown", path, cause)
      })

      const targetLength = Number(length ?? 0n)
      const truncatedBytes = currentBytes.slice(0, targetLength)

      yield* Effect.tryPromise({
        try: () => file.write(truncatedBytes),
        catch: (cause) => makeSystemError("truncate", "Unknown", path, cause)
      })
    })

  const utimes: FS.FileSystem["utimes"] = (_path, _atime, _mtime) => Effect.void // Expo doesn't support utimes

  const watch: FS.FileSystem["watch"] = (_path, _options) =>
    Stream.fail(
      makeSystemError("watch", "Unknown", "", new Error("Expo does not support file watching"))
    )

  const writeFile: FS.FileSystem["writeFile"] = (path, data, _options) =>
    Effect.gen(function*() {
      const fs = yield* Effect.promise(getFs)
      const baseDir = yield* Effect.promise(getBaseDirectory)
      const normalizedPath = normalizePath(path)

      const segments = normalizedPath.length > 0 ? normalizedPath.split("/") : []
      const filename = segments.pop() ?? ""
      if (!filename) {
        return yield* Effect.fail(makeSystemError("writeFile", "InvalidData", path))
      }

      // Build directory path by joining base directory URI with the relative directory segments
      const dirPath = segments.length > 0
        ? `${baseDir.replace(/\/$/, "")}/${segments.join("/")}`
        : baseDir

      const dir = new fs.Directory(dirPath)
      if (!dir.exists) {
        yield* Effect.try({
          try: () => dir.create({ intermediates: true }),
          catch: (cause) => makeSystemError("writeFile", "Unknown", path, cause)
        })
      }

      // Build full file path
      const filePath = `${dirPath.replace(/\/$/, "")}/${filename}`
      const file = new fs.File(filePath)
      yield* Effect.try({
        try: () => file.write(data),
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
 * Layer that provides the Expo FileSystem implementation
 */
export const layer = (options: ExpoFileSystemOptions = {}): Layer.Layer<FS.FileSystem> =>
  Layer.succeed(FileSystem, makeExpoFileSystem(options))

/**
 * Default Expo FileSystem layer (uses Paths.document as base directory)
 */
export const layerDefault: Layer.Layer<FS.FileSystem> = layer()
