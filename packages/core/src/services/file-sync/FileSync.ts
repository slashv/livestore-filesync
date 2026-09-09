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
import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule, Scope, Stream, SubscriptionRef } from "effect"
import { StorageError } from "../../errors/index.js"
import type { FileNotFoundError, HashError } from "../../errors/index.js"
import { getClientSession, type LiveStoreDeps } from "../../livestore/types.js"
import type {
  FileCreatedPayload,
  FileDeletedPayload,
  FileMetadata,
  FileOperationResult,
  FileRecord,
  FileSyncEvent,
  FileSyncEventCallback,
  FileUpdatedPayload,
  LocalFilesState,
  LocalFilesStateMutable,
  LocalFileState,
  PreprocessorMap,
  TransferStatus
} from "../../types/index.js"
import { applyPreprocessorWithMetadata, makeStoredPath } from "../../utils/index.js"
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

  /**
   * @internal Test-only: Simulates event stream death for heartbeat testing.
   * Interrupts the stream fiber and clears the ref so heartbeat will detect and recover.
   */
  readonly _simulateStreamDeath: () => Effect.Effect<void>
}

/**
 * FileSync service tag
 */
export class FileSync extends Context.Service<FileSync, FileSyncService>()("FileSync") {}

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
   * File transfer mode.
   * - "remote": normal signer-backed upload/download/delete behavior
   * - "local-only": local storage only; no remote calls or transfer queue work
   * @default "remote"
   */
  readonly remoteMode?: "remote" | "local-only"

  /**
   * Sync executor configuration
   */
  readonly executorConfig?: Partial<SyncExecutorConfig>

  /**
   * Health check interval when offline (ms)
   */
  readonly healthCheckIntervalMs?: number

  /**
   * Heartbeat interval in ms. A background loop checks that the event stream
   * and sync executor are still alive, restarting them if needed.
   * Set to 0 to disable.
   * @default 15000
   */
  readonly heartbeatIntervalMs?: number

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
   * Threshold in ms for detecting a stalled stream.
   * If the upstream head advances but no events have been processed for this
   * duration, the stream is considered stalled and will be restarted.
   * Set to 0 to disable stall detection.
   * @default 30000
   */
  readonly streamStallThresholdMs?: number

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
  heartbeatIntervalMs: 15000,
  autoPrioritizeOnResolve: true,
  maxStreamRecoveryAttempts: 5,
  streamRecoveryBaseDelayMs: 1000,
  streamRecoveryMaxDelayMs: 60000,
  streamStallThresholdMs: 30000
}

/**
 * Create the FileSync service
 */
export const makeFileSync = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Effect.Effect<
  FileSyncService,
  never,
  Hash | LocalFileStorage | LocalFileStateManager | RemoteStorage | Scope.Scope
