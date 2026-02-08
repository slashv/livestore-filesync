/**
 * Singleton API for Thumbnail Service
 *
 * Provides a simple, framework-agnostic API for one global ThumbnailService instance.
 *
 * @module
 */

import type { FileSystem } from "@effect/platform/FileSystem"
import type { Store } from "@livestore/livestore"
import type { Layer } from "effect"

import { createThumbnailSchema, type ThumbnailEvents, type ThumbnailTables } from "../schema/index.js"
import type { FileThumbnailState, InitThumbnailsConfig, ThumbnailEvent } from "../types/index.js"
import { createThumbnails, type ThumbnailInstance } from "./createThumbnails.js"

// ============================================
// Singleton State
// ============================================

let singleton: ThumbnailInstance | null = null
let singletonUserId: string | null = null

const requireThumbnails = (): ThumbnailInstance => {
  if (!singleton) {
    throw new Error("Thumbnails not initialized. Call initThumbnails(store, config) first.")
  }
  return singleton
}

// ============================================
// Schema Resolution
// ============================================

interface SchemaFallback {
  tables: ThumbnailTables
  events: ThumbnailEvents
}

interface ResolvedSchema {
  tables: ThumbnailTables
  events: ThumbnailEvents
}

const resolveSchema = (store: Store<any>, schema?: SchemaFallback): ResolvedSchema => {
  if (schema) {
    return { tables: schema.tables, events: schema.events }
  }

  // Validate store has thumbnailState table
  const storeSchema: any = store.schema
  const tables = storeSchema?.state?.sqlite?.tables

  if (!(tables instanceof Map) || !tables.has("thumbnailState")) {
    // Create default schema
    const defaults = createThumbnailSchema()
    return { tables: defaults.tables, events: defaults.events }
  }

  // Use default schema
  const defaults = createThumbnailSchema()
  return { tables: defaults.tables, events: defaults.events }
}

// ============================================
// Singleton Helpers
// ============================================

/**
 * Initialize and optionally start thumbnail generation.
 *
 * Creates a ThumbnailService instance, and by default starts automatically.
 * Returns a dispose function to clean up resources.
 *
 * If a userId is provided and differs from the previous initialization,
 * the existing singleton will be disposed and a new one created.
 * This ensures state is refreshed when switching users.
 *
 * @example
 * ```typescript
 * import { initThumbnails } from '@livestore-filesync/image/thumbnails'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * const dispose = initThumbnails(store, {
 *   sizes: { small: 128, medium: 256, large: 512 },
 *   fileSystem: opfsLayer(),
 *   workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
 *   userId: 'user-123'
 * })
 *
 * // Later, to clean up:
 * await dispose()
 * ```
 *
 * @returns Dispose function that stops sync and cleans up resources
 */
export const initThumbnails = (
  store: Store<any>,
  config: InitThumbnailsConfig
): () => Promise<void> => {
  const userId = config.userId ?? null

  // If singleton exists but for a different user, dispose it first
  if (singleton && singletonUserId !== userId) {
    console.log("[Thumbnails] User changed, disposing old instance")
    singleton.dispose()
    singleton = null
    singletonUserId = null
  }

  if (singleton) {
    return async () => {
      await singleton?.dispose()
      singleton = null
      singletonUserId = null
    }
  }

  singletonUserId = userId

  if (!config.fileSystem) {
    throw new Error(
      "Thumbnails requires a fileSystem layer. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node."
    )
  }

  if (!config.workerUrl && !config.worker) {
    throw new Error("Thumbnails requires either 'worker' (Worker constructor) or 'workerUrl' (URL/string)")
  }

  const { events, tables } = resolveSchema(store)

  // Resolve filesTable from config
  // Priority: schema.tables > legacy filesTable option
  let resolvedFilesTable = config.filesTable

  if (config.schema?.tables?.files) {
    // Use the new simplified API - extract files table
    resolvedFilesTable = config.schema.tables.files
  }

  singleton = createThumbnails({
    store,
    tables,
    events,
    fileSystem: config.fileSystem as Layer.Layer<FileSystem>,
    ...(config.worker ? { worker: config.worker } : {}),
    ...(config.workerUrl ? { workerUrl: config.workerUrl } : {}),
    sizes: config.sizes,
    ...(config.format !== undefined ? { format: config.format } : {}),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.supportedMimeTypes !== undefined ? { supportedMimeTypes: config.supportedMimeTypes } : {}),
    ...(config.onEvent !== undefined ? { onEvent: config.onEvent } : {}),
    ...(config.qualitySettings !== undefined ? { qualitySettings: config.qualitySettings } : {}),
    ...(resolvedFilesTable !== undefined ? { filesTable: resolvedFilesTable } : {})
  })

  // Auto-start by default
  if (config.autoStart !== false) {
    singleton.start()
  }

  return async () => {
    await singleton?.dispose()
    singleton = null
    singletonUserId = null
  }
}

