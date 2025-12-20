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
import { makeSyncExecutor, type SyncExecutorConfig, type TransferKind } from "../sync-executor/index.js"
import { hashFile } from "../../utils/index.js"
import type {
  FileRecord,
  FileSyncEvent,
  FileSyncEventCallback,
  LocalFilesState
} from "../../types/index.js"

/**
 * Store abstraction for LiveStore integration
 *
 * Implement this interface to connect FileSync to your LiveStore instance.
 */
export interface FileSyncStore {
  /**
   * Get all file records
   */
  readonly getFiles: () => Effect.Effect<FileRecord[]>

  /**
   * Get a file record by ID
   */
  readonly getFile: (fileId: string) => Effect.Effect<FileRecord | undefined>

  /**
   * Get the local files state
   */
  readonly getLocalFilesState: () => Effect.Effect<LocalFilesState>

  /**
   * Update local files state
   */
  readonly updateLocalFilesState: (
    updater: (state: LocalFilesState) => LocalFilesState
  ) => Effect.Effect<void>

  /**
   * Update a file record with remote URL
   */
  readonly updateFileRemoteUrl: (fileId: string, remoteUrl: string) => Effect.Effect<void>

  /**
   * Subscribe to file changes
   */
  readonly onFilesChanged: (callback: () => void) => Effect.Effect<() => void>
}

/**
 * FileSyncStore service tag
 */
export class FileSyncStoreTag extends Context.Tag("FileSyncStore")<
  FileSyncStoreTag,
  FileSyncStore
>() {}

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
>() {}

/**
 * FileSync configuration
 */
export interface FileSyncConfig {
  /**
   * Sync executor configuration
   */
  readonly executorConfig?: SyncExecutorConfig

  /**
   * Health check interval when offline (ms)
   */
  readonly healthCheckIntervalMs?: number
}

/**
 * Default FileSync configuration
 */
export const defaultFileSyncConfig: FileSyncConfig = {
  healthCheckIntervalMs: 10000
}

/**
 * Create the FileSync service
 */
export const makeFileSync = (
  config: FileSyncConfig = defaultFileSyncConfig
): Effect.Effect<
  FileSyncService,
  never,
  LocalFileStorage | RemoteStorage | FileSyncStoreTag | Scope.Scope
