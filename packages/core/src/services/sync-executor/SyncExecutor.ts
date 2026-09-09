/**
 * SyncExecutor Service
 *
 * Manages concurrent file transfers with automatic retry and exponential backoff.
 * Uses Effect's concurrency primitives for queue management.
 *
 * @module
 */

import type { Scope } from "effect"
import { Context, Deferred, Duration, Effect, Fiber, Layer, Option, Queue, Schedule, Semaphore } from "effect"

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
  /** Synchronous membership check for durable queue reconstruction; does not schedule a follow-up. */
  readonly hasTask: (kind: TransferKind, fileId: string) => boolean

  /**
   * Enqueue a download task. Enqueues during an active transfer coalesce into
   * one subsequent run so the handler can pick up the latest version.
   */
  readonly enqueueDownload: (fileId: string) => Effect.Effect<void>

  /**
   * Enqueue an upload task. Enqueues during an active transfer coalesce into
   * one subsequent run so the handler can pick up the latest version.
   */
  readonly enqueueUpload: (fileId: string) => Effect.Effect<void>

  /**
   * Prioritize a download - moves it to high priority queue.
   * If already queued in normal queue, it will be processed from high priority first.
   * If already in high priority or inflight, this is a no-op.
   */
  readonly prioritizeDownload: (fileId: string) => Effect.Effect<void>

  /**
   * Cancel queued and in-flight downloads, including retries.
   * Waits for the in-flight effect to finish interruption.
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
   * Interrupt all in-flight transfer fibers and reset inflight counts.
   * Returns the file IDs that were interrupted, so the caller can
   * reset their transfer statuses (e.g., inProgress → queued).
   */
  readonly interruptInflight: () => Effect.Effect<ReadonlyArray<{ kind: TransferKind; fileId: string }>>

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
export class SyncExecutor extends Context.Service<SyncExecutor, SyncExecutorService>()("SyncExecutor") {}

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
    // Queue entries have identity so obsolete normal/priority entries cannot
    // consume a later request for the same file.
    interface Request {
      readonly kind: TransferKind
      readonly fileId: string
      priority: boolean
    }
    const downloadQueue = yield* Queue.unbounded<Request>()
    const priorityQueue = yield* Queue.unbounded<Request>()
    const uploadQueue = yield* Queue.unbounded<Request>()
    const queued = new Map<string, Request>()
    const active = new Map<string, { request: Request; fiber: Fiber.Fiber<void, never> }>()
    const idleWaiters = new Set<Deferred.Deferred<void>>()
    const workerMutex = yield* Semaphore.make(1)
    let paused = false
    let downloadWorker: Fiber.Fiber<void, never> | undefined
    let uploadWorker: Fiber.Fiber<void, never> | undefined
    const keyOf = (kind: TransferKind, fileId: string) => `${kind}:${fileId}`
    const countKind = (kind: TransferKind) =>
      Array.from(active.values()).filter((entry) => entry.request.kind === kind).length

    const retrySchedule = Schedule.exponential(Duration.millis(config.baseDelayMs)).pipe(
      Schedule.jittered,
      Schedule.upTo({ duration: Duration.millis(config.maxDelayMs), times: config.maxRetries })
    )

    const checkIdle = Effect.gen(function*() {
      if (active.size !== 0 || queued.size !== 0) return
      const waiters = Array.from(idleWaiters)
      idleWaiters.clear()
      for (const waiter of waiters) yield* Deferred.succeed(waiter, undefined)
    })

    const offer = (request: Request) =>
      Queue.offer(
        request.kind === "upload" ? uploadQueue : request.priority ? priorityQueue : downloadQueue,
        request
      )

    const processTask = (request: Request): Effect.Effect<void> =>
      Effect.gen(function*() {
        const { fileId, kind } = request
        const result = yield* Effect.suspend(() => handler(kind, fileId)).pipe(
          Effect.retry(retrySchedule),
          Effect.map(() => ({ kind, fileId, success: true as const })),
          Effect.catch((error) => Effect.succeed({ kind, fileId, success: false as const, error }))
        )
        if (!result.success) {
          yield* Effect.logWarning(`Transfer failed after ${config.maxRetries} retries`, result)
        }
        if (onTaskComplete) {
          yield* onTaskComplete(result).pipe(
            Effect.catch((callbackError) => Effect.logWarning("onTaskComplete callback failed", { callbackError }))
          )
        }
      })

    const forkTracked = (request: Request, scope: Scope.Scope): Effect.Effect<void> =>
      workerMutex.withPermit(Effect.uninterruptible(Effect.gen(function*() {
        const key = keyOf(request.kind, request.fileId)
        if (queued.get(key) !== request || active.has(key)) return
        if (paused) {
          yield* offer(request)
          return
        }
        // Keep the request queued until its active slot is registered.
        // Gate execution until its handle is registered. Even a synchronous
        // handler must not finalize before it owns an active slot.
        const ready = yield* Deferred.make<void>()
        const task = Deferred.await(ready).pipe(
          Effect.andThen(processTask(request)),
          Effect.interruptible,
          Effect.ensuring(Effect.gen(function*() {
            active.delete(key)
            const next = queued.get(key)
            if (next) yield* offer(next)
            yield* checkIdle
          }))
        )
        const fiber = yield* Effect.forkIn(task, scope)
        active.set(key, { request, fiber })
        if (queued.get(key) !== request) {
          yield* Fiber.interrupt(fiber)
          return
        }
        queued.delete(key)
        yield* Deferred.succeed(ready, undefined)
      })))

    const worker = (kind: TransferKind, scope: Scope.Scope): Effect.Effect<void> =>
      Effect.forever(Effect.gen(function*() {
        const limit = kind === "download" ? config.maxConcurrentDownloads : config.maxConcurrentUploads
        if (paused || countKind(kind) >= limit) {
          yield* Effect.sleep("50 millis")
          return
        }
        let next = yield* Queue.poll(kind === "download" ? priorityQueue : uploadQueue)
        if (kind === "download" && Option.isNone(next)) next = yield* Queue.poll(downloadQueue)
        if (Option.isSome(next)) {
          yield* forkTracked(next.value, scope)
        } else {
          yield* Effect.sleep("100 millis")
        }
      })).pipe(Effect.interruptible)

    const ensureWorkers = (): Effect.Effect<void, never, Scope.Scope> =>
      workerMutex.withPermit(Effect.gen(function*() {
        const scope = yield* Effect.scope
        if (!downloadWorker || downloadWorker.pollUnsafe() !== undefined) {
          downloadWorker = yield* Effect.forkIn(worker("download", scope), scope)
        }
        if (!uploadWorker || uploadWorker.pollUnsafe() !== undefined) {
          uploadWorker = yield* Effect.forkIn(worker("upload", scope), scope)
        }
      }))

    const enqueue = (kind: TransferKind, fileId: string): Effect.Effect<void> =>
      Effect.uninterruptible(Effect.gen(function*() {
        const key = keyOf(kind, fileId)
        if (queued.has(key)) return
        const request: Request = { kind, fileId, priority: false }
        queued.set(key, request)
        // An explicit enqueue during a transfer requests one subsequent run.
        // Its finalizer offers that request only after the active run exits.
        if (!active.has(key)) yield* offer(request)
      }))

    const prioritizeDownload = (fileId: string): Effect.Effect<void> =>
      Effect.uninterruptible(Effect.gen(function*() {
        const key = keyOf("download", fileId)
        const request = queued.get(key)
        if (!request || request.priority || active.has(key)) return
        request.priority = true
        yield* Queue.offer(priorityQueue, request)
      }))

    const cancelDownload = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const key = keyOf("download", fileId)
        queued.delete(key)
        const entry = active.get(key)
        if (entry) yield* Fiber.interrupt(entry.fiber)
        yield* checkIdle
      })

    const interruptInflight = (): Effect.Effect<ReadonlyArray<TransferTask>> =>
      Effect.gen(function*() {
        const entries = Array.from(active.values())
        for (const entry of entries) yield* Fiber.interrupt(entry.fiber)
        return entries.map(({ request: { fileId, kind } }) => ({ kind, fileId }))
      })

    const awaitIdle = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        const waiter = yield* Deferred.make<void>()
        // Register before checking to avoid a lost completion, and support
        // multiple callers waiting for the same batch.
        idleWaiters.add(waiter)
        yield* checkIdle
        yield* Deferred.await(waiter).pipe(Effect.ensuring(Effect.sync(() => {
          idleWaiters.delete(waiter)
        })))
      })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        paused = true
        yield* interruptInflight()
      })
    )

    return {
      hasTask: (kind, fileId) => active.has(keyOf(kind, fileId)) || queued.has(keyOf(kind, fileId)),
      enqueueDownload: (fileId) => enqueue("download", fileId),
      enqueueUpload: (fileId) => enqueue("upload", fileId),
      prioritizeDownload,
      cancelDownload,
      pause: () =>
        workerMutex.withPermit(Effect.sync(() => {
          paused = true
        })),
      resume: () =>
        Effect.sync(() => {
          paused = false
        }),
      isPaused: () => Effect.sync(() => paused),
      getInflightCount: () =>
        Effect.sync(() => ({
          downloads: countKind("download"),
          uploads: countKind("upload")
        })),
      getQueuedCount: () =>
        Effect.sync(() => ({
          downloads: Array.from(queued.values()).filter((request) => request.kind === "download").length,
          uploads: Array.from(queued.values()).filter((request) => request.kind === "upload").length
        })),
      awaitIdle,
      interruptInflight,
      start: ensureWorkers,
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
): Layer.Layer<SyncExecutor> =>
  Layer.effect(
    SyncExecutor,
    makeSyncExecutor(handler, config, onTaskComplete)
  )
