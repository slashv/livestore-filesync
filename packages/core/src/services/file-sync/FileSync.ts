/**
 * FileSync Service
 *
 * Core sync orchestration service that coordinates file synchronization
 * between local OPFS storage and remote storage.
 *
 * @module
 */

import { Context, Effect, Fiber, Layer, Ref, Scope } from "effect"
import { LocalFileStorage } from "../local-file-storage/index.js"
import { RemoteStorage } from "../remote-file-storage/index.js"
import {
  defaultConfig as defaultExecutorConfig,
  makeSyncExecutor,
  type SyncExecutorConfig,
  type TransferKind,
  type TransferStatus
} from "../sync-executor/index.js"
import { FILES_DIRECTORY } from "../../utils/path.js"
import { hashFile } from "../../utils/index.js"
import type { LiveStoreDeps } from "../../livestore/types.js"
import type {
  FileRecord,
  FileSyncEvent,
  FileSyncEventCallback,
  LocalFilesState
} from "../../types/index.js"

/**
 * FileSync service interface
 */
export interface FileSyncService {
  /**
   * Start the file sync process
   * This will begin watching for file changes and syncing
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>

  /**
   * Stop the file sync process
   */
  readonly stop: () => Effect.Effect<void>

  /**
   * Manually trigger a sync check
   */
  readonly syncNow: () => Effect.Effect<void>

  /**
   * Mark a local file as changed (triggers upload)
   */
  readonly markLocalFileChanged: (
    fileId: string,
    path: string,
    hash: string
  ) => Effect.Effect<void>

  /**
   * Set online/offline status
   */
  readonly setOnline: (online: boolean) => Effect.Effect<void>

  /**
   * Get current online status
   */
  readonly isOnline: () => Effect.Effect<boolean>

  /**
   * Subscribe to sync events (callback API)
   */
  readonly onEvent: (callback: FileSyncEventCallback) => () => void

  /**
   * Get the current local files state
   */
  readonly getLocalFilesState: () => Effect.Effect<LocalFilesState>
}

/**
 * FileSync service tag
 */
export class FileSync extends Context.Tag("FileSync")<
  FileSync,
  FileSyncService
>() { }

/**
 * FileSync configuration
 */
export interface FileSyncConfig {
  /**
   * Sync executor configuration
   */
  readonly executorConfig?: Partial<SyncExecutorConfig>

  /**
   * Health check interval when offline (ms)
   */
  readonly healthCheckIntervalMs?: number

  /**
   * Cleanup delay for deleted local files (ms)
   */
  readonly gcDelayMs?: number
}

/**
 * Default FileSync configuration
 */
export const defaultFileSyncConfig: FileSyncConfig = {
  healthCheckIntervalMs: 10000,
  gcDelayMs: 300
}

/**
 * Create the FileSync service
 */
