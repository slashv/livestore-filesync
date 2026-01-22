/**
 * Singleton FileSync helpers
 *
 * Provides a simple, framework-agnostic API for one global FileSync instance.
 *
 * @module
 */

import type { FileSystem } from "@effect/platform/FileSystem"
import { queryDb } from "@livestore/livestore"
import type { Store } from "@livestore/livestore"
import type { Layer } from "effect"
import type { SyncSchema } from "../livestore/types.js"
import { createFileSyncSchema } from "../schema/index.js"
import type { Hash } from "../services/hash/index.js"
import type { FileSyncEvent } from "../types/index.js"
import { createFileSync, type CreateFileSyncConfig, type FileSyncInstance } from "./createFileSync.js"

const DEFAULT_SIGNER_BASE_URL = "/api"
const REQUIRED_TABLES = ["files", "localFileState"] as const
const REQUIRED_EVENTS = [
  "v1.FileCreated",
  "v1.FileUpdated",
  "v1.FileDeleted",
  "localFileStateSet"
] as const

type SchemaFallback = Pick<SyncSchema, "tables" | "events"> & {
  queryDb?: SyncSchema["queryDb"]
}

export interface InitFileSyncConfig {
  /** FileSystem layer - required. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node. */
  fileSystem: Layer.Layer<FileSystem>

  /**
   * HashService layer - optional.
   * Defaults to Web Crypto API implementation (works in browsers, Node 20+, Electron).
   * For React Native, pass HashServiceLive from @livestore-filesync/expo.
   */
  hashService?: Layer.Layer<Hash>

  remote?: {
    signerBaseUrl?: string
    headers?: Record<string, string>
    authToken?: string
  }
  options?: CreateFileSyncConfig["options"]
  schema?: SchemaFallback

  /**
   * Whether to start syncing immediately after initialization.
   * @default true
   */
  autoStart?: boolean
}

let singleton: FileSyncInstance | null = null

const requireFileSync = (): FileSyncInstance => {
  if (!singleton) {
    throw new Error("FileSync not initialized. Call initFileSync(store, config) first.")
  }
  return singleton
}

const validateDefaultSchema = (store: Store<any>) => {
  const schema: any = store.schema
  const tables = schema?.state?.sqlite?.tables
  const events = schema?.eventsDefsMap

  if (!(tables instanceof Map) || !(events instanceof Map)) {
    throw new Error("FileSync store schema is not available for validation.")
  }

  const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name))
  const missingEvents = REQUIRED_EVENTS.filter((name) => !events.has(name))

  if (missingTables.length || missingEvents.length) {
    const details = [
      missingTables.length ? `tables: ${missingTables.join(", ")}` : null,
      missingEvents.length ? `events: ${missingEvents.join(", ")}` : null
    ]
      .filter(Boolean)
      .join("; ")
    throw new Error(
      `FileSync schema missing from store (${details}). ` +
        "Ensure createFileSyncSchema is merged into your LiveStore schema or pass schema to initFileSync."
    )
  }
}

const resolveSchema = (store: Store<any>, schema?: SchemaFallback): SyncSchema => {
  if (schema) {
    return {
      tables: schema.tables,
      events: schema.events,
      queryDb: schema.queryDb ?? queryDb
    }
  }

  validateDefaultSchema(store)
  const defaults = createFileSyncSchema()
  return {
    tables: defaults.tables,
    events: defaults.events,
    queryDb
  }
}

/**
 * Initialize and start file sync.
 *
 * Creates a FileSync instance, and by default starts syncing immediately.
 * Returns a dispose function to clean up resources.
 *
 * @example
 * ```typescript
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * const dispose = initFileSync(store, {
 *   fileSystem: opfsLayer(),
 *   remote: { signerBaseUrl: '/api' }
 * })
 *
 * // Later, to clean up:
 * await dispose()
 * ```
 *
 * @returns Dispose function that stops sync and cleans up resources
 */
export const initFileSync = (
  store: Store<any>,
  config: InitFileSyncConfig
): () => Promise<void> => {
  if (singleton) {
    return async () => {
      await singleton?.dispose()
      singleton = null
    }
  }

  if (!config.fileSystem) {
    throw new Error(
      "FileSync requires a fileSystem layer. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node."
    )
  }

  const schema = resolveSchema(store, config.schema)
  const remote: CreateFileSyncConfig["remote"] = {
    signerBaseUrl: config.remote?.signerBaseUrl ?? DEFAULT_SIGNER_BASE_URL,
    ...(config.remote?.headers ? { headers: config.remote.headers } : {}),
    ...(config.remote?.authToken ? { authToken: config.remote.authToken } : {})
  }

  singleton = createFileSync({
    store,
    schema,
    remote,
    fileSystem: config.fileSystem,
    ...(config.hashService ? { hashService: config.hashService } : {}),
    options: {
      ...config.options,
      onEvent: (event) => {
        config.options?.onEvent?.(event)
        _broadcastEvent(event)
      }
    }
  })

  // Auto-start by default
  if (config.autoStart !== false) {
    singleton.start()
  }

  return async () => {
    await singleton?.dispose()
    singleton = null
  }
}

/**
 * Start the file sync process.
 * Only needed if initFileSync was called with autoStart: false.
 */
export const startFileSync = (): void => {
  requireFileSync().start()
}

/**
 * Stop the file sync process.
 * Can be restarted later with startFileSync().
 */
export const stopFileSync = (): void => {
  requireFileSync().stop()
}

export const saveFile = (file: File) => requireFileSync().saveFile(file)
export const updateFile = (fileId: string, file: File) => requireFileSync().updateFile(fileId, file)
export const deleteFile = (fileId: string) => requireFileSync().deleteFile(fileId)
export const readFile = (path: string) => requireFileSync().readFile(path)
export const getFileUrl = (path: string) => requireFileSync().getFileUrl(path)
export const resolveFileUrl = (fileId: string) => requireFileSync().resolveFileUrl(fileId)
export const prioritizeDownload = (fileId: string) => requireFileSync().prioritizeDownload(fileId)
export const isOnline = () => requireFileSync().isOnline()
export const triggerSync = () => requireFileSync().triggerSync()

/**
 * Retry all files currently in error state.
 * Re-queues uploads and downloads for files with error status.
 * @returns Promise resolving to array of file IDs that were re-queued
 */
export const retryErrors = () => requireFileSync().retryErrors()

// Event subscription storage
const eventListeners: Set<(event: FileSyncEvent) => void> = new Set()

/**
 * Subscribe to file sync events.
 * Returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * import { onFileSyncEvent, createActiveTransferProgress, updateActiveTransfers } from '@livestore-filesync/core'
 *
 * let transfers = {}
 * const unsub = onFileSyncEvent((event) => {
 *   if (event.type === 'upload:progress') {
 *     const progress = createActiveTransferProgress(
 *       event.fileId, 'upload',
 *       event.progress.loaded, event.progress.total
 *     )
 *     transfers = updateActiveTransfers(transfers, progress)
 *   }
 * })
 * ```
 */
export const onFileSyncEvent = (
  callback: (event: FileSyncEvent) => void
): () => void => {
  eventListeners.add(callback)
  return () => {
    eventListeners.delete(callback)
  }
}

// Internal function to broadcast events to all listeners
// This is wired up during initFileSync
export const _broadcastEvent = (event: FileSyncEvent): void => {
  for (const listener of eventListeners) {
    listener(event)
  }
}
