/**
 * Instance API for Thumbnail Service
 *
 * Creates a ThumbnailService instance with full lifecycle control.
 *
 * @module
 */

import type { FileSystem } from "@effect/platform/FileSystem"
import type { Store } from "@livestore/livestore"
import { Effect, Layer, ManagedRuntime } from "effect"

import type { ThumbnailTables } from "../schema/index.js"
import {
  type LocalThumbnailStorage,
  LocalThumbnailStorageLive,
  ThumbnailService,
  type ThumbnailServiceConfig,
  ThumbnailServiceLive
} from "../services/index.js"
import { ThumbnailWorkerClient, ThumbnailWorkerClientLive } from "../services/ThumbnailWorkerClient.js"
import type {
  FilesTable,
  FileThumbnailState,
  InitThumbnailsConfig,
  QueryDbFn,
  ThumbnailFormat,
  ThumbnailQualitySettings,
  ThumbnailSizes
} from "../types/index.js"
import { SUPPORTED_IMAGE_MIME_TYPES } from "../types/index.js"

// ============================================
// Instance Interface
// ============================================

/**
 * ThumbnailInstance - the return type of createThumbnails
 */
export interface ThumbnailInstance {
  /**
   * Resolve a thumbnail URL for a file and size.
   * Returns null if the thumbnail doesn't exist.
   */
  readonly resolveThumbnailUrl: (fileId: string, size: string) => Promise<string | null>

  /**
   * Resolve a thumbnail URL, falling back to the file URL if not available.
   * This is a convenience method for use in components.
   */
  readonly resolveThumbnailOrFileUrl: (
    fileId: string,
    size: string,
    getFileUrl: () => Promise<string | null>
  ) => Promise<string | null>

  /**
   * Get the thumbnail state for a file
   */
  readonly getThumbnailState: (fileId: string) => FileThumbnailState | null

  /**
   * Regenerate thumbnails for a file
   */
  readonly regenerate: (fileId: string) => Promise<void>

  /**
   * Start the thumbnail service
   */
  readonly start: () => void

  /**
   * Stop the thumbnail service
   */
  readonly stop: () => void

  /**
   * Dispose of all resources
   */
  readonly dispose: () => Promise<void>
}

// ============================================
// Factory
// ============================================

/**
 * Configuration for createThumbnails
 */
export interface CreateThumbnailsConfig {
  store: Store<any>
  tables: ThumbnailTables
  fileSystem: Layer.Layer<FileSystem>
  /** URL to the thumbnail worker (use workerUrl OR worker, not both) */
  workerUrl?: URL | string
  /** Worker constructor from Vite's ?worker import (preferred for production builds) */
  worker?: new () => Worker
  sizes: ThumbnailSizes
  format?: ThumbnailFormat | undefined
  concurrency?: number | undefined
  supportedMimeTypes?: Array<string> | undefined
  onEvent?: InitThumbnailsConfig["onEvent"] | undefined
  qualitySettings?: ThumbnailQualitySettings | undefined
  queryDb?: QueryDbFn | undefined
  filesTable?: FilesTable | undefined
}

/**
 * Create a ThumbnailService instance
 *
 * @example
 * ```typescript
 * import { createThumbnails } from '@livestore-filesync/image/thumbnails'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * const thumbnails = createThumbnails({
 *   store,
 *   tables: thumbnailSchema.tables,
 *   fileSystem: opfsLayer(),
 *   workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
 *   sizes: { small: 128, medium: 256, large: 512 }
 * })
 *
 * thumbnails.start()
 *
 * const url = await thumbnails.resolveThumbnailUrl(fileId, 'small')
 * ```
 */
