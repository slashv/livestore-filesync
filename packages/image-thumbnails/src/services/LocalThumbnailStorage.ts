/**
 * LocalThumbnailStorage Service
 *
 * Handles storing and retrieving thumbnails from local storage (OPFS).
 * Uses the same FileSystem adapter as the core package.
 *
 * Storage path: thumbnails/{contentHash}/{sizeName}.{format}
 *
 * @module
 */

import { FileSystem } from "@effect/platform/FileSystem"
import type * as FS from "@effect/platform/FileSystem"
import { Context, Effect, Layer } from "effect"

import { ThumbnailFileNotFoundError, ThumbnailStorageError } from "../errors/index.js"
import type { ThumbnailFormat } from "../types/index.js"

// ============================================
// Service Interface
// ============================================

/**
 * LocalThumbnailStorage service interface
 */
export interface LocalThumbnailStorageService {
  /**
   * Write a thumbnail to storage
   */
  readonly writeThumbnail: (
    contentHash: string,
    sizeName: string,
    format: ThumbnailFormat,
    data: Uint8Array
  ) => Effect.Effect<string, ThumbnailStorageError>

  /**
   * Read a thumbnail from storage
   */
  readonly readThumbnail: (
    contentHash: string,
    sizeName: string,
    format: ThumbnailFormat
  ) => Effect.Effect<Uint8Array, ThumbnailFileNotFoundError | ThumbnailStorageError>

  /**
   * Check if a thumbnail exists
   */
  readonly thumbnailExists: (
    contentHash: string,
    sizeName: string,
    format: ThumbnailFormat
  ) => Effect.Effect<boolean, ThumbnailStorageError>

  /**
   * Get a URL for a thumbnail (for use in img.src, etc.)
   * Caller is responsible for revoking the URL when done
   */
  readonly getThumbnailUrl: (
    contentHash: string,
    sizeName: string,
    format: ThumbnailFormat
  ) => Effect.Effect<string, ThumbnailFileNotFoundError | ThumbnailStorageError>

  /**
   * Delete all thumbnails for a content hash
   */
  readonly deleteThumbnails: (contentHash: string) => Effect.Effect<void, ThumbnailStorageError>

  /**
   * Get the storage path for a thumbnail
   */
  readonly getThumbnailPath: (
    contentHash: string,
    sizeName: string,
    format: ThumbnailFormat
  ) => string
}

/**
 * LocalThumbnailStorage service tag
 */
export class LocalThumbnailStorage extends Context.Tag("LocalThumbnailStorage")<
  LocalThumbnailStorage,
  LocalThumbnailStorageService
>() {}

// ============================================
// Implementation
// ============================================

const THUMBNAILS_DIR = "thumbnails"

/**
 * Join path segments
 */
const joinPath = (...segments: Array<string>): string =>
  segments
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")

/**
 * Ensure a directory exists, creating it if necessary
 */
const ensureDirectory = (fs: FS.FileSystem, path: string): Effect.Effect<void, ThumbnailStorageError> =>
  fs.makeDirectory(path, { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new ThumbnailStorageError({
          message: `Failed to create directory: ${path}`,
          cause: error
        })
    )
  )

/**
 * Create the LocalThumbnailStorage service
 */
const make = (): Effect.Effect<LocalThumbnailStorageService, never, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem

    const getThumbnailPath = (
      contentHash: string,
      sizeName: string,
      format: ThumbnailFormat
    ): string => joinPath(THUMBNAILS_DIR, contentHash, `${sizeName}.${format}`)

    const getDirectoryPath = (contentHash: string): string => joinPath(THUMBNAILS_DIR, contentHash)

    const writeThumbnail: LocalThumbnailStorageService["writeThumbnail"] = (
      contentHash,
      sizeName,
      format,
      data
    ) =>
      Effect.gen(function*() {
        const path = getThumbnailPath(contentHash, sizeName, format)
        const dirPath = getDirectoryPath(contentHash)

        // Ensure directory exists
        yield* ensureDirectory(fs, dirPath)

        // Write the file
        yield* fs.writeFile(path, data).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to write thumbnail: ${path}`,
                cause: error
              })
          )
        )

        return path
      })

    const readThumbnail: LocalThumbnailStorageService["readThumbnail"] = (
      contentHash,
      sizeName,
      format
    ) =>
      Effect.gen(function*() {
        const path = getThumbnailPath(contentHash, sizeName, format)

        // Check if file exists
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to check thumbnail existence: ${path}`,
                cause: error
              })
          )
        )

        if (!exists) {
          return yield* Effect.fail(new ThumbnailFileNotFoundError({ path }))
        }

        // Read the file
        return yield* fs.readFile(path).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to read thumbnail: ${path}`,
                cause: error
              })
          )
        )
      })

    const thumbnailExists: LocalThumbnailStorageService["thumbnailExists"] = (
      contentHash,
      sizeName,
      format
    ) =>
      Effect.gen(function*() {
        const path = getThumbnailPath(contentHash, sizeName, format)
        return yield* fs.exists(path).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to check thumbnail existence: ${path}`,
                cause: error
              })
          )
        )
      })

    const getThumbnailUrl: LocalThumbnailStorageService["getThumbnailUrl"] = (
      contentHash,
      sizeName,
      format
    ) =>
      Effect.gen(function*() {
        const data = yield* readThumbnail(contentHash, sizeName, format)
        const mimeType = `image/${format}`
        // Convert to regular ArrayBuffer if it's a SharedArrayBuffer
        const arrayBuffer = data.buffer instanceof SharedArrayBuffer
          ? new Uint8Array(data).buffer
          : data.buffer
        const blob = new Blob([new Uint8Array(arrayBuffer as ArrayBuffer)], { type: mimeType })
        return URL.createObjectURL(blob)
      })

    const deleteThumbnails: LocalThumbnailStorageService["deleteThumbnails"] = (contentHash) =>
      Effect.gen(function*() {
        const dirPath = getDirectoryPath(contentHash)

        // Check if directory exists
        const exists = yield* fs.exists(dirPath).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to check directory existence: ${dirPath}`,
                cause: error
              })
          )
        )

        if (!exists) {
          return
        }

        // Remove directory recursively
        yield* fs.remove(dirPath, { recursive: true }).pipe(
          Effect.mapError(
            (error) =>
              new ThumbnailStorageError({
                message: `Failed to delete thumbnails directory: ${dirPath}`,
                cause: error
              })
          )
        )
      })

    return {
      writeThumbnail,
      readThumbnail,
      thumbnailExists,
      getThumbnailUrl,
      deleteThumbnails,
      getThumbnailPath
    }
  })

// ============================================
// Layer
// ============================================

/**
 * Live layer for LocalThumbnailStorage
 */
export const LocalThumbnailStorageLive: Layer.Layer<LocalThumbnailStorage, never, FileSystem> = Layer.effect(
  LocalThumbnailStorage,
  make()
)
