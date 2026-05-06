/**
 * Canvas-only image preprocessing (no wasm-vips dependency)
 *
 * This module provides image preprocessing using only the Canvas API.
 * It does not import or reference wasm-vips, making it suitable for
 * environments where you want to avoid bundling WASM.
 *
 * @module
 */

import { type FilePreprocessor, MemoryFile } from "@livestore-filesync/core"

import { createCanvasProcessor } from "../processor/canvas.js"

import type { ImageFormat } from "./preprocessor.js"

/**
 * Options for the canvas image preprocessor
 */
export interface CanvasImagePreprocessorOptions {
  /**
   * Maximum dimension (width or height) in pixels.
   * Images larger than this will be resized, maintaining aspect ratio.
   * Set to 0 or undefined to disable resizing.
   * @default 1500
   */
  maxDimension?: number

  /**
   * Output quality (1-100).
   * Only applies to JPEG and WebP formats.
   * @default 90
   */
  quality?: number

  /**
   * Output format for the processed image.
   * @default "jpeg"
   */
  format?: ImageFormat

  /**
   * Skip processing for files below this size (in bytes).
   * Useful to avoid processing small images that don't need optimization.
   * Set to 0 to process all images.
   * @default 0
   */
  minSizeThreshold?: number
}

const defaults = {
  maxDimension: 1500,
  quality: 90,
  format: "jpeg" as ImageFormat,
  minSizeThreshold: 0
}

/**
 * Get the file extension for a given format
 */
function getExtension(format: ImageFormat): string {
  switch (format) {
    case "jpeg":
      return "jpg"
    case "webp":
      return "webp"
    case "png":
      return "png"
  }
}

/**
 * Get the MIME type for a given format
 */
function getMimeType(format: ImageFormat): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "png":
      return "image/png"
  }
}

type ImageDimensions = {
  readonly width: number
  readonly height: number
}

const getFileMetadata = (
  file: File,
  dimensions?: ImageDimensions
) => ({
  ...(file.type ? { mimeType: file.type } : {}),
  sizeBytes: file.size,
  ...(dimensions ? { image: dimensions } : {})
})

const getImageDimensions = async (arrayBuffer: ArrayBuffer): Promise<ImageDimensions | undefined> => {
  if (typeof createImageBitmap !== "function") return undefined

  const bitmap = await createImageBitmap(new Blob([arrayBuffer])).catch(() => undefined)
  if (!bitmap) return undefined

  try {
    return {
      width: bitmap.width,
      height: bitmap.height
    }
  } finally {
    bitmap.close()
  }
}

/**
 * Create a canvas-based image preprocessor.
 *
 * This is a lightweight alternative to `createImagePreprocessor` that uses
 * only the Canvas API — no wasm-vips or WASM files are imported or bundled.
 *
 * Limitations compared to the vips backend:
 * - Converts all images to sRGB (no ICC profile preservation)
 * - No lossless WebP support
 * - Strips all metadata
 *
 * @param options - Preprocessor options
 * @returns A FilePreprocessor function
 *
 * @example
 * ```typescript
 * import { createCanvasImagePreprocessor } from '@livestore-filesync/image/preprocessor/canvas'
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * initFileSync(store, {
 *   fileSystem: opfsLayer(),
 *   remote: { signerBaseUrl: '/api' },
 *   options: {
 *     preprocessors: {
 *       'image/*': createCanvasImagePreprocessor({
 *         maxDimension: 1500,
 *         quality: 85,
 *         format: 'jpeg'
 *       })
 *     }
 *   }
 * })
 * ```
 */
export function createCanvasImagePreprocessor(options: CanvasImagePreprocessorOptions = {}): FilePreprocessor {
  const {
    format = defaults.format,
    maxDimension = defaults.maxDimension,
    minSizeThreshold = defaults.minSizeThreshold,
    quality = defaults.quality
  } = options

  const targetMimeType = getMimeType(format)
  const processor = createCanvasProcessor()

  return async (file: File) => {
    const arrayBuffer = await file.arrayBuffer()

    // Skip if below size threshold
    if (minSizeThreshold > 0 && file.size < minSizeThreshold) {
      return {
        file,
        metadata: getFileMetadata(file, await getImageDimensions(arrayBuffer))
      }
    }

    // Check if already in target format
    const isTargetFormat = file.type === targetMimeType

    // Early exit: if already target format and no resizing configured, skip entirely
    if (isTargetFormat && maxDimension === 0) {
      return {
        file,
        metadata: getFileMetadata(file, await getImageDimensions(arrayBuffer))
      }
    }

    // Initialize processor if needed
    if (!processor.isInitialized()) {
      await processor.init()
    }

    // Process the image
    const result = await processor.process(arrayBuffer, {
      maxDimension,
      format,
      quality,
      keepIccProfile: true
    })

    // Check if the image was actually modified
    const dimensions = await getImageDimensions(arrayBuffer)
    const originalWidth = dimensions?.width ?? result.width
    const originalHeight = dimensions?.height ?? result.height

    // If already in target format and within bounds, return original
    const withinBounds = maxDimension === 0 || (originalWidth <= maxDimension && originalHeight <= maxDimension)
    if (isTargetFormat && withinBounds) {
      return {
        file,
        metadata: getFileMetadata(file, { width: originalWidth, height: originalHeight })
      }
    }

    // Generate new filename
    const baseName = file.name.replace(/\.[^/.]+$/, "") // Remove extension
    const newFilename = `${baseName}.${getExtension(format)}`

    // Use MemoryFile for React Native compatibility
    const processedFile = new MemoryFile(new Uint8Array(result.data), newFilename, result.mimeType) as unknown as File
    return {
      file: processedFile,
      metadata: getFileMetadata(processedFile, { width: result.width, height: result.height })
    }
  }
}

/**
 * Create a canvas-based resize-only preprocessor.
 * The output format will match the input format.
 *
 * @param maxDimension - Maximum dimension (width or height) in pixels
 * @returns A FilePreprocessor function
 */
export function createCanvasResizeOnlyPreprocessor(maxDimension: number): FilePreprocessor {
  const processor = createCanvasProcessor()

  return async (file: File) => {
    // Determine output format from input MIME type
    let format: ImageFormat = "jpeg"
    if (file.type === "image/png") {
      format = "png"
    } else if (file.type === "image/webp") {
      format = "webp"
    }

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer()

    // Check dimensions first
    const dimensions = await getImageDimensions(arrayBuffer)
    const width = dimensions?.width ?? 0
    const height = dimensions?.height ?? 0

    // Skip if already within bounds
    if (dimensions && width <= maxDimension && height <= maxDimension) {
      return {
        file,
        metadata: getFileMetadata(file, dimensions)
      }
    }

    // Initialize processor if needed
    if (!processor.isInitialized()) {
      await processor.init()
    }

    // Process the image
    const result = await processor.process(arrayBuffer, {
      maxDimension,
      format,
      quality: 90,
      keepIccProfile: true
    })

    const processedFile = new MemoryFile(new Uint8Array(result.data), file.name, result.mimeType) as unknown as File
    return {
      file: processedFile,
      metadata: getFileMetadata(processedFile, { width: result.width, height: result.height })
    }
  }
}