export const makeFileSync = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Effect.Effect<FileSyncService, never, LocalFileStorage | RemoteStorage | Scope.Scope> =>
  Effect.gen(function* () {
    const localStorage = yield* LocalFileStorage
    const remoteStorage = yield* RemoteStorage
    const { store, schema } = deps
    const { tables, events, queryDb } = schema

    // State
    const onlineRef = yield* Ref.make(true)
    const runningRef = yield* Ref.make(false)
    const unsubscribeRef = yield* Ref.make<(() => void) | null>(null)
    const activeSyncOpsRef = yield* Ref.make(0)

    // Event callbacks
    const eventCallbacks = yield* Ref.make<FileSyncEventCallback[]>([])

    // Background fibers
    const gcFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    const healthCheckFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

    const executorConfig: SyncExecutorConfig = {
      ...defaultExecutorConfig,
      ...(config.executorConfig ?? {})
    }

    // Emit an event
    const emit = (event: FileSyncEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const callbacks = yield* Ref.get(eventCallbacks)
        for (const callback of callbacks) {
          callback(event)
        }
      })

    const getActiveFiles = (): Effect.Effect<FileRecord[]> =>
      Effect.sync(() => store.query<FileRecord[]>(queryDb(tables.files.where({ deletedAt: null }))))

    const getDeletedFiles = (): Effect.Effect<FileRecord[]> =>
      Effect.sync(() =>
        store.query<FileRecord[]>(
          queryDb(tables.files.where({ deletedAt: { op: "!=", value: null } }))
        )
      )

    const getFile = (fileId: string): Effect.Effect<FileRecord | undefined> =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id: fileId })))
        return files[0]
      })

    const readLocalFilesState = (): Effect.Effect<LocalFilesState> =>
      Effect.sync(() => {
        const state = store.query<{ localFiles: LocalFilesState }>(
          queryDb(tables.localFileState.get())
        )
        return state.localFiles ?? {}
      })

    const updateLocalFilesState = (
      updater: (state: LocalFilesState) => LocalFilesState
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const state = store.query<{ localFiles: LocalFilesState }>(
          queryDb(tables.localFileState.get())
        )
        const next = updater(state.localFiles ?? {})
        store.commit(events.localFileStateSet({ localFiles: next }))
      })

    const updateFileRemoteUrl = (fileId: string, remoteUrl: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id: fileId })))
        const file = files[0]
        if (!file) return
        store.commit(
          events.fileUpdated({
            id: fileId,
            path: file.path,
            remoteUrl,
            contentHash: file.contentHash,
            updatedAt: new Date()
          })
        )
      })

    const mergeLocalFiles = (patch: Record<string, LocalFilesState[string]>): Effect.Effect<void> =>
      updateLocalFilesState((state) => ({
        ...state,
        ...patch
      }))

    const setLocalFileTransferStatus = (
      fileId: string,
      action: "upload" | "download",
      status: TransferStatus
    ): Effect.Effect<void> =>
      updateLocalFilesState((state) => {
        const localFile = state[fileId]
        if (!localFile) return state
        const field = action === "upload" ? "uploadStatus" : "downloadStatus"
        return {
          ...state,
          [fileId]: { ...localFile, [field]: status }
        }
      })

    // Cleanup deleted local files when idle
    const cleanDeletedLocalFiles = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const diskPaths = yield* localStorage.listFiles(FILES_DIRECTORY).pipe(
          Effect.catchAll(() => Effect.succeed<string[]>([]))
        )

        const activeFiles = yield* getActiveFiles()
        const deletedFiles = yield* getDeletedFiles()

        const activePaths = new Set(activeFiles.map((f) => f.path))
        const deletedPaths = new Set(deletedFiles.map((f) => f.path))

        const pathsToDelete = Array.from(deletedPaths).filter(
          (p) => diskPaths.includes(p) && !activePaths.has(p)
        )

        if (pathsToDelete.length === 0) return

        yield* Effect.forEach(
          pathsToDelete,
          (path) => localStorage.deleteFile(path).pipe(Effect.ignore),
          { concurrency: "unbounded" }
        )
      })

    const scheduleCleanupIfIdle = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const active = yield* Ref.get(activeSyncOpsRef)
        if (active !== 0) return

        const existing = yield* Ref.get(gcFiberRef)
        if (existing) {
          yield* Fiber.interrupt(existing)
        }

        const delayMs = config.gcDelayMs ?? 300
        const fiber = yield* Effect.fork(
          Effect.sleep(`${delayMs} millis`).pipe(
            Effect.flatMap(() => Ref.get(activeSyncOpsRef)),
            Effect.flatMap((activeNow) =>
              activeNow === 0
                ? cleanDeletedLocalFiles().pipe(Effect.catchAll(() => Effect.void))
                : Effect.void
            ),
            Effect.ensuring(Ref.set(gcFiberRef, null))
          )
        )

        yield* Ref.set(gcFiberRef, fiber)
      })

    // Health check loop while offline
    const stopHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (!existing) return
        yield* Fiber.interrupt(existing)
        yield* Ref.set(healthCheckFiberRef, null)
      })

    const startHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (existing) return

        const intervalMs = config.healthCheckIntervalMs ?? 10000

        const loop: Effect.Effect<void> = Effect.gen(function* () {
          const isHealthy = yield* remoteStorage.checkHealth()
          if (isHealthy) {
            yield* Ref.set(onlineRef, true)
            yield* emit({ type: "online" })
            yield* executor.resume()
            yield* checkAndSync()
            return
          }

          yield* Effect.sleep(`${intervalMs} millis`)
          yield* loop
        })

        const fiber = yield* Effect.fork(
          loop.pipe(Effect.ensuring(Ref.set(healthCheckFiberRef, null)))
        )

        yield* Ref.set(healthCheckFiberRef, fiber)
      })

    // Download a file from remote to local
    const downloadFile = (fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        yield* setLocalFileTransferStatus(fileId, "download", "inProgress")
        yield* emit({ type: "download:start", fileId })

        const file = yield* getFile(fileId)
        if (!file || !file.remoteUrl) {
          const error = new Error("File not found or no remote URL")
          yield* emit({ type: "download:error", fileId, error })
          return yield* Effect.fail(error)
        }

        const downloadedFile = yield* remoteStorage.download(file.remoteUrl)
        yield* localStorage.writeFile(file.path, downloadedFile)
        const localHash = yield* hashFile(downloadedFile)

        yield* mergeLocalFiles({
          [fileId]: {
            path: file.path,
            localHash,
            downloadStatus: "done",
            uploadStatus: "done",
            lastSyncError: ""
          }
        })

        yield* emit({ type: "download:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* updateLocalFilesState((state) => ({
              ...state,
              [fileId]: {
                ...state[fileId],
                path: state[fileId]?.path ?? "",
                localHash: state[fileId]?.localHash ?? "",
                downloadStatus: "pending",
                uploadStatus: state[fileId]?.uploadStatus ?? "done",
                lastSyncError: String(error)
              }
            }))
            yield* emit({ type: "download:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Upload a file from local to remote
    const uploadFile = (fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        yield* setLocalFileTransferStatus(fileId, "upload", "inProgress")
        yield* emit({ type: "upload:start", fileId })

        const file = yield* getFile(fileId)
        if (!file) {
          const error = new Error("File not found")
          yield* emit({ type: "upload:error", fileId, error })
          return yield* Effect.fail(error)
        }

        const localFile = yield* localStorage.readFile(file.path)
        const remoteUrl = yield* remoteStorage.upload(localFile)

        yield* updateFileRemoteUrl(fileId, remoteUrl)

        yield* updateLocalFilesState((state) => ({
          ...state,
          [fileId]: {
            ...state[fileId],
            path: state[fileId]?.path ?? file.path,
            localHash: state[fileId]?.localHash ?? "",
            downloadStatus: state[fileId]?.downloadStatus ?? "done",
            uploadStatus: "done",
            lastSyncError: ""
          }
        }))

        yield* emit({ type: "upload:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* updateLocalFilesState((state) => ({
              ...state,
              [fileId]: {
                ...state[fileId],
                path: state[fileId]?.path ?? "",
                localHash: state[fileId]?.localHash ?? "",
                downloadStatus: state[fileId]?.downloadStatus ?? "done",
                uploadStatus: "pending",
                lastSyncError: String(error)
              }
            }))
            yield* emit({ type: "upload:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Transfer handler for the sync executor
    const transferHandler = (kind: TransferKind, fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        yield* Ref.update(activeSyncOpsRef, (value) => value + 1)
        try {
          if (kind === "download") {
            yield* downloadFile(fileId)
          } else {
            yield* uploadFile(fileId)
          }
        } finally {
          yield* Ref.update(activeSyncOpsRef, (value) => Math.max(0, value - 1))
          yield* scheduleCleanupIfIdle()
        }
      })

    // Create sync executor
    const executor = yield* makeSyncExecutor(transferHandler, executorConfig)

    // Two-pass reconciliation of local file state
    const updateLocalFileState = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const files = yield* getActiveFiles()
        const localFiles = yield* readLocalFilesState()

        const nextLocalFilesState: LocalFilesState = { ...localFiles }

        // Pass 1: reconcile using existing state and remote metadata only (no disk I/O)
        for (const file of files) {
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
        }

        // Pass 2: detect local files that need upload (disk I/O)
        const additions: LocalFilesState = {}

        for (const file of files) {
          if (file.id in nextLocalFilesState) continue

          const exists = yield* localStorage.fileExists(file.path)
          if (!exists) continue

          const f = yield* localStorage.readFile(file.path)
          const localHash = yield* hashFile(f)
          const shouldUpload = !file.remoteUrl

          additions[file.id] = {
            path: file.path,
            localHash,
            downloadStatus: "done",
            uploadStatus: shouldUpload ? "pending" : "done",
            lastSyncError: ""
          }
        }

        const merged: LocalFilesState = { ...nextLocalFilesState, ...additions }
        yield* updateLocalFilesState(() => merged)
      }).pipe(Effect.catchAll(() => Effect.void))

    const syncFiles = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* emit({ type: "sync:start" })

        const localFiles = yield* readLocalFilesState()
        for (const [fileId, localFile] of Object.entries(localFiles)) {
          if (localFile.downloadStatus === "pending" || localFile.downloadStatus === "queued") {
            yield* setLocalFileTransferStatus(fileId, "download", "queued")
            yield* executor.enqueueDownload(fileId)
          }
          if (localFile.uploadStatus === "pending" || localFile.uploadStatus === "queued") {
            yield* setLocalFileTransferStatus(fileId, "upload", "queued")
            yield* executor.enqueueUpload(fileId)
          }
        }

        yield* emit({ type: "sync:complete" })
      })

    const checkAndSync = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        console.log("checkAndSync")
        yield* updateLocalFileState()
        yield* syncFiles()
        yield* scheduleCleanupIfIdle()
      })

    // Service methods
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef)
        if (running) return

        yield* Ref.set(runningRef, true)

        console.log("start")

        // Start the executor
        yield* executor.start()

        // Subscribe to file changes
        const unsubscribe = yield* Effect.sync(() => {
          const fileQuery = queryDb(tables.files.select().where({ deletedAt: null }))
          return store.subscribe(fileQuery, () => {
            console.log("file changed")
            Effect.runPromise(checkAndSync()).catch(() => {})
          })
        })

        yield* Ref.set(unsubscribeRef, unsubscribe)

        // Initial sync
        yield* checkAndSync()
      })

    const stop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef)
        if (!running) return

        yield* Ref.set(runningRef, false)

        // Stop health check if running
        yield* stopHealthCheckLoop()

        // Pause executor processing
        yield* executor.pause()

        const gcFiber = yield* Ref.get(gcFiberRef)
        if (gcFiber) {
          yield* Fiber.interrupt(gcFiber)
          yield* Ref.set(gcFiberRef, null)
        }

        // Unsubscribe from file changes
        const unsubscribe = yield* Ref.get(unsubscribeRef)
        if (unsubscribe) {
          unsubscribe()
          yield* Ref.set(unsubscribeRef, null)
        }
      })

    const syncNow = (): Effect.Effect<void> => checkAndSync()

    const markLocalFileChanged = (
      fileId: string,
      path: string,
      hash: string
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* updateLocalFilesState((state) => ({
          ...state,
          [fileId]: {
            path,
            localHash: hash,
            downloadStatus: "done",
            uploadStatus: "queued",
            lastSyncError: ""
          }
        }))

        yield* executor.enqueueUpload(fileId)
      })

    const setOnline = (online: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const wasOnline = yield* Ref.get(onlineRef)
        if (online === wasOnline) return

        yield* Ref.set(onlineRef, online)

        if (online) {
          yield* emit({ type: "online" })
          yield* executor.resume()
          yield* stopHealthCheckLoop()
          yield* checkAndSync()
        } else {
          yield* emit({ type: "offline" })
          yield* executor.pause()
          yield* startHealthCheckLoop()
        }
      })

    const isOnline = (): Effect.Effect<boolean> => Ref.get(onlineRef)

    const onEvent = (callback: FileSyncEventCallback): (() => void) => {
      // Add callback synchronously
      Effect.runSync(Ref.update(eventCallbacks, (cbs) => [...cbs, callback]))

      return () => {
        Effect.runSync(Ref.update(eventCallbacks, (cbs) => cbs.filter((cb) => cb !== callback)))
      }
    }

    const getLocalFilesState = (): Effect.Effect<LocalFilesState> => readLocalFilesState()

    return {
      start,
      stop,
      syncNow,
      markLocalFileChanged,
      setOnline,
      isOnline,
      onEvent,
      getLocalFilesState
    }
  })

/**
 * Create a Layer for FileSync
 */
export const FileSyncLive = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Layer.Layer<FileSync, never, LocalFileStorage | RemoteStorage | Scope.Scope> =>
  Layer.scoped(FileSync, makeFileSync(deps, config))
