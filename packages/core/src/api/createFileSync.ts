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

import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import {
  LocalFileStorage,
  LocalFileStorageLive,
  RemoteStorage,
  makeHttpRemoteStorage
} from "../services/index.js"
import { hashFile as hashFileEffect } from "../utils/hash.js"
import { makeStoredPath, FILES_DIRECTORY } from "../utils/path.js"

// ============================================================================
// Types (prefixed to avoid conflicts with existing types)
// ============================================================================

/**
 * Transfer status for file operations
 */
export type SyncTransferStatus = "pending" | "queued" | "inProgress" | "done" | "error"

/**
 * Local file state tracking for createFileSync
 */
export interface SyncLocalFileState {
  path: string
  localHash: string
  downloadStatus: SyncTransferStatus
  uploadStatus: SyncTransferStatus
  lastSyncError: string
}

/**
 * Map of file ID to local file state
 */
export type SyncLocalFilesState = Record<string, SyncLocalFileState>

/**
 * File record from the files table for createFileSync
 */
export interface SyncFileRecord {
  id: string
  path: string
  remoteUrl: string
  contentHash: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/**
 * Result of a file operation from createFileSync
 */
export interface SyncFileOperationResult {
  fileId: string
  path: string
  contentHash: string
}

/**
 * Events emitted by the file sync system
 */
export type SyncEvent =
  | { type: "online"; online: boolean }
  | { type: "syncStart" }
  | { type: "syncComplete" }
  | { type: "fileDownloaded"; fileId: string }
  | { type: "fileUploaded"; fileId: string }
  | { type: "error"; error: Error; fileId?: string }

/**
 * Framework-agnostic store interface
 *
 * This matches the essential methods from LiveStore
 */
export interface SyncStore {
  query: <T>(q: unknown) => T
  commit: (event: unknown) => void
  subscribe: (q: unknown, opts: { onUpdate: (result: unknown) => void }) => () => void
}

/**
 * Chainable query interface
 */
interface ChainableQuery {
  where: (condition: Record<string, unknown>) => unknown
}

/**
 * Schema configuration for file sync
 *
 * Must provide the tables and events from createFileSyncSchema
 */
export interface SyncSchema {
  tables: {
    files: {
      where: (condition: Record<string, unknown>) => unknown
      select: () => ChainableQuery
    }
    localFileState: {
      get: () => unknown
    }
  }
  events: {
    fileCreated: (data: {
      id: string
      path: string
      contentHash: string
      createdAt: Date
      updatedAt: Date
    }) => unknown
    fileUpdated: (data: {
      id: string
      path: string
      remoteUrl: string
      contentHash: string
      updatedAt: Date
    }) => unknown
    fileDeleted: (data: { id: string; deletedAt: Date }) => unknown
    localFileStateSet: (data: { localFiles: SyncLocalFilesState }) => unknown
  }
  /** Query builder - typically `queryDb` from livestore */
  queryDb: <T>(query: unknown) => T
}

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
// Sync Executor (queue management with backoff)
// ============================================================================

type TransferKind = "download" | "upload"
type TaskKey = `${TransferKind}:${string}`

interface SyncExecutorOptions {
  maxConcurrentPerKind?: Partial<Record<TransferKind, number>>
  baseDelayMs?: number
  maxDelayMs?: number
  jitterMs?: number
  isOnline: () => boolean
  run: (kind: TransferKind, fileId: string) => Promise<void>
}

function createSyncExecutor(options: SyncExecutorOptions) {
  const maxPerKind: Record<TransferKind, number> = {
    download: options.maxConcurrentPerKind?.download ?? 2,
    upload: options.maxConcurrentPerKind?.upload ?? 2
  }

  const queues: Record<TransferKind, Set<string>> = {
    download: new Set(),
    upload: new Set()
  }

  const inflight: Record<TransferKind, number> = {
    download: 0,
    upload: 0
  }

  const attempts = new Map<TaskKey, number>()
  let paused = false
  let processing = false

  const makeTaskKey = (kind: TransferKind, id: string): TaskKey => `${kind}:${id}`

  const computeBackoffDelay = (taskKey: TaskKey) => {
    const attemptCount = (attempts.get(taskKey) ?? 0) + 1
    attempts.set(taskKey, attemptCount)
    const base = options.baseDelayMs ?? 1000
    const max = options.maxDelayMs ?? 60000
    const jitter = options.jitterMs ?? 500
    const delay =
      Math.min(base * 2 ** (attemptCount - 1), max) + Math.floor(Math.random() * jitter)
    return delay
  }

  const enqueue = (kind: TransferKind, fileId: string) => {
    queues[kind].add(fileId)
    tick()
  }

  const dequeue = (kind: TransferKind): string | undefined => {
    const iterator = queues[kind].values().next()
    if (iterator.done) return undefined
    const fileId = iterator.value as string
    queues[kind].delete(fileId)
    return fileId
  }

  const runOne = async (kind: TransferKind, fileId: string) => {
    inflight[kind]++
    try {
      await options.run(kind, fileId)
      attempts.delete(makeTaskKey(kind, fileId))
    } catch {
      const delay = computeBackoffDelay(makeTaskKey(kind, fileId))
      setTimeout(() => {
        queues[kind].add(fileId)
        tick()
      }, delay)
    } finally {
      inflight[kind]--
      tick()
    }
  }

  const tick = () => {
    if (processing) return
    processing = true
    queueMicrotask(() => {
      processing = false
      if (paused || !options.isOnline()) return
      for (const kind of ["download", "upload"] as const) {
        while (inflight[kind] < maxPerKind[kind]) {
          const fileId = dequeue(kind)
          if (!fileId) break
          runOne(kind, fileId)
        }
      }
    })
  }

  const pause = () => {
    paused = true
  }
  const resume = () => {
    paused = false
    tick()
  }

  const clear = () => {
    queues.download.clear()
    queues.upload.clear()
    attempts.clear()
  }

  return {
    enqueue,
    pause,
    resume,
    clear,
    stats: () => ({
      queuedDownload: queues.download.size,
      queuedUpload: queues.upload.size,
      inflight: { ...inflight },
      paused
    })
  }
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
  const { store, schema, remote, options = {} } = config
  const { tables, events, queryDb } = schema

  // State
  let online = typeof navigator !== "undefined" ? navigator.onLine : true
  let unsubscribe: (() => void) | null = null
  let connectivityEventsAttached = false
  let healthCheckIntervalId: ReturnType<typeof setInterval> | null = null
  let gcTimerId: ReturnType<typeof setTimeout> | null = null
  let activeSyncOps = 0
  let disposed = false

  const healthCheckIntervalMs = options.healthCheckIntervalMs ?? 10000
  const gcDelayMs = options.gcDelayMs ?? 300

  // Create Effect runtime using existing makeHttpRemoteStorage
  const remoteConfig: { baseUrl: string; headers?: Record<string, string> } = {
    baseUrl: remote.baseUrl
  }
  if (remote.authHeaders) {
    remoteConfig.headers = remote.authHeaders() as Record<string, string>
  }
  const remoteService = makeHttpRemoteStorage(remoteConfig)
  const RemoteStorageLive = Layer.succeed(RemoteStorage, remoteService)
  const MainLayer = Layer.merge(LocalFileStorageLive, RemoteStorageLive)
  const runtime = ManagedRuntime.make(MainLayer)

  // Helper to run Effect and get result
  const runEffect = async <A, E>(effect: Effect.Effect<A, E, LocalFileStorage | RemoteStorage>): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    throw exit.cause
  }

