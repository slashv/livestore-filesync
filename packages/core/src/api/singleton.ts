/**
 * Singleton FileSync helpers
 *
 * Provides a simple, framework-agnostic API for one global FileSync instance.
 *
 * @module
 */

import { queryDb } from "@livestore/livestore"
import type { Store } from "@livestore/livestore"
import type { Layer } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { SyncSchema } from "../livestore/types.js"
import { createFileSyncSchema } from "../schema/index.js"
import type { Hash } from "../services/hash/index.js"
import type { FileSyncEvent } from "../types/index.js"
import {
  createFileSync,
  type CreateFileSyncConfig,
  type FileSyncInstance,
  type SignerRemoteConfig
} from "./createFileSync.js"

const DEFAULT_SIGNER_BASE_URL = "/api"
const REQUIRED_TABLES = ["files", "localFileState"] as const
const REQUIRED_EVENTS = [
  "v1.FileCreated",
  "v1.FileUpdated",
  "v1.FileDeleted",
  "v1.LocalFileStateUpsert",
  "v1.LocalFileStateRemove",
  "v1.LocalFileStateClear"
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

  /** Remote signer config. Pass false for explicit local-only mode. */
  remote?: false | (Partial<Pick<SignerRemoteConfig, "signerBaseUrl">> & Omit<SignerRemoteConfig, "signerBaseUrl">)
  options?: CreateFileSyncConfig["options"]
  schema?: SchemaFallback

  /**
   * Whether to start syncing immediately after initialization.
   * @default true
   */
  autoStart?: boolean

  /**
   * User ID for the current authenticated user.
   * When provided, FileSync will automatically dispose and recreate the singleton
   * if a different user ID is passed (e.g., after logout/login).
   * This prevents stale auth credentials from being used after user switch.
   */
  userId?: string
}

interface SingletonGeneration {
  instance: FileSyncInstance
  store: Store<any>
  userId: string | null
  remoteMode: "remote" | "local-only"
  refs: number
  wantsStart: boolean
  ready: Promise<void>
}

let singleton: SingletonGeneration | null = null
let retirement: Promise<void> = Promise.resolve()

const retire = (generation: SingletonGeneration): Promise<void> => {
  const pending = generation.instance.dispose()
  retirement = Promise.all([retirement, pending]).then(() => undefined)
  void retirement.catch((error) => console.error("[FileSync] Cleanup failed:", error))
  return retirement
}

const retainSingleton = (generation: SingletonGeneration): () => Promise<void> => {
  generation.refs += 1
  let released = false
  return async () => {
    if (released) return
    released = true
    generation.refs -= 1
    if (generation.refs > 0) return
    if (singleton === generation) singleton = null
    await retire(generation)
  }
}

const requireFileSync = (): FileSyncInstance => {
  if (!singleton) {
    throw new Error("FileSync not initialized. Call initFileSync(store, config) first.")
  }
  return singleton.instance
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
 * If a userId is provided and differs from the previous initialization,
 * the existing singleton will be disposed and a new one created.
 * This ensures auth credentials are refreshed when switching users.
 *
 * @example
 * ```typescript
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * const dispose = initFileSync(store, {
 *   fileSystem: opfsLayer(),
 *   remote: { signerBaseUrl: '/api' },
 *   userId: 'user-123'
 * })
 *
 * // Local-only / unauthenticated mode
 * const disposeLocal = initFileSync(store, {
 *   fileSystem: opfsLayer(),
 *   remote: false
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
  const userId = config.userId ?? null
  const remoteMode = config.remote === false ? "local-only" : "remote"

  if (
    singleton && singleton.store === store && singleton.userId === userId &&
    singleton.remoteMode === remoteMode
  ) {
    return retainSingleton(singleton)
  }

  if (!config.fileSystem) {
    throw new Error(
      "FileSync requires a fileSystem layer. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node."
    )
  }

  const schema = resolveSchema(store, config.schema)
  const remote: CreateFileSyncConfig["remote"] = config.remote === false
    ? false
    : {
      signerBaseUrl: config.remote?.signerBaseUrl ?? DEFAULT_SIGNER_BASE_URL,
      ...(config.remote?.headers ? { headers: config.remote.headers } : {}),
      ...(config.remote?.authToken ? { authToken: config.remote.authToken } : {}),
      ...(config.remote?.includeCredentials ? { includeCredentials: config.remote.includeCredentials } : {})
    }

  const instance = createFileSync({
    store,
    schema,
    remote,
    fileSystem: config.fileSystem,
    ...(config.hashService ? { hashService: config.hashService } : {}),
    options: {
      ...config.options,
      onEvent: (event) => {
        if (singleton?.instance !== instance) return
        try {
          config.options?.onEvent?.(event)
        } catch (error) {
          console.error("[FileSync] Event listener failed:", error)
        }
        _broadcastEvent(event)
      }
    }
  })

  const previous = singleton
  const retired = previous ? retire(previous) : retirement
  const generation: SingletonGeneration = {
    instance,
    store,
    userId,
    remoteMode,
    refs: 0,
    ready: retired,
    wantsStart: config.autoStart !== false
  }
  singleton = generation
  // Detach before awaiting cleanup: old disposers can never affect this generation.
  void retired.then(() => {
    if (singleton === generation && generation.wantsStart) return instance.start()
  }).catch((error) => console.error("[FileSync] Replacement cleanup failed:", error))

  return retainSingleton(generation)
}

/**
 * Dispose the FileSync singleton.
 * Call this on logout to ensure auth credentials are cleared.
 *
 * @example
 * ```typescript
 * import { disposeFileSync } from '@livestore-filesync/core'
 *
 * async function handleLogout() {
 *   await disposeFileSync()
 *   await authClient.signOut()
 * }
 * ```
 */
export const disposeFileSync = async (): Promise<void> => {
  const generation = singleton
  singleton = null
  await (generation ? retire(generation) : retirement)
}

/**
 * Start the file sync process.
 * Only needed if initFileSync was called with autoStart: false.
 */
export const startFileSync = async (): Promise<void> => {
  requireFileSync()
  const generation = singleton!
  generation.wantsStart = true
  await generation.ready
  if (singleton === generation && generation.wantsStart) await generation.instance.start()
}

/**
 * Stop the file sync process.
 * Can be restarted later with startFileSync().
 */
export const stopFileSync = (): Promise<void> => {
  const instance = requireFileSync()
  singleton!.wantsStart = false
  return instance.stop()
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
    try {
      listener(event)
    } catch (error) {
      console.error("[FileSync] Event listener failed:", error)
    }
  }
}
