/**
 * Thumbnail Worker Entry Point
 *
 * This file should be imported by apps in their own worker file.
 * It handles thumbnail generation using wasm-vips.
 *
 * @example
 * ```typescript
 * // In your app's thumbnail.worker.ts
 * import '@livestore-filesync/image-thumbnails/worker'
 * ```
 *
 * @module
 */

import type Vips from "wasm-vips"

import type {
  GeneratedThumbnail,
  ThumbnailErrorResponse,
  ThumbnailGenerateRequest,
  ThumbnailGenerateResponse,
  ThumbnailWorkerReady
} from "./types/index.js"

// Declare self for TypeScript in worker context
declare const self: DedicatedWorkerGlobalScope

// Vips instance - lazily initialized
let vips: Awaited<ReturnType<typeof Vips>> | null = null
let initPromise: Promise<void> | null = null

/**
 * Initialize wasm-vips
 * Only initializes once, subsequent calls return immediately
 */
const initVips = async (): Promise<Awaited<ReturnType<typeof Vips>>> => {
  if (vips) return vips

  if (!initPromise) {
    initPromise = (async () => {
      // Dynamic import to handle the WASM loading
      // wasm-vips exports the factory function in different ways depending on the bundler

      const VipsModule = await import("wasm-vips") as unknown as { default?: typeof Vips } & typeof Vips
      const VipsFactory = VipsModule.default ?? VipsModule
      vips = await VipsFactory()
    })()
  }

  await initPromise
  return vips!
}

/**
 * Generate thumbnails for an image
 */
const generateThumbnails = async (
  request: ThumbnailGenerateRequest
): Promise<Array<GeneratedThumbnail>> => {
  const v = await initVips()

  const { format, imageData, sizes } = request
  const thumbnails: Array<GeneratedThumbnail> = []

  // Load image from buffer
  const image = v.Image.newFromBuffer(new Uint8Array(imageData))

  try {
    for (const [sizeName, maxDim] of Object.entries(sizes)) {
      // Calculate scale to fit within maxDim while maintaining aspect ratio
      const scale = Math.min(maxDim / image.width, maxDim / image.height, 1)

      // Skip if image is already smaller than requested size
      if (scale >= 1) {
        // Still create the thumbnail at original size
        const buffer = image.writeToBuffer(`.${format}`)
        const arrayBuffer = buffer.buffer instanceof SharedArrayBuffer
          ? new ArrayBuffer(buffer.byteLength)
          : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
        if (buffer.buffer instanceof SharedArrayBuffer) {
          new Uint8Array(arrayBuffer).set(buffer)
        }
        thumbnails.push({
          sizeName,
          data: arrayBuffer,
          width: image.width,
          height: image.height,
          mimeType: `image/${format}`
        })
        continue
      }

      // Resize the image
      const resized = image.resize(scale)

      try {
        // Convert to output format
        const buffer = resized.writeToBuffer(`.${format}`)
        const resizedArrayBuffer = buffer.buffer instanceof SharedArrayBuffer
          ? new ArrayBuffer(buffer.byteLength)
          : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
        if (buffer.buffer instanceof SharedArrayBuffer) {
          new Uint8Array(resizedArrayBuffer).set(buffer)
        }
        thumbnails.push({
          sizeName,
          data: resizedArrayBuffer,
          width: resized.width,
          height: resized.height,
          mimeType: `image/${format}`
        })
      } finally {
        // Clean up resized image
        resized.delete()
      }
    }
  } finally {
    // Clean up original image
    image.delete()
  }

  return thumbnails
}

/**
 * Handle incoming messages
 */
self.onmessage = async (event: MessageEvent<ThumbnailGenerateRequest>) => {
  const request = event.data

  if (request.type === "generate") {
    try {
      const thumbnails = await generateThumbnails(request)

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

// Initialize vips on load and send ready message
initVips()
  .then(() => {
    const ready: ThumbnailWorkerReady = { type: "ready" }
    self.postMessage(ready)
  })
  .catch((error) => {
    console.error("[ThumbnailWorker] Failed to initialize wasm-vips:", error)
    const response: ThumbnailErrorResponse = {
      type: "error",
      id: "init",
      error: `Failed to initialize wasm-vips: ${error instanceof Error ? error.message : String(error)}`
    }
    self.postMessage(response)
  })