  // Emit event
  const emit = (event: SyncEvent) => {
    options.onEvent?.(event)
  }

  // ============================================================================
  // Local File State Management
  // ============================================================================

  const getLocalFilesState = (): SyncLocalFilesState => {
    const state = store.query<{ localFiles: SyncLocalFilesState }>(queryDb(tables.localFileState.get()))
    return state.localFiles
  }

  const mergeLocalFiles = (patch: Record<string, SyncLocalFileState>) => {
    const current = getLocalFilesState()
    store.commit(events.localFileStateSet({ localFiles: { ...current, ...patch } }))
  }

  const setLocalFileTransferStatus = (
    fileId: string,
    action: "upload" | "download",
    status: SyncTransferStatus
  ) => {
    const localFiles = getLocalFilesState()
    const localFile = localFiles[fileId]
    if (!localFile) return
    const field = action === "upload" ? "uploadStatus" : "downloadStatus"
    store.commit(
      events.localFileStateSet({
        localFiles: { ...localFiles, [fileId]: { ...localFile, [field]: status } }
      })
    )
  }

  // ============================================================================
  // Connectivity Management
  // ============================================================================

  const setOnline = (value: boolean) => {
    if (online !== value) {
      online = value
      emit({ type: "online", online: value })
    }
    if (value) {
      executor.resume()
    } else {
      executor.pause()
    }
  }

