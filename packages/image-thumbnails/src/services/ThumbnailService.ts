/**
 * ThumbnailService - Main Orchestration Service
 *
 * Coordinates thumbnail generation:
 * - Watches files table for image files
 * - Queues generation jobs to worker
 * - Stores generated thumbnails in local storage
 * - Updates thumbnail state client document
 * - Handles cleanup when files are deleted
 *
 * Only runs on the leader tab (via LiveStore's leader election).
 *
 * @module
 */

import { FileSystem } from "@effect/platform/FileSystem"
import type { Store } from "@livestore/livestore"
import { Context, Effect, Fiber, Layer, Queue, Ref } from "effect"

import type { ThumbnailTables } from "../schema/index.js"
import type {
  FilesTable,
  FileThumbnailState,
  QueryDbFn,
  ThumbnailEvent,
  ThumbnailFormat,
  ThumbnailGenerationStatus,
  ThumbnailSizes,
  ThumbnailSizeState,
  ThumbnailStateDocument
} from "../types/index.js"
import { isSupportedImageMimeType } from "../types/index.js"
import { LocalThumbnailStorage } from "./LocalThumbnailStorage.js"
import type { GeneratedThumbnails } from "./ThumbnailWorkerClient.js"
import { ThumbnailWorkerClient } from "./ThumbnailWorkerClient.js"

// ============================================
// Service Interface
// ============================================

/**
 * File record from the files table
 */
export interface FileRecord {
  id: string
  path: string
  contentHash: string
  remoteKey: string
  deletedAt: Date | null
}

/**
 * ThumbnailService configuration
 */
export interface ThumbnailServiceConfig {
  sizes: ThumbnailSizes
  format: ThumbnailFormat
  concurrency: number
  supportedMimeTypes: Array<string>
  onEvent?: ((event: ThumbnailEvent) => void) | undefined
  /**
   * Interval in milliseconds to poll for new files.
   * Set to 0 to disable polling (default: 2000).
   */
  pollInterval?: number | undefined
  /**
   * The queryDb function from the app's schema.
   * Required for querying files.
   */
  queryDb?: QueryDbFn | undefined
  /**
   * The files table from @livestore-filesync/core.
   * Required for querying files.
   */
  filesTable?: FilesTable | undefined
}

/**
 * ThumbnailService service interface
 */
export interface ThumbnailServiceService {
  /**
   * Get a thumbnail URL, falling back to the original file URL if not available
   */
  readonly resolveThumbnailUrl: (
    fileId: string,
    size: string
  ) => Effect.Effect<string | null>

  /**
   * Get the state for a file's thumbnails
   */
  readonly getThumbnailState: (fileId: string) => Effect.Effect<FileThumbnailState | null>

  /**
   * Regenerate thumbnails for a file
   */
  readonly regenerate: (fileId: string) => Effect.Effect<void>

  /**
   * Start the thumbnail service
   */
  readonly start: () => Effect.Effect<void>

  /**
   * Stop the thumbnail service
   */
  readonly stop: () => Effect.Effect<void>
}

/**
 * ThumbnailService service tag
 */
export class ThumbnailService extends Context.Tag("ThumbnailService")<
  ThumbnailService,
  ThumbnailServiceService
>() {}

// ============================================
// Queue Item Types
// ============================================

interface GenerationQueueItem {
  fileId: string
  contentHash: string
  path: string
  mimeType: string
}

// ============================================
// Implementation
// ============================================

/**
 * Get file's MIME type from its path
 */
const getMimeTypeFromPath = (path: string): string | null => {
  const ext = path.split(".").pop()?.toLowerCase()
  if (!ext) return null

  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff"
  }

  return mimeMap[ext] ?? null
}

/**
 * Create the ThumbnailService
 */
export const makeThumbnailService = (
  store: Store<any>,
  tables: ThumbnailTables,
  config: ThumbnailServiceConfig
): Effect.Effect<
  ThumbnailServiceService,
  never,
  ThumbnailWorkerClient | LocalThumbnailStorage | FileSystem