/**
 * Dispose the Thumbnails singleton.
 * Call this on logout to ensure state is cleared.
 *
 * @example
 * ```typescript
 * import { disposeThumbnails } from '@livestore-filesync/image/thumbnails'
 *
 * async function handleLogout() {
 *   await disposeThumbnails()
 *   await authClient.signOut()
 * }
 * ```
 */
export const disposeThumbnails = async (): Promise<void> => {
  if (singleton) {
    console.log("[Thumbnails] Disposing singleton")
    await singleton.dispose()
    singleton = null
    singletonUserId = null
  }
}

/**
 * Start thumbnail generation.
 * Only needed if initThumbnails was called with autoStart: false.
 */
export const startThumbnails = (): void => {
  requireThumbnails().start()
}

/**
 * Stop thumbnail generation.
 * Can be restarted later with startThumbnails().
 */
export const stopThumbnails = (): void => {
  requireThumbnails().stop()
}

/**
 * Resolve a thumbnail URL for a file and size.
 * Returns null if the thumbnail doesn't exist.
 *
 * @example
 * ```typescript
 * const url = await resolveThumbnailUrl(fileId, 'small')
 * if (url) {
 *   img.src = url
 * }
 * ```
 */
export const resolveThumbnailUrl = (fileId: string, size: string): Promise<string | null> =>
  requireThumbnails().resolveThumbnailUrl(fileId, size)

/**
 * Resolve a thumbnail URL, falling back to the file URL if not available.
 * This is a convenience method for use in components.
 *
 * @example
 * ```typescript
 * const url = await resolveThumbnailOrFileUrl(
 *   fileId,
 *   'small',
 *   () => resolveFileUrl(fileId)  // from @livestore-filesync/core
 * )
 * ```
 */
export const resolveThumbnailOrFileUrl = (
  fileId: string,
  size: string,
  getFileUrl: () => Promise<string | null>
): Promise<string | null> => requireThumbnails().resolveThumbnailOrFileUrl(fileId, size, getFileUrl)

/**
 * Get the thumbnail state for a file.
 *
 * @example
 * ```typescript
 * const state = getThumbnailState(fileId)
 * if (state?.sizes.small.status === 'done') {
 *   // Thumbnail is ready
 * }
 * ```
 */
export const getThumbnailState = (fileId: string): FileThumbnailState | null =>
  requireThumbnails().getThumbnailState(fileId)

/**
 * Regenerate thumbnails for a file.
 * Useful when the source file has been updated.
 */
export const regenerateThumbnail = (fileId: string): Promise<void> => requireThumbnails().regenerate(fileId)

// ============================================
// Event Subscription
// ============================================

const eventListeners: Set<(event: ThumbnailEvent) => void> = new Set()

/**
 * Subscribe to thumbnail events.
 * Returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * const unsub = onThumbnailEvent((event) => {
 *   if (event.type === 'thumbnail:generation-completed') {
 *     console.log('Thumbnails ready for', event.fileId)
 *   }
 * })
 * ```
 */
export const onThumbnailEvent = (
  callback: (event: ThumbnailEvent) => void
): () => void => {
  eventListeners.add(callback)
  return () => {
    eventListeners.delete(callback)
  }
}

/**
 * Internal function to broadcast events to all listeners
 */
export const _broadcastThumbnailEvent = (event: ThumbnailEvent): void => {
  for (const listener of eventListeners) {
    listener(event)
  }
}
