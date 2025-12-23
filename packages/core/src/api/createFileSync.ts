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

import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import {
  FileStorage,
  FileStorageLive,
  FileSync,
  FileSyncLive,
  FileSystem,
  FileSystemOpfsLive,
  LocalFileStorage,
  LocalFileStorageLive,
  RemoteStorage,
  makeHttpRemoteStorage
} from "../services/index.js"
import type { FileStorageService } from "../services/file-storage/index.js"
import type { FileSyncService } from "../services/file-sync/index.js"
import { defaultConfig as defaultExecutorConfig } from "../services/sync-executor/index.js"
import type {
  FileOperationResult,
  FileRecord,
  FileSyncEvent,
  LocalFileState,
  LocalFilesState,
  TransferStatus
} from "../types/index.js"
import {
  type SyncSchema,
  type SyncStore,
  type LiveStoreDeps
} from "../livestore/types.js"
import type { FileSyncConfig } from "../services/file-sync/index.js"

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
    baseUrl: string
    authHeaders?: () => HeadersInit
  }

  /** Optional filesystem layer override */
  fileSystem?: Layer.Layer<FileSystem>

  /** Optional configuration */
  options?: {
    maxConcurrentDownloads?: number
    maxConcurrentUploads?: number
    healthCheckIntervalMs?: number
    gcDelayMs?: number
    onEvent?: (event: SyncEvent) => void
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

  /** Check if currently online */
  isOnline: () => boolean

  /** Manually trigger a sync check */
  triggerSync: () => void

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
 * import { createFileSync } from '@livestore-filesync/core'
 * import { useStore } from 'vue-livestore'
 * import { queryDb } from '@livestore/livestore'
 * import { tables, events } from './schema'
 *
 * const { store } = useStore()
 *
 * const fileSync = createFileSync({
 *   store,
 *   schema: {
 *     tables,
 *     events,
 *     queryDb
 *   },
 *   remote: {
 *     baseUrl: '/api',
 *     authHeaders: () => ({ Authorization: `Bearer ${token}` })
 *   }
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
  const { store, schema, remote, fileSystem, options = {} } = config

  // State
  let online = typeof navigator !== "undefined" ? navigator.onLine : true
  let unsubscribeEvents: (() => void) | null = null
  let connectivityEventsAttached = false
  let disposed = false
  let scope: Scope.CloseableScope | null = null
  let fileSyncService: FileSyncService | null = null
  let fileStorageService: FileStorageService | null = null

  const deps: LiveStoreDeps = { store, schema }

  const remoteStorageConfig: { baseUrl: string; headers?: Record<string, string> } = {
    baseUrl: remote.baseUrl
  }
  if (remote.authHeaders) {
    remoteStorageConfig.headers = remote.authHeaders() as Record<string, string>
  }

  const RemoteStorageLive = Layer.succeed(
    RemoteStorage,
    makeHttpRemoteStorage(remoteStorageConfig)
  )

  const fileSyncConfig: FileSyncConfig = {
    executorConfig: {
      maxConcurrentDownloads:
        options.maxConcurrentDownloads ?? defaultExecutorConfig.maxConcurrentDownloads,
      maxConcurrentUploads: options.maxConcurrentUploads ?? defaultExecutorConfig.maxConcurrentUploads
    },
    ...(options.healthCheckIntervalMs !== undefined
      ? { healthCheckIntervalMs: options.healthCheckIntervalMs }
      : {}),
    ...(options.gcDelayMs !== undefined ? { gcDelayMs: options.gcDelayMs } : {})
  }

  const FileSystemLive = fileSystem ?? FileSystemOpfsLive()

  const BaseLayer = Layer.mergeAll(
    Layer.scope,
    FileSystemLive,
    LocalFileStorageLive,
    RemoteStorageLive
  )

  const FileSyncLayer = Layer.provide(BaseLayer)(FileSyncLive(deps, fileSyncConfig))
  const FileStorageLayer = Layer.provide(Layer.mergeAll(BaseLayer, FileSyncLayer))(
    FileStorageLive(deps)
  )

  const MainLayer = Layer.mergeAll(BaseLayer, FileSyncLayer, FileStorageLayer)

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

  const getFileStorageService = async (): Promise<FileStorageService> => {
    if (fileStorageService) return fileStorageService
    fileStorageService = await runEffect(Effect.gen(function*() {
      return yield* FileStorage
    }))
    return fileStorageService
  }

  // Connectivity wiring (browser-only)
  const attachConnectivityHandlers = async () => {
    if (connectivityEventsAttached || typeof window === "undefined") return
    connectivityEventsAttached = true

    const fileSync = await getFileSyncService()

    const initialOnline = typeof navigator !== "undefined" ? navigator.onLine : true
    online = initialOnline
    void runEffect(fileSync.setOnline(initialOnline))

    window.addEventListener("online", () => {
      online = true
      void runEffect(fileSync.setOnline(true))
    })
    window.addEventListener("offline", () => {
      online = false
      void runEffect(fileSync.setOnline(false))
    })
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
    if (scope || disposed) return
    void (async () => {
      scope = await runEffect(Scope.make())
      const fileSync = await getFileSyncService()
      await ensureEventSubscription()
      await attachConnectivityHandlers()
      await runEffect(Scope.extend(fileSync.start(), scope))
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
    const storage = await getFileStorageService()
    return runEffect(storage.saveFile(file))
  }

  const updateFile = async (fileId: string, file: File): Promise<SyncFileOperationResult> => {
    const storage = await getFileStorageService()
    return runEffect(storage.updateFile(fileId, file))
  }

  const deleteFile = async (fileId: string): Promise<void> => {
    const storage = await getFileStorageService()
    await runEffect(storage.deleteFile(fileId))
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

  const triggerSync = () => {
    void (async () => {
      const fileSync = await getFileSyncService()
      await runEffect(fileSync.syncNow())
    })()
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
    isOnline: () => online,
    triggerSync,
    dispose
  }
}
