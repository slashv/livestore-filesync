/**
 * FileSync Service
 *
 * Core sync orchestration service that coordinates file synchronization
 * between local storage and remote storage, and provides file CRUD helpers.
 *
 * IMPORTANT: In multi-tab scenarios, only the leader tab runs the sync loop.
 * This prevents race conditions where multiple tabs try to update state
 * and enqueue transfers simultaneously.
 *
 * @module
 */

import type { Scope } from "effect"
import { Context, Effect, Fiber, Layer, Ref, Stream, SubscriptionRef } from "effect"
import { StorageError } from "../../errors/index.js"
import type { FileNotFoundError, HashError } from "../../errors/index.js"
import { getClientSession, type LiveStoreDeps } from "../../livestore/types.js"
import type {
  FileOperationResult,
  FileRecord,
  FileSyncEvent,
  FileSyncEventCallback,
  LocalFilesState,
  LocalFilesStateMutable
} from "../../types/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import { makeStoreRoot, stripFilesRoot } from "../../utils/path.js"
import { LocalFileStateManager } from "../local-file-state/index.js"
import { LocalFileStorage } from "../local-file-storage/index.js"
import { RemoteStorage } from "../remote-file-storage/index.js"
import {
  defaultConfig as defaultExecutorConfig,
  makeSyncExecutor,
  type SyncExecutorConfig,
  type TransferKind
} from "../sync-executor/index.js"

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
   * Save a new file locally and queue for upload
   */
  readonly saveFile: (file: File) => Effect.Effect<FileOperationResult, HashError | StorageError>

  /**
   * Update an existing file
   */
  readonly updateFile: (
    fileId: string,
    file: File
  ) => Effect.Effect<FileOperationResult, Error | HashError | StorageError>

  /**
   * Delete a file (soft delete in store, cleanup local/remote)
   */
  readonly deleteFile: (fileId: string) => Effect.Effect<void>

  /**
   * Resolve a file URL with local->remote fallback by file ID
   */
  readonly resolveFileUrl: (
    fileId: string
  ) => Effect.Effect<string | null, StorageError | FileNotFoundError>

  /**
   * Mark a local file as changed (triggers upload)
   */
  readonly markLocalFileChanged: (
    fileId: string,
    path: string,
    hash: string
  ) => Effect.Effect<void>

  /**
   * Prioritize download of a specific file.
   * Moves the file to the front of the download queue if it's pending.
   */
  readonly prioritizeDownload: (fileId: string) => Effect.Effect<void>

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
>() {}

const isNode = (): boolean => typeof process !== "undefined" && !!process.versions?.node

const resolveLocalFileUrl = (root: string | undefined, storedPath: string): string => {
  // Build a file:// URL (for Node/Electron main) without node:* imports so bundlers don't externalize node modules in browser builds.
  const normalize = (value: string): string => value.replace(/\\/g, "/")
  const normalizedRoot = root ? normalize(root).replace(/\/+$/, "") : ""
  const rootWithSlash = normalizedRoot
    ? normalizedRoot.startsWith("/")
      ? normalizedRoot
      : `/${normalizedRoot}`
    : ""
  const normalizedPath = normalize(storedPath).replace(/^\/+/, "")
  const fullPath = `${rootWithSlash || ""}/${normalizedPath}`.replace(/\/{2,}/g, "/")
  return `file://${fullPath}`
}

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

  /**
   * Automatically prioritize downloads when resolving file URLs.
   * When true (default), calling resolveFileUrl for a file that's queued for download
   * will move it to the front of the download queue.
   * @default true
   */
  readonly autoPrioritizeOnResolve?: boolean
}

/**
 * Default FileSync configuration
 */
export const defaultFileSyncConfig: FileSyncConfig = {
  healthCheckIntervalMs: 10000,
  gcDelayMs: 300,
  autoPrioritizeOnResolve: true
}

/**
 * Create the FileSync service
 */