> =>
  Effect.gen(function*() {
    const hashService = yield* Hash
    const localStorage = yield* LocalFileStorage
    const stateManager = yield* LocalFileStateManager
    const remoteStorage = yield* RemoteStorage
    const { schema, store, storeId } = deps
    const { events, queryDb, tables } = schema
    const isLocalOnly = config.remoteMode === "local-only"

    // Local wrapper for hashFile that uses the captured hash service
    const doHashFile = (file: File) => hashService.hashFile(file)

    const serializeFileMetadata = (
      file: File,
      metadata: FileMetadata | undefined
    ): Effect.Effect<string | null, StorageError> =>
      Effect.try({
        try: () => {
          if (!metadata) return null
          const normalized: FileMetadata = {
            ...metadata,
            ...(metadata.mimeType === undefined && file.type ? { mimeType: file.type } : {}),
            ...(metadata.sizeBytes === undefined ? { sizeBytes: file.size } : {})
          }
          return JSON.stringify(normalized)
        },
        catch: (error) =>
          new StorageError({
            message: `Failed to serialize metadata for ${file.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error
          })
      })

    // Get client session for leader election
    const clientSession = getClientSession(store)

    // State
    const onlineRef = yield* Ref.make(true)
    const runningRef = yield* Ref.make(false)
    const isLeaderRef = yield* Ref.make(false)
    const leaderWatcherFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null)
    const eventStreamFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null)
    const cursorRef = yield* Ref.make<string>("")

    // Event callbacks
    const eventCallbacks = yield* Ref.make<Array<FileSyncEventCallback>>([])

    // Background fibers
    const healthCheckFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null)
    const heartbeatFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null)

    // Stuck-queue detection: consecutive heartbeats where items are queued but nothing is inflight
    const stuckCounterRef = yield* Ref.make(0)

    // Stream stall detection: track last processed batch time and cursor
    const lastBatchAtRef = yield* Ref.make(0)
    const lastBatchCursorRef = yield* Ref.make<EventSequenceNumber.Client.Composite | null>(null)

    // Stale recovery gating: ensures recoverStaleTransfers runs only once per start() lifecycle
    const staleRecoveryDoneRef = yield* Ref.make(false)

    // Main scope ref - stores the scope from start() for use in setOnline/health check
    const mainScopeRef = yield* Ref.make<Scope.Scope | null>(null)

    const executorConfig: SyncExecutorConfig = {
      ...defaultExecutorConfig,
      ...config.executorConfig
    }

    // Emit an event — individual callback errors are caught to prevent one bad
    // subscriber from crashing the sync engine or preventing other subscribers
    // from receiving events.
    const emit = (event: FileSyncEvent): Effect.Effect<void> =>
      Effect.gen(function*() {
        const callbacks = yield* Ref.get(eventCallbacks)
        for (const callback of callbacks) {
          try {
            callback(event)
          } catch (err) {
            yield* Effect.logWarning("[FileSync] Event callback threw an error", { event: event.type, error: err })
          }
        }
      })

    const getFile = (fileId: string): Effect.Effect<FileRecord | undefined> =>
      Effect.sync(() => {
        const files = store.query<Array<FileRecord>>(queryDb(tables.files.where({ id: fileId })))
        return files[0]
      })

    const getLocalFilesState = (): Effect.Effect<LocalFilesState> => stateManager.getState()

    // Read and compare in the same synchronous operation that commits completion.
    // Metadata-only edits are compatible; content, path, remote source and deletion are not.
    const readFile = (fileId: string): FileRecord | undefined =>
      store.query<Array<FileRecord>>(queryDb(tables.files.where({ id: fileId })))[0]

    const isCurrentTransfer = (file: Pick<FileRecord, "id" | "contentHash" | "path" | "remoteKey">): boolean => {
      const current = readFile(file.id)
      return !!current && !current.deletedAt && current.contentHash === file.contentHash &&
        current.path === file.path && current.remoteKey === file.remoteKey
    }

    const createFileRecord = (params: { id: string; path: string; contentHash: string; metadataJson: string | null }) =>
      Effect.sync(() => {
        console.log("createFileRecord file ID:", params.id)
        store.commit(
          events.fileCreated({
            id: params.id,
            path: params.path,
            contentHash: params.contentHash,
            metadataJson: params.metadataJson,
            createdAt: new Date(),
            updatedAt: new Date()
          })
        )
      })

    const updateFileRecord = (params: {
      id: string
      path: string
      contentHash: string
      metadataJson: string | null
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
            metadataJson: params.metadataJson,
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

    const getUpstreamHeadCursor = (): Effect.Effect<string> => Effect.sync(() => store.syncStatus().upstreamHead)

    const setCursorAfterBootstrap = (upstreamCursor: string): Effect.Effect<string> =>
      Effect.gen(function*() {
        const storedCursor = yield* readCursor()
        yield* persistCursor(upstreamCursor)
        yield* Ref.set(cursorRef, upstreamCursor)
        // Compare only the global component — local events and rebase generations
        // should not cause a misleading "overriding" log message
        const storedGlobal = storedCursor ? resolveCursor(storedCursor).global : null
        const upstreamGlobal = resolveCursor(upstreamCursor).global
        if (storedGlobal !== null && storedGlobal !== upstreamGlobal) {
          yield* Effect.logInfo("[FileSync] Overriding stored cursor after bootstrap", {
            storedCursor,
            upstreamCursor
          })
        }
        return upstreamCursor
      }).pipe(Effect.orDie)

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

    // Re-enqueue transfers that are in "queued" state in the state manager
    // but may not have corresponding entries in the executor queues (e.g. after goOffline reset)
    const reEnqueueQueuedTransfers = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (isLocalOnly) return
        const state = yield* stateManager.getState()
        for (const [fileId, localFile] of Object.entries(state)) {
          if (localFile.uploadStatus === "queued") {
            yield* executor.enqueueUpload(fileId)
          }
          if (localFile.downloadStatus === "queued") {
            yield* executor.enqueueDownload(fileId)
          }
        }
      })

    // Continuous health check loop — runs always, detects connectivity changes
    const stopHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (!existing) return
        yield* Fiber.interrupt(existing)
        yield* Ref.set(healthCheckFiberRef, null)
      })

    const startHealthCheckLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (isLocalOnly) return
        const existing = yield* Ref.get(healthCheckFiberRef)
        if (existing) return

        const intervalMs = config.healthCheckIntervalMs ?? 10000

        const loop = Effect.forever(
          Effect.gen(function*() {
            yield* Effect.sleep(Duration.millis(intervalMs))
            const wasOnline = yield* Ref.get(onlineRef)
            const isHealthy = yield* remoteStorage.checkHealth()

            if (isHealthy && !wasOnline) {
              // Recovered: transition offline → online
              yield* Ref.set(onlineRef, true)
              yield* emit({ type: "online" })
              yield* executor.resume()
              // Re-enqueue transfers that were reset to queued while offline
              yield* reEnqueueQueuedTransfers()
            } else if (!isHealthy && wasOnline) {
              // Lost connectivity: transition online → offline
              yield* goOffline()
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("[FileSync] Health check tick failed", { error }).pipe(Effect.asVoid)
            )
          )
        ).pipe(Effect.interruptible)

        // Fork into the main scope so the health check fiber stays alive
        const mainScope = yield* Ref.get(mainScopeRef)
        if (!mainScope) return
        const fiber = yield* Effect.forkIn(
          loop.pipe(Effect.ensuring(Ref.set(healthCheckFiberRef, null))),
          mainScope
        )

        yield* Ref.set(healthCheckFiberRef, fiber)
      })

    // On transfer failure, verify connectivity before going offline.
    // The transfer may have failed for legitimate reasons (e.g. bad file) while backend is still reachable.
    const checkConnectivityOnFailure = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (isLocalOnly) return
        const isHealthy = yield* remoteStorage.checkHealth()
        if (!isHealthy) {
          yield* goOffline()
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("[FileSync] Connectivity check after transfer failure failed", { error }).pipe(
            Effect.asVoid
          )
        )
      )

    // Shared offline transition logic — used by health check and connectivity check
    const goOffline = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const wasOnline = yield* Ref.get(onlineRef)
        if (!wasOnline) return

        yield* Ref.set(onlineRef, false)
        yield* emit({ type: "offline" })
        yield* executor.pause()

        // Only reset inProgress transfers to queued — these are actively running and
        // will fail due to network loss, so they need to be re-queued when back online.
        // Do NOT reset error transfers: they may have failed for non-network reasons
        // (corrupt file, permission denied, too large) and blindly retrying would
        // create infinite retry loops.
        yield* stateManager.atomicUpdate((state) => {
          let hasChanges = false
          const nextState = { ...state }
          for (const [fileId, localFile] of Object.entries(nextState)) {
            let updated = false
            const updatedFile = { ...localFile }

            if (localFile.uploadStatus === "inProgress") {
              updatedFile.uploadStatus = "queued"
              updated = true
            }
            if (localFile.downloadStatus === "inProgress") {
              updatedFile.downloadStatus = "queued"
              updated = true
            }

            if (updated) {
              nextState[fileId] = updatedFile
              hasChanges = true
            }
          }
          return hasChanges ? nextState : state
        })
      })

    // Each retry captures the current version. Stale attempts neither complete nor
    // fail the replacement version; reconciliation schedules its required transfer.
    const transferHandler = (kind: TransferKind, fileId: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        const file = yield* getFile(fileId)
        if (!file || file.deletedAt) return
        if (kind === "download" && !file.remoteKey) return
        if (kind === "upload" && file.remoteKey) {
          yield* stateManager.atomicUpdate((state) => {
            const local = state[fileId]
            if (!isCurrentTransfer(file) || !local || local.localHash !== file.contentHash) return state
            return { ...state, [fileId]: { ...local, uploadStatus: "done", lastSyncError: "" } }
          })
          return
        }

        const reconcileLatest = (): Effect.Effect<void> =>
          Effect.gen(function*() {
            const latest = yield* getFile(fileId)
            if (latest && !latest.deletedAt) {
              yield* handleFileUpdated(latest)
            } else {
              yield* stateManager.atomicUpdate((state) => {
                const current = readFile(fileId)
                if (current && !current.deletedAt) return state
                const next = { ...state }
                delete next[fileId]
                return next
              })
            }
          })

        yield* stateManager.setTransferStatus(fileId, kind, "inProgress")
        yield* emit({ type: kind === "upload" ? "upload:start" : "download:start", fileId })

        const onProgress = (progress: { loaded: number; total: number }) => {
          if (!isCurrentTransfer(file)) return
          Effect.runFork(emit({
            type: kind === "upload" ? "upload:progress" : "download:progress",
            fileId,
            progress: { kind, fileId, status: "inProgress", ...progress }
          }))
        }

        yield* Effect.gen(function*() {
          if (kind === "upload") {
            const localFile = yield* localStorage.readFile(file.path)
            const hash = yield* doHashFile(localFile)
            if (!isCurrentTransfer(file)) return yield* reconcileLatest()
            if (hash !== file.contentHash) {
              return yield* Effect.fail(new Error("Upload content hash mismatch"))
            }
            const uploaded = yield* remoteStorage.upload(localFile, {
              key: stripFilesRoot(file.path),
              onProgress
            })
            // Commit the key only against the version whose bytes were uploaded.
            // Do not delete stale content-addressed objects here: other rows may own them.
            const completed = yield* Effect.sync(() => {
              if (!isCurrentTransfer(file)) return false
              const current = readFile(fileId)!
              store.commit(events.fileUpdated({
                id: fileId,
                path: current.path,
                remoteKey: uploaded.key,
                contentHash: current.contentHash,
                metadataJson: current.metadataJson,
                updatedAt: new Date()
              }))
              return true
            })
            if (!completed) {
              const latest = readFile(fileId)
              const referenced = store.query<Array<FileRecord>>(queryDb(tables.files))
                .some((row) =>
                  !row.deletedAt &&
                  (row.remoteKey === uploaded.key || stripFilesRoot(row.path) === uploaded.key)
                )
              if ((!latest || latest.deletedAt) && !referenced) {
                yield* remoteStorage.delete(uploaded.key).pipe(Effect.catch(() => Effect.void))
              }
              return yield* reconcileLatest()
            }
            yield* stateManager.atomicUpdate((state) => {
              const current = readFile(fileId)
              const local = state[fileId]
              if (
                !current || current.deletedAt || current.contentHash !== file.contentHash ||
                current.path !== file.path || current.remoteKey !== uploaded.key ||
                !local || local.localHash !== file.contentHash
              ) return state
              return { ...state, [fileId]: { ...local, uploadStatus: "done", lastSyncError: "" } }
            })
          } else {
            const downloaded = yield* remoteStorage.download(file.remoteKey, { onProgress })
            const hash = yield* doHashFile(downloaded)
            if (!isCurrentTransfer(file)) return yield* reconcileLatest()
            if (hash !== file.contentHash) {
              return yield* Effect.fail(new Error("Download content hash mismatch"))
            }
            // Finish publication and stale-path cleanup even if cancellation arrives
            // during an adapter write that cannot itself be aborted.
            const published = yield* Effect.gen(function*() {
              yield* localStorage.writeFile(file.path, downloaded)
              if (!isCurrentTransfer(file)) {
                const referenced = store.query<Array<FileRecord>>(queryDb(tables.files))
                  .some((row) => !row.deletedAt && row.path === file.path)
                if (!referenced) yield* localStorage.deleteFile(file.path).pipe(Effect.catch(() => Effect.void))
                return false
              }
              yield* stateManager.atomicUpdate((state) => {
                if (!isCurrentTransfer(file)) return state
                return {
                  ...state,
                  [fileId]: {
                    path: file.path,
                    localHash: hash,
                    downloadStatus: "done",
                    uploadStatus: "done",
                    lastSyncError: ""
                  }
                }
              })
              return true
            }).pipe(Effect.uninterruptible)
            if (!published) return yield* reconcileLatest()
          }
          yield* emit({ type: kind === "upload" ? "upload:complete" : "download:complete", fileId })
        }).pipe(Effect.catch((error) =>
          Effect.gen(function*() {
            if (!isCurrentTransfer(file)) return yield* reconcileLatest()
            yield* stateManager.atomicUpdate((state) => {
              if (!isCurrentTransfer(file) || !state[fileId]) return state
              return {
                ...state,
                [fileId]: {
                  ...state[fileId],
                  [kind === "upload" ? "uploadStatus" : "downloadStatus"]: "error",
                  lastSyncError: String(error)
                }
              }
            })
            yield* emit({ type: kind === "upload" ? "upload:error" : "download:error", fileId, error })
            yield* checkConnectivityOnFailure()
            return yield* Effect.fail(error)
          })
        ))
      })

    // Create sync executor with task completion callback
    const onTaskComplete = (
      result: { kind: "upload" | "download"; fileId: string; success: boolean; error?: unknown }
    ) =>
      Effect.gen(function*() {
        if (!result.success) {
          yield* emit({
            type: "transfer:exhausted",
            kind: result.kind,
            fileId: result.fileId,
            error: result.error
          })
        }
      })

    const executor = yield* makeSyncExecutor(transferHandler, executorConfig, onTaskComplete)

    // Two-pass reconciliation of local file state
    const activeTransferStatuses = ["queued", "inProgress"] as const

    const resolveTransferStatus = (
      current: TransferStatus | undefined,
      next: TransferStatus
    ): TransferStatus =>
      current && activeTransferStatuses.includes(current as (typeof activeTransferStatuses)[number])
        ? current
        : next

    const mergeFileState = (
      existing: LocalFileState | undefined,
      nextState: {
        path: string
        localHash: string
        uploadStatus: TransferStatus
        downloadStatus: TransferStatus
        lastSyncError: string
      }
    ): LocalFileState => {
      if (!existing) {
        return nextState
      }

      const uploadStatus = resolveTransferStatus(existing.uploadStatus, nextState.uploadStatus)
      const downloadStatus = resolveTransferStatus(existing.downloadStatus, nextState.downloadStatus)

      return {
        ...existing,
        ...nextState,
        uploadStatus,
        downloadStatus
      }
    }

    const applyFileState = (
      file: FileCreatedPayload | FileUpdatedPayload,
      nextState: {
        path: string
        localHash: string
        uploadStatus: TransferStatus
        downloadStatus: TransferStatus
        lastSyncError: string
      }
    ): Effect.Effect<void> =>
      stateManager.atomicUpdate((currentState) => {
        const current = readFile(file.id)
        if (
          !current || current.deletedAt || current.path !== file.path ||
          current.contentHash !== file.contentHash ||
          ("remoteKey" in file && current.remoteKey !== file.remoteKey)
        ) return currentState
        return {
          ...currentState,
          [file.id]: mergeFileState(currentState[file.id], nextState)
        }
      })

    const setLocalOnlyAvailableFileState = (
      fileId: string,
      path: string,
      localHash: string
    ): Effect.Effect<void> =>
      stateManager.setFileState(fileId, {
        path,
        localHash,
        uploadStatus: "done",
        downloadStatus: "done",
        lastSyncError: ""
      })

    const readLocalHash = (path: string) =>
      Effect.gen(function*() {
        const exists = yield* localStorage.fileExists(path)
        if (!exists) return { exists: false, localHash: "" }
        const file = yield* localStorage.readFile(path)
        const localHash = yield* doHashFile(file)
        return { exists: true, localHash }
      }).pipe(Effect.catch((error) =>
        Effect.gen(function*() {
          yield* Effect.logWarning("[FileSync] readLocalHash failed, treating as non-existent", { path, error })
          return { exists: false, localHash: "" }
        })
      ))

    const handleFileCreated = (payload: FileCreatedPayload): Effect.Effect<void> =>
      Effect.gen(function*() {
        const { exists, localHash } = yield* readLocalHash(payload.path)
        if (!exists) return

        if (isLocalOnly) {
          yield* setLocalOnlyAvailableFileState(payload.id, payload.path, localHash)
          return
        }

        yield* applyFileState(payload, {
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
        if (!isCurrentTransfer(payload)) return

        if (isLocalOnly) {
          if (exists) {
            yield* setLocalOnlyAvailableFileState(payload.id, payload.path, localHash)
          } else {
            yield* stateManager.removeFile(payload.id)
          }
          return
        }

        if (!exists) {
          if (!payload.remoteKey) return
          yield* applyFileState(payload, {
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
            yield* applyFileState(payload, {
              path: payload.path,
              localHash,
              uploadStatus: "done",
              downloadStatus: "queued",
              lastSyncError: ""
            })
            yield* executor.enqueueDownload(payload.id)
            return
          }

          yield* applyFileState(payload, {
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
          yield* applyFileState(payload, {
            path: payload.path,
            localHash,
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          })
          yield* executor.enqueueUpload(payload.id)
          return
        }

        yield* applyFileState(payload, {
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
          // Only delete from OPFS if no other active (non-deleted) file shares the same content-addressable path
          const allFiles = store.query<Array<FileRecord>>(queryDb(tables.files.select()))
          const otherActiveFileWithSamePath = allFiles.some(
            (f) => f.id !== payload.id && !f.deletedAt && f.path === path
          )
          if (!otherActiveFileWithSamePath) {
            yield* localStorage.deleteFile(path).pipe(Effect.ignore)
          }
        }

        // Cancel any pending download for this file
        yield* executor.cancelDownload(payload.id)

        yield* stateManager.removeFile(payload.id)
      })

    const bootstrapFromTables = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const files = store.query<Array<FileRecord>>(queryDb(tables.files.select()))
        const currentState = yield* stateManager.getState()
        const nextState: LocalFilesStateMutable = { ...currentState }
        const pendingUploads = new Set<string>()
        const pendingDownloads = new Set<string>()

        for (const file of files) {
          if (file.deletedAt) {
            const statePath = nextState[file.id]?.path
            const path = statePath ?? file.path

            if (path) {
              // Only delete from OPFS if no other active (non-deleted) file shares the same content-addressable path
              const otherActiveFileWithSamePath = files.some(
                (f) => f.id !== file.id && !f.deletedAt && f.path === path
              )
              if (!otherActiveFileWithSamePath) {
                yield* localStorage.deleteFile(path).pipe(Effect.ignore)
              }
            }

            // Cancel any pending download for this file
            yield* executor.cancelDownload(file.id)
            delete nextState[file.id]
            continue
          }

          const { exists, localHash } = yield* readLocalHash(file.path)

          if (isLocalOnly) {
            if (exists) {
              nextState[file.id] = {
                path: file.path,
                localHash,
                uploadStatus: "done",
                downloadStatus: "done",
                lastSyncError: ""
              }
            } else {
              delete nextState[file.id]
            }
            continue
          }

          if (!exists) {
            if (!file.remoteKey) continue
            nextState[file.id] = mergeFileState(nextState[file.id], {
              path: file.path,
              localHash: "",
              uploadStatus: "done",
              downloadStatus: "queued",
              lastSyncError: ""
            })
            pendingDownloads.add(file.id)
            continue
          }

          if (localHash !== file.contentHash) {
            if (file.remoteKey) {
              nextState[file.id] = mergeFileState(nextState[file.id], {
                path: file.path,
                localHash,
                uploadStatus: "done",
                downloadStatus: "queued",
                lastSyncError: ""
              })
              pendingDownloads.add(file.id)
              continue
            }

            nextState[file.id] = mergeFileState(nextState[file.id], {
              path: file.path,
              localHash,
              uploadStatus: "queued",
              downloadStatus: "done",
              lastSyncError: ""
            })
            pendingUploads.add(file.id)
            continue
          }

          if (!file.remoteKey) {
            nextState[file.id] = mergeFileState(nextState[file.id], {
              path: file.path,
              localHash,
              uploadStatus: "queued",
              downloadStatus: "done",
              lastSyncError: ""
            })
            pendingUploads.add(file.id)
            continue
          }

          nextState[file.id] = mergeFileState(nextState[file.id], {
            path: file.path,
            localHash,
            uploadStatus: "done",
            downloadStatus: "done",
            lastSyncError: ""
          })
        }

        yield* stateManager.atomicUpdate(() => nextState)

        for (const fileId of pendingUploads) {
          yield* executor.enqueueUpload(fileId)
        }

        for (const fileId of pendingDownloads) {
          yield* executor.enqueueDownload(fileId)
        }
      }).pipe(
        Effect.catch((error) =>
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

        // Process each event individually so that a failure in one event
        // doesn't prevent the cursor from advancing past already-processed events.
        for (const event of eventsBatch) {
          yield* Effect.gen(function*() {
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
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function*() {
                yield* Effect.logError("[FileSync] Failed to process event", { eventName: event.name, error })
                yield* emit({ type: "sync:error", error, context: `event:${event.name}` })
              })
            )
          )
        }

        // Advance the cursor to the last successfully processed event,
        // or to the end of the batch if all events succeeded.
        // Always advance to the last event in the batch even if some failed,
        // since re-processing a failed event would likely fail again.
        const cursorEvent = eventsBatch[eventsBatch.length - 1]
        const nextCursor = EventSequenceNumber.Client.toString(cursorEvent.seqNum)
        yield* Ref.set(cursorRef, nextCursor)
        yield* persistCursor(nextCursor)

        // Update stall detection refs
        yield* Ref.set(lastBatchCursorRef, cursorEvent.seqNum)
        yield* Ref.set(lastBatchAtRef, Date.now())

        yield* emit({ type: "sync:complete" })
      }).pipe(
        Effect.catch((error) =>
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
        if (isLocalOnly) {
          yield* stateManager.atomicUpdate((currentState) => {
            let hasChanges = false
            const nextState = { ...currentState }

            for (const [fileId, localFile] of Object.entries(nextState)) {
              if (
                localFile.uploadStatus === "done" &&
                localFile.downloadStatus === "done" &&
                localFile.lastSyncError === ""
              ) {
                continue
              }

              nextState[fileId] = {
                ...localFile,
                uploadStatus: "done",
                downloadStatus: "done",
                lastSyncError: ""
              }
              hasChanges = true
            }

            return hasChanges ? nextState : currentState
          })
          return
        }

        const retriedFileIds: Array<string> = []
        const queuedUploadFileIds: Array<string> = []
        const queuedDownloadFileIds: Array<string> = []

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
              queuedUploadFileIds.push(fileId)
            }
            if (localFile.downloadStatus === "inProgress") {
              updatedFile.downloadStatus = "queued"
              updated = true
              queuedDownloadFileIds.push(fileId)
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

        for (const fileId of queuedUploadFileIds) {
          yield* executor.enqueueUpload(fileId)
        }

        for (const fileId of queuedDownloadFileIds) {
          yield* executor.enqueueDownload(fileId)
        }
      })

    // Gated wrapper: run recoverStaleTransfers only once per start() lifecycle
    const maybeRecoverStaleTransfers = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const done = yield* Ref.get(staleRecoveryDoneRef)
        if (done) return
        yield* recoverStaleTransfers()
        yield* Ref.set(staleRecoveryDoneRef, true)
      })

    const maybeBootstrapFromTables = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const storedCursor = yield* readCursor()
        const localState = yield* stateManager.getState()
        const isCursorRoot = EventSequenceNumber.Client.isEqual(
          resolveCursor(storedCursor),
          EventSequenceNumber.Client.ROOT
        )
        const isLocalStateEmpty = Object.keys(localState).length === 0

        if (!isCursorRoot && !isLocalStateEmpty) return

        const upstreamCursor = yield* getUpstreamHeadCursor()
        yield* bootstrapFromTables()
        yield* setCursorAfterBootstrap(upstreamCursor)
      })

    const startEventStream = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const isLeader = yield* Ref.get(isLeaderRef)
        if (!isLeader) return

        yield* stopEventStream()
        const storedCursor = yield* readCursor()

        // Stream recovery configuration
        const maxAttempts = config.maxStreamRecoveryAttempts ?? 5
        const baseDelayMs = config.streamRecoveryBaseDelayMs ?? 1000
        const maxDelayMs = config.streamRecoveryMaxDelayMs ?? 60000

        // Create retry schedule with exponential backoff
        const retrySchedule = Schedule.exponential(Duration.millis(baseDelayMs)).pipe(
          Schedule.jittered,
          Schedule.upTo({
            duration: Duration.millis(maxDelayMs * 2),
            times: maxAttempts - 1
          })
        )

        // Track recovery attempts for logging
        const attemptRef = yield* Ref.make(0)

        const stream = store.eventsStream({
          since: resolveCursor(storedCursor),
          filter: ["v1.FileCreated", "v1.FileUpdated", "v1.FileDeleted"]
        }).pipe(
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
          Stream.catchCause((error) =>
            Effect.gen(function*() {
              const attempts = yield* Ref.get(attemptRef)
              yield* Effect.logError("[FileSync] Stream recovery exhausted", { error, attempts })
              yield* emit({ type: "sync:stream-exhausted", error, attempts })
              // Clear fiber ref so the heartbeat can detect the dead stream and restart it
              yield* Ref.set(eventStreamFiberRef, null)
              return Stream.empty
            }).pipe(Stream.unwrap)
          )
        )

        // Use the stored main scope for forking - this ensures the fiber lives as long as start()
        const mainScope = yield* Ref.get(mainScopeRef)
        if (!mainScope) {
          console.warn("[FileSync] Cannot start event stream - main scope not available")
          return
        }
        const streamEffect = stream.pipe(Stream.runForEach((event) => handleEventBatch([event])))
        const fiber = yield* Effect.forkIn(streamEffect, mainScope)

        yield* Ref.set(eventStreamFiberRef, fiber)
      }).pipe(
        Effect.catch((error) =>
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
        // Ensure queued transfer state is reflected in executor queues before restart.
        yield* reEnqueueQueuedTransfers()
        yield* startEventStream()
      })

    // Start the sync loop (only called when we're the leader)
    const startSyncLoop = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        // Run one-time stale transfer recovery before any transfers begin
        yield* maybeRecoverStaleTransfers()

        if (!isLocalOnly) {
          const isOnline = yield* Ref.get(onlineRef)
          if (isOnline) {
            yield* executor.resume()
          } else {
            yield* executor.pause()
          }
        }
        yield* maybeBootstrapFromTables()
        yield* startEventStream()
      })

    // Stop the sync loop (called when we lose leadership)
    const stopSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* executor.pause()

        // Interrupt in-flight transfers so they don't commit conflicting state
        // after this tab has lost leadership. Reset their statuses to queued
        // so the new leader can pick them up.
        const interrupted = yield* executor.interruptInflight()
        if (interrupted.length > 0) {
          yield* Effect.logDebug("[FileSync] Interrupted in-flight transfers on leadership loss", {
            count: interrupted.length,
            fileIds: interrupted.map((t) => t.fileId)
          })
          yield* stateManager.atomicUpdate((state) => {
            const nextState = { ...state }
            for (const task of interrupted) {
              const existing = nextState[task.fileId]
              if (!existing) continue
              const statusField = task.kind === "download" ? "downloadStatus" : "uploadStatus"
              if (existing[statusField] === "inProgress") {
                nextState[task.fileId] = { ...existing, [statusField]: "queued" }
              }
            }
            return nextState
          })
        }

        yield* stopEventStream()
      })

    // Watch for leadership changes
    const watchLeadership = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        // Include the current value before following changes. Effect 4's
        // SubscriptionRef.changes only emits future PubSub values, so a lock
        // acquired between the startup read and stream subscription would
        // otherwise be missed and leave transfers permanently queued.
        yield* Stream.concat(
          Stream.fromEffect(SubscriptionRef.get(clientSession.lockStatus)),
          SubscriptionRef.changes(clientSession.lockStatus)
        ).pipe(
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

    // Heartbeat: periodically verify that the event stream and executor are alive
    const stopHeartbeat = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existing = yield* Ref.get(heartbeatFiberRef)
        if (!existing) return
        yield* Fiber.interrupt(existing)
        yield* Ref.set(heartbeatFiberRef, null)
      })

    // Check if event stream fiber is alive, restart if dead
    const checkEventStreamLiveness = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const streamFiber = yield* Ref.get(eventStreamFiberRef)
        if (!streamFiber) {
          yield* Effect.logWarning("[FileSync] Heartbeat: event stream fiber is dead, restarting")
          yield* emit({ type: "sync:heartbeat-recovery", reason: "stream-dead" })
          yield* startEventStream()
          return
        }

        if (streamFiber.pollUnsafe() !== undefined) {
          yield* Ref.set(eventStreamFiberRef, null)
          yield* Effect.logWarning("[FileSync] Heartbeat: event stream fiber exited, restarting")
          yield* emit({ type: "sync:heartbeat-recovery", reason: "stream-dead" })
          yield* startEventStream()
        }
      })

    // Check if queue is stuck (items queued but nothing inflight), recover if needed
    const checkStuckQueue = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const online = yield* Ref.get(onlineRef)
        const paused = yield* executor.isPaused()

        if (!online || paused) {
          yield* Ref.set(stuckCounterRef, 0)
          return
        }

        const queued = yield* executor.getQueuedCount()
        const inflight = yield* executor.getInflightCount()
        const totalQueued = queued.downloads + queued.uploads
        const totalInflight = inflight.downloads + inflight.uploads

        if (totalQueued > 0 && totalInflight === 0) {
          const count = yield* Ref.updateAndGet(stuckCounterRef, (n) => n + 1)
          if (count >= 2) {
            yield* Effect.logWarning(
              `[FileSync] Heartbeat: ${totalQueued} items stuck in queue for ${count} intervals, recovering`
            )
            yield* emit({ type: "sync:heartbeat-recovery", reason: "stuck-queue" })
            // Ensure workers are alive before resuming
            const mainScope = yield* Ref.get(mainScopeRef)
            if (mainScope) {
              yield* Effect.provideService(executor.ensureWorkers(), Scope.Scope, mainScope)
            }
            // Resume executor in case workers stopped polling
            yield* executor.resume()
            yield* Ref.set(stuckCounterRef, 0)
          }
        } else {
          yield* Ref.set(stuckCounterRef, 0)
        }
      })

    // Check if stream is stalled (alive but not advancing while upstream moves ahead)
    const checkStreamStall = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const thresholdMs = config.streamStallThresholdMs ?? 30000
        if (thresholdMs <= 0) return

        const online = yield* Ref.get(onlineRef)
        if (!online) return

        const lastBatchAt = yield* Ref.get(lastBatchAtRef)
        // Skip if we haven't processed any batches yet
        if (lastBatchAt === 0) return

        const timeSinceLastBatch = Date.now() - lastBatchAt
        if (timeSinceLastBatch < thresholdMs) return

        const lastBatchCursor = yield* Ref.get(lastBatchCursorRef)
        if (!lastBatchCursor) return

        const upstreamHead = resolveCursor(store.syncStatus().upstreamHead)

        // Compare only the global (synced) component — local events and rebase generations
        // should not affect stall detection since the upstream head only tracks synced events
        if (upstreamHead.global === lastBatchCursor.global) return

        yield* Effect.logWarning(
          `[FileSync] Heartbeat: stream stalled - upstream at ${EventSequenceNumber.Client.toString(upstreamHead)}, ` +
            `last batch at ${
              EventSequenceNumber.Client.toString(lastBatchCursor)
            }, ${timeSinceLastBatch}ms since last batch`
        )
        yield* emit({ type: "sync:heartbeat-recovery", reason: "stream-stalled" })
        yield* startEventStream()
      })

    const startHeartbeat = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const intervalMs = config.heartbeatIntervalMs ?? 15000
        if (intervalMs <= 0) return

        yield* stopHeartbeat()

        const tick: Effect.Effect<void> = Effect.gen(function*() {
          const running = yield* Ref.get(runningRef)
          const isLeader = yield* Ref.get(isLeaderRef)
          if (!running || !isLeader) {
            yield* Ref.set(stuckCounterRef, 0)
            return
          }

          yield* checkEventStreamLiveness()
          yield* checkStuckQueue()
          yield* checkStreamStall()
        }).pipe(
          Effect.catch((error) => Effect.logError("[FileSync] Heartbeat tick failed", { error }))
        )

        const loop = Effect.forever(
          Effect.gen(function*() {
            yield* Effect.sleep(Duration.millis(intervalMs))
            yield* tick
          })
        ).pipe(Effect.interruptible)

        // Fork into the main scope so the heartbeat stays alive
        const mainScope = yield* Ref.get(mainScopeRef)
        if (!mainScope) return
        const fiber = yield* Effect.forkIn(
          loop.pipe(Effect.ensuring(Ref.set(heartbeatFiberRef, null))),
          mainScope
        )
        yield* Ref.set(heartbeatFiberRef, fiber)
      })

    // Service methods
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const running = yield* Ref.get(runningRef)
        if (running) return

        yield* Ref.set(runningRef, true)

        // Capture and store the scope for use in setOnline/health check
        const scope = yield* Effect.scope
        yield* Ref.set(mainScopeRef, scope)

        // Start transfer workers only when remote transfers are enabled.
        if (!isLocalOnly) {
          yield* executor.start()
        }

        // Check initial lock status
        const initialStatus = yield* SubscriptionRef.get(clientSession.lockStatus)
        const isInitialLeader = initialStatus === "has-lock"
        yield* Ref.set(isLeaderRef, isInitialLeader)

        if (isInitialLeader) {
          yield* startSyncLoop()
        }

        // Watch for leadership changes
        const watchFiber = yield* watchLeadership().pipe(Effect.forkScoped)
        yield* Ref.set(leaderWatcherFiberRef, watchFiber)

        // Start heartbeat to monitor stream and executor liveness
        yield* startHeartbeat()

        // Start continuous health check to detect connectivity changes
        yield* startHealthCheckLoop()
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

        // Stop heartbeat and health check if running
        yield* stopHeartbeat()
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
      isLocalOnly
        ? setLocalOnlyAvailableFileState(fileId, path, hash)
        : stateManager.setFileState(fileId, {
          path,
          localHash: hash,
          downloadStatus: "done",
          uploadStatus: "queued",
          lastSyncError: ""
        })

    const saveFile = (file: File): Effect.Effect<FileOperationResult, HashError | StorageError> =>
      Effect.gen(function*() {
        // Apply preprocessor if configured for this file type
        // Use tryPromise so rejected/throwing preprocessors produce a caught error
        // instead of a defect that crashes the fiber
        const processed = yield* Effect.tryPromise({
          try: () => applyPreprocessorWithMetadata(config.preprocessors, file),
          catch: (err) =>
            new StorageError({
              message: `Preprocessor failed for ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err
            })
        })
        const processedFile = processed.file
        const metadataJson = yield* serializeFileMetadata(processedFile, processed.metadata)

        const id = crypto.randomUUID()
        const contentHash = yield* doHashFile(processedFile)
        const path = makeStoredPath(storeId, contentHash)

        yield* localStorage.writeFile(path, processedFile)
        yield* createFileRecord({ id, path, contentHash, metadataJson })
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
        const processed = yield* Effect.tryPromise({
          try: () => applyPreprocessorWithMetadata(config.preprocessors, file),
          catch: (err) =>
            new StorageError({
              message: `Preprocessor failed for ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err
            })
        })
        const processedFile = processed.file
        const metadataJson = yield* serializeFileMetadata(processedFile, processed.metadata)

        const contentHash = yield* doHashFile(processedFile)
        const path = makeStoredPath(storeId, contentHash)

        if (contentHash !== existingFile.contentHash) {
          yield* localStorage.writeFile(path, processedFile)
          yield* updateFileRecord({ id: fileId, path, contentHash, metadataJson, remoteKey: "" })

          if (path !== existingFile.path) {
            yield* localStorage.deleteFile(existingFile.path).pipe(Effect.catch(() => Effect.void))
          }

          if (!isLocalOnly && existingFile.remoteKey) {
            yield* remoteStorage.delete(existingFile.remoteKey).pipe(Effect.catch(() => Effect.void))
          }

          yield* markLocalFileChanged(fileId, path, contentHash)
        }

        return { fileId, path, contentHash }
      })

    const deleteFile = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const existingFile = yield* getFile(fileId)
        if (!existingFile) return

        // Cancel any pending download so it doesn't write the file back after deletion
        yield* executor.cancelDownload(fileId)

        yield* deleteFileRecord(fileId)

        yield* localStorage.deleteFile(existingFile.path).pipe(Effect.catch(() => Effect.void))
        yield* stateManager.removeFile(fileId)

        if (!isLocalOnly && existingFile.remoteKey) {
          yield* remoteStorage.delete(existingFile.remoteKey).pipe(Effect.catch(() => Effect.void))
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

        if (isLocalOnly) {
          const exists = yield* localStorage.fileExists(file.path)
          if (!exists) return null
          if (isNode()) {
            return resolveLocalFileUrl(deps.localPathRoot, file.path)
          }
          return yield* localStorage.getFileUrl(file.path)
        }

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
        if (isLocalOnly) {
          yield* Ref.set(onlineRef, true)
          return
        }

        const wasOnline = yield* Ref.get(onlineRef)
        if (online === wasOnline) return

        if (online) {
          yield* Ref.set(onlineRef, true)
          yield* emit({ type: "online" })
          yield* executor.resume()
        } else {
          yield* goOffline()
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

    const prioritizeDownload = (fileId: string): Effect.Effect<void> =>
      isLocalOnly ? Effect.void : executor.prioritizeDownload(fileId)

    const retryErrors = (): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function*() {
        if (isLocalOnly) return []

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

    const _simulateStreamDeath = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const fiber = yield* Ref.get(eventStreamFiberRef)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
        }
        yield* Ref.set(eventStreamFiberRef, null)
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
      retryErrors,
      _simulateStreamDeath
    }
  })

/**
 * Create a Layer for FileSync
 */
export const FileSyncLive = (
  deps: LiveStoreDeps,
  config: FileSyncConfig = defaultFileSyncConfig
): Layer.Layer<FileSync, never, Hash | LocalFileStorage | LocalFileStateManager | RemoteStorage> =>
  Layer.effect(FileSync, makeFileSync(deps, config))
