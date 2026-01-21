/**
 * LocalFileStorage Service
 *
 * Provides an Effect-based abstraction over a pluggable FileSystem service.
 * This service handles local file operations including reading, writing,
 * deleting, and listing files, with optional metadata preservation.
 *
 * @module
 */

import { FileSystem } from "@effect/platform/FileSystem"
import type * as FS from "@effect/platform/FileSystem"
import { Context, Effect, Layer } from "effect"
import { DirectoryNotFoundError, FileNotFoundError, StorageError } from "../../errors/index.js"
import { MemoryFile } from "../../utils/MemoryFile.js"
import { joinPath, parsePath } from "../../utils/path.js"

interface FileMetadata {
  readonly type?: string
  readonly lastModified?: number
}

const META_SUFFIX = ".meta.json"

const metadataPath = (path: string): string => `${path}${META_SUFFIX}`

/**
 * LocalFileStorage service interface
 */
export interface LocalFileStorageService {
  /**
   * Write a file at the specified path
   * Creates parent directories as needed
   */
  readonly writeFile: (path: string, file: File) => Effect.Effect<void, StorageError>

  /**
   * Write raw bytes at the specified path
   * Creates parent directories as needed
   */
  readonly writeBytes: (path: string, data: Uint8Array, mimeType?: string) => Effect.Effect<void, StorageError>

  /**
   * Read a file
   */
  readonly readFile: (path: string) => Effect.Effect<File, FileNotFoundError | StorageError>

  /**
   * Read raw bytes
   */
  readonly readBytes: (path: string) => Effect.Effect<Uint8Array, FileNotFoundError | StorageError>

  /**
   * Check if a file exists
   */
  readonly fileExists: (path: string) => Effect.Effect<boolean, StorageError>

  /**
   * Delete a file
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
  readonly listFiles: (directory: string) => Effect.Effect<Array<string>, DirectoryNotFoundError | StorageError>
}

/**
 * LocalFileStorage service tag
 */
export class LocalFileStorage extends Context.Tag("LocalFileStorage")<
  LocalFileStorage,
  LocalFileStorageService
>() {}

const encodeMetadata = (metadata: FileMetadata): Uint8Array => new TextEncoder().encode(JSON.stringify(metadata))

const decodeMetadata = (data: Uint8Array): FileMetadata => {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as FileMetadata
  } catch {
    return {}
  }
}

const ensureParentDirectory = (fs: FS.FileSystem, path: string) =>
  Effect.gen(function*() {
    const { directory } = parsePath(path)
    if (!directory) return
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to create directory: ${directory}`,
            cause: error
          })
      )
    )
  })

const readMetadataFile = (
  fs: FS.FileSystem,
  path: string
): Effect.Effect<FileMetadata | null, StorageError> =>
  Effect.gen(function*() {
    const metaPath = metadataPath(path)
    const exists = yield* fs.exists(metaPath).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to check metadata: ${metaPath}`,
            cause: error
          })
      )
    )
    if (!exists) return null
    const data = yield* fs.readFile(metaPath).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to read metadata: ${metaPath}`,
            cause: error
          })
      )
    )
    return decodeMetadata(data)
  })

const writeMetadataFile = (
  fs: FS.FileSystem,
  path: string,
  metadata: FileMetadata
) =>
  Effect.gen(function*() {
    const metaPath = metadataPath(path)
    yield* fs.writeFile(metaPath, encodeMetadata(metadata)).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to write metadata: ${metaPath}`,
            cause: error
          })
      )
    )
  })