  const stopHealthChecks = () => {
    if (healthCheckIntervalId !== null) {
      clearInterval(healthCheckIntervalId)
      healthCheckIntervalId = null
    }
  }

  const startHealthChecks = () => {
    if (healthCheckIntervalId !== null) return
    healthCheckIntervalId = setInterval(async () => {
      try {
        const ok = await runEffect(remoteService.checkHealth())
        if (ok) {
          setOnline(true)
          stopHealthChecks()
        }
      } catch {
        // remain offline and keep checking
      }
    }, healthCheckIntervalMs)
  }

  const attachConnectivityHandlers = () => {
    if (connectivityEventsAttached || typeof window === "undefined") return
    connectivityEventsAttached = true

    const initialOnline = typeof navigator !== "undefined" ? navigator.onLine : true
    setOnline(initialOnline)
    if (!initialOnline) startHealthChecks()

    window.addEventListener("online", () => {
      setOnline(true)
      stopHealthChecks()
    })
    window.addEventListener("offline", () => {
      setOnline(false)
      startHealthChecks()
    })
  }

  // ============================================================================
  // Garbage Collection
  // ============================================================================

  const cleanDeletedLocalFiles = async () => {
    const diskPaths = await runEffect(
      Effect.gen(function* () {
        const localStorage = yield* LocalFileStorage
        return yield* localStorage.listFiles(FILES_DIRECTORY)
      })
    )

    const activeFiles = store.query<SyncFileRecord[]>(queryDb(tables.files.where({ deletedAt: null })))
    const deletedFiles = store.query<SyncFileRecord[]>(
      queryDb(tables.files.where({ deletedAt: { $ne: null } }))
    )

    const activePaths = new Set(activeFiles.map((f) => f.path))
    const deletedPaths = new Set(deletedFiles.map((f) => f.path))

    const pathsToDelete = Array.from(deletedPaths).filter(
      (p) => diskPaths.includes(p) && !activePaths.has(p)
    )

    if (pathsToDelete.length > 0) {
      await Promise.all(
        pathsToDelete.map((p) =>
          runEffect(
            Effect.gen(function* () {
              const localStorage = yield* LocalFileStorage
              yield* localStorage.deleteFile(p).pipe(Effect.ignore)
            })
          )
        )
      )
    }
  }

  const scheduleCleanupIfIdle = () => {
    if (activeSyncOps !== 0) return
    if (gcTimerId !== null) {
      clearTimeout(gcTimerId)
      gcTimerId = null
    }
    gcTimerId = setTimeout(async () => {
      gcTimerId = null
      if (activeSyncOps === 0) {
        try {
          await cleanDeletedLocalFiles()
        } catch (e) {
          console.error("Error cleaning deleted local files", e)
        }
      }
    }, gcDelayMs)
  }

  // ============================================================================
  // Download/Upload Operations
  // ============================================================================

  const downloadRemoteFile = async (fileId: string): Promise<Record<string, SyncLocalFileState>> => {
    try {
      const files = store.query<SyncFileRecord[]>(queryDb(tables.files.where({ id: fileId })))
      const fileInstance = files[0]
      if (!fileInstance) {
        throw new Error(`File: ${fileId} not found`)
      }

      const file = await runEffect(
        Effect.gen(function* () {
          const remoteStorage = yield* RemoteStorage
          return yield* remoteStorage.download(fileInstance.remoteUrl)
        })
      )

      await runEffect(
        Effect.gen(function* () {
          const localStorage = yield* LocalFileStorage
          yield* localStorage.writeFile(fileInstance.path, file)
        })
      )

      const localHash = await runEffect(hashFileEffect(file))

      emit({ type: "fileDownloaded", fileId })

      return {
        [fileId]: {
          path: fileInstance.path,
          localHash,
          downloadStatus: "done",
          uploadStatus: "done",
          lastSyncError: ""
        }
      }
    } catch (error) {
      console.error("Error downloading remote file", error)
      startHealthChecks()
      emit({ type: "error", error: error as Error, fileId })
      return {
        [fileId]: {
          path: "",
          localHash: "",
          downloadStatus: "pending",
          uploadStatus: "done",
          lastSyncError: String(error)
        }
      }
    }
  }

