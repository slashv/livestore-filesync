/**
 * Shared worker core logic for thumbnail generation
 *
 * This module provides the shared setup logic for thumbnail workers.
 * It handles message passing, initialization, and error handling,
 * allowing different processor implementations to be used.
 *
 * @module
 */

import type { BufferImageProcessor, ProcessImageOptions } from "../processor/types.js"
import type {
  GeneratedThumbnail,
  ThumbnailErrorResponse,
  ThumbnailGenerateRequest,
  ThumbnailGenerateResponse,
  ThumbnailWorkerReady
} from "./types/index.js"

// Declare self for TypeScript in worker context
declare const self: DedicatedWorkerGlobalScope

/**
 * Setup a thumbnail worker with the given image processor
 *
 * This function initializes the processor and sets up message handling
 * for thumbnail generation requests.
 *
 * @param processor - A BufferImageProcessor to use for thumbnail generation
 *
 * @example
 * ```typescript
 * // In vips.worker.ts
 * import { createVipsProcessor } from '../processor/vips.js'
 * import { setupThumbnailWorker } from './worker-core.js'
 *
 * setupThumbnailWorker(createVipsProcessor())
 * ```
 *
 * @example
 * ```typescript
 * // In canvas.worker.ts
 * import { createCanvasProcessor } from '../processor/canvas.js'
 * import { setupThumbnailWorker } from './worker-core.js'
 *
 * setupThumbnailWorker(createCanvasProcessor())
 * ```
 */
export function setupThumbnailWorker(processor: BufferImageProcessor): void {
  // Initialize processor and signal ready
  processor
    .init()
    .then(() => {
      const ready: ThumbnailWorkerReady = { type: "ready" }
      self.postMessage(ready)
    })
    .catch((error) => {
      console.error("[ThumbnailWorker] Failed to initialize image processor:", error)
      const response: ThumbnailErrorResponse = {
        type: "error",
        id: "init",
        error: `Failed to initialize image processor: ${error instanceof Error ? error.message : String(error)}`
      }
      self.postMessage(response)
    })

  // Handle generation requests
  self.onmessage = async (event: MessageEvent<ThumbnailGenerateRequest>) => {
    const request = event.data

    if (request.type === "generate") {
      try {
        // Build options, only including defined values
        const options: Omit<ProcessImageOptions, "maxDimension"> = {
          format: request.format
        }
        if (request.qualitySettings?.quality !== undefined) {
          options.quality = request.qualitySettings.quality
        }
        if (request.qualitySettings?.keepIccProfile !== undefined) {
          options.keepIccProfile = request.qualitySettings.keepIccProfile
        }
        if (request.qualitySettings?.losslessThreshold !== undefined) {
          options.losslessThreshold = request.qualitySettings.losslessThreshold
        }

        // Use processMultiple for efficient batch processing
        const results = await processor.processMultiple(request.imageData, request.sizes, options)

        // Convert to the expected thumbnail format
        const thumbnails: Array<GeneratedThumbnail> = Object.entries(results).map(([sizeName, result]) => ({
          sizeName,
          data: result.data,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType
        }))

        const response: ThumbnailGenerateResponse = {
          type: "complete",
          id: request.id,
          thumbnails
        }

        // Transfer ArrayBuffers for performance
        const transferables = thumbnails.map((t) => t.data)
        self.postMessage(response, transferables)
      } catch (error) {
        const response: ThumbnailErrorResponse = {
          type: "error",
          id: request.id,
          error: error instanceof Error ? error.message : String(error)
        }
        self.postMessage(response)
      }
    }
  }
}
