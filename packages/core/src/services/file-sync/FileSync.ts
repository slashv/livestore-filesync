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

import { EventSequenceNumber } from "@livestore/livestore"
import type { LiveStoreEvent } from "@livestore/livestore"
import { Chunk, Context, Duration, Effect, Fiber, Layer, Ref, Schedule, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { StorageError } from "../../errors/index.js"
import type { FileNotFoundError, HashError } from "../../errors/index.js"
import { getClientSession, type LiveStoreDeps } from "../../livestore/types.js"
import type {
  FileCreatedPayload,
  FileDeletedPayload,
  FileOperationResult,
  FileRecord,
  FileSyncEvent,
  FileSyncEventCallback,
  FileUpdatedPayload,
  LocalFilesState,
  PreprocessorMap,
  TransferStatus
} from "../../types/index.js"
import { applyPreprocessor, makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { Hash } from "../hash/index.js"
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
   * Manually restart the event stream from the stored cursor
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

  /**
   * Retry all files currently in error state.
   * Re-queues uploads and downloads for files with error status.
   * @returns Array of file IDs that were re-queued
   */
  readonly retryErrors: () => Effect.Effect<ReadonlyArray<string>>
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
   * Automatically prioritize downloads when resolving file URLs.
   * When true (default), calling resolveFileUrl for a file that's queued for download
   * will move it to the front of the download queue.
   * @default true
   */
  readonly autoPrioritizeOnResolve?: boolean

  /**
   * Maximum stream recovery attempts before giving up.
   * @default 5
   */
  readonly maxStreamRecoveryAttempts?: number

  /**
   * Base delay for stream recovery backoff in ms.
   * @default 1000
   */
  readonly streamRecoveryBaseDelayMs?: number

  /**
   * Maximum delay for stream recovery backoff in ms.
   * @default 60000
   */
  readonly streamRecoveryMaxDelayMs?: number

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
  readonly preprocessors?: PreprocessorMap
}

/**
 * Default FileSync configuration
 */
export const defaultFileSyncConfig: FileSyncConfig = {
  healthCheckIntervalMs: 10000,
  autoPrioritizeOnResolve: true,
  maxStreamRecoveryAttempts: 5,
  streamRecoveryBaseDelayMs: 1000,
  streamRecoveryMaxDelayMs: 60000
}

/**
 * Create the FileSync service
 */
export const makeFileSync = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Effect.Effect<FileSyncService, never, Hash | LocalFileStorage | LocalFileStateManager | RemoteStorage | Scope.Scope> =>
  Effect.gen(function*() {
    const hashService = yield* Hash
    const localStorage = yield* LocalFileStorage
    const stateManager = yield* LocalFileStateManager
    const remoteStorage = yield* RemoteStorage
    const { schema, store, storeId } = deps
    const { events, queryDb, tables } = schema

    // Local wrapper for hashFile that uses the captured hash service
    const doHashFile = (file: File) => hashService.hashFile(file)

    // Get client session for leader election
    const clientSession = getClientSession(store)

    // State
    const onlineRef = yield* Ref.make(true)
    const runningRef = yield* Ref.make(false)
    const isLeaderRef = yield* Ref.make(false)
    const leaderWatcherFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    const eventStreamFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, unknown> | null>(null)
    const cursorRef = yield* Ref.make<string>("")

    // Event callbacks
    const eventCallbacks = yield* Ref.make<Array<FileSyncEventCallback>>([])

    // Background fibers
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

    const readCursor = (): Effect.Effect<string> =>
      Effect.sync(() => {
        const doc = store.query<{ lastEventSequence?: string }>(
          queryDb(tables.fileSyncCursor.get())
        )
        return doc.lastEventSequence ?? ""
      })

    const resolveCursor = (sequence: string) =>
      sequence ? EventSequenceNumber.Client.fromString(sequence) : EventSequenceNumber.Client.ROOT

    const persistCursor = (sequence: string): Effect.Effect<void> =>
      Effect.sync(() => {
        store.commit(
          events.fileSyncCursorSet({
            lastEventSequence: sequence,
            updatedAt: new Date()
          })
        )
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
            yield* restartEventStream()
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
    const downloadFile = (fileId: string) =>
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
        const localHash = yield* doHashFile(downloadedFile)

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
              "error",
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
              "error",
              String(error)
            )
            yield* emit({ type: "upload:error", fileId, error })
            return yield* Effect.fail(error)
          })
        )
      )

    // Transfer handler for the sync executor
    const transferHandler = (kind: TransferKind, fileId: string) =>
      Effect.gen(function*() {
        if (kind === "download") {
          yield* downloadFile(fileId)
        } else {
          yield* uploadFile(fileId)
        }
      })

    // Create sync executor
    const executor = yield* makeSyncExecutor(transferHandler, executorConfig)

    // Two-pass reconciliation of local file state
    const activeTransferStatuses = ["queued", "inProgress"] as const

    const resolveTransferStatus = (
      current: TransferStatus | undefined,
      next: TransferStatus
    ): TransferStatus =>
      current && activeTransferStatuses.includes(current as (typeof activeTransferStatuses)[number])
        ? current
        : next

    const applyFileState = (
      fileId: string,
      nextState: {
        path: string
        localHash: string
        uploadStatus: TransferStatus
        downloadStatus: TransferStatus
        lastSyncError: string
      }
    ): Effect.Effect<void> =>
      stateManager.atomicUpdate((currentState) => {
        const existing = currentState[fileId]
        if (!existing) {
          return {
            ...currentState,
            [fileId]: nextState
          }
        }

        const uploadStatus = resolveTransferStatus(existing.uploadStatus, nextState.uploadStatus)
        const downloadStatus = resolveTransferStatus(existing.downloadStatus, nextState.downloadStatus)

        return {
          ...currentState,
          [fileId]: {
            ...existing,
            ...nextState,
            uploadStatus,
            downloadStatus
          }
        }
      })

    const readLocalHash = (path: string) =>
      Effect.gen(function*() {
        const exists = yield* localStorage.fileExists(path)
        if (!exists) return { exists: false, localHash: "" }
        const file = yield* localStorage.readFile(path)
        const localHash = yield* doHashFile(file)
        return { exists: true, localHash }
      }).pipe(Effect.catchAll(() => Effect.succeed({ exists: false, localHash: "" })))

    const handleFileCreated = (payload: FileCreatedPayload): Effect.Effect<void> =>
      Effect.gen(function*() {
        const { exists, localHash } = yield* readLocalHash(payload.path)
        if (!exists) return

        yield* applyFileState(payload.id, {
          path: payload.path,
          localHash,
          uploadStatus: "queued",
          downloadStatus: "done",
          lastSyncError: ""
        })

        yield* executor.enqueueUpload(payload.id)
      })

    const handleFileUpdated = (payload: FileUpdatedPayload): Effect.Effect<void> =>
      Effect.gen(function*() {
        const { exists, localHash } = yield* readLocalHash(payload.path)

        if (!exists) {
          if (!payload.remoteKey) return
          yield* applyFileState(payload.id, {
            path: payload.path,
            localHash: "",
            uploadStatus: "done",
            downloadStatus: "queued",
            lastSyncError: ""
          })
          yield* executor.enqueueDownload(payload.id)
          return
        }

        if (localHash !== payload.contentHash) {
          if (payload.remoteKey) {
            yield* applyFileState(payload.id, {
              path: payload.path,
              localHash,
              uploadStatus: "done",
              downloadStatus: "queued",
              lastSyncError: ""
            })
            yield* executor.enqueueDownload(payload.id)
            return
          }

          yield* applyFileState(payload.id, {
            path: payload.path,
            localHash,
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          })
          yield* executor.enqueueUpload(payload.id)
          return
        }

        if (!payload.remoteKey) {
          yield* applyFileState(payload.id, {
            path: payload.path,
            localHash,
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          })
          yield* executor.enqueueUpload(payload.id)
          return
        }

        yield* applyFileState(payload.id, {
          path: payload.path,
          localHash,
          uploadStatus: "done",
          downloadStatus: "done",
          lastSyncError: ""
        })
      })

    const handleFileDeleted = (payload: FileDeletedPayload): Effect.Effect<void> =>
      Effect.gen(function*() {
        const state = yield* stateManager.getState()
        const localPath = state[payload.id]?.path
        const file = localPath ? undefined : yield* getFile(payload.id)
        const path = localPath ?? file?.path

        if (path) {
          yield* localStorage.deleteFile(path).pipe(Effect.ignore)
        }

        yield* stateManager.removeFile(payload.id)
      })

    const bootstrapFromTables = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const files = store.query<Array<FileRecord>>(queryDb(tables.files.select()))

        for (const file of files) {
          if (file.deletedAt) {
            yield* handleFileDeleted({ id: file.id, deletedAt: file.deletedAt })
            continue
          }

          yield* handleFileUpdated({
            id: file.id,
            path: file.path,
            remoteKey: file.remoteKey,
            contentHash: file.contentHash,
            updatedAt: file.updatedAt
          })
        }
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* Effect.logError("[FileSync] Bootstrap from tables failed", { error })
            yield* emit({ type: "sync:error", error, context: "bootstrap" })
          })
        )
      )

    const handleEventBatch = (
      eventsBatch: ReadonlyArray<LiveStoreEvent.Client.Decoded>
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (eventsBatch.length === 0) return

        yield* emit({ type: "sync:start" })

        for (const event of eventsBatch) {
          switch (event.name) {
            case "v1.FileCreated":
              yield* handleFileCreated(event.args as FileCreatedPayload)
              break
            case "v1.FileUpdated":
              yield* handleFileUpdated(event.args as FileUpdatedPayload)
              break
            case "v1.FileDeleted":
              yield* handleFileDeleted(event.args as FileDeletedPayload)
              break
          }
        }

        const lastEvent = eventsBatch[eventsBatch.length - 1]
        const nextCursor = EventSequenceNumber.Client.toString(lastEvent.seqNum)
        yield* Ref.set(cursorRef, nextCursor)
        yield* persistCursor(nextCursor)

        yield* emit({ type: "sync:complete" })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* Effect.logError("[FileSync] Event batch processing failed", { error })
            yield* emit({ type: "sync:error", error, context: "event-batch" })
          })
        )
      )

    // Recovery: Reset stale "inProgress" and "error" statuses to "queued"
    // This handles the case where a page refresh interrupted an in-flight transfer
    // or where a previous transfer failed with an error.
    // On a fresh page load, no transfer can actually be in progress, so any
    // "inProgress" status is stale and should be reset to allow retry.
    // Files in "error" state are also reset to give them another chance.
    const recoverStaleTransfers = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const retriedFileIds: Array<string> = []

        yield* stateManager.atomicUpdate((currentState) => {
          let hasChanges = false
          const nextState = { ...currentState }

          for (const [fileId, localFile] of Object.entries(nextState)) {
            let updated = false
            const updatedFile = { ...localFile }

            // Reset "inProgress" to "queued" (existing logic)
            if (localFile.uploadStatus === "inProgress") {
              updatedFile.uploadStatus = "queued"
              updated = true
            }
            if (localFile.downloadStatus === "inProgress") {
              updatedFile.downloadStatus = "queued"
              updated = true
            }

            // Reset "error" to "queued" for auto-retry
            if (localFile.uploadStatus === "error") {
              updatedFile.uploadStatus = "queued"
              updatedFile.lastSyncError = ""
              updated = true
              retriedFileIds.push(fileId)
            }
            if (localFile.downloadStatus === "error") {
              updatedFile.downloadStatus = "queued"
              updatedFile.lastSyncError = ""
              updated = true
              if (!retriedFileIds.includes(fileId)) {
                retriedFileIds.push(fileId)
              }
            }

            if (updated) {
              nextState[fileId] = updatedFile
              hasChanges = true
            }
          }

          return hasChanges ? nextState : currentState
        })

        if (retriedFileIds.length > 0) {
          yield* Effect.logInfo(`[FileSync] Auto-retrying ${retriedFileIds.length} files from error state`)
          yield* emit({ type: "sync:error-retry-start", fileIds: retriedFileIds })
        }
      })

    const startEventStream = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const isLeader = yield* Ref.get(isLeaderRef)
        if (!isLeader) return

        yield* stopEventStream()
        yield* recoverStaleTransfers()
        yield* bootstrapFromTables()

        const storedCursor = yield* readCursor()
        yield* Ref.set(cursorRef, storedCursor)

        // Stream recovery configuration
        const maxAttempts = config.maxStreamRecoveryAttempts ?? 5
        const baseDelayMs = config.streamRecoveryBaseDelayMs ?? 1000
        const maxDelayMs = config.streamRecoveryMaxDelayMs ?? 60000

        // Create retry schedule with exponential backoff
        const retrySchedule = Schedule.exponential(Duration.millis(baseDelayMs)).pipe(
          Schedule.jittered,
          Schedule.either(Schedule.spaced(Duration.millis(maxDelayMs))),
          Schedule.upTo(Duration.millis(maxDelayMs * 2)),
          Schedule.intersect(Schedule.recurs(maxAttempts - 1))
        )

        // Track recovery attempts for logging
        const attemptRef = yield* Ref.make(0)

        const stream = store.eventsStream({
          since: resolveCursor(storedCursor),
          filter: ["v1.FileCreated", "v1.FileUpdated", "v1.FileDeleted"] as const,
          includeClientOnly: true
        } as any).pipe(
          Stream.tapError((error) =>
            Effect.gen(function*() {
              const attempt = yield* Ref.updateAndGet(attemptRef, (n) => n + 1)
              yield* Effect.logError("[FileSync] Event stream error", { error, attempt })
              yield* emit({ type: "sync:stream-error", error, attempt })
            })
          ),
          Stream.retry(retrySchedule),
          Stream.tap(() =>
            Effect.gen(function*() {
              const attempt = yield* Ref.get(attemptRef)
              if (attempt > 0) {
                yield* Effect.logInfo("[FileSync] Stream recovered after error")
                yield* emit({ type: "sync:recovery", from: "stream-error" })
                yield* Ref.set(attemptRef, 0)
              }
            })
          ),
          Stream.catchAll((error) =>
            Effect.gen(function*() {
              const attempts = yield* Ref.get(attemptRef)
              yield* Effect.logError("[FileSync] Stream recovery exhausted", { error, attempts })
              yield* emit({ type: "sync:stream-exhausted", error, attempts })
              return Stream.empty
            }).pipe(Stream.unwrap)
          )
        )

        const fiber = yield* stream.pipe(
          Stream.runForEachChunk((chunk) => handleEventBatch(Chunk.toReadonlyArray(chunk))),
          Effect.fork
        )

        yield* Ref.set(eventStreamFiberRef, fiber)
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* Effect.logError("[FileSync] Failed to start event stream", { error })
            yield* emit({ type: "sync:error", error, context: "stream-start" })
          })
        )
      )

    const stopEventStream = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existing = yield* Ref.get(eventStreamFiberRef)
        if (!existing) return
        yield* Fiber.interrupt(existing)
        yield* Ref.set(eventStreamFiberRef, null)
      })

    const restartEventStream = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const isLeader = yield* Ref.get(isLeaderRef)
        if (!isLeader) return
        yield* startEventStream()
      })

    // Start the sync loop (only called when we're the leader)
    const startSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const isOnline = yield* Ref.get(onlineRef)
        if (isOnline) {
          yield* executor.resume()
        } else {
          yield* executor.pause()
        }
        yield* startEventStream()
      })

    // Stop the sync loop (called when we lose leadership)
    const stopSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* executor.pause()
        yield* stopEventStream()
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

        yield* stopEventStream()
        yield* executor.pause()

        // Reset leader status
        yield* Ref.set(isLeaderRef, false)
      })

    const syncNow = (): Effect.Effect<void> => restartEventStream()

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
        // Apply preprocessor if configured for this file type
        const processedFile = yield* Effect.promise(() => applyPreprocessor(config.preprocessors, file))

        const id = crypto.randomUUID()
        const contentHash = yield* doHashFile(processedFile)
        const path = makeStoredPath(storeId, contentHash)

        yield* localStorage.writeFile(path, processedFile)
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

        // Apply preprocessor if configured for this file type
        const processedFile = yield* Effect.promise(() => applyPreprocessor(config.preprocessors, file))

        const contentHash = yield* doHashFile(processedFile)
        const path = makeStoredPath(storeId, contentHash)

        if (contentHash !== existingFile.contentHash) {
          yield* localStorage.writeFile(path, processedFile)
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
          yield* restartEventStream()
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

    const retryErrors = (): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function*() {
        const retriedFileIds: Array<string> = []
        const currentState = yield* stateManager.getState()

        for (const [fileId, localFile] of Object.entries(currentState)) {
          if (localFile.uploadStatus === "error") {
            yield* stateManager.setTransferStatus(fileId, "upload", "queued")
            yield* executor.enqueueUpload(fileId)
            retriedFileIds.push(fileId)
          }
          if (localFile.downloadStatus === "error") {
            yield* stateManager.setTransferStatus(fileId, "download", "queued")
            yield* executor.enqueueDownload(fileId)
            if (!retriedFileIds.includes(fileId)) {
              retriedFileIds.push(fileId)
            }
          }
        }

        if (retriedFileIds.length > 0) {
          yield* Effect.logInfo(`[FileSync] Manually retrying ${retriedFileIds.length} files from error state`)
          yield* emit({ type: "sync:recovery", from: "error-retry" })
        }

        return retriedFileIds
      })

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
      getLocalFilesState,
      retryErrors
    }
  })

/**
 * Create a Layer for FileSync
 */
export const FileSyncLive = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Layer.Layer<FileSync, never, Hash | LocalFileStorage | LocalFileStateManager | RemoteStorage | Scope.Scope> =>
  Layer.scoped(FileSync, makeFileSync(deps, config))
