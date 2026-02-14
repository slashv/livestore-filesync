/**
 * ThumbnailService - Main Orchestration Service
 *
 * Coordinates thumbnail generation:
 * - Watches files table for image files
 * - Queues generation jobs to worker
 * - Stores generated thumbnails in local storage
 * - Updates thumbnail state in SQLite tables
 * - Handles cleanup when files are deleted
 *
 * Only runs on the leader tab (via LiveStore's leader election).
 *
 * ARCHITECTURE NOTE: Uses SQLite tables with clientOnly events instead of
 * clientDocument with Schema.Record to prevent rebase conflicts during
 * concurrent multi-tab operations.
 * See: https://github.com/livestorejs/livestore/issues/998
 *
 * @module
 */

import { FileSystem } from "@effect/platform/FileSystem"
import { queryDb } from "@livestore/livestore"
import type { Store } from "@livestore/livestore"
import { Context, Effect, Fiber, Layer, Queue, Ref } from "effect"

import type { ThumbnailEvents, ThumbnailTables } from "../schema/index.js"
import type {
  FilesTable,
  FileThumbnailState,
  ThumbnailEvent,
  ThumbnailFormat,
  ThumbnailGenerationStatus,
  ThumbnailQualitySettings,
  ThumbnailSizes,
  ThumbnailSizeState
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
 * Row type for the thumbnailState table
 */
interface ThumbnailStateTableRow {
  fileId: string
  contentHash: string
  mimeType: string
  sizesJson: string
}

/**
 * Row type for the thumbnailConfig table
 */
interface ThumbnailConfigTableRow {
  id: string
  configHash: string
  sizesJson: string
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
   * Quality settings for thumbnail generation.
   */
  qualitySettings?: ThumbnailQualitySettings | undefined
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

interface ScanAccumulator {
  knownMissingFileIds: Set<string>
  pendingStatesByFileId: Map<string, FileThumbnailState>
  deferredGenerationQueueItems: Array<GenerationQueueItem>
}

// ============================================
// Implementation
// ============================================

/**
 * Get file's MIME type from its path extension (fallback)
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
 * Detect MIME type from file magic bytes (file signature)
 * Returns null if unknown format
 */
const getMimeTypeFromBytes = (data: ArrayBuffer): string | null => {
  if (data.byteLength < 12) return null

  const bytes = new Uint8Array(data)

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }

  // GIF: 47 49 46 38 (GIF8)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif"
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }

  // BMP: 42 4D (BM)
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp"
  }

  // TIFF: 49 49 2A 00 (little endian) or 4D 4D 00 2A (big endian)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return "image/tiff"
  }

  return null
}

/**
 * Create the ThumbnailService
 */