const removeMetadataFile = (fs: FS.FileSystem, path: string): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const metaPath = metadataPath(path)
    const exists = yield* fs.exists(metaPath).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to check metadata: ${metaPath}`,
            cause: error
          })
      )
    )
    if (!exists) return
    yield* fs.remove(metaPath).pipe(
      Effect.mapError(
        (error) =>
          new StorageError({
            message: `Failed to remove metadata: ${metaPath}`,
            cause: error
          })
      )
    )
  })

/**
 * Create the live LocalFileStorage service implementation
 */
const make = (): Effect.Effect<LocalFileStorageService, never, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem

    const writeFile = (path: string, file: File): Effect.Effect<void, StorageError> =>
      Effect.gen(function*() {
        yield* ensureParentDirectory(fs, path)

        const buffer = yield* Effect.tryPromise({
          try: () => file.arrayBuffer(),
          catch: (error) =>
            new StorageError({
              message: `Failed to read file data: ${path}`,
              cause: error
            })
        })

        yield* fs.writeFile(path, new Uint8Array(buffer)).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to write file: ${path}`,
                cause: error
              })
          )
        )

        const metadata: FileMetadata = {
          ...(file.type ? { type: file.type } : {}),
          ...(typeof file.lastModified === "number" ? { lastModified: file.lastModified } : {})
        }

        yield* writeMetadataFile(fs, path, metadata)
      })

    const writeBytes = (
      path: string,
      data: Uint8Array,
      mimeType = "application/octet-stream"
    ): Effect.Effect<void, StorageError> =>
      Effect.gen(function*() {
        yield* ensureParentDirectory(fs, path)
        yield* fs.writeFile(path, data).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to write bytes: ${path}`,
                cause: error
              })
          )
        )
        yield* writeMetadataFile(fs, path, { type: mimeType, lastModified: Date.now() })
      })

    const readBytes = (path: string): Effect.Effect<Uint8Array, FileNotFoundError | StorageError> =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to check file existence: ${path}`,
                cause: error
              })
          )
        )
        if (!exists) {
          return yield* Effect.fail(new FileNotFoundError({ path }))
        }
        return yield* fs.readFile(path).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to read bytes: ${path}`,
                cause: error
              })
          )
        )
      })

    const readFile = (path: string): Effect.Effect<File, FileNotFoundError | StorageError> =>
      Effect.gen(function*() {
        const data = yield* readBytes(path)
        const metadata = yield* readMetadataFile(fs, path)
        const { filename } = parsePath(path)
        const mimeType = metadata?.type || "application/octet-stream"

        // Try native File constructor first (works in browsers)
        try {
          // Create a proper ArrayBuffer copy from the Uint8Array for the File constructor
          const buffer = new ArrayBuffer(data.byteLength)
          new Uint8Array(buffer).set(data)
          return new File([buffer], filename, {
            type: mimeType,
            ...(metadata?.lastModified !== undefined ? { lastModified: metadata.lastModified } : {})
          })
        } catch {
          // React Native's Blob/File constructors don't support ArrayBuffer/Uint8Array
          // Use MemoryFile which implements the Blob interface and works everywhere
          return new MemoryFile(
            data,
            filename,
            mimeType,
            metadata?.lastModified !== undefined ? { lastModified: metadata.lastModified } : undefined
          ) as unknown as File
        }
      })

    const fileExists = (path: string): Effect.Effect<boolean, StorageError> =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to check file existence: ${path}`,
                cause: error
              })
          )
        )
        if (!exists) return false
        const stat = yield* fs.stat(path).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to stat path: ${path}`,
                cause: error
              })
          )
        )
        return stat.type === "File"
      })

    const deleteFile = (path: string): Effect.Effect<void, StorageError> =>
      Effect.gen(function*() {
        const exists = yield* fileExists(path)
        if (exists) {
          yield* fs.remove(path).pipe(
            Effect.mapError(
              (error) =>
                new StorageError({
                  message: `Failed to delete file: ${path}`,
                  cause: error
                })
            )
          )
        }

        yield* removeMetadataFile(fs, path)
      })

    const getFileUrl = (path: string): Effect.Effect<string, FileNotFoundError | StorageError> =>
      Effect.gen(function*() {
        // In React Native, URL.createObjectURL isn't fully functional
        // Detect React Native by checking for navigator.product or lack of document
        const isReactNative = typeof navigator !== "undefined" && navigator.product === "ReactNative"
        const isNonBrowser = typeof document === "undefined"
        
        if (isReactNative || isNonBrowser) {
          const realFilePath = yield* fs.realPath(path).pipe(
            Effect.mapError(
              (error) =>
                new StorageError({
                  message: `Failed to resolve real path: ${path}`,
                  cause: error
                })
            )
          )
          return realFilePath
        }
        const file = yield* readFile(path)
        return URL.createObjectURL(file)
      })

    const listFiles = (
      directory: string
    ): Effect.Effect<Array<string>, DirectoryNotFoundError | StorageError> =>
      Effect.gen(function*() {
        const shouldCheckExists = directory !== "" && directory !== "."
        const exists = shouldCheckExists
          ? yield* fs.exists(directory).pipe(
            Effect.mapError(
              (error) =>
                new StorageError({
                  message: `Failed to check directory: ${directory}`,
                  cause: error
                })
            )
          )
          : true
        if (!exists && shouldCheckExists) {
          return yield* Effect.fail(new DirectoryNotFoundError({ path: directory }))
        }
        const files = yield* listFilesRecursive(directory)
        return files.filter((path) => !path.endsWith(META_SUFFIX))
      })

    const listFilesRecursive = (directory: string): Effect.Effect<Array<string>, StorageError> =>
      Effect.gen(function*() {
        const entries = yield* fs.readDirectory(directory).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: `Failed to list files in directory: ${directory}`,
                cause: error
              })
          )
        )

        const files: Array<string> = []
        for (const entry of entries) {
          const entryPath = joinPath(directory, entry)
          const stat = yield* fs.stat(entryPath).pipe(
            Effect.mapError(
              (error) =>
                new StorageError({
                  message: `Failed to stat path: ${entryPath}`,
                  cause: error
                })
            )
          )
          if (stat.type === "File") {
            files.push(entryPath)
          } else {
            const subFiles = yield* listFilesRecursive(entryPath)
            for (const subFile of subFiles) {
              files.push(subFile)
            }
          }
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
  })

/**
 * Live layer for LocalFileStorage using FileSystem
 */
export const LocalFileStorageLive = Layer.effect(LocalFileStorage, make())