export const createThumbnails = (config: CreateThumbnailsConfig): ThumbnailInstance => {
  const {
    concurrency = 2,
    fileSystem,
    filesTable,
    format = "webp",
    onEvent,
    qualitySettings,
    queryDb,
    sizes,
    store,
    supportedMimeTypes = [...SUPPORTED_IMAGE_MIME_TYPES],
    tables,
    workerUrl,
    worker
  } = config

  // Resolve worker source - prefer worker constructor over URL
  const workerSource = worker ?? workerUrl
  if (!workerSource) {
    throw new Error("Thumbnails requires either 'worker' (Worker constructor) or 'workerUrl' (URL/string)")
  }

  const serviceConfig: ThumbnailServiceConfig = {
    sizes,
    format,
    concurrency,
    supportedMimeTypes,
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(qualitySettings !== undefined ? { qualitySettings } : {}),
    ...(queryDb !== undefined ? { queryDb } : {}),
    ...(filesTable !== undefined ? { filesTable } : {})
  }

  // Build layers
  const FileSystemLive = fileSystem
  const WorkerClientLayer = ThumbnailWorkerClientLive(workerSource)
  const StorageLayer = Layer.provide(FileSystemLive)(LocalThumbnailStorageLive)
  const ServiceLayer = Layer.provide(
    Layer.mergeAll(WorkerClientLayer, StorageLayer, FileSystemLive)
  )(ThumbnailServiceLive(store, tables, serviceConfig))

  const MainLayer = Layer.mergeAll(ServiceLayer, WorkerClientLayer, StorageLayer, FileSystemLive)

  // Create runtime
  const runtime = ManagedRuntime.make(MainLayer)

  // Run an effect
  const runPromise = <A, E>(
    effect: Effect.Effect<A, E, ThumbnailService | ThumbnailWorkerClient | LocalThumbnailStorage | FileSystem>
  ): Promise<A> => runtime.runPromise(effect as Effect.Effect<A, E, never>)

  // Run a sync effect
  const runSync = <A, E>(
    effect: Effect.Effect<A, E, ThumbnailService | ThumbnailWorkerClient | LocalThumbnailStorage | FileSystem>
  ): A => runtime.runSync(effect as Effect.Effect<A, E, never>)

  // Instance methods
  const resolveThumbnailUrl = async (fileId: string, size: string): Promise<string | null> =>
    runPromise(
      Effect.gen(function*() {
        const service = yield* ThumbnailService
        return yield* service.resolveThumbnailUrl(fileId, size)
      })
    )

  const resolveThumbnailOrFileUrl = async (
    fileId: string,
    size: string,
    getFileUrl: () => Promise<string | null>
  ): Promise<string | null> => {
    const thumbnailUrl = await resolveThumbnailUrl(fileId, size)
    if (thumbnailUrl) return thumbnailUrl
    return getFileUrl()
  }

  const getThumbnailState = (fileId: string): FileThumbnailState | null =>
    runSync(
      Effect.gen(function*() {
        const service = yield* ThumbnailService
        return yield* service.getThumbnailState(fileId)
      })
    )

  const regenerate = async (fileId: string): Promise<void> =>
    runPromise(
      Effect.gen(function*() {
        const service = yield* ThumbnailService
        yield* service.regenerate(fileId)
      })
    )

  const start = (): void => {
    runPromise(
      Effect.gen(function*() {
        const service = yield* ThumbnailService
        yield* service.start()
      })
    ).catch((error) => {
      console.error("[ThumbnailService] Failed to start:", error)
    })
  }

  const stop = (): void => {
    runPromise(
      Effect.gen(function*() {
        const service = yield* ThumbnailService
        yield* service.stop()
      })
    ).catch((error) => {
      console.error("[ThumbnailService] Failed to stop:", error)
    })
  }

  const dispose = async (): Promise<void> => {
    // Stop first
    try {
      await runPromise(
        Effect.gen(function*() {
          const service = yield* ThumbnailService
          yield* service.stop()
        })
      )
    } catch {
      // Ignore
    }

    // Terminate worker
    try {
      await runPromise(
        Effect.gen(function*() {
          const workerClient = yield* ThumbnailWorkerClient
          yield* workerClient.terminate()
        })
      )
    } catch {
      // Ignore
    }

    // Dispose runtime
    await runtime.dispose()
  }

  return {
    resolveThumbnailUrl,
    resolveThumbnailOrFileUrl,
    getThumbnailState,
    regenerate,
    start,
    stop,
    dispose
  }
}
