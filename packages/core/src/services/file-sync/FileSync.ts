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
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
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
  PreprocessorMap
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
import { makeBlobOwnership } from "./BlobOwnership.js"
import { type FileRepair, makeReconciliation } from "./Reconciliation.js"

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
   * Delete a file (soft delete in store, reclaim unowned local bytes; retain remote blobs)
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

    const blobs = yield* makeBlobOwnership(localStorage, (path) =>
      store.query<Array<FileRecord>>(queryDb(tables.files))
        .some((row) => !row.deletedAt && row.path === path))

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
    const lifecycle = yield* Semaphore.make(1)
    let generation = 0
    // Read the actual lock as well: leadership notifications may wait behind I/O.
    const isRunningLeader = () =>
      Effect.runSync(Ref.get(runningRef)) &&
      Effect.runSync(SubscriptionRef.get(clientSession.lockStatus)) === "has-lock"
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

    // Main scope ref - stores the scope from start() for use in setOnline/health check
    const mainScopeRef = yield* Ref.make<Scope.Closeable | null>(null)

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
            repairs: readRepairs(),
            lastEventSequence: sequence,
            updatedAt: new Date()
          })
        )
      })

    const readRepairs = (): ReadonlyArray<FileRepair> =>
      store.query<{ repairs?: ReadonlyArray<FileRepair> }>(queryDb(tables.fileSyncCursor.get())).repairs ?? []

    const writeRepairs = (update: (repairs: ReadonlyArray<FileRepair>) => ReadonlyArray<FileRepair>) =>
      Effect.sync(() => {
        const doc = store.query<{ lastEventSequence: string; repairs?: ReadonlyArray<FileRepair> }>(
          queryDb(tables.fileSyncCursor.get())
        )
        const repairs = update(doc.repairs ?? [])
        if (JSON.stringify(repairs) === JSON.stringify(doc.repairs ?? [])) return
        store.commit(events.fileSyncCursorSet({ ...doc, repairs, updatedAt: new Date() }))
      })

    const reEnqueueQueuedTransfers = (): Effect.Effect<void> => reconciliation.recover().pipe(Effect.asVoid)

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
              if (isRunningLeader()) {
                yield* reEnqueueQueuedTransfers()
                if (isRunningLeader()) yield* executor.resume()
              }
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

        if (!isRunningLeader()) return

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
        const transferGeneration = generation
        const ownsTransfer = () => generation === transferGeneration && isRunningLeader()
        if (!ownsTransfer()) return
        const currentTransfer = (file: FileRecord) => ownsTransfer() && isCurrentTransfer(file)
        const file = yield* getFile(fileId)
        if (!file || file.deletedAt) return
        if (kind === "download") {
          if (!file.remoteKey) return
          const local = (yield* stateManager.getState())[fileId]
          // Coalesced follow-ups may outlive completion of the same content.
          if (local?.downloadStatus === "done" && local.path === file.path && local.localHash === file.contentHash) {
            return
          }
        }
        if (kind === "upload" && file.remoteKey) {
          yield* stateManager.atomicUpdate((state) => {
            const local = state[fileId]
            if (!currentTransfer(file) || !local || local.localHash !== file.contentHash) return state
            return { ...state, [fileId]: { ...local, uploadStatus: "done", lastSyncError: "" } }
          })
          return
        }

        const reconcileLatest = (): Effect.Effect<void> =>
          Effect.gen(function*() {
            if (!ownsTransfer()) return
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

        return yield* blobs.duringTransfer(
          file.path,
          Effect.gen(function*() {
            yield* stateManager.atomicUpdate((state) => {
              if (!currentTransfer(file) || !state[fileId]) return state
              return {
                ...state,
                [fileId]: { ...state[fileId], [kind === "upload" ? "uploadStatus" : "downloadStatus"]: "inProgress" }
              }
            })
            if (!currentTransfer(file)) return
            yield* emit({ type: kind === "upload" ? "upload:start" : "download:start", fileId })

            const onProgress = (progress: { loaded: number; total: number }) => {
              if (!currentTransfer(file)) return
              Effect.runSync(emit({
                type: kind === "upload" ? "upload:progress" : "download:progress",
                fileId,
                progress: { kind, fileId, status: "inProgress", ...progress }
              }))
            }

            yield* Effect.gen(function*() {
              if (!currentTransfer(file)) return
              if (kind === "upload") {
                const localFile = yield* blobs.publish(localStorage.readFile(file.path))
                const hash = yield* doHashFile(localFile)
                if (!currentTransfer(file)) return yield* reconcileLatest()
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
                  if (!currentTransfer(file)) return false
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
                  return yield* reconcileLatest()
                }
                yield* stateManager.atomicUpdate((state) => {
                  const current = readFile(fileId)
                  const local = state[fileId]
                  if (
                    !ownsTransfer() || !current || current.deletedAt || current.contentHash !== file.contentHash ||
                    current.path !== file.path || current.remoteKey !== uploaded.key ||
                    !local || local.localHash !== file.contentHash
                  ) return state
                  return { ...state, [fileId]: { ...local, uploadStatus: "done", lastSyncError: "" } }
                })
              } else {
                const downloaded = yield* remoteStorage.download(file.remoteKey, { onProgress })
                const hash = yield* doHashFile(downloaded)
                if (!currentTransfer(file)) return yield* reconcileLatest()
                if (hash !== file.contentHash) {
                  return yield* Effect.fail(new Error("Download content hash mismatch"))
                }
                // Finish publication and stale-path cleanup even if cancellation arrives
                // during an adapter write that cannot itself be aborted.
                const published = yield* Effect.gen(function*() {
                  yield* localStorage.writeFile(file.path, downloaded)
                  if (!currentTransfer(file)) {
                    return false
                  }
                  yield* stateManager.atomicUpdate((state) => {
                    if (!currentTransfer(file)) return state
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
                }).pipe(blobs.publish)
                if (!published) return yield* reconcileLatest()
              }
              if (!ownsTransfer()) return
              yield* emit({ type: kind === "upload" ? "upload:complete" : "download:complete", fileId })
            }).pipe(Effect.catch((error) =>
              Effect.gen(function*() {
                if (!currentTransfer(file)) return yield* reconcileLatest()
                yield* stateManager.atomicUpdate((state) => {
                  if (!currentTransfer(file) || !state[fileId]) return state
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
        )
      })

    // Create sync executor with task completion callback
    const onTaskComplete = (
      result: { kind: "upload" | "download"; fileId: string; success: boolean; error?: unknown }
    ) =>
      Effect.gen(function*() {
        if (!result.success && isRunningLeader()) {
          yield* emit({
            type: "transfer:exhausted",
            kind: result.kind,
            fileId: result.fileId,
            error: result.error
          })
        }
      })

    const executor = yield* makeSyncExecutor(transferHandler, executorConfig, onTaskComplete)
    yield* executor.pause()

    const setLocalOnlyAvailableFileState = (fileId: string, path: string, localHash: string) =>
      stateManager.setFileState(fileId, {
        path,
        localHash,
        uploadStatus: "done",
        downloadStatus: "done",
        lastSyncError: ""
      })

    const reconciliation = makeReconciliation({
      state: stateManager,
      executor,
      localOnly: isLocalOnly,
      readFile,
      readRepairs,
      writeRepairs,
      maxRepairAttempts: Math.max(2, executorConfig.maxRetries + 1),
      onError: (fileId, error) => emit({ type: "sync:error", error, context: `reconcile:${fileId}` }),
      remove: (file) =>
        Effect.gen(function*() {
          const localPath = (yield* stateManager.getState())[file.id]?.path
          yield* executor.cancelDownload(file.id)
          yield* blobs.cleanup(file.path)
          if (localPath && localPath !== file.path) yield* blobs.cleanup(localPath)
        }),
      inspect: (file) =>
        Effect.gen(function*() {
          // A failed read is repair work, not evidence that the bytes are missing.
          const exists = yield* localStorage.fileExists(file.path)
          const localHash = exists ? yield* doHashFile(yield* localStorage.readFile(file.path)) : ""
          if (isLocalOnly) {
            return exists
              ? { path: file.path, localHash, uploadStatus: "done", downloadStatus: "done", lastSyncError: "" }
              : undefined
          }
          if (!exists && !file.remoteKey) return undefined
          return {
            path: file.path,
            localHash,
            uploadStatus: file.remoteKey ? "done" : "queued",
            downloadStatus: file.remoteKey && localHash !== file.contentHash ? "queued" : "done",
            lastSyncError: ""
          }
        })
    })

    // Reconcile current materialized metadata, never an obsolete event payload.
    const handleFileUpdated = (payload: { id: string }): Effect.Effect<void> =>
      reconciliation.reconcile([payload.id], true)

    const bootstrapFromTables = (): Effect.Effect<void> =>
      Effect.suspend(() =>
        reconciliation.reconcile(
          store.query<Array<FileRecord>>(queryDb(tables.files.select())).map((file) => file.id)
        )
      )

    const handleEventBatch = (
      eventsBatch: ReadonlyArray<LiveStoreEvent.Client.Decoded>
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (eventsBatch.length === 0) return

        yield* emit({ type: "sync:start" })

        // Reconciliation persists failed file IDs before this cursor advances.
        // Heartbeat/startup repair only those IDs, without replaying unrelated events.
        for (const event of eventsBatch) {
          yield* Effect.gen(function*() {
            switch (event.name) {
              case "v1.FileCreated":
                yield* handleFileUpdated(event.args as FileCreatedPayload)
                break
              case "v1.FileUpdated":
                yield* handleFileUpdated(event.args as FileUpdatedPayload)
                break
              case "v1.FileDeleted":
                yield* handleFileUpdated(event.args as FileDeletedPayload)
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

        // Each file now has either reconciled state or a durable repair entry.
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
        if (!isLeader || !isRunningLeader()) return

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
        if (!isLeader || !isRunningLeader()) return
        // Ensure queued transfer state is reflected in executor queues before restart.
        yield* reEnqueueQueuedTransfers()
        yield* startEventStream()
      })

    // Start the sync loop (only called when we're the leader)
    const startSyncLoop = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        if (!isRunningLeader()) return
        // Every leadership acquisition rebuilds work, including a fresh executor.
        const retried = yield* reconciliation.recover(true)
        if (retried.length > 0) yield* emit({ type: "sync:error-retry-start", fileIds: retried })
        yield* reconciliation.repair()

        if (!isLocalOnly) {
          const isOnline = yield* Ref.get(onlineRef)
          if (isOnline && isRunningLeader()) {
            yield* executor.resume()
          } else {
            yield* executor.pause()
          }
        }
        if (!isLocalOnly) yield* executor.ensureWorkers()
        yield* maybeBootstrapFromTables()
        yield* startEventStream()
      })

    // Stop the sync loop (called when we lose leadership)
    const stopSyncLoop = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        generation++
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
        // Subscribe before reading the lock: startup/recovery can await I/O,
        // during which leadership may change again. Keep those notifications.
        const subscription = yield* PubSub.subscribe(clientSession.lockStatus.pubsub)
        yield* Stream.concat(
          Stream.fromEffect(SubscriptionRef.get(clientSession.lockStatus)),
          Stream.fromEffectRepeat(PubSub.take(subscription))
        ).pipe(
          Stream.tap((status) =>
            Effect.gen(function*() {
              const wasLeader = yield* Ref.get(isLeaderRef)
              const isNowLeader = status === "has-lock" && isRunningLeader()
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
          Stream.runDrain
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
            if (isRunningLeader()) yield* executor.resume()
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
          if (!running || !isLeader || !isRunningLeader()) {
            yield* Ref.set(stuckCounterRef, 0)
            return
          }

          yield* reconciliation.repair()
          yield* reconciliation.recover()
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

    // A run owns its workers, watcher and background work. Closing an old caller's
    // scope must not stop a newer run, and stop waits for non-cancellable writes.
    const stopRun = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* Ref.set(runningRef, false)
        generation++
        const scope = yield* Ref.get(mainScopeRef)
        const watcher = yield* Ref.get(leaderWatcherFiberRef)
        if (watcher) yield* Fiber.interrupt(watcher)
        yield* Ref.set(leaderWatcherFiberRef, null)
        yield* stopHeartbeat()
        yield* stopHealthCheckLoop()
        yield* stopSyncLoop()
        if (scope) yield* Scope.close(scope, Exit.void)
        yield* Ref.set(mainScopeRef, null)
        yield* Ref.set(isLeaderRef, false)
      })

    const stop = (): Effect.Effect<void> => lifecycle.withPermit(stopRun()).pipe(Effect.uninterruptible)

    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      lifecycle.withPermit(Effect.gen(function*() {
        if (yield* Ref.get(runningRef)) return
        const scope = yield* Scope.make()
        yield* Ref.set(mainScopeRef, scope)
        yield* Ref.set(runningRef, true)
        generation++
        yield* Effect.addFinalizer(() =>
          lifecycle.withPermit(Effect.gen(function*() {
            if ((yield* Ref.get(mainScopeRef)) === scope) yield* stopRun()
          }))
        )
        yield* Scope.provide(
          Effect.gen(function*() {
            const initialStatus = yield* SubscriptionRef.get(clientSession.lockStatus)
            const isInitialLeader = initialStatus === "has-lock"
            yield* Ref.set(isLeaderRef, isInitialLeader)
            if (isInitialLeader) yield* startSyncLoop()
            const watcher = yield* Effect.forkIn(watchLeadership(), scope)
            yield* Ref.set(leaderWatcherFiberRef, watcher)
            yield* startHeartbeat()
            yield* startHealthCheckLoop()
          }),
          scope
        ).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? stopRun() : Effect.void))
      }))

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

        yield* blobs.publish(Effect.gen(function*() {
          yield* localStorage.writeFile(path, processedFile)
          yield* createFileRecord({ id, path, contentHash, metadataJson })
        }))
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
          yield* blobs.publish(Effect.gen(function*() {
            yield* localStorage.writeFile(path, processedFile)
            yield* updateFileRecord({ id: fileId, path, contentHash, metadataJson, remoteKey: "" })
          }))
          if (path !== existingFile.path) yield* blobs.cleanup(existingFile.path)

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

        yield* blobs.cleanup(existingFile.path)
        yield* stateManager.removeFile(fileId)
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
          if (isRunningLeader()) {
            yield* reEnqueueQueuedTransfers()
            if (isRunningLeader()) yield* executor.resume()
          }
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

        const retriedFileIds = yield* reconciliation.recover(true)
        yield* writeRepairs((repairs) => repairs.map((r) => ({ ...r, attempts: 0 })))
        yield* reconciliation.repair()

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
