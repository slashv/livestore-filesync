/**
 * Vips-based image processor implementation
 *
 * Uses wasm-vips for high-quality image processing with ICC profile preservation.
 *
 * @module
 */

import type Vips from "wasm-vips"

import { initVips, type VipsInitOptions } from "../vips.js"
import type { BufferImageProcessor, ProcessedImage, ProcessImageOptions } from "./types.js"

// Type for vips instance
type VipsInstance = Awaited<ReturnType<typeof Vips>>

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
  image: VipsInstance["Image"]["prototype"],
  options: ProcessImageOptions,
  maxDimension: number
): Uint8Array => {
  const { format, keepIccProfile = true, losslessThreshold = 0, quality = 90 } = options

  // Determine if this size should be lossless
  const useLossless = losslessThreshold > 0 && maxDimension <= losslessThreshold

  // ForeignKeep flags: icc = 8
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
 * Options for creating a Vips processor
 */
export type VipsProcessorOptions = VipsInitOptions

/**
 * Create a Vips-based image processor
 *
 * @param options - Vips initialization options
 * @returns A BufferImageProcessor using wasm-vips
 *
 * @example
 * ```typescript
 * const processor = createVipsProcessor({
 *   locateFile: (path) => `/wasm/${path}`
 * })
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
export function createVipsProcessor(options: VipsProcessorOptions = {}): BufferImageProcessor {
  let vips: VipsInstance | null = null

  return {
    type: "buffer",

    capabilities: {
      preservesIccProfile: true,
      supportsLossless: true,
      preservesMetadata: true,
      supportedFormats: ["jpeg", "webp", "png"],
      runsOffMainThread: true
    },

    async init(): Promise<void> {
      if (!vips) {
        vips = await initVips(options)
      }
    },

    isInitialized(): boolean {
      return vips !== null
    },

    async process(input: ArrayBuffer, opts: ProcessImageOptions): Promise<ProcessedImage> {
      if (!vips) {
        await this.init()
      }

      const v = vips!
      const image = v.Image.newFromBuffer(new Uint8Array(input))

      try {
        // Calculate scale to fit within maxDimension while maintaining aspect ratio
        const scale = Math.min(opts.maxDimension / image.width, opts.maxDimension / image.height, 1)

        // Resize if needed
        let processed = image
        if (scale < 1) {
          processed = image.resize(scale)
        }

        try {
          const buffer = writeImageToBuffer(processed, opts, opts.maxDimension)

          return {
            data: toArrayBuffer(buffer),
            width: processed.width,
            height: processed.height,
            mimeType: `image/${opts.format}`
          }
        } finally {
          // Clean up resized image if we created one
          if (processed !== image) {
            processed.delete()
          }
        }
      } finally {
        // Clean up original image
        image.delete()
      }
    },

    async processMultiple(
      input: ArrayBuffer,
      sizes: Record<string, number>,
      opts: Omit<ProcessImageOptions, "maxDimension">
    ): Promise<Record<string, ProcessedImage>> {
      if (!vips) {
        await this.init()
      }

      const v = vips!
      const image = v.Image.newFromBuffer(new Uint8Array(input))
      const results: Record<string, ProcessedImage> = {}

      try {
        for (const [sizeName, maxDimension] of Object.entries(sizes)) {
          // Calculate scale to fit within maxDimension while maintaining aspect ratio
          const scale = Math.min(maxDimension / image.width, maxDimension / image.height, 1)

          // Create resized version if needed
          let processed = image
          if (scale < 1) {
            processed = image.resize(scale)
          }

          try {
            const buffer = writeImageToBuffer(
              processed,
              { ...opts, maxDimension } as ProcessImageOptions,
              maxDimension
            )

            results[sizeName] = {
              data: toArrayBuffer(buffer),
              width: processed.width,
              height: processed.height,
              mimeType: `image/${opts.format}`
            }
          } finally {
            // Clean up resized image if we created one
            if (processed !== image) {
              processed.delete()
            }
          }
        }

        return results
      } finally {
        // Clean up original image
        image.delete()
      }
    }
  }
}