> =>
  Effect.gen(function*() {
    const workerClient = yield* ThumbnailWorkerClient
    const storage = yield* LocalThumbnailStorage
    const fs = yield* FileSystem

    // State
    const isRunningRef = yield* Ref.make(false)
    const processingFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null)
    const generationQueue = yield* Queue.unbounded<GenerationQueueItem>()

    // Helper to emit events
    const emitEvent = (event: ThumbnailEvent): void => {
      config.onEvent?.(event)
    }

    // Helper to read thumbnail state
    const readThumbnailState = (): ThumbnailStateDocument => {
      const result = store.query(tables.thumbnailState.get())
      return result ?? { files: {} }
    }

    // Helper to update thumbnail state
    const updateThumbnailState = (
      updater: (state: ThumbnailStateDocument) => ThumbnailStateDocument
    ): void => {
      const currentState = readThumbnailState()
      const newState = updater(currentState)
      // Use the .set event directly, passing the value contents (not wrapped in { value: ... })
      store.commit(tables.thumbnailState.set(newState))
    }

    // Helper to update a single file's thumbnail state
    const updateFileThumbnailState = (
      fileId: string,
      updater: (state: FileThumbnailState | undefined) => FileThumbnailState | undefined
    ): void => {
      updateThumbnailState((state) => {
        const fileState = state.files[fileId]
        const newFileState = updater(fileState)

        if (newFileState === undefined) {
          // Remove the file state
          const { [fileId]: _, ...rest } = state.files
          return { files: rest }
        }

        return {
          files: {
            ...state.files,
            [fileId]: newFileState
          }
        }
      })
    }

    // Helper to read local file
    const readLocalFile = (path: string): Effect.Effect<ArrayBuffer | null> =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!exists) return null

        const data = yield* fs.readFile(path).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (!data) return null

        // Convert to regular ArrayBuffer if it's a SharedArrayBuffer
        if (data.buffer instanceof SharedArrayBuffer) {
          const arrayBuffer = new ArrayBuffer(data.byteLength)
          new Uint8Array(arrayBuffer).set(data)
          return arrayBuffer
        }
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      })

    // Process a single generation request
    const processGenerationItem = (item: GenerationQueueItem): Effect.Effect<void> =>
      Effect.gen(function*() {
        const { contentHash, fileId, mimeType, path } = item
        const sizeNames = Object.keys(config.sizes)

        emitEvent({
          type: "thumbnail:generation-started",
          fileId,
          sizes: sizeNames
        })

        // Update status to generating
        updateFileThumbnailState(fileId, (state) => {
          if (!state) {
            const sizes: Record<string, ThumbnailSizeState> = {}
            for (const sizeName of sizeNames) {
              sizes[sizeName] = { status: "generating" }
            }
            return { fileId, contentHash, mimeType, sizes }
          }

          const newSizes = { ...state.sizes }
          for (const sizeName of sizeNames) {
            newSizes[sizeName] = { status: "generating" }
          }
          return { ...state, contentHash, sizes: newSizes }
        })

        // Read the file from local storage
        // The path format is: files/{storeId}/{contentHash}
        const fileData = yield* readLocalFile(path)

        if (!fileData) {
          // File not available locally, mark as pending to retry later
          updateFileThumbnailState(fileId, (state) => {
            if (!state) return undefined
            const newSizes = { ...state.sizes }
            for (const sizeName of sizeNames) {
              newSizes[sizeName] = { status: "pending" }
            }
            return { ...state, sizes: newSizes }
          })
          return
        }

        // Generate thumbnails via worker
        const result = yield* workerClient
          .generate(fileData, path, contentHash, config.sizes, config.format)
          .pipe(
            Effect.catchAll((error) =>
              Effect.succeed<GeneratedThumbnails | null>(null).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const errorMessage = error instanceof Error ? error.message : String(error)
                    emitEvent({
                      type: "thumbnail:generation-error",
                      fileId,
                      error: errorMessage
                    })

                    // Update state to error
                    updateFileThumbnailState(fileId, (state) => {
                      if (!state) return undefined
                      const newSizes = { ...state.sizes }
                      for (const sizeName of sizeNames) {
                        newSizes[sizeName] = { status: "error", error: errorMessage }
                      }
                      return { ...state, sizes: newSizes }
                    })
                  })
                )
              )
            )
          )

        if (!result) return

        // Store thumbnails
        for (const thumbnail of result.thumbnails) {
          const thumbnailPath = yield* storage
            .writeThumbnail(contentHash, thumbnail.sizeName, config.format, new Uint8Array(thumbnail.data))
            .pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)))

          if (thumbnailPath) {
            // Update state to done
            updateFileThumbnailState(fileId, (state) => {
              if (!state) return undefined
              const newSizes = { ...state.sizes }
              newSizes[thumbnail.sizeName] = {
                status: "done",
                path: thumbnailPath,
                generatedAt: Date.now()
              }
              return { ...state, sizes: newSizes }
            })
          }
        }

        emitEvent({
          type: "thumbnail:generation-completed",
          fileId,
          sizes: sizeNames
        })
      })

    // Worker loop that processes the queue
    const workerLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Process up to `concurrency` items in parallel
        const items: Array<GenerationQueueItem> = []

        // Take items from queue
        for (let i = 0; i < config.concurrency; i++) {
          const item = yield* Queue.poll(generationQueue)
          if (item._tag === "Some") {
            items.push(item.value)
          } else {
            break
          }
        }

        if (items.length === 0) {
          // No items, wait a bit before checking again
          yield* Effect.sleep("500 millis")
          return
        }

        // Process items in parallel
        yield* Effect.all(items.map(processGenerationItem), { concurrency: "unbounded" })
      }).pipe(
        Effect.forever,
        Effect.catchAll(() => Effect.void)
      )

    // Queue a file for thumbnail generation
    const queueFile = (file: FileRecord): Effect.Effect<void> =>
      Effect.gen(function*() {
        const mimeType = getMimeTypeFromPath(file.path)

        if (!mimeType || !isSupportedImageMimeType(mimeType)) {
          // Not an image, mark as skipped
          updateFileThumbnailState(file.id, () => ({
            fileId: file.id,
            contentHash: file.contentHash,
            mimeType: mimeType ?? "unknown",
            sizes: Object.fromEntries(
              Object.keys(config.sizes).map((sizeName) => [
                sizeName,
                { status: "skipped" as ThumbnailGenerationStatus }
              ])
            )
          }))
          return
        }

        // Check if thumbnails already exist with matching content hash
        const existingState = readThumbnailState().files[file.id]
        if (existingState && existingState.contentHash === file.contentHash) {
          // Check if all sizes are done
          const allDone = Object.keys(config.sizes).every(
            (sizeName) => existingState.sizes[sizeName]?.status === "done"
          )
          if (allDone) return
        }

        // Initialize state as queued
        const sizes: Record<string, ThumbnailSizeState> = {}
        for (const sizeName of Object.keys(config.sizes)) {
          sizes[sizeName] = { status: "queued" }
        }
        updateFileThumbnailState(file.id, () => ({
          fileId: file.id,
          contentHash: file.contentHash,
          mimeType,
          sizes
        }))

        // Add to queue
        // Use the file's path directly - it's already the full storage path
        yield* Queue.offer(generationQueue, {
          fileId: file.id,
          contentHash: file.contentHash,
          path: file.path,
          mimeType
        })
      })

    // Clean up thumbnails for a deleted file
    // TODO: Wire this up to file deletion events from LiveStore
    const _cleanupFile = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const state = readThumbnailState().files[fileId]
        if (!state) return

        // Delete thumbnail files
        yield* storage.deleteThumbnails(state.contentHash).pipe(Effect.catchAll(() => Effect.void))

        // Remove from state
        updateFileThumbnailState(fileId, () => undefined)

        emitEvent({
          type: "thumbnail:cleanup",
          fileId
        })
      })

    // Scan existing files and queue those missing thumbnails
    const scanExistingFiles = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Query all non-deleted files from the files table
        if (!config.queryDb || !config.filesTable) {
          // Can't query files without queryDb and filesTable
          return
        }

        try {
          const files = store.query<Array<FileRecord>>(
            config.queryDb(config.filesTable.select())
          )

          for (const file of files) {
            if (file.deletedAt) continue
            yield* queueFile(file)
          }
        } catch (error) {
          // Table might not exist yet, or query failed
          console.warn("[ThumbnailService] Failed to query files:", error)
        }
      })

    // Service methods
    const resolveThumbnailUrl: ThumbnailServiceService["resolveThumbnailUrl"] = (fileId, size) =>
      Effect.gen(function*() {
        const state = readThumbnailState().files[fileId]
        if (!state) return null

        const sizeState = state.sizes[size]
        if (!sizeState || sizeState.status !== "done" || !sizeState.path) {
          return null
        }

        // Get URL from storage
        return yield* storage
          .getThumbnailUrl(state.contentHash, size, config.format)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      })

    const getThumbnailState: ThumbnailServiceService["getThumbnailState"] = (fileId) =>
      Effect.sync(() => readThumbnailState().files[fileId] ?? null)

    const regenerate: ThumbnailServiceService["regenerate"] = (fileId) =>
      Effect.gen(function*() {
        if (!config.queryDb || !config.filesTable) {
          return
        }

        // Get the file record
        try {
          const files = store.query<Array<FileRecord>>(
            config.queryDb(config.filesTable.where({ id: fileId }))
          )

          const file = files.find((f) => !f.deletedAt)
          if (!file) return

          const state = readThumbnailState().files[fileId]

          // Delete existing thumbnails if content hash changed
          if (state && state.contentHash !== file.contentHash) {
            yield* storage.deleteThumbnails(state.contentHash).pipe(Effect.catchAll(() => Effect.void))
          }

          // Queue for regeneration
          yield* queueFile(file)
        } catch {
          // Ignore errors
        }
      })

    // Polling loop to scan for new files
    const pollForNewFiles = (intervalMs: number): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* Effect.sleep(`${intervalMs} millis`)
        yield* scanExistingFiles()
      }).pipe(
        Effect.forever,
        Effect.catchAll(() => Effect.void)
      )

    const start: ThumbnailServiceService["start"] = () =>
      Effect.gen(function*() {
        const isRunning = yield* Ref.get(isRunningRef)
        if (isRunning) return

        yield* Ref.set(isRunningRef, true)

        // Wait for worker to be ready
        yield* workerClient.waitForReady().pipe(Effect.catchAll(() => Effect.void))

        // Scan existing files
        yield* scanExistingFiles()

        // Start the worker loop
        const workerFiber = yield* workerLoop().pipe(Effect.fork)
        yield* Ref.set(processingFiberRef, workerFiber)

        // Start polling for new files if enabled
        const pollInterval = config.pollInterval ?? 2000
        if (pollInterval > 0) {
          yield* pollForNewFiles(pollInterval).pipe(Effect.forkDaemon)
        }

        // Mark _cleanupFile as intentionally unused for now (to be wired up later)
        void _cleanupFile
      })

    const stop: ThumbnailServiceService["stop"] = () =>
      Effect.gen(function*() {
        yield* Ref.set(isRunningRef, false)

        const fiber = yield* Ref.get(processingFiberRef)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
          yield* Ref.set(processingFiberRef, null)
        }
      })

    return {
      resolveThumbnailUrl,
      getThumbnailState,
      regenerate,
      start,
      stop
    }
  })

// ============================================
// Layer
// ============================================

/**
 * Create a live layer for ThumbnailService
 */
export const ThumbnailServiceLive = (
  store: Store<any>,
  tables: ThumbnailTables,
  config: ThumbnailServiceConfig
): Layer.Layer<ThumbnailService, never, ThumbnailWorkerClient | LocalThumbnailStorage | FileSystem> =>
  Layer.effect(ThumbnailService, makeThumbnailService(store, tables, config))