> =>
  Effect.gen(function*() {
    const localStorage = yield* LocalFileStorage
    const remoteStorage = yield* RemoteStorage
    const store = yield* FileSyncStoreTag

    // State
    const onlineRef = yield* Ref.make(true)
    const runningRef = yield* Ref.make(false)
    const unsubscribeRef = yield* Ref.make<(() => void) | null>(null)

    // Event callbacks
    const eventCallbacks = yield* Ref.make<FileSyncEventCallback[]>([])

    // Emit an event
    const emit = (event: FileSyncEvent): Effect.Effect<void> =>
      Effect.gen(function*() {
        const callbacks = yield* Ref.get(eventCallbacks)
        for (const callback of callbacks) {
          callback(event)
        }
      })

    // Transfer handler for the sync executor
    const transferHandler = (kind: TransferKind, fileId: string): Effect.Effect<void, unknown> =>
      kind === "download" ? downloadFile(fileId) : uploadFile(fileId)

    // Create sync executor
    const executor = yield* makeSyncExecutor(transferHandler, config.executorConfig)

    // Download a file from remote to local
    const downloadFile = (fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        yield* emit({ type: "download:start", fileId })

        const file = yield* store.getFile(fileId)
        if (!file || !file.remoteUrl) {
          const error = new Error("File not found or no remote URL")
          yield* emit({
            type: "download:error",
            fileId,
            error
          })
          return yield* Effect.fail(error)
        }

        // Download from remote
        const downloadedFile = yield* remoteStorage.download(file.remoteUrl)

        // Write to local storage
        yield* localStorage.writeFile(file.path, downloadedFile)

        // Hash the downloaded file
        const hash = yield* hashFile(downloadedFile)

        // Update local state
        yield* store.updateLocalFilesState((state) => ({
          ...state,
          [fileId]: {
            path: file.path,
            localHash: hash,
            downloadStatus: "done" as const,
            uploadStatus: state[fileId]?.uploadStatus ?? "pending" as const,
            lastSyncError: null
          }
        }))

        yield* emit({ type: "download:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* store.updateLocalFilesState((state) => ({
              ...state,
              [fileId]: {
                ...state[fileId],
                path: state[fileId]?.path ?? "",
                localHash: state[fileId]?.localHash ?? null,
                downloadStatus: "error" as const,
                uploadStatus: state[fileId]?.uploadStatus ?? "pending" as const,
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
      Effect.gen(function*() {
        yield* emit({ type: "upload:start", fileId })

        const file = yield* store.getFile(fileId)
        if (!file) {
          const error = new Error("File not found")
          yield* emit({
            type: "upload:error",
            fileId,
            error
          })
          return yield* Effect.fail(error)
        }

        // Read from local storage
        const localFile = yield* localStorage.readFile(file.path)

        // Upload to remote
        const remoteUrl = yield* remoteStorage.upload(localFile)

        // Update file record with remote URL
        yield* store.updateFileRemoteUrl(fileId, remoteUrl)

        // Update local state
        yield* store.updateLocalFilesState((state) => ({
          ...state,
          [fileId]: {
            ...state[fileId],
            path: state[fileId]?.path ?? file.path,
            localHash: state[fileId]?.localHash ?? null,
            downloadStatus: state[fileId]?.downloadStatus ?? "pending" as const,
            uploadStatus: "done" as const,
            lastSyncError: null
          }
        }))

        yield* emit({ type: "upload:complete", fileId })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* store.updateLocalFilesState((state) => ({
              ...state,
              [fileId]: {
                ...state[fileId],
                path: state[fileId]?.path ?? "",
                localHash: state[fileId]?.localHash ?? null,
                downloadStatus: state[fileId]?.downloadStatus ?? "pending" as const,
                uploadStatus: "error" as const,
                lastSyncError: String(error)
              }
            }))
            yield* emit({ type: "upload:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Check files and enqueue necessary syncs
    const checkAndSync = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const online = yield* Ref.get(onlineRef)
        if (!online) return

        const files = yield* store.getFiles()
        const localState = yield* store.getLocalFilesState()

        for (const file of files) {
          if (file.deletedAt !== null) continue

          const local = localState[file.id]

          // Check if needs download (has remote URL but no local file or hash mismatch)
          if (file.remoteUrl) {
            const needsDownload =
              !local ||
              local.localHash === null ||
              local.localHash !== file.contentHash

            if (needsDownload && local?.downloadStatus !== "inProgress") {
              yield* store.updateLocalFilesState((state) => ({
                ...state,
                [file.id]: {
                  path: file.path,
                  localHash: state[file.id]?.localHash ?? null,
                  downloadStatus: "queued" as const,
                  uploadStatus: state[file.id]?.uploadStatus ?? "pending" as const,
                  lastSyncError: null
                }
              }))
              yield* executor.enqueueDownload(file.id)
            }
          }

          // Check if needs upload (has local file but no remote URL)
          if (!file.remoteUrl && local?.localHash) {
            if (local.uploadStatus !== "inProgress") {
              yield* store.updateLocalFilesState((state) => ({
                ...state,
                [file.id]: {
                  ...state[file.id],
                  path: state[file.id]?.path ?? file.path,
                  localHash: state[file.id]?.localHash ?? null,
                  downloadStatus: state[file.id]?.downloadStatus ?? "pending" as const,
                  uploadStatus: "queued" as const,
                  lastSyncError: null
                }
              }))
              yield* executor.enqueueUpload(file.id)
            }
          }
        }
      })

    // Start health check loop when offline
    let healthCheckFiber: Fiber.RuntimeFiber<void, never> | null = null

    const startHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const loop: Effect.Effect<void> = Effect.gen(function*() {
          const online = yield* Ref.get(onlineRef)
          if (online) return

          const isHealthy = yield* remoteStorage.checkHealth()
          if (isHealthy) {
            yield* Ref.set(onlineRef, true)
            yield* emit({ type: "online" })
            yield* executor.resume()
            yield* checkAndSync()
          } else {
            yield* Effect.sleep(`${config.healthCheckIntervalMs ?? 10000} millis`)
            yield* loop
          }
        })

        healthCheckFiber = yield* Effect.fork(loop)
      })

    // Service methods
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const running = yield* Ref.get(runningRef)
        if (running) return

        yield* Ref.set(runningRef, true)

        // Start the executor
        yield* executor.start()

        // Subscribe to file changes
        const unsubscribe = yield* store.onFilesChanged(() => {
          Effect.runPromise(checkAndSync())
        })

        yield* Ref.set(unsubscribeRef, unsubscribe)

        // Initial sync
        yield* checkAndSync()
      })

    const stop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const running = yield* Ref.get(runningRef)
        if (!running) return

        yield* Ref.set(runningRef, false)

        // Stop health check if running
        if (healthCheckFiber) {
          yield* Fiber.interrupt(healthCheckFiber)
          healthCheckFiber = null
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
      Effect.gen(function*() {
        yield* store.updateLocalFilesState((state) => ({
          ...state,
          [fileId]: {
            path,
            localHash: hash,
            downloadStatus: "done" as const,
            uploadStatus: "queued" as const,
            lastSyncError: null
          }
        }))

        yield* executor.enqueueUpload(fileId)
      })

    const setOnline = (online: boolean): Effect.Effect<void> =>
      Effect.gen(function*() {
        const wasOnline = yield* Ref.get(onlineRef)
        yield* Ref.set(onlineRef, online)

        if (online && !wasOnline) {
          yield* emit({ type: "online" })
          yield* executor.resume()
          yield* checkAndSync()
        } else if (!online && wasOnline) {
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

    const getLocalFilesState = (): Effect.Effect<LocalFilesState> =>
      store.getLocalFilesState()

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
  config: FileSyncConfig = defaultFileSyncConfig
): Layer.Layer<FileSync, never, LocalFileStorage | RemoteStorage | FileSyncStoreTag | Scope.Scope> =>
  Layer.scoped(FileSync, makeFileSync(config))