export const makeThumbnailService = (
  store: Store<any>,
  tables: ThumbnailTables,
  events: ThumbnailEvents,
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

    /**
     * Parse sizes JSON from a table row
     */
    const parseSizesJson = (sizesJson: string): Record<string, ThumbnailSizeState> => {
      try {
        return JSON.parse(sizesJson) as Record<string, ThumbnailSizeState>
      } catch {
        return {}
      }
    }

    /**
     * Read a single file's thumbnail state from the table
     */
    const readFileThumbnailState = (fileId: string): FileThumbnailState | undefined => {
      const rows = store.query<Array<ThumbnailStateTableRow>>(
        queryDb(tables.thumbnailState.where({ fileId }))
      )
      if (rows.length === 0) return undefined
      const row = rows[0]!
      return {
        fileId: row.fileId,
        contentHash: row.contentHash,
        mimeType: row.mimeType,
        sizes: parseSizesJson(row.sizesJson)
      }
    }

    /**
     * Read all file thumbnail states from the table
     */
    const readAllFileThumbnailStates = (): Record<string, FileThumbnailState> => {
      const rows = store.query<Array<ThumbnailStateTableRow>>(
        queryDb(tables.thumbnailState.select())
      )
      const result: Record<string, FileThumbnailState> = {}
      for (const row of rows) {
        result[row.fileId] = {
          fileId: row.fileId,
          contentHash: row.contentHash,
          mimeType: row.mimeType,
          sizes: parseSizesJson(row.sizesJson)
        }
      }
      return result
    }

    /**
     * Read the config from the config table
     */
    const readConfig = (): { configHash: string; sizes: ThumbnailSizes } | undefined => {
      const rows = store.query<Array<ThumbnailConfigTableRow>>(
        queryDb(tables.thumbnailConfig.where({ id: "global" }))
      )
      if (rows.length === 0) return undefined
      const row = rows[0]!
      return {
        configHash: row.configHash,
        sizes: JSON.parse(row.sizesJson) as ThumbnailSizes
      }
    }

    /**
     * Read the full thumbnail state document (for backwards compatibility)
     * Prefixed with underscore since currently unused but kept for potential future use
     */
    const _readThumbnailState = (): {
      config: { configHash: string; sizes: ThumbnailSizes } | undefined
      files: Record<string, FileThumbnailState>
    } => {
      const files = readAllFileThumbnailStates()
      const configData = readConfig()
      return {
        config: configData,
        files
      }
      // Suppress "declared but never used" warning
      void _readThumbnailState
    }

    /**
     * Create an upsert event for a file's thumbnail state
     */
    const createThumbnailStateUpsertEvent = (state: FileThumbnailState) =>
      events.thumbnailStateUpsert({
        fileId: state.fileId,
        contentHash: state.contentHash,
        mimeType: state.mimeType,
        sizesJson: JSON.stringify(state.sizes)
      })

    /**
     * Commit upserts for multiple file thumbnail states in a single transaction.
     */
    const commitBatchThumbnailState = (states: ReadonlyArray<FileThumbnailState>): void => {
      if (states.length === 0) return
      store.commit(...states.map(createThumbnailStateUpsertEvent))
    }

    /**
     * Commit an upsert for a single file's thumbnail state
     */
    const commitFileThumbnailState = (state: FileThumbnailState): void => {
      store.commit(createThumbnailStateUpsertEvent(state))
    }

    /**
     * Commit a remove for a single file's thumbnail state
     */
    const commitRemoveFileThumbnailState = (fileId: string): void => {
      store.commit(events.thumbnailStateRemove({ fileId }))
    }

    /**
     * Helper to update a single file's thumbnail state
     */
    const updateFileThumbnailState = (
      fileId: string,
      updater: (state: FileThumbnailState | undefined) => FileThumbnailState | undefined,
      scanAccumulator?: ScanAccumulator
    ): void => {
      const currentState = scanAccumulator
        ? scanAccumulator.pendingStatesByFileId.has(fileId)
          ? scanAccumulator.pendingStatesByFileId.get(fileId)
          : scanAccumulator.knownMissingFileIds.has(fileId)
          ? undefined
          : readFileThumbnailState(fileId)
        : readFileThumbnailState(fileId)
      const newState = updater(currentState)

      if (newState === undefined) {
        // Remove the file state
        if (currentState !== undefined) {
          if (scanAccumulator) {
            scanAccumulator.pendingStatesByFileId.delete(fileId)
            scanAccumulator.knownMissingFileIds.add(fileId)
          } else {
            commitRemoveFileThumbnailState(fileId)
          }
        }
      } else {
        // Upsert the file state
        if (scanAccumulator) {
          scanAccumulator.pendingStatesByFileId.set(fileId, newState)
          scanAccumulator.knownMissingFileIds.delete(fileId)
        } else {
          commitFileThumbnailState(newState)
        }
      }
    }

    // Generate a hash of the current config for change detection
    const generateConfigHash = (): string => {
      const configStr = JSON.stringify({
        sizes: config.sizes,
        format: config.format
      })
      // Simple hash function
      let hash = 0
      for (let i = 0; i < configStr.length; i++) {
        const char = configStr.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash // Convert to 32bit integer
      }
      return hash.toString(16)
    }

    // Check if config has changed and handle accordingly
    const checkAndHandleConfigChange = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const currentHash = generateConfigHash()
        const storedConfig = readConfig()
        const storedHash = storedConfig?.configHash

        if (storedHash === currentHash) {
          // Config unchanged, nothing to do
          return
        }

        // Config changed (or first run) - wipe all thumbnails and state
        if (storedHash !== undefined) {
          console.log("[ThumbnailService] Config changed, clearing all thumbnails...")

          // Delete all thumbnail files from storage
          const allStates = readAllFileThumbnailStates()
          for (const fileState of Object.values(allStates)) {
            yield* storage.deleteThumbnails(fileState.contentHash).pipe(
              Effect.catchAll(() => Effect.void)
            )
          }

          // Clear all file states
          store.commit(events.thumbnailStateClear({}))
        }

        // Set new config
        store.commit(
          events.thumbnailConfigSet({
            id: "global",
            configHash: currentHash,
            sizesJson: JSON.stringify(config.sizes)
          })
        )
      })

    // Helper to read local file
    const readLocalFile = (path: string): Effect.Effect<ArrayBuffer | null> =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!exists) return null

        const data = yield* fs.readFile(path).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (!data) return null

        // Convert to regular ArrayBuffer if it's a SharedArrayBuffer
        // Note: SharedArrayBuffer may not be defined in all browser contexts
        // (requires specific security headers), so check existence first
        if (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer) {
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
          .generate(fileData, path, contentHash, config.sizes, config.format, config.qualitySettings)
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
    const queueFile = (file: FileRecord, scanAccumulator?: ScanAccumulator): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Check if thumbnails already exist with matching content hash
        const existingState = scanAccumulator?.pendingStatesByFileId.get(file.id) ?? readFileThumbnailState(file.id)
        if (scanAccumulator) {
          if (existingState) {
            scanAccumulator.pendingStatesByFileId.set(file.id, existingState)
            scanAccumulator.knownMissingFileIds.delete(file.id)
          } else {
            scanAccumulator.knownMissingFileIds.add(file.id)
          }
        }
        if (existingState && existingState.contentHash === file.contentHash) {
          // Check if all sizes are in a final or in-progress state
          // Skip if already queued/generating/done/skipped (don't re-queue)
          const allInProgress = Object.keys(config.sizes).every(
            (sizeName) => {
              const status = existingState.sizes[sizeName]?.status
              return status === "done" || status === "skipped" || status === "queued" || status === "generating"
            }
          )
          if (allInProgress) return
        }

        // Try to detect MIME type from path first (fast path for files with extensions)
        let mimeType = getMimeTypeFromPath(file.path)

        // If path detection failed (e.g., content-addressed path without extension),
        // try to read file and detect from magic bytes
        if (!mimeType || !isSupportedImageMimeType(mimeType)) {
          const fileData = yield* readLocalFile(file.path)
          if (fileData) {
            mimeType = getMimeTypeFromBytes(fileData)
          } else {
            // File not available locally yet - leave as pending for next scan
            // Don't update state at all, let it be picked up on next poll
            return
          }
        }

        if (!mimeType || !isSupportedImageMimeType(mimeType)) {
          // File was read but it's not a supported image type - mark as skipped
          console.log(`[ThumbnailService] queueFile: not a supported image, marking as skipped`)
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
          }), scanAccumulator)
          return
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
        }), scanAccumulator)

        // Add to queue
        const generationQueueItem: GenerationQueueItem = {
          fileId: file.id,
          contentHash: file.contentHash,
          path: file.path,
          mimeType
        }
        if (scanAccumulator) {
          scanAccumulator.deferredGenerationQueueItems.push(generationQueueItem)
        } else {
          yield* Queue.offer(generationQueue, generationQueueItem)
        }
      })

    // Clean up thumbnails for a deleted file
    // TODO: Wire this up to file deletion events from LiveStore
    const _cleanupFile = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const state = readFileThumbnailState(fileId)
        if (!state) return

        // Delete thumbnail files
        yield* storage.deleteThumbnails(state.contentHash).pipe(Effect.catchAll(() => Effect.void))

        // Remove from state
        commitRemoveFileThumbnailState(fileId)

        emitEvent({
          type: "thumbnail:cleanup",
          fileId
        })
      })

    // Scan existing files and queue those missing thumbnails
    const scanExistingFiles = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Query all non-deleted files from the files table
        if (!config.filesTable) {
          // Can't query files without filesTable
          return
        }

        try {
          const files = store.query<Array<FileRecord>>(
            queryDb(config.filesTable.select())
          )
          const scanAccumulator: ScanAccumulator = {
            knownMissingFileIds: new Set(),
            pendingStatesByFileId: new Map(),
            deferredGenerationQueueItems: []
          }

          for (const file of files) {
            if (file.deletedAt) continue
            yield* queueFile(file, scanAccumulator)
          }

          // Commit all state changes first, then enqueue generation work.
          // This avoids stale queued state writes racing with generation updates.
          commitBatchThumbnailState([...scanAccumulator.pendingStatesByFileId.values()])

          for (const item of scanAccumulator.deferredGenerationQueueItems) {
            yield* Queue.offer(generationQueue, item)
          }
        } catch (error) {
          // Table might not exist yet, or query failed
          console.warn("[ThumbnailService] Failed to query files:", error)
        }
      })

    // Service methods
    const resolveThumbnailUrl: ThumbnailServiceService["resolveThumbnailUrl"] = (fileId, size) =>
      Effect.gen(function*() {
        const state = readFileThumbnailState(fileId)
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
      Effect.sync(() => readFileThumbnailState(fileId) ?? null)

    const regenerate: ThumbnailServiceService["regenerate"] = (fileId) =>
      Effect.gen(function*() {
        if (!config.filesTable) {
          return
        }

        // Get the file record
        try {
          const files = store.query<Array<FileRecord>>(
            queryDb(config.filesTable.where({ id: fileId }))
          )

          const file = files.find((f) => !f.deletedAt)
          if (!file) return

          const state = readFileThumbnailState(fileId)

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

        // Check for config changes and clear thumbnails if needed
        yield* checkAndHandleConfigChange()

        // Scan existing files
        yield* scanExistingFiles()

        // Start the worker loop (use forkDaemon to ensure it survives after start() returns)
        const workerFiber = yield* workerLoop().pipe(Effect.forkDaemon)
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
  events: ThumbnailEvents,
  config: ThumbnailServiceConfig
): Layer.Layer<ThumbnailService, never, ThumbnailWorkerClient | LocalThumbnailStorage | FileSystem> =>
  Layer.effect(ThumbnailService, makeThumbnailService(store, tables, events, config))