  const uploadLocalFile = async (
    fileId: string,
    localFile: SyncLocalFileState
  ): Promise<Record<string, SyncLocalFileState>> => {
    try {
      const file = await runEffect(
        Effect.gen(function* () {
          const localStorage = yield* LocalFileStorage
          return yield* localStorage.readFile(localFile.path)
        })
      )

      const remoteUrl = await runEffect(
        Effect.gen(function* () {
          const remoteStorage = yield* RemoteStorage
          return yield* remoteStorage.upload(file)
        })
      )

      store.commit(
        events.fileUpdated({
          id: fileId,
          path: localFile.path.replace(/\?.*$/, ""),
          remoteUrl,
          contentHash: localFile.localHash,
          updatedAt: new Date()
        })
      )

      emit({ type: "fileUploaded", fileId })

      return {
        [fileId]: {
          ...localFile,
          uploadStatus: "done"
        }
      }
    } catch (error) {
      console.error("Error uploading local file", error)
      startHealthChecks()
      emit({ type: "error", error: error as Error, fileId })
      return {
        [fileId]: {
          ...localFile,
          uploadStatus: "pending",
          lastSyncError: String(error)
        }
      }
    }
  }

  // ============================================================================
  // Sync Executor
  // ============================================================================

  const executor = createSyncExecutor({
    maxConcurrentPerKind: {
      download: options.maxConcurrentDownloads ?? 2,
      upload: options.maxConcurrentUploads ?? 2
    },
    isOnline: () => online,
    run: async (kind, fileId) => {
      activeSyncOps++
      try {
        if (kind === "download") {
          setLocalFileTransferStatus(fileId, "download", "inProgress")
          const newLocalFile = await downloadRemoteFile(fileId)
          mergeLocalFiles(newLocalFile)
        } else if (kind === "upload") {
          setLocalFileTransferStatus(fileId, "upload", "inProgress")
          const localFiles = getLocalFilesState()
          const latestLocal = localFiles[fileId]
          if (!latestLocal) return
          const newLocalFile = await uploadLocalFile(fileId, latestLocal)
          mergeLocalFiles(newLocalFile)
        }
      } finally {
        activeSyncOps = Math.max(0, activeSyncOps - 1)
      }
    }
  })

  // ============================================================================
  // Two-Pass Reconciliation
  // ============================================================================

  const updateLocalFileState = async () => {
    const files = store.query<SyncFileRecord[]>(queryDb(tables.files.where({ deletedAt: null })))
    const localFiles = getLocalFilesState()

    const nextLocalFilesState: SyncLocalFilesState = { ...localFiles }

    // Pass 1: reconcile using existing state and remote metadata only (no disk I/O)
    files.forEach((file) => {
      if (file.id in nextLocalFilesState) {
        const localFile = nextLocalFilesState[file.id]!
        const remoteMismatch = localFile.localHash !== file.contentHash
        nextLocalFilesState[file.id] = {
          ...localFile,
          downloadStatus: remoteMismatch ? "pending" : "done",
          uploadStatus: "done"
        }
      } else if (file.remoteUrl) {
        // Not known locally but exists remotely: mark as pending download
        nextLocalFilesState[file.id] = {
          path: file.path,
          localHash: "",
          downloadStatus: "pending",
          uploadStatus: "done",
          lastSyncError: ""
        }
      }
    })

    // Pass 2: detect local files that need upload (disk I/O)
    const additions: Record<string, SyncLocalFileState> = {}

    await Promise.all(
      files
        .filter((file) => !(file.id in nextLocalFilesState))
        .map(async (file) => {
          const exists = await runEffect(
            Effect.gen(function* () {
              const localStorage = yield* LocalFileStorage
              return yield* localStorage.fileExists(file.path)
            })
          )
          if (!exists) return

          const f = await runEffect(
            Effect.gen(function* () {
              const localStorage = yield* LocalFileStorage
              return yield* localStorage.readFile(file.path)
            })
          )
          const localHash = await runEffect(hashFileEffect(f))
          const shouldUpload = !file.remoteUrl

          additions[file.id] = {
            path: file.path,
            localHash,
            downloadStatus: "done",
            uploadStatus: shouldUpload ? "pending" : "done",
            lastSyncError: ""
          }
        })
    )

    const merged: SyncLocalFilesState = { ...nextLocalFilesState, ...additions }
    store.commit(events.localFileStateSet({ localFiles: merged }))
  }

