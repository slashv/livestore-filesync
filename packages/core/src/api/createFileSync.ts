/**
 * createFileSync - Framework-agnostic file sync factory
 *
 * Creates a file sync instance that handles:
 * - Local file storage (OPFS)
 * - Remote file sync (upload/download)
 * - Offline support with automatic retry
 * - Two-pass reconciliation for efficient syncing
 *
 * @module
 */

import type { FileSystem } from "@effect/platform/FileSystem"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import type { LiveStoreDeps, SyncSchema, SyncStore } from "../livestore/types.js"
import type { FileSyncConfig, FileSyncService } from "../services/file-sync/index.js"
import {
  FileSync,
  FileSyncLive,
  HashServiceLive,
  LocalFileStorage,
  LocalFileStorageLive,
  makeS3SignerRemoteStorage,
  RemoteStorage
} from "../services/index.js"
import type { Hash, RemoteStorageConfig } from "../services/index.js"
import { LocalFileStateManagerLive } from "../services/local-file-state/index.js"
import { defaultConfig as defaultExecutorConfig } from "../services/sync-executor/index.js"
import type {
  FileOperationResult,
  FileRecord,
  FileSyncEvent,
  LocalFilesState,
  LocalFileState,
  PreprocessorMap,
  TransferStatus
} from "../types/index.js"
import { sanitizeStoreId } from "../utils/index.js"

/**
 * Transfer status for file operations
 */
export type SyncTransferStatus = TransferStatus

/**
 * Local file state tracking for createFileSync
 */
export type SyncLocalFileState = LocalFileState

/**
 * Map of file ID to local file state
 */
export type SyncLocalFilesState = LocalFilesState

/**
 * File record from the files table for createFileSync
 */
export type SyncFileRecord = FileRecord

/**
 * Result of a file operation from createFileSync
 */
export type SyncFileOperationResult = FileOperationResult

/**
 * Events emitted by the file sync system
 */
export type SyncEvent = FileSyncEvent

export type { SyncSchema, SyncStore } from "../livestore/types.js"

/**
 * Configuration for createFileSync
 */
export interface CreateFileSyncConfig {
  /** LiveStore store instance */
  store: SyncStore

  /** Schema with tables and events from createFileSyncSchema */
  schema: SyncSchema

  /** Remote storage configuration */
  remote: {
    signerBaseUrl: string
    headers?: Record<string, string>
    authToken?: string
  }

  /** FileSystem layer - required. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node. */
  fileSystem: Layer.Layer<FileSystem>

  /**
   * HashService layer - optional.
   * Defaults to Web Crypto API implementation (works in browsers, Node 20+, Electron).
   * For React Native, pass HashServiceLive from @livestore-filesync/expo.
   */
  hashService?: Layer.Layer<Hash>

  /** Optional configuration */
  options?: {
    /** Root path for local file storage (needed to produce file:// URLs in Node/Electron main) */
    localPathRoot?: string
    maxConcurrentDownloads?: number
    maxConcurrentUploads?: number
    healthCheckIntervalMs?: number
    onEvent?: (event: SyncEvent) => void
    /**
     * Automatically prioritize downloads when resolving file URLs.
     * When true (default), calling resolveFileUrl for a file that's queued for download
     * will move it to the front of the download queue.
     * @default true
     */
    autoPrioritizeOnResolve?: boolean
    /**
     * Map of MIME type patterns to preprocessor functions.
     * Files matching a pattern are transformed before saving.
     *
     * Pattern matching rules:
     * - Exact match: 'image/png' matches only 'image/png'
     * - Wildcard subtype: 'image/*' matches 'image/png', 'image/jpeg', etc.
     * - Universal wildcard: '*' or '*\/*' matches any MIME type
     *
     * @example
     * ```typescript
     * preprocessors: {
     *   'image/*': async (file) => resizeImage(file, { maxDimension: 1500 })
     * }
     * ```
     */
    preprocessors?: PreprocessorMap
  }
}

/**
 * File sync instance returned by createFileSync
 */
export interface FileSyncInstance {
  /** Start the sync process */
  start: () => void

  /** Stop the sync process */
  stop: () => void

  /** Save a new file locally and queue for upload */
  saveFile: (file: File) => Promise<SyncFileOperationResult>

  /** Update an existing file */
  updateFile: (fileId: string, file: File) => Promise<SyncFileOperationResult>

  /** Delete a file (soft delete in store, cleanup local/remote) */
  deleteFile: (fileId: string) => Promise<void>

  /** Read a file from local storage */
  readFile: (path: string) => Promise<File>

  /** Get a blob URL for a local file */
  getFileUrl: (path: string) => Promise<string | null>

  /** Resolve a file URL with local->remote fallback by file ID */
  resolveFileUrl: (fileId: string) => Promise<string | null>

