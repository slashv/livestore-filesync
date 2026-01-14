/**
 * Thumbnail Worker Entry Point
 *
 * This file should be imported by apps in their own worker file.
 * It handles thumbnail generation using wasm-vips.
 *
 * @example
 * ```typescript
 * // In your app's thumbnail.worker.ts
 * import '@livestore-filesync/image/thumbnails/worker'
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
  ThumbnailQualitySettings,
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
 * Default quality settings
 */
const DEFAULT_QUALITY_SETTINGS: Required<ThumbnailQualitySettings> = {
  quality: 90,
  losslessThreshold: 200,
  keepIccProfile: true
}

/**
 * Convert Uint8Array buffer to ArrayBuffer, handling SharedArrayBuffer
 */
const toArrayBuffer = (buffer: Uint8Array): ArrayBuffer => {
  if (buffer.buffer instanceof SharedArrayBuffer) {
    const arrayBuffer = new ArrayBuffer(buffer.byteLength)
    new Uint8Array(arrayBuffer).set(buffer)
    return arrayBuffer
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/**
 * Write image to buffer with format-specific options
 */
const writeImageToBuffer = (
  image: Awaited<ReturnType<typeof Vips>>["Image"]["prototype"],
  format: string,
  maxDim: number,
  settings: Required<ThumbnailQualitySettings>
): Uint8Array => {
  const { keepIccProfile, losslessThreshold, quality } = settings
  
  // Determine if this size should be lossless
  const useLossless = losslessThreshold > 0 && maxDim <= losslessThreshold
  
  // ForeignKeep flags: icc = 8, all = 31
  const keepFlags = keepIccProfile ? 8 : 0

  if (format === "webp") {
    return image.webpsaveBuffer({
      Q: quality,
      lossless: useLossless,
      keep: keepFlags
    })
  } else if (format === "jpeg") {
    return image.jpegsaveBuffer({
      Q: quality,
      keep: keepFlags
    })
  } else if (format === "png") {
    return image.pngsaveBuffer({
      keep: keepFlags
    })
  }
  
  // Fallback to generic writeToBuffer (won't preserve ICC)
  return image.writeToBuffer(`.${format}`)
}

/**
 * Generate thumbnails for an image
 */
const generateThumbnails = async (
  request: ThumbnailGenerateRequest
): Promise<Array<GeneratedThumbnail>> => {
  const v = await initVips()

  const { format, imageData, qualitySettings, sizes } = request
  const thumbnails: Array<GeneratedThumbnail> = []
  
  // Merge with defaults
  const settings: Required<ThumbnailQualitySettings> = {
    ...DEFAULT_QUALITY_SETTINGS,
    ...qualitySettings
  }

  // Load image from buffer
  const image = v.Image.newFromBuffer(new Uint8Array(imageData))

  try {
    for (const [sizeName, maxDim] of Object.entries(sizes)) {
      // Calculate scale to fit within maxDim while maintaining aspect ratio
      const scale = Math.min(maxDim / image.width, maxDim / image.height, 1)

      // Skip if image is already smaller than requested size
      if (scale >= 1) {
        // Still create the thumbnail at original size with quality settings
        const buffer = writeImageToBuffer(image, format, maxDim, settings)
        thumbnails.push({
          sizeName,
          data: toArrayBuffer(buffer),
          width: image.width,
          height: image.height,
          mimeType: `image/${format}`
        })
        continue
      }

      // Resize the image
      const resized = image.resize(scale)

      try {
        // Convert to output format with quality settings
        const buffer = writeImageToBuffer(resized, format, maxDim, settings)
        thumbnails.push({
          sizeName,
          data: toArrayBuffer(buffer),
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
