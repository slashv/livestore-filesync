/**
 * ThumbnailWorkerClient Service
 *
 * Effect-based wrapper for communicating with the thumbnail worker.
 * Handles request/response correlation, timeouts, and cleanup.
 *
 * @module
 */

import { Context, Deferred, Effect, Layer, Ref } from "effect"

import type { WorkerTimeoutError } from "../errors/index.js"
import { ThumbnailGenerationError, VipsInitializationError, WorkerCommunicationError } from "../errors/index.js"
import type {
  GeneratedThumbnail,
  ThumbnailFormat,
  ThumbnailGenerateRequest,
  ThumbnailSizes,
  ThumbnailWorkerResponse
} from "../types/index.js"

// ============================================
// Service Interface
// ============================================

/**
 * Result of a thumbnail generation request
 */
export interface GeneratedThumbnails {
  thumbnails: Array<GeneratedThumbnail>
}

/**
 * ThumbnailWorkerClient service interface
 */
export interface ThumbnailWorkerClientService {
  /**
   * Generate thumbnails for an image
   */
  readonly generate: (
    imageData: ArrayBuffer,
    fileName: string,
    contentHash: string,
    sizes: ThumbnailSizes,
    format: ThumbnailFormat
  ) => Effect.Effect<
    GeneratedThumbnails,
    ThumbnailGenerationError | WorkerTimeoutError | WorkerCommunicationError
  >

  /**
   * Wait for the worker to be ready
   */
  readonly waitForReady: () => Effect.Effect<void, VipsInitializationError>

  /**
   * Check if the worker is ready
   */
  readonly isReady: () => Effect.Effect<boolean>

  /**
   * Terminate the worker
   */
  readonly terminate: () => Effect.Effect<void>
}

/**
 * ThumbnailWorkerClient service tag
 */
export class ThumbnailWorkerClient extends Context.Tag("ThumbnailWorkerClient")<
  ThumbnailWorkerClient,
  ThumbnailWorkerClientService
>() {}

// ============================================
// Implementation
// ============================================