  /**
   * Prioritize download of a specific file.
   * Moves the file to the front of the download queue if it's pending/queued.
   */
  prioritizeDownload: (fileId: string) => Promise<void>

  /** Check if currently online */
  isOnline: () => boolean

  /** Manually set online state */
  setOnline: (online: boolean) => Promise<void>

  /** Manually restart the event stream from the stored cursor */
  triggerSync: () => void

  /**
   * Retry all files currently in error state.
   * Re-queues uploads and downloads for files with error status.
   * @returns Promise resolving to array of file IDs that were re-queued
   */
  retryErrors: () => Promise<ReadonlyArray<string>>

  /** Dispose resources */
  dispose: () => Promise<void>
}

// ============================================================================
// Main Factory
// ============================================================================

/**
 * Create a file sync instance
 *
 * @example
 * ```typescript
 * // Browser (using OPFS)
 * import { createFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 * import { queryDb } from '@livestore/livestore'
 * import { tables, events } from './schema'
 *
 * const fileSync = createFileSync({
 *   store,
 *   schema: { tables, events, queryDb },
 *   fileSystem: opfsLayer(),
 *   remote: { signerBaseUrl: '/api' }
 * })
 *
 * // Node.js (using platform-node)
 * import { NodeFileSystem } from '@effect/platform-node'
 *
 * const fileSync = createFileSync({
 *   store,
 *   schema: { tables, events, queryDb },
 *   fileSystem: NodeFileSystem.layer,
 *   remote: { signerBaseUrl: 'https://api.example.com' }
 * })
 *
 * // Start syncing
 * fileSync.start()
 *
 * // Save a file
 * const result = await fileSync.saveFile(file)
 *
 * // Stop when done
 * fileSync.stop()
 * ```
 */
