/**
 * SyncExecutor Service
 *
 * Manages concurrent file transfers with automatic retry and exponential backoff.
 * Uses Effect's concurrency primitives for queue management.
 *
 * @module
 */

import type { Scope } from "effect"
import { Context, Deferred, Duration, Effect, Fiber, Layer, Option, Queue, Ref, Schedule } from "effect"

/**
 * Transfer kind
 */
export type TransferKind = "upload" | "download"

// Re-export TransferStatus from types (derived from schema - single source of truth)
export type { TransferStatus } from "../../types/index.js"

/**
 * Transfer task
 */
export interface TransferTask {
  readonly kind: TransferKind
  readonly fileId: string
}

/**
 * Transfer result
 */
export interface TransferResult {
  readonly kind: TransferKind
  readonly fileId: string
  readonly success: boolean
  readonly error?: unknown
}

/**
 * SyncExecutor configuration
 */
export interface SyncExecutorConfig {
  /**
   * Maximum concurrent downloads (default: 2)
   */
  readonly maxConcurrentDownloads: number

  /**
   * Maximum concurrent uploads (default: 2)
   */
  readonly maxConcurrentUploads: number

  /**
   * Base delay for exponential backoff (default: 1 second)
   */
  readonly baseDelayMs: number

  /**
   * Maximum delay for exponential backoff (default: 60 seconds)
   */
  readonly maxDelayMs: number

  /**
   * Jitter to add to delays (default: 500ms)
   */
  readonly jitterMs: number

  /**
   * Maximum retry attempts (default: 5)
   */
  readonly maxRetries: number
}

/**
 * Default configuration
 */
export const defaultConfig: SyncExecutorConfig = {
  maxConcurrentDownloads: 2,
  maxConcurrentUploads: 2,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterMs: 500,
  maxRetries: 5
}

/**
 * Transfer handler function type
 */
export type TransferHandler = (
  kind: TransferKind,
  fileId: string
) => Effect.Effect<void, unknown>

/**
 * SyncExecutor service interface
 */
export interface SyncExecutorService {
  /**
   * Enqueue a download task
   */
  readonly enqueueDownload: (fileId: string) => Effect.Effect<void>

  /**
   * Enqueue an upload task
   */
  readonly enqueueUpload: (fileId: string) => Effect.Effect<void>

  /**
   * Prioritize a download - moves it to high priority queue.
   * If already queued in normal queue, it will be processed from high priority first.
   * If already in high priority, inflight, or processed, this is a no-op.
   */
  readonly prioritizeDownload: (fileId: string) => Effect.Effect<void>

  /**
   * Cancel a pending download.
   * Marks the file as cancelled so it will be skipped when dequeued.
   * If already inflight, the download will continue but won't be retried on failure.
   */
  readonly cancelDownload: (fileId: string) => Effect.Effect<void>

  /**
   * Pause processing (e.g., when going offline)
   */
  readonly pause: () => Effect.Effect<void>

  /**
   * Resume processing (e.g., when coming back online)
   */
  readonly resume: () => Effect.Effect<void>

  /**
   * Check if the executor is paused
   */
  readonly isPaused: () => Effect.Effect<boolean>

  /**
   * Get the number of tasks currently in flight
   */
  readonly getInflightCount: () => Effect.Effect<{ downloads: number; uploads: number }>

  /**
   * Get the number of tasks waiting in queue
   */
  readonly getQueuedCount: () => Effect.Effect<{ downloads: number; uploads: number }>

  /**
   * Wait for all current tasks to complete
   */
  readonly awaitIdle: () => Effect.Effect<void>

  /**
   * Start the executor (begins processing queues)
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>

  /**
   * Ensure worker fibers are running.
   * If a worker fiber has exited (crashed, interrupted), restarts it.
   * Only restarts workers when executor is not paused.
   * @internal
   */
  readonly ensureWorkers: () => Effect.Effect<void, never, Scope.Scope>
}

