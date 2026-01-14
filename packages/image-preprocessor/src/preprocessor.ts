/**
 * Image preprocessing using wasm-vips
 *
 * @module
 */

import type { FilePreprocessor } from "@livestore-filesync/core"
import { initVips, type VipsInitOptions } from "./vips.js"

/**
 * Output format for processed images
 */
export type ImageFormat = "jpeg" | "webp" | "png"

/**
 * Options for the image preprocessor
 */
export interface ImagePreprocessorOptions {
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
   * Custom wasm-vips initialization options.
   * Use this to specify a custom path for the WASM file.
   */
  vipsOptions?: VipsInitOptions

  /**
   * Skip processing for files below this size (in bytes).
   * Useful to avoid processing small images that don't need optimization.
   * Set to 0 to process all images.
   * @default 0
   */
  minSizeThreshold?: number
}

/**
 * Default options for the image preprocessor
 */
export const defaultImagePreprocessorOptions: Required<Omit<ImagePreprocessorOptions, "vipsOptions">> = {
  maxDimension: 1500,
  quality: 90,
  format: "jpeg",
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

/**
 * Get the vips output format string
 */
function getVipsFormat(format: ImageFormat): string {
  switch (format) {
    case "jpeg":
      return ".jpg"
    case "webp":
      return ".webp"
    case "png":
      return ".png"
  }
}

/**
 * Create an image preprocessor with the given options.
 * Uses wasm-vips for high-quality image processing.
 *
 * The preprocessor will:
 * - Resize images that exceed maxDimension (maintaining aspect ratio)
 * - Convert to the specified output format
 * - Apply the specified quality setting
 *
 * **Skip behavior:** If the image is already in the target format AND within
 * the dimension bounds, it will be returned unchanged. This prevents quality
 * degradation from repeated re-compression when files are updated.
 *
 * @param options - Preprocessor options
 * @returns A FilePreprocessor function
 *
 * @example
 * ```typescript
 * import { createImagePreprocessor } from '@livestore-filesync/image-preprocessor'
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * // Default settings: max 1500px, JPEG at 90% quality
 * const imagePreprocessor = createImagePreprocessor()
 *
 * // Custom settings
 * const customPreprocessor = createImagePreprocessor({
 *   maxDimension: 1200,
 *   quality: 85,
 *   format: 'webp'
 * })
 *
 * initFileSync(store, {
 *   fileSystem: opfsLayer(),
 *   remote: { signerBaseUrl: '/api' },
 *   options: {
 *     preprocessors: {
 *       'image/*': imagePreprocessor
 *     }
 *   }
 * })
 * ```
 */
export function createImagePreprocessor(options: ImagePreprocessorOptions = {}): FilePreprocessor {
  const {
    format = defaultImagePreprocessorOptions.format,
    maxDimension = defaultImagePreprocessorOptions.maxDimension,
    minSizeThreshold = defaultImagePreprocessorOptions.minSizeThreshold,
    quality = defaultImagePreprocessorOptions.quality,
    vipsOptions
  } = options

  const targetMimeType = getMimeType(format)

  return async (file: File): Promise<File> => {
    // Skip if below size threshold
    if (minSizeThreshold > 0 && file.size < minSizeThreshold) {
      return file
    }

    // Check if already in target format
    const isTargetFormat = file.type === targetMimeType

    // Early exit: if already target format and no resizing configured, skip entirely
    if (isTargetFormat && maxDimension === 0) {
      return file
    }

    // Initialize vips (cached after first call)
    const vips = await initVips(vipsOptions)

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer()
    const inputBuffer = new Uint8Array(arrayBuffer)

    // Load image
    const image = vips.Image.newFromBuffer(inputBuffer)

    try {
      // Check if already processed: correct format AND within dimension bounds
      // This prevents quality degradation from repeated re-compression
      const withinBounds = maxDimension === 0
        || (image.width <= maxDimension && image.height <= maxDimension)

      if (isTargetFormat && withinBounds) {
        return file
      }

      let processed = image

      // Resize if image exceeds max dimension
      if (maxDimension > 0 && (image.width > maxDimension || image.height > maxDimension)) {
        // thumbnailImage maintains aspect ratio, fits within the given dimensions
        processed = image.thumbnailImage(maxDimension, { height: maxDimension })
      }

      // Build write options based on format
      const writeOptions: Record<string, unknown> = {}
      if (format === "jpeg" || format === "webp") {
        writeOptions.Q = quality
      }

      // Export to the specified format
      const outputBuffer = processed.writeToBuffer(getVipsFormat(format), writeOptions)

      // Clean up if we created a new image
      if (processed !== image) {
        processed.delete()
      }

      // Generate new filename
      const baseName = file.name.replace(/\.[^/.]+$/, "") // Remove extension
      const newFilename = `${baseName}.${getExtension(format)}`

      // Convert to ArrayBuffer to ensure compatibility with File constructor
      const buffer = outputBuffer.buffer.slice(
        outputBuffer.byteOffset,
        outputBuffer.byteOffset + outputBuffer.byteLength
      ) as ArrayBuffer

      return new File([buffer], newFilename, { type: getMimeType(format) })
    } finally {
      image.delete()
    }
  }
}

/**
 * Create an image preprocessor that only resizes without format conversion.
 * The output format will match the input format.
 *
 * Note: This function is less efficient than createImagePreprocessor because
 * it must re-encode in the original format, which may not be optimal.
 *
 * @param maxDimension - Maximum dimension (width or height) in pixels
 * @param vipsOptions - Custom wasm-vips initialization options
 * @returns A FilePreprocessor function
 */
export function createResizeOnlyPreprocessor(
  maxDimension: number,
  vipsOptions?: VipsInitOptions
): FilePreprocessor {
  return async (file: File): Promise<File> => {
    // Initialize vips (cached after first call)
    const vips = await initVips(vipsOptions)

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer()
    const inputBuffer = new Uint8Array(arrayBuffer)

    // Load image
    const image = vips.Image.newFromBuffer(inputBuffer)

    try {
      // Skip if already within bounds
      if (image.width <= maxDimension && image.height <= maxDimension) {
        return file
      }

      // Resize maintaining aspect ratio
      const processed = image.thumbnailImage(maxDimension, { height: maxDimension })

      // Determine output format from input MIME type
      let outputFormat = ".jpg"
      if (file.type === "image/png") {
        outputFormat = ".png"
      } else if (file.type === "image/webp") {
        outputFormat = ".webp"
      } else if (file.type === "image/gif") {
        outputFormat = ".gif"
      }

      // Export in the same format
      const outputBuffer = processed.writeToBuffer(outputFormat)

      // Clean up
      processed.delete()

      // Convert to ArrayBuffer
      const buffer = outputBuffer.buffer.slice(
        outputBuffer.byteOffset,
        outputBuffer.byteOffset + outputBuffer.byteLength
      ) as ArrayBuffer

      return new File([buffer], file.name, { type: file.type })
    } finally {
      image.delete()
    }
  }
}