export const makeFileSync = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Effect.Effect<FileSyncService, never, LocalFileStorage | LocalFileStateManager | RemoteStorage | Scope.Scope> =>
  Effect.gen(function*() {
    const localStorage = yield* LocalFileStorage
    const stateManager = yield* LocalFileStateManager
    const remoteStorage = yield* RemoteStorage
    const { schema, store, storeId } = deps
    const { events, queryDb, tables } = schema

    // Get client session for leader election
    const clientSession = getClientSession(store)

    // State
    const onlineRef = yield* Ref.make(true)
    const runningRef = yield* Ref.make(false)
    const unsubscribeRef = yield* Ref.make<(() => void) | null>(null)
    const activeSyncOpsRef = yield* Ref.make(0)
    const isLeaderRef = yield* Ref.make(false)
    const leaderWatcherFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

    // Semaphore to ensure checkAndSync doesn't run concurrently with itself
    // This prevents race conditions where multiple reconciliations interleave
    const checkAndSyncLock = yield* Effect.makeSemaphore(1)

    // Event callbacks
    const eventCallbacks = yield* Ref.make<Array<FileSyncEventCallback>>([])

    // Background fibers
    const gcFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    const healthCheckFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

    const executorConfig: SyncExecutorConfig = {
      ...defaultExecutorConfig,
      ...config.executorConfig
    }

    // Emit an event
    const emit = (event: FileSyncEvent): Effect.Effect<void> =>
      Effect.gen(function*() {
        const callbacks = yield* Ref.get(eventCallbacks)
        for (const callback of callbacks) {
          callback(event)
        }
      })

    const getActiveFiles = (): Effect.Effect<Array<FileRecord>> =>
      Effect.sync(() => store.query<Array<FileRecord>>(queryDb(tables.files.where({ deletedAt: null }))))

    const getDeletedFiles = (): Effect.Effect<Array<FileRecord>> =>
      Effect.sync(() =>
        store.query<Array<FileRecord>>(
          queryDb(tables.files.where({ deletedAt: { op: "!=", value: null } }))
        )
      )

    const getFile = (fileId: string): Effect.Effect<FileRecord | undefined> =>
      Effect.sync(() => {
        const files = store.query<Array<FileRecord>>(queryDb(tables.files.where({ id: fileId })))
        return files[0]
      })

    const getLocalFilesState = (): Effect.Effect<LocalFilesState> => stateManager.getState()

    const updateFileRemoteKey = (fileId: string, remoteKey: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const files = store.query<Array<FileRecord>>(queryDb(tables.files.where({ id: fileId })))
        const file = files[0]
        if (!file) return
        store.commit(
          events.fileUpdated({
            id: fileId,
            path: file.path,
            remoteKey,
            contentHash: file.contentHash,
            updatedAt: new Date()
          })
        )
      })

    const createFileRecord = (params: { id: string; path: string; contentHash: string }) =>
      Effect.sync(() => {
        console.log("createFileRecord file ID:", params.id)
        store.commit(
          events.fileCreated({
            id: params.id,
            path: params.path,
            contentHash: params.contentHash,
            createdAt: new Date(),
            updatedAt: new Date()
          })
        )
      })

    const updateFileRecord = (params: {
      id: string
      path: string
      contentHash: string
      remoteKey?: string
    }) =>
      Effect.gen(function*() {
        const file = yield* getFile(params.id)
        if (!file) return
        store.commit(
          events.fileUpdated({
            id: params.id,
            path: params.path,
            remoteKey: params.remoteKey ?? file.remoteKey,
            contentHash: params.contentHash,
            updatedAt: new Date()
          })
        )
      })

    const deleteFileRecord = (fileId: string) =>
      Effect.sync(() => {
        store.commit(events.fileDeleted({ id: fileId, deletedAt: new Date() }))
      })

    // Cleanup deleted local files when idle
    const cleanDeletedLocalFiles = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const diskPaths = yield* localStorage.listFiles(makeStoreRoot(storeId)).pipe(
          Effect.catchAll(() => Effect.succeed<Array<string>>([]))
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
      Effect.gen(function*() {
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
      Effect.gen(function*() {
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (!existing) return
        yield* Fiber.interrupt(existing)
        yield* Ref.set(healthCheckFiberRef, null)
      })

    const startHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (existing) return

        const intervalMs = config.healthCheckIntervalMs ?? 10000

        const loop: Effect.Effect<void> = Effect.gen(function*() {
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
      Effect.gen(function*() {
        yield* stateManager.setTransferStatus(fileId, "download", "inProgress")
        yield* emit({ type: "download:start", fileId })

        const file = yield* getFile(fileId)
        if (!file || !file.remoteKey) {
          const error = new Error("File not found or no remote URL")
          yield* emit({ type: "download:error", fileId, error })
          return yield* Effect.fail(error)
        }

        const downloadedFile = yield* remoteStorage.download(file.remoteKey, {
          onProgress: (progress) => {
            // Fire-and-forget progress event - don't block the download
            Effect.runFork(
              emit({
                type: "download:progress",
                fileId,
                progress: {
                  kind: "download",
                  fileId,
                  status: "inProgress",
                  loaded: progress.loaded,
                  total: progress.total
                }
              })
            )
          }
        })
        yield* localStorage.writeFile(file.path, downloadedFile)
        const localHash = yield* hashFile(downloadedFile)

        yield* stateManager.setFileState(fileId, {
          path: file.path,
          localHash,
          downloadStatus: "done",
          uploadStatus: "done",
          lastSyncError: ""
        })

        yield* emit({ type: "download:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* stateManager.setTransferError(
              fileId,
              "download",
              "pending",
              String(error)
            )
            yield* emit({ type: "download:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Upload a file from local to remote
    const uploadFile = (fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        yield* stateManager.setTransferStatus(fileId, "upload", "inProgress")
        yield* emit({ type: "upload:start", fileId })

        const file = yield* getFile(fileId)
        if (!file) {
          const error = new Error("File not found")
          yield* emit({ type: "upload:error", fileId, error })
          return yield* Effect.fail(error)
        }

        if (file.deletedAt) {
          yield* stateManager.removeFile(fileId)
          yield* emit({ type: "upload:complete", fileId })
          return
        }

        const localFile = yield* localStorage.readFile(file.path)
        const remoteKey = stripFilesRoot(file.path)
        const uploadResult = yield* remoteStorage.upload(localFile, {
          key: remoteKey,
          onProgress: (progress) => {
            // Fire-and-forget progress event - don't block the upload
            Effect.runFork(
              emit({
                type: "upload:progress",
                fileId,
                progress: {
                  kind: "upload",
                  fileId,
                  status: "inProgress",
                  loaded: progress.loaded,
                  total: progress.total
                }
              })
            )
          }
        })

        const latestFile = yield* getFile(fileId)
        if (!latestFile || latestFile.deletedAt) {
          yield* remoteStorage.delete(uploadResult.key).pipe(Effect.catchAll(() => Effect.void))
          yield* stateManager.removeFile(fileId)
          yield* emit({ type: "upload:complete", fileId })
          return
        }

        yield* updateFileRemoteKey(fileId, uploadResult.key)

        // Update state with upload completed
        yield* stateManager.atomicUpdate((state) => {
          const existing = state[fileId]
          if (!existing) return state
          return {
            ...state,
            [fileId]: {
              ...existing,
              uploadStatus: "done",
              lastSyncError: ""
            }
          }
        })

        yield* emit({ type: "upload:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* stateManager.setTransferError(
              fileId,
              "upload",
              "pending",
              String(error)
            )
            yield* emit({ type: "upload:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Transfer handler for the sync executor
    const transferHandler = (kind: TransferKind, fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
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
    // Pass 1 runs atomically (no disk I/O), Pass 2 does disk I/O for new files only
    const reconcileLocalFileState = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const files = yield* getActiveFiles()

        // Pass 1: Atomically reconcile existing state (no disk I/O)
        // This ensures we don't clobber concurrent transfer status updates
        yield* stateManager.atomicUpdate((currentState) => {
          const nextState: LocalFilesStateMutable = {}

          // Only keep files that are still active
          for (const file of files) {
            const existing = currentState[file.id]
            if (existing) {
              const remoteMismatch = existing.localHash !== file.contentHash
              // Only consider download if file has a remote key
              const needsDownload = remoteMismatch && !!file.remoteKey
              // Need upload if file doesn't have a remote key yet
              const needsUpload = !file.remoteKey

              // CRITICAL: Preserve active transfer statuses - these are being managed by
              // concurrent upload/download operations and we must not overwrite them
              const activeStatuses = ["queued", "inProgress"] as const
              const preserveUploadStatus = activeStatuses.includes(
                existing.uploadStatus as typeof activeStatuses[number]
              )
              const preserveDownloadStatus = activeStatuses.includes(
                existing.downloadStatus as typeof activeStatuses[number]
              )

              nextState[file.id] = {
                ...existing,
                downloadStatus: preserveDownloadStatus
                  ? existing.downloadStatus
                  : needsDownload
                  ? "pending"
                  : "done",
                uploadStatus: preserveUploadStatus
                  ? existing.uploadStatus
                  : needsUpload
                  ? "pending"
                  : "done"
              }
            }
          }

          return nextState
        })

        // Pass 2: Check disk for files not yet in state (disk I/O required)
        // This happens outside the atomic block since disk I/O is slow
        const currentState = yield* stateManager.getState()

        for (const file of files) {
          // Skip if already in state
          if (file.id in currentState) continue

          const exists = yield* localStorage.fileExists(file.path)
          if (!exists) {
            if (file.remoteKey) {
              // File exists remotely but not locally - need to download
              yield* stateManager.setFileState(file.id, {
                path: file.path,
                localHash: "",
                downloadStatus: "pending",
                uploadStatus: "done",
                lastSyncError: ""
              })
            }
            continue
          }

          // File exists locally - compute hash and determine sync needs
          const f = yield* localStorage.readFile(file.path)
          const localHash = yield* hashFile(f)
          const remoteMismatch = localHash !== file.contentHash
          const shouldUpload = !file.remoteKey

          yield* stateManager.setFileState(file.id, {
            path: file.path,
            localHash,
            downloadStatus: remoteMismatch && file.remoteKey ? "pending" : "done",
            uploadStatus: shouldUpload ? "pending" : "done",
            lastSyncError: ""
          })
        }
      }).pipe(Effect.catchAll(() => Effect.void))

    const syncFiles = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* emit({ type: "sync:start" })

        // Collect files to enqueue while atomically updating their status
        const toEnqueue: Array<{ fileId: string; kind: "upload" | "download" }> = []

        yield* stateManager.atomicUpdate((currentState) => {
          const nextState = { ...currentState }

          for (const [fileId, localFile] of Object.entries(nextState)) {
            if (localFile.downloadStatus === "pending") {
              nextState[fileId] = { ...localFile, downloadStatus: "queued" }
              toEnqueue.push({ fileId, kind: "download" })
            }
            if (localFile.uploadStatus === "pending") {
              nextState[fileId] = { ...nextState[fileId], uploadStatus: "queued" }
              toEnqueue.push({ fileId, kind: "upload" })
            }
          }

          return nextState
        })

        // Enqueue after the atomic state update (outside the atomic block)
        for (const { fileId, kind } of toEnqueue) {
          if (kind === "download") {
            yield* executor.enqueueDownload(fileId)
          } else {
            yield* executor.enqueueUpload(fileId)
          }
        }

        yield* emit({ type: "sync:complete" })
      })

    const checkAndSync = (): Effect.Effect<void> =>
      checkAndSyncLock.withPermits(1)(
        Effect.gen(function*() {
          yield* reconcileLocalFileState()
          yield* syncFiles()
          yield* scheduleCleanupIfIdle()
        })
      )

    // Recovery: Reset stale "inProgress" statuses to "pending"
    // This handles the case where a page refresh interrupted an in-flight transfer.
    // On a fresh page load, no transfer can actually be in progress, so any
    // "inProgress" status is stale and should be reset to allow retry.
    const recoverStaleTransfers = (): Effect.Effect<void> =>
      stateManager.atomicUpdate((currentState) => {
        let hasChanges = false
        const nextState = { ...currentState }

        for (const [fileId, localFile] of Object.entries(nextState)) {
          let updated = false
          const updatedFile = { ...localFile }

          if (localFile.uploadStatus === "inProgress") {
            updatedFile.uploadStatus = "pending"
            updated = true
          }
          if (localFile.downloadStatus === "inProgress") {
            updatedFile.downloadStatus = "pending"
            updated = true
          }

          if (updated) {
            nextState[fileId] = updatedFile
            hasChanges = true
          }
        }

        return hasChanges ? nextState : currentState
      })

    // Start the sync loop (only called when we're the leader)
    const startSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const isLeader = yield* Ref.get(isLeaderRef)
        if (!isLeader) return

        // Unsubscribe from any existing subscription first
        const existingUnsub = yield* Ref.get(unsubscribeRef)
        if (existingUnsub) {
          existingUnsub()
          yield* Ref.set(unsubscribeRef, null)
        }

        // IMPORTANT: Recover from stale "inProgress" states before reconciliation.
        // This handles page refresh mid-transfer scenarios where the transfer fiber
        // died but the state was persisted as "inProgress".
        yield* recoverStaleTransfers()

        // Subscribe to file changes
        const unsubscribe = yield* Effect.sync(() => {
          const fileQuery = queryDb(tables.files.select().where({ deletedAt: null }))
          return store.subscribe(fileQuery, () => {
            // Only run sync if we're still the leader
            Effect.runPromise(
              Effect.gen(function*() {
                const stillLeader = yield* Ref.get(isLeaderRef)
                if (stillLeader) {
                  yield* checkAndSync()
                }
              })
            ).catch(() => {})
          })
        })

        yield* Ref.set(unsubscribeRef, unsubscribe)

        // Initial sync
        yield* checkAndSync()
      })

    // Stop the sync loop (called when we lose leadership)
    const stopSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Pause executor processing
        yield* executor.pause()

        // Unsubscribe from file changes
        const unsubscribe = yield* Ref.get(unsubscribeRef)
        if (unsubscribe) {
          unsubscribe()
          yield* Ref.set(unsubscribeRef, null)
        }
      })

    // Watch for leadership changes
    const watchLeadership = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        // Use SubscriptionRef's changes stream to watch lockStatus
        yield* clientSession.lockStatus.changes.pipe(
          Stream.tap((status) =>
            Effect.gen(function*() {
              const wasLeader = yield* Ref.get(isLeaderRef)
              const isNowLeader = status === "has-lock"

              if (isNowLeader && !wasLeader) {
                // Became leader - start sync loop
                yield* Effect.logDebug("[FileSync] Became leader, starting sync loop")
                yield* Ref.set(isLeaderRef, true)
                yield* executor.resume()
                yield* startSyncLoop()
              } else if (!isNowLeader && wasLeader) {
                // Lost leadership - stop sync loop
                yield* Effect.logDebug("[FileSync] Lost leadership, stopping sync loop")
                yield* Ref.set(isLeaderRef, false)
                yield* stopSyncLoop()
              }
            })
          ),
          Stream.runDrain,
          Effect.forkScoped
        )
      })

    // Service methods
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const running = yield* Ref.get(runningRef)
        if (running) return

        yield* Ref.set(runningRef, true)

        // Start the executor
        yield* executor.start()

        // Check initial lock status
        const initialStatus = yield* SubscriptionRef.get(clientSession.lockStatus)
        const isInitialLeader = initialStatus === "has-lock"
        yield* Ref.set(isLeaderRef, isInitialLeader)

        if (isInitialLeader) {
          yield* Effect.logDebug("[FileSync] Starting as leader")
          yield* startSyncLoop()
        } else {
          yield* Effect.logDebug("[FileSync] Starting as non-leader, waiting for leadership")
        }

        // Watch for leadership changes
        const watchFiber = yield* watchLeadership().pipe(Effect.forkScoped)
        yield* Ref.set(leaderWatcherFiberRef, watchFiber)
      })

    const stop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const running = yield* Ref.get(runningRef)
        if (!running) return

        yield* Ref.set(runningRef, false)

        // Stop leader watcher
        const leaderWatcherFiber = yield* Ref.get(leaderWatcherFiberRef)
        if (leaderWatcherFiber) {
          yield* Fiber.interrupt(leaderWatcherFiber)
          yield* Ref.set(leaderWatcherFiberRef, null)
        }

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

        // Reset leader status
        yield* Ref.set(isLeaderRef, false)
      })

    const syncNow = (): Effect.Effect<void> => checkAndSync()

    const markLocalFileChanged = (
      fileId: string,
      path: string,
      hash: string
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* stateManager.setFileState(fileId, {
          path,
          localHash: hash,
          downloadStatus: "done",
          uploadStatus: "queued",
          lastSyncError: ""
        })

        yield* executor.enqueueUpload(fileId)
      })

    const saveFile = (file: File): Effect.Effect<FileOperationResult, HashError | StorageError> =>
      Effect.gen(function*() {
        const id = crypto.randomUUID()
        const contentHash = yield* hashFile(file)
        const path = makeStoredPath(storeId, contentHash)

        yield* localStorage.writeFile(path, file)
        yield* createFileRecord({ id, path, contentHash })
        yield* markLocalFileChanged(id, path, contentHash)

        return { fileId: id, path, contentHash }
      })

    const updateFile = (
      fileId: string,
      file: File
    ): Effect.Effect<FileOperationResult, Error | HashError | StorageError> =>
      Effect.gen(function*() {
        const existingFile = yield* getFile(fileId)
        if (!existingFile) {
          return yield* Effect.fail(new Error(`File not found: ${fileId}`))
        }

        const contentHash = yield* hashFile(file)
        const path = makeStoredPath(storeId, contentHash)

        if (contentHash !== existingFile.contentHash) {
          yield* localStorage.writeFile(path, file)
          yield* updateFileRecord({ id: fileId, path, contentHash, remoteKey: "" })

          if (path !== existingFile.path) {
            yield* localStorage.deleteFile(existingFile.path).pipe(Effect.catchAll(() => Effect.void))
          }

          if (existingFile.remoteKey) {
            yield* remoteStorage.delete(existingFile.remoteKey).pipe(Effect.catchAll(() => Effect.void))
          }

          yield* markLocalFileChanged(fileId, path, contentHash)
        }

        return { fileId, path, contentHash }
      })

    const deleteFile = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existingFile = yield* getFile(fileId)
        if (!existingFile) return

        yield* deleteFileRecord(fileId)

        yield* localStorage.deleteFile(existingFile.path).pipe(Effect.catchAll(() => Effect.void))

        if (existingFile.remoteKey) {
          yield* remoteStorage.delete(existingFile.remoteKey).pipe(Effect.catchAll(() => Effect.void))
        }
      })

    const resolveFileUrl = (
      fileId: string
    ): Effect.Effect<string | null, StorageError | FileNotFoundError> =>
      Effect.gen(function*() {
        const file = yield* getFile(fileId)
        if (!file) return null

        const localState = yield* getLocalFilesState()
        const local = localState[fileId]

        if (local?.localHash) {
          const exists = yield* localStorage.fileExists(file.path)
          if (exists) {
            if (isNode()) {
              return resolveLocalFileUrl(deps.localPathRoot, file.path)
            }
            return yield* localStorage.getFileUrl(file.path)
          }
        }

        if (config.autoPrioritizeOnResolve !== false) {
          if (local?.downloadStatus === "pending" || local?.downloadStatus === "queued") {
            yield* executor.prioritizeDownload(fileId)
          }
        }

        if (!file.remoteKey) return null
        return yield* remoteStorage.getDownloadUrl(file.remoteKey).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: "Failed to resolve remote URL",
                cause: error
              })
          )
        )
      })

    const setOnline = (online: boolean): Effect.Effect<void> =>
      Effect.gen(function*() {
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

    const onEvent = (callback: FileSyncEventCallback): () => void => {
      // Add callback synchronously
      Effect.runSync(Ref.update(eventCallbacks, (cbs) => [...cbs, callback]))

      return () => {
        Effect.runSync(Ref.update(eventCallbacks, (cbs) => cbs.filter((cb) => cb !== callback)))
      }
    }

    const prioritizeDownload = (fileId: string): Effect.Effect<void> => executor.prioritizeDownload(fileId)

    return {
      start,
      stop,
      syncNow,
      saveFile,
      updateFile,
      deleteFile,
      resolveFileUrl,
      markLocalFileChanged,
      prioritizeDownload,
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
): Layer.Layer<FileSync, never, LocalFileStorage | LocalFileStateManager | RemoteStorage | Scope.Scope> =>
  Layer.scoped(FileSync, makeFileSync(deps, config))