/**
 * SyncExecutor service tag
 */
export class SyncExecutor extends Context.Tag("SyncExecutor")<
  SyncExecutor,
  SyncExecutorService
>() {}

/**
 * Internal state for the executor
 */
interface ExecutorState {
  readonly paused: boolean
  readonly downloadsInflight: number
  readonly uploadsInflight: number
}

/**
 * Callback invoked after each task completes (success or failure after all retries exhausted).
 * Errors thrown by the callback are caught and logged — they won't crash the executor.
 */
export type TaskCompleteCallback = (result: TransferResult) => Effect.Effect<void, unknown>

/**
 * Create a SyncExecutor service
 */
export const makeSyncExecutor = (
  handler: TransferHandler,
  config: SyncExecutorConfig = defaultConfig,
  onTaskComplete?: TaskCompleteCallback
): Effect.Effect<SyncExecutorService, never, Scope.Scope> =>
  Effect.gen(function*() {
    // Create queues for downloads and uploads
    // Downloads use two queues: high priority (processed first) and normal
    const highPriorityDownloadQueue = yield* Queue.unbounded<string>()
    const downloadQueue = yield* Queue.unbounded<string>()
    const uploadQueue = yield* Queue.unbounded<string>()

    // State management
    const stateRef = yield* Ref.make<ExecutorState>({
      paused: false,
      downloadsInflight: 0,
      uploadsInflight: 0
    })

    // Worker fiber tracking for liveness
    const downloadWorkerFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
    const uploadWorkerFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

    // Track queued file IDs to avoid duplicates
    const highPriorityDownloadQueuedSet = yield* Ref.make<Set<string>>(new Set())
    const downloadQueuedSet = yield* Ref.make<Set<string>>(new Set())
    const uploadQueuedSet = yield* Ref.make<Set<string>>(new Set())

    // Track processed downloads to skip duplicates when same file is in both queues
    const downloadProcessedSet = yield* Ref.make<Set<string>>(new Set())

    // Track cancelled downloads to skip when dequeued (e.g., file was deleted)
    const cancelledDownloadsSet = yield* Ref.make<Set<string>>(new Set())

    // Signal for idle waiting
    const idleDeferred = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none())

    // Create retry schedule with exponential backoff
    const retrySchedule = Schedule.exponential(Duration.millis(config.baseDelayMs)).pipe(
      Schedule.jittered,
      Schedule.upTo(Duration.millis(config.maxDelayMs)),
      Schedule.intersect(Schedule.recurs(config.maxRetries))
    )

    // Check if we're idle and signal if needed
    const checkIdle = Effect.gen(function*() {
      const state = yield* Ref.get(stateRef)
      const highPriorityDownloadQueueSize = yield* Queue.size(highPriorityDownloadQueue)
      const downloadQueueSize = yield* Queue.size(downloadQueue)
      const uploadQueueSize = yield* Queue.size(uploadQueue)

      if (
        state.downloadsInflight === 0 &&
        state.uploadsInflight === 0 &&
        highPriorityDownloadQueueSize === 0 &&
        downloadQueueSize === 0 &&
        uploadQueueSize === 0
      ) {
        // Clear processed and cancelled sets when idle to avoid unbounded memory growth
        yield* Ref.set(downloadProcessedSet, new Set())
        yield* Ref.set(highPriorityDownloadQueuedSet, new Set())
        yield* Ref.set(cancelledDownloadsSet, new Set())

        const maybeDeferred = yield* Ref.get(idleDeferred)
        if (Option.isSome(maybeDeferred)) {
          yield* Deferred.succeed(maybeDeferred.value, undefined)
          yield* Ref.set(idleDeferred, Option.none())
        }
      }
    })

    // Process a single task with retry
    const processTask = (
      kind: TransferKind,
      fileId: string
    ): Effect.Effect<TransferResult> =>
      Effect.gen(function*() {
        // Update inflight count
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          downloadsInflight: kind === "download" ? s.downloadsInflight + 1 : s.downloadsInflight,
          uploadsInflight: kind === "upload" ? s.uploadsInflight + 1 : s.uploadsInflight
        }))

        // Remove from queued sets and mark as processed for downloads
        if (kind === "download") {
          yield* Ref.update(downloadQueuedSet, (set) => {
            const newSet = new Set(set)
            newSet.delete(fileId)
            return newSet
          })
          yield* Ref.update(highPriorityDownloadQueuedSet, (set) => {
            const newSet = new Set(set)
            newSet.delete(fileId)
            return newSet
          })
          yield* Ref.update(downloadProcessedSet, (set) => {
            const newSet = new Set(set)
            newSet.add(fileId)
            return newSet
          })
        } else {
          yield* Ref.update(uploadQueuedSet, (set) => {
            const newSet = new Set(set)
            newSet.delete(fileId)
            return newSet
          })
        }

        // Execute with retry
        const result = yield* handler(kind, fileId).pipe(
          Effect.retry(retrySchedule),
          Effect.map(() => ({ kind, fileId, success: true as const })),
          Effect.catchAll((error) => Effect.succeed({ kind, fileId, success: false as const, error }))
        )

        // Log and notify when retries are exhausted
        if (!result.success) {
          yield* Effect.logWarning(
            `Transfer failed after ${config.maxRetries} retries`,
            { kind, fileId, error: result.error }
          )
        }

        // Notify caller of task completion (success or failure)
        if (onTaskComplete) {
          yield* onTaskComplete(result).pipe(
            Effect.catchAll((callbackError) => Effect.logWarning("onTaskComplete callback failed", { callbackError }))
          )
        }

        // Update inflight count
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          downloadsInflight: kind === "download" ? s.downloadsInflight - 1 : s.downloadsInflight,
          uploadsInflight: kind === "upload" ? s.uploadsInflight - 1 : s.uploadsInflight
        }))

        // Check if we're idle now
        yield* checkIdle

        return result
      })

    // Worker that processes uploads (single queue)
    const createUploadWorker = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const processLoop: Effect.Effect<void> = Effect.gen(function*() {
          // Check if paused
          const state = yield* Ref.get(stateRef)
          if (state.paused) {
            yield* Effect.sleep(Duration.millis(100))
            return
          }

          // Check if we can start more tasks
          if (state.uploadsInflight >= config.maxConcurrentUploads) {
            yield* Effect.sleep(Duration.millis(50))
            return
          }

          // Try to get a task from the queue (non-blocking)
          const maybeFileId = yield* Queue.poll(uploadQueue)
          if (Option.isNone(maybeFileId)) {
            yield* Effect.sleep(Duration.millis(100))
            return
          }

          // Process the task in the background
          yield* Effect.fork(processTask("upload", maybeFileId.value))
        })

        yield* Effect.forever(processLoop).pipe(Effect.interruptible)
      })

    // Worker that processes downloads with priority (high priority queue first)
    const createDownloadWorker = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const processLoop: Effect.Effect<void> = Effect.gen(function*() {
          // Check if paused
          const state = yield* Ref.get(stateRef)
          if (state.paused) {
            yield* Effect.sleep(Duration.millis(100))
            return
          }

          // Check if we can start more tasks
          if (state.downloadsInflight >= config.maxConcurrentDownloads) {
            yield* Effect.sleep(Duration.millis(50))
            return
          }

          // Try high priority queue first
          const maybeHighPriority = yield* Queue.poll(highPriorityDownloadQueue)
          if (Option.isSome(maybeHighPriority)) {
            const fileId = maybeHighPriority.value
            // Check if already processed or cancelled (e.g., file was deleted)
            const processed = yield* Ref.get(downloadProcessedSet)
            const cancelled = yield* Ref.get(cancelledDownloadsSet)
            if (!processed.has(fileId) && !cancelled.has(fileId)) {
              yield* Effect.fork(processTask("download", fileId))
            } else {
              // Item was skipped - check if we're idle now
              yield* checkIdle
            }
            return
          }

          // Fall back to normal queue
          const maybeNormal = yield* Queue.poll(downloadQueue)
          if (Option.isSome(maybeNormal)) {
            const fileId = maybeNormal.value
            // Check if already processed or cancelled via high priority queue
            const processed = yield* Ref.get(downloadProcessedSet)
            const cancelled = yield* Ref.get(cancelledDownloadsSet)
            if (!processed.has(fileId) && !cancelled.has(fileId)) {
              yield* Effect.fork(processTask("download", fileId))
            } else {
              // Item was skipped - check if we're idle now
              yield* checkIdle
            }
            return
          }

          // Both queues empty, wait a bit
          yield* Effect.sleep(Duration.millis(100))
        })

        yield* Effect.forever(processLoop).pipe(Effect.interruptible)
      })

    // Start a download worker and track its fiber
    const startDownloadWorker = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkScoped(createDownloadWorker())
        yield* Ref.set(downloadWorkerFiberRef, fiber)
      })

    // Start an upload worker and track its fiber
    const startUploadWorker = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkScoped(createUploadWorker())
        yield* Ref.set(uploadWorkerFiberRef, fiber)
      })

    // Check if a fiber is dead (null or exited)
    const isFiberDead = (
      fiber: Fiber.RuntimeFiber<void, never> | null
    ): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        if (!fiber) return true
        const poll = yield* Fiber.poll(fiber)
        return Option.isSome(poll)
      })

    // Ensure workers are running. Restarts any dead workers.
    // Workers check the paused state in their loop, so they can be running but not processing.
    const ensureWorkers = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const downloadFiber = yield* Ref.get(downloadWorkerFiberRef)
        const uploadFiber = yield* Ref.get(uploadWorkerFiberRef)

        const downloadDead = yield* isFiberDead(downloadFiber)
        const uploadDead = yield* isFiberDead(uploadFiber)

        if (downloadDead) {
          yield* startDownloadWorker()
        }
        if (uploadDead) {
          yield* startUploadWorker()
        }
      })

    // Start workers (idempotent - uses ensureWorkers)
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        yield* ensureWorkers()
      })

    // Atomic check-and-set: Ref.modify returns [shouldEnqueue, newSet] in a single
    // operation, preventing races where two fibers both see the fileId as absent
    // and double-enqueue the same file.
    const enqueueDownload = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const shouldEnqueue = yield* Ref.modify(downloadQueuedSet, (set) => {
          if (set.has(fileId)) return [false, set] as const
          const newSet = new Set(set)
          newSet.add(fileId)
          return [true, newSet] as const
        })
        if (shouldEnqueue) {
          yield* Queue.offer(downloadQueue, fileId)
        }
      })

    const enqueueUpload = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const shouldEnqueue = yield* Ref.modify(uploadQueuedSet, (set) => {
          if (set.has(fileId)) return [false, set] as const
          const newSet = new Set(set)
          newSet.add(fileId)
          return [true, newSet] as const
        })
        if (shouldEnqueue) {
          yield* Queue.offer(uploadQueue, fileId)
        }
      })

    const prioritizeDownload = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Check if already processed or in high priority queue
        const processed = yield* Ref.get(downloadProcessedSet)
        if (processed.has(fileId)) return

        // Check if file is actually queued in normal queue (otherwise nothing to prioritize)
        const normalQueued = yield* Ref.get(downloadQueuedSet)
        if (!normalQueued.has(fileId)) return

        // Atomic check-and-set for the high priority queue set
        const shouldEnqueue = yield* Ref.modify(highPriorityDownloadQueuedSet, (set) => {
          if (set.has(fileId)) return [false, set] as const
          const newSet = new Set(set)
          newSet.add(fileId)
          return [true, newSet] as const
        })
        if (shouldEnqueue) {
          yield* Queue.offer(highPriorityDownloadQueue, fileId)
        }

        // Note: We don't remove from normal queue since Effect Queue doesn't support removal.
        // The worker will skip it when it reaches it in the normal queue because
        // it will already be in the downloadProcessedSet by then.
      })

    const cancelDownload = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Mark as cancelled so it will be skipped when dequeued
        yield* Ref.update(cancelledDownloadsSet, (set) => {
          const newSet = new Set(set)
          newSet.add(fileId)
          return newSet
        })

        // Remove from queued sets so queue counts are accurate
        yield* Ref.update(downloadQueuedSet, (set) => {
          const newSet = new Set(set)
          newSet.delete(fileId)
          return newSet
        })
        yield* Ref.update(highPriorityDownloadQueuedSet, (set) => {
          const newSet = new Set(set)
          newSet.delete(fileId)
          return newSet
        })

        // Note: We can't remove from the actual Queue, but the worker will skip
        // when it sees the fileId in cancelledDownloadsSet
      })

    const pause = (): Effect.Effect<void> => Ref.update(stateRef, (s) => ({ ...s, paused: true }))

    const resume = (): Effect.Effect<void> => Ref.update(stateRef, (s) => ({ ...s, paused: false }))

    const isPaused = (): Effect.Effect<boolean> => Ref.get(stateRef).pipe(Effect.map((s) => s.paused))

    const getInflightCount = (): Effect.Effect<{ downloads: number; uploads: number }> =>
      Ref.get(stateRef).pipe(
        Effect.map((s) => ({
          downloads: s.downloadsInflight,
          uploads: s.uploadsInflight
        }))
      )

    const getQueuedCount = (): Effect.Effect<{ downloads: number; uploads: number }> =>
      Effect.gen(function*() {
        // Use the queued sets for accurate counts (they track unique file IDs)
        const highPriorityQueued = yield* Ref.get(highPriorityDownloadQueuedSet)
        const normalQueued = yield* Ref.get(downloadQueuedSet)
        const uploadsQueued = yield* Ref.get(uploadQueuedSet)

        // Union of both download sets to avoid double-counting
        const allDownloadIds = new Set([...highPriorityQueued, ...normalQueued])

        return {
          downloads: allDownloadIds.size,
          uploads: uploadsQueued.size
        }
      })

    const awaitIdle = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Check if already idle
        const state = yield* Ref.get(stateRef)
        const highPriorityDownloadQueueSize = yield* Queue.size(highPriorityDownloadQueue)
        const downloadQueueSize = yield* Queue.size(downloadQueue)
        const uploadQueueSize = yield* Queue.size(uploadQueue)

        if (
          state.downloadsInflight === 0 &&
          state.uploadsInflight === 0 &&
          highPriorityDownloadQueueSize === 0 &&
          downloadQueueSize === 0 &&
          uploadQueueSize === 0
        ) {
          return
        }

        // Create a deferred to wait on
        const deferred = yield* Deferred.make<void>()
        yield* Ref.set(idleDeferred, Option.some(deferred))

        // Wait for completion
        yield* Deferred.await(deferred)
      })

    return {
      enqueueDownload,
      enqueueUpload,
      prioritizeDownload,
      cancelDownload,
      pause,
      resume,
      isPaused,
      getInflightCount,
      getQueuedCount,
      awaitIdle,
      start,
      ensureWorkers
    }
  })

/**
 * Create a Layer for SyncExecutor
 *
 * Note: The handler must be provided separately since it typically
 * depends on other services (LocalFileStorage, RemoteStorage, etc.)
 */
export const makeSyncExecutorLayer = (
  handler: TransferHandler,
  config: SyncExecutorConfig = defaultConfig,
  onTaskComplete?: TaskCompleteCallback
): Layer.Layer<SyncExecutor, never, Scope.Scope> =>
  Layer.scoped(
    SyncExecutor,
    makeSyncExecutor(handler, config, onTaskComplete)
  )
