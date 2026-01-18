/**
 * Canvas-based image processor implementation
 *
 * Uses Canvas API (OffscreenCanvas in workers, HTMLCanvasElement on main thread)
 * for lightweight image processing without WASM dependencies.
 *
 * Limitations:
 * - Converts all images to sRGB (no ICC profile preservation)
 * - No lossless WebP support
 * - Strips all metadata
 *
 * @module
 */

import type { BufferImageProcessor, ProcessedImage, ProcessImageOptions } from "./types.js"

/**
 * Helper to convert canvas to blob
 * Handles both OffscreenCanvas and HTMLCanvasElement
 */
async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality })
  } else {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create blob from canvas"))),
        type,
        quality
      )
    })
  }
}

/**
 * Create a canvas element (for main thread fallback)
 */
function createCanvasElement(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * Create a Canvas-based image processor
 *
 * Uses OffscreenCanvas in workers and HTMLCanvasElement on the main thread.
 * This processor is lightweight (no WASM) but has limitations:
 * - Converts all images to sRGB (no ICC profile preservation)
 * - No lossless WebP support
 * - Strips all metadata
 *
 * @returns A BufferImageProcessor using Canvas APIs
 *
 * @example
 * ```typescript
 * const processor = createCanvasProcessor()
 *
 * await processor.init()
 *
 * const result = await processor.process(imageBuffer, {
 *   maxDimension: 1500,
 *   format: 'jpeg',
 *   quality: 90
 * })
 * ```
 */
export function createCanvasProcessor(): BufferImageProcessor {
  let initialized = false

  return {
    type: "buffer",

    capabilities: {
      preservesIccProfile: false, // Canvas converts to sRGB
      supportsLossless: false, // No lossless WebP support
      preservesMetadata: false, // All metadata stripped
      supportedFormats: ["jpeg", "webp", "png"],
      runsOffMainThread: true // OffscreenCanvas works in workers
    },

    async init(): Promise<void> {
      // No initialization needed for canvas
      initialized = true
    },

    isInitialized(): boolean {
      return initialized
    },

    async process(input: ArrayBuffer, options: ProcessImageOptions): Promise<ProcessedImage> {
      // Create blob from input
      const blob = new Blob([input])
      const bitmap = await createImageBitmap(blob)

      try {
        // Calculate scale to fit within maxDimension while maintaining aspect ratio
        const scale = Math.min(options.maxDimension / bitmap.width, options.maxDimension / bitmap.height, 1)

        const width = Math.round(bitmap.width * scale)
        const height = Math.round(bitmap.height * scale)

        // Use OffscreenCanvas in worker, regular canvas on main thread
        const canvas = typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(width, height)
          : createCanvasElement(width, height)

        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
        if (!ctx) {
          throw new Error("Failed to get canvas 2D context")
        }

        // Enable high-quality image smoothing
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = "high"

        // Draw the image
        ctx.drawImage(bitmap, 0, 0, width, height)

        // Convert to output format
        const mimeType = `image/${options.format}`
        const quality = (options.quality ?? 90) / 100

        const outputBlob = await canvasToBlob(canvas, mimeType, quality)

        return {
          data: await outputBlob.arrayBuffer(),
          width,
          height,
          mimeType
        }
      } finally {
        bitmap.close()
      }
    },

    async processMultiple(
      input: ArrayBuffer,
      sizes: Record<string, number>,
      options: Omit<ProcessImageOptions, "maxDimension">
    ): Promise<Record<string, ProcessedImage>> {
      // Create blob from input once
      const blob = new Blob([input])
      const bitmap = await createImageBitmap(blob)
      const results: Record<string, ProcessedImage> = {}

      try {
        for (const [sizeName, maxDimension] of Object.entries(sizes)) {
          // Calculate scale to fit within maxDimension while maintaining aspect ratio
          const scale = Math.min(maxDimension / bitmap.width, maxDimension / bitmap.height, 1)

          const width = Math.round(bitmap.width * scale)
          const height = Math.round(bitmap.height * scale)

          // Use OffscreenCanvas in worker, regular canvas on main thread
          const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(width, height)
            : createCanvasElement(width, height)

          const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
          if (!ctx) {
            throw new Error("Failed to get canvas 2D context")
          }

          // Enable high-quality image smoothing
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = "high"

          // Draw the image
          ctx.drawImage(bitmap, 0, 0, width, height)

          // Convert to output format
          const mimeType = `image/${options.format}`
          const quality = (options.quality ?? 90) / 100

          const outputBlob = await canvasToBlob(canvas, mimeType, quality)

          results[sizeName] = {
            data: await outputBlob.arrayBuffer(),
            width,
            height,
            mimeType
          }
        }

        return results
      } finally {
        bitmap.close()
      }
    }
  }
}