interface PendingRequest {
  deferred: Deferred.Deferred<GeneratedThumbnails, ThumbnailGenerationError | WorkerCommunicationError>
  timeoutId: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 60000 // 60 seconds

/**
 * Create the ThumbnailWorkerClient service
 */
const make = (
  workerUrl: URL | string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Effect.Effect<ThumbnailWorkerClientService, never, never> =>
  Effect.gen(function*() {
    // Create the worker
    const worker = new Worker(workerUrl, { type: "module" })

    // Pending requests map
    const pendingRequestsRef = yield* Ref.make<Map<string, PendingRequest>>(new Map())

    // Ready state
    const readyDeferred = yield* Deferred.make<void, VipsInitializationError>()
    const isReadyRef = yield* Ref.make(false)

    // Request ID counter
    const requestIdRef = yield* Ref.make(0)

    // Message handler
    const handleMessage = (event: MessageEvent<ThumbnailWorkerResponse>) => {
      const response = event.data

      if (response.type === "ready") {
        // Worker is ready
        Effect.runSync(Ref.set(isReadyRef, true))
        Effect.runSync(Deferred.succeed(readyDeferred, undefined))
        return
      }

      if (response.type === "error" && response.id === "init") {
        // Initialization error
        Effect.runSync(
          Deferred.fail(
            readyDeferred,
            new VipsInitializationError({ message: response.error })
          )
        )
        return
      }

      // Handle request response
      Effect.runSync(
        Effect.gen(function*() {
          const pendingRequests = yield* Ref.get(pendingRequestsRef)
          const pending = pendingRequests.get(response.id)

          if (!pending) {
            // Request already timed out or was cancelled
            return
          }

          // Clear timeout
          clearTimeout(pending.timeoutId)

          // Remove from pending
          pendingRequests.delete(response.id)
          yield* Ref.set(pendingRequestsRef, pendingRequests)

          if (response.type === "complete") {
            yield* Deferred.succeed(pending.deferred, { thumbnails: response.thumbnails })
          } else if (response.type === "error") {
            yield* Deferred.fail(
              pending.deferred,
              new ThumbnailGenerationError({ message: response.error })
            )
          }
        })
      )
    }

    // Error handler
    const handleError = (event: ErrorEvent) => {
      Effect.runSync(
        Effect.gen(function*() {
          const pendingRequests = yield* Ref.get(pendingRequestsRef)

          // Fail all pending requests
          for (const [, pending] of pendingRequests) {
            clearTimeout(pending.timeoutId)
            yield* Deferred.fail(
              pending.deferred,
              new WorkerCommunicationError({
                message: `Worker error: ${event.message}`,
                cause: event.error
              })
            )
          }

          // Clear pending requests
          yield* Ref.set(pendingRequestsRef, new Map())

          // Also fail ready deferred if not yet ready
          const isReady = yield* Ref.get(isReadyRef)
          if (!isReady) {
            yield* Deferred.fail(
              readyDeferred,
              new VipsInitializationError({
                message: `Worker error during initialization: ${event.message}`,
                cause: event.error
              })
            )
          }
        })
      )
    }

    // Set up event listeners
    worker.addEventListener("message", handleMessage)
    worker.addEventListener("error", handleError)

    const generate: ThumbnailWorkerClientService["generate"] = (
      imageData,
      fileName,
      contentHash,
      sizes,
      format
    ) =>
      Effect.gen(function*() {
        // Generate unique request ID
        const id = yield* Ref.updateAndGet(requestIdRef, (n) => n + 1)
        const requestId = `req-${id}`

        // Create deferred for response
        const deferred = yield* Deferred.make<
          GeneratedThumbnails,
          ThumbnailGenerationError | WorkerCommunicationError
        >()

        // Set up timeout
        const timeoutId = setTimeout(() => {
          Effect.runSync(
            Effect.gen(function*() {
              const pendingRequests = yield* Ref.get(pendingRequestsRef)
              const pending = pendingRequests.get(requestId)

              if (pending) {
                pendingRequests.delete(requestId)
                yield* Ref.set(pendingRequestsRef, pendingRequests)
                yield* Deferred.fail(
                  pending.deferred,
                  new ThumbnailGenerationError({
                    message: `Thumbnail generation timed out after ${timeoutMs}ms`
                  })
                )
              }
            })
          )
        }, timeoutMs)

        // Add to pending requests
        const pendingRequests = yield* Ref.get(pendingRequestsRef)
        pendingRequests.set(requestId, { deferred, timeoutId })
        yield* Ref.set(pendingRequestsRef, pendingRequests)

        // Send request to worker
        const request: ThumbnailGenerateRequest = {
          type: "generate",
          id: requestId,
          imageData,
          fileName,
          contentHash,
          sizes,
          format
        }

        // Transfer the ArrayBuffer for performance
        worker.postMessage(request, [imageData])

        // Wait for response
        return yield* Deferred.await(deferred)
      })

    const waitForReady: ThumbnailWorkerClientService["waitForReady"] = () => Deferred.await(readyDeferred)

    const isReady: ThumbnailWorkerClientService["isReady"] = () => Ref.get(isReadyRef)

    const terminate: ThumbnailWorkerClientService["terminate"] = () =>
      Effect.gen(function*() {
        // Clear all pending requests
        const pendingRequests = yield* Ref.get(pendingRequestsRef)
        for (const [, pending] of pendingRequests) {
          clearTimeout(pending.timeoutId)
        }
        yield* Ref.set(pendingRequestsRef, new Map())

        // Remove event listeners
        worker.removeEventListener("message", handleMessage)
        worker.removeEventListener("error", handleError)

        // Terminate worker
        worker.terminate()
      })

    return {
      generate,
      waitForReady,
      isReady,
      terminate
    }
  })

// ============================================
// Layer
// ============================================

/**
 * Create a live layer for ThumbnailWorkerClient
 *
 * @param workerUrl - URL to the worker file
 * @param timeoutMs - Timeout for requests in milliseconds (default: 60000)
 */
export const ThumbnailWorkerClientLive = (
  workerUrl: URL | string,
  timeoutMs?: number
): Layer.Layer<ThumbnailWorkerClient> => Layer.effect(ThumbnailWorkerClient, make(workerUrl, timeoutMs))