export function createFileSync(config: CreateFileSyncConfig): FileSyncInstance {
  const { fileSystem, hashService, options = {}, remote, schema, store } = config

  // State
  // Note: navigator.onLine is undefined in React Native, so we default to true
  let online = (typeof navigator !== "undefined" && navigator.onLine !== undefined) ? navigator.onLine : true
  let unsubscribeEvents: (() => void) | null = null
  let connectivityEventsAttached = false
  let disposed = false
  let scope: Scope.CloseableScope | null = null
  let fileSyncService: FileSyncService | null = null

  const storeId = sanitizeStoreId(store.storeId)
  const deps: LiveStoreDeps = {
    store,
    schema,
    storeId,
    ...(options.localPathRoot !== undefined ? { localPathRoot: options.localPathRoot } : {})
  }

  const remoteStorageConfig: RemoteStorageConfig = {
    signerBaseUrl: remote.signerBaseUrl,
    ...(remote.headers ? { headers: remote.headers } : {}),
    ...(remote.authToken ? { authToken: remote.authToken } : {})
  }

  const RemoteStorageLive = Layer.succeed(
    RemoteStorage,
    makeS3SignerRemoteStorage(remoteStorageConfig)
  )

  const fileSyncConfig: FileSyncConfig = {
    executorConfig: {
      maxConcurrentDownloads: options.maxConcurrentDownloads ?? defaultExecutorConfig.maxConcurrentDownloads,
      maxConcurrentUploads: options.maxConcurrentUploads ?? defaultExecutorConfig.maxConcurrentUploads
    },
    ...(options.healthCheckIntervalMs !== undefined
      ? { healthCheckIntervalMs: options.healthCheckIntervalMs }
      : {}),
    ...(options.autoPrioritizeOnResolve !== undefined
      ? { autoPrioritizeOnResolve: options.autoPrioritizeOnResolve }
      : {}),
    ...(options.preprocessors !== undefined
      ? { preprocessors: options.preprocessors }
      : {})
  }

  if (!fileSystem) {
    throw new Error(
      "FileSync requires a fileSystem layer. Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node."
    )
  }

  const FileSystemLive = fileSystem
  const HashLive = hashService ?? HashServiceLive
  const LocalFileStorageLayer = Layer.provide(FileSystemLive)(LocalFileStorageLive)
  const LocalFileStateManagerLayer = LocalFileStateManagerLive(deps)

  const BaseLayer = Layer.mergeAll(
    Layer.scope,
    FileSystemLive,
    HashLive,
    LocalFileStorageLayer,
    LocalFileStateManagerLayer,
    RemoteStorageLive
  )

  const FileSyncLayer = Layer.provide(BaseLayer)(FileSyncLive(deps, fileSyncConfig))

  const MainLayer = Layer.mergeAll(BaseLayer, FileSyncLayer)

  const runtime = ManagedRuntime.make(MainLayer)

  // Helper to run Effect and get result
  const runEffect = async <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    throw exit.cause
  }

  const getFileSyncService = async (): Promise<FileSyncService> => {
    if (fileSyncService) return fileSyncService
    fileSyncService = await runEffect(Effect.gen(function*() {
      return yield* FileSync
    }))
    return fileSyncService
  }

  // Connectivity wiring (browser-only)
  // Note: In React Native, window exists but addEventListener doesn't.
  // We check for window.addEventListener specifically to ensure browser environment.
  const attachConnectivityHandlers = async () => {
    if (connectivityEventsAttached) return
    connectivityEventsAttached = true

    const fileSync = await getFileSyncService()

    // Note: navigator.onLine is undefined in React Native, so we default to true
    const initialOnline = (typeof navigator !== "undefined" && navigator.onLine !== undefined) ? navigator.onLine : true
    online = initialOnline
    void runEffect(fileSync.setOnline(initialOnline))

    // Only attach window event listeners in browser environments
    // React Native has window but not window.addEventListener
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", () => {
        online = true
        void runEffect(fileSync.setOnline(true))
      })
      window.addEventListener("offline", () => {
        online = false
        void runEffect(fileSync.setOnline(false))
      })
    }
  }

  const ensureEventSubscription = async () => {
    if (unsubscribeEvents) return
    const fileSync = await getFileSyncService()
    unsubscribeEvents = fileSync.onEvent((event) => {
      if (event.type === "online") {
        online = true
      } else if (event.type === "offline") {
        online = false
      }
      options.onEvent?.(event)
    })
  }

  const start = () => {
    console.log("[createFileSync] start() called")
    if (scope || disposed) {
      console.log("[createFileSync] start() early return - scope:", !!scope, "disposed:", disposed)
      return
    }
    void (async () => {
      try {
        console.log("[createFileSync] Starting async init...")
        scope = await runEffect(Scope.make())
        console.log("[createFileSync] Scope created")
        const fileSync = await getFileSyncService()
        console.log("[createFileSync] FileSync service obtained")
        await ensureEventSubscription()
        console.log("[createFileSync] Event subscription ensured")
        await attachConnectivityHandlers()
        console.log("[createFileSync] Connectivity handlers attached")
        await runEffect(Scope.extend(fileSync.start(), scope))
        console.log("[createFileSync] FileSync.start() completed")
      } catch (error) {
        console.error("[createFileSync] Error during start:", error)
      }
    })()
  }

  const stopInternal = async () => {
    if (!scope) return
    const currentScope = scope
    scope = null

    const fileSync = await getFileSyncService()
    await runEffect(fileSync.stop())
    if (unsubscribeEvents) {
      unsubscribeEvents()
      unsubscribeEvents = null
    }
    await runEffect(Scope.close(currentScope, Exit.void))
  }

  const stop = () => {
    void stopInternal()
  }

  const saveFile = async (file: File): Promise<SyncFileOperationResult> => {
    const fileSync = await getFileSyncService()
    return runEffect(fileSync.saveFile(file))
  }

  const updateFile = async (fileId: string, file: File): Promise<SyncFileOperationResult> => {
    const fileSync = await getFileSyncService()
    return runEffect(fileSync.updateFile(fileId, file))
  }

  const deleteFile = async (fileId: string): Promise<void> => {
    const fileSync = await getFileSyncService()
    await runEffect(fileSync.deleteFile(fileId))
  }

  const readFile = async (path: string): Promise<File> =>
    runEffect(
      Effect.gen(function*() {
        const localStorage = yield* LocalFileStorage
        return yield* localStorage.readFile(path)
      })
    )

  const getFileUrl = async (path: string): Promise<string | null> =>
    runEffect(
      Effect.gen(function*() {
        const localStorage = yield* LocalFileStorage
        const exists = yield* localStorage.fileExists(path)
        if (!exists) return null
        return yield* localStorage.getFileUrl(path)
      })
    )

  const resolveFileUrl = async (fileId: string): Promise<string | null> => {
    const fileSync = await getFileSyncService()
    return runEffect(fileSync.resolveFileUrl(fileId))
  }

  const prioritizeDownload = async (fileId: string): Promise<void> => {
    const fileSync = await getFileSyncService()
    return runEffect(fileSync.prioritizeDownload(fileId))
  }

  const setOnline = async (nextOnline: boolean): Promise<void> => {
    const fileSync = await getFileSyncService()
    online = nextOnline
    await runEffect(fileSync.setOnline(nextOnline))
  }

  const triggerSync = () => {
    void (async () => {
      const fileSync = await getFileSyncService()
      await runEffect(Effect.scoped(fileSync.syncNow()))
    })()
  }

  const retryErrors = async (): Promise<ReadonlyArray<string>> => {
    const fileSync = await getFileSyncService()
    return runEffect(fileSync.retryErrors())
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    await stopInternal()
    await runtime.dispose()
  }

  return {
    start,
    stop,
    saveFile,
    updateFile,
    deleteFile,
    readFile,
    getFileUrl,
    resolveFileUrl,
    prioritizeDownload,
    isOnline: () => online,
    setOnline,
    triggerSync,
    retryErrors,
    dispose
  }
}