  const syncFiles = async () => {
    emit({ type: "syncStart" })
    const localFiles = getLocalFilesState()
    Object.entries(localFiles).forEach(([fileId, localFile]) => {
      if (localFile.downloadStatus === "pending" || localFile.downloadStatus === "queued") {
        setLocalFileTransferStatus(fileId, "download", "queued")
        executor.enqueue("download", fileId)
      }
      if (localFile.uploadStatus === "pending" || localFile.uploadStatus === "queued") {
        setLocalFileTransferStatus(fileId, "upload", "queued")
        executor.enqueue("upload", fileId)
      }
    })
    emit({ type: "syncComplete" })
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  const hashFile = async (file: File): Promise<string> => {
    return runEffect(hashFileEffect(file))
  }

  const saveFile = async (file: File): Promise<SyncFileOperationResult> => {
    const fileId = crypto.randomUUID()
    const contentHash = await hashFile(file)
    const path = makeStoredPath(contentHash)

    await runEffect(
      Effect.gen(function* () {
        const localStorage = yield* LocalFileStorage
        yield* localStorage.writeFile(path, file)
      })
    )

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )

    // Mark for upload
    mergeLocalFiles({
      [fileId]: {
        path,
        localHash: contentHash,
        downloadStatus: "done",
        uploadStatus: "queued",
        lastSyncError: ""
      }
    })
    executor.enqueue("upload", fileId)

    return { fileId, path, contentHash }
  }

  const updateFile = async (fileId: string, file: File): Promise<SyncFileOperationResult> => {
    const files = store.query<SyncFileRecord[]>(queryDb(tables.files.where({ id: fileId })))
    const prev = files[0]
    if (!prev) {
      throw new Error(`File not found: ${fileId}`)
    }

    const contentHash = await hashFile(file)
    const path = makeStoredPath(contentHash)

    if (prev.path !== path) {
      await runEffect(
        Effect.gen(function* () {
          const localStorage = yield* LocalFileStorage
          yield* localStorage.writeFile(path, file)
        })
      )
      try {
        await runEffect(
          Effect.gen(function* () {
            const localStorage = yield* LocalFileStorage
            yield* localStorage.deleteFile(prev.path).pipe(Effect.ignore)
          })
        )
      } catch {
        // Ignore delete errors
      }
    } else {
      await runEffect(
        Effect.gen(function* () {
          const localStorage = yield* LocalFileStorage
          yield* localStorage.writeFile(prev.path, file)
        })
      )
    }

    // Mark for upload
    mergeLocalFiles({
      [fileId]: {
        path,
        localHash: contentHash,
        downloadStatus: "done",
        uploadStatus: "queued",
        lastSyncError: ""
      }
    })
    executor.enqueue("upload", fileId)

    return { fileId, path, contentHash }
  }

  const deleteFile = async (fileId: string): Promise<void> => {
    const files = store.query<SyncFileRecord[]>(queryDb(tables.files.where({ id: fileId })))
    const file = files[0]
    if (!file) return

    store.commit(events.fileDeleted({ id: fileId, deletedAt: new Date() }))

    // Try to delete local file
    try {
      await runEffect(
        Effect.gen(function* () {
          const localStorage = yield* LocalFileStorage
          yield* localStorage.deleteFile(file.path).pipe(Effect.ignore)
        })
      )
    } catch {
      // Ignore
    }

    // Try to delete remote file
    if (file.remoteUrl) {
      try {
        await runEffect(
          Effect.gen(function* () {
            const remoteStorage = yield* RemoteStorage
            yield* remoteStorage.delete(file.remoteUrl).pipe(Effect.ignore)
          })
        )
      } catch {
        // Ignore
      }
    }
  }

  const readFile = async (path: string): Promise<File> => {
    return runEffect(
      Effect.gen(function* () {
        const localStorage = yield* LocalFileStorage
        return yield* localStorage.readFile(path)
      })
    )
  }

  const getFileUrl = async (path: string): Promise<string | null> => {
    return runEffect(
      Effect.gen(function* () {
        const localStorage = yield* LocalFileStorage
        const exists = yield* localStorage.fileExists(path)
        if (!exists) return null
        return yield* localStorage.getFileUrl(path)
      })
    )
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  const start = () => {
    if (unsubscribe || disposed) return

    attachConnectivityHandlers()

    const fileQuery = queryDb(tables.files.select().where({ deletedAt: null }))
    unsubscribe = store.subscribe(fileQuery, {
      onUpdate: async () => {
        await updateLocalFileState()
        await syncFiles()
        scheduleCleanupIfIdle()
      }
    })
  }

  const stop = () => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    stopHealthChecks()
    if (gcTimerId !== null) {
      clearTimeout(gcTimerId)
      gcTimerId = null
    }
    executor.clear()
  }

  const dispose = async () => {
    if (disposed) return
    disposed = true
    stop()
    await runtime.dispose()
  }

  const triggerSync = () => {
    updateLocalFileState().then(() => syncFiles())
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
