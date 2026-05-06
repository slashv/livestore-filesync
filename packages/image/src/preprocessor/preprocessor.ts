/**
 * Image preprocessing with configurable backend
 *
 * Supports both wasm-vips (high quality) and Canvas API (lightweight) backends.
 *
 * @module
 */

import { type FilePreprocessor, MemoryFile } from "@livestore-filesync/core"

import { createCanvasProcessor } from "../processor/canvas.js"
import type { BufferImageProcessor } from "../processor/types.js"
import { type VipsInitOptions } from "../vips.js"

/**
 * Output format for processed images
 */
export type ImageFormat = "jpeg" | "webp" | "png"

/**
 * Image processor backend type
 */
export type ImageProcessorBackend = "vips" | "canvas"

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
   * Only used when processor is 'vips'.
   */
  vipsOptions?: VipsInitOptions

  /**
   * Skip processing for files below this size (in bytes).
   * Useful to avoid processing small images that don't need optimization.
   * Set to 0 to process all images.
   * @default 0
   */
  minSizeThreshold?: number

  /**
   * Image processor backend to use.
   *
   * - 'vips': wasm-vips (high quality, ~3MB WASM, preserves ICC profiles)
   * - 'canvas': Canvas API (lightweight, no WASM, converts to sRGB)
   *
   * @default 'vips'
   */
  processor?: ImageProcessorBackend
}

/**
 * Default options for the image preprocessor
 */
export const defaultImagePreprocessorOptions: Required<Omit<ImagePreprocessorOptions, "vipsOptions">> = {
  maxDimension: 1500,
  quality: 90,
  format: "jpeg",
  minSizeThreshold: 0,
  processor: "vips"
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
 * Create an image preprocessor with the given options.
 *
 * Supports two backends:
 * - **vips** (default): wasm-vips for high-quality processing with ICC profile preservation
 * - **canvas**: Canvas API for lightweight processing without WASM
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
 * import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * // Default settings: max 1500px, JPEG at 90% quality (using vips)
 * const imagePreprocessor = createImagePreprocessor()
 *
 * // Using canvas backend (lightweight, no WASM)
 * const canvasPreprocessor = createImagePreprocessor({
 *   processor: 'canvas',
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
    processor: processorType = defaultImagePreprocessorOptions.processor,
    quality = defaultImagePreprocessorOptions.quality,
    vipsOptions
  } = options

  const targetMimeType = getMimeType(format)

  // Create the appropriate processor lazily
  let processor: BufferImageProcessor | undefined

  const getProcessor = async (): Promise<BufferImageProcessor> => {
    if (!processor) {
      if (processorType === "canvas") {
        processor = createCanvasProcessor()
      } else {
        const { createVipsProcessor } = await import("../processor/vips.js")
        processor = createVipsProcessor(vipsOptions)
      }
    }
    return processor
  }

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

    // Get or create the processor (lazy init, dynamic import for vips)
    const proc = await getProcessor()

    // Initialize processor if needed
    if (!proc.isInitialized()) {
      await proc.init()
    }

    // Process the image
    const result = await proc.process(arrayBuffer, {
      maxDimension,
      format,
      quality,
      keepIccProfile: true
    })

    // Check if the image was actually modified
    // If dimensions match and format matches, original might have been within bounds
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
    // React Native's File/Blob constructors don't properly support ArrayBuffer
    const processedFile = new MemoryFile(new Uint8Array(result.data), newFilename, result.mimeType) as unknown as File
    return {
      file: processedFile,
      metadata: getFileMetadata(processedFile, { width: result.width, height: result.height })
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
 * @param options - Optional configuration
 * @returns A FilePreprocessor function
 */
export function createResizeOnlyPreprocessor(
  maxDimension: number,
  options?: {
    vipsOptions?: VipsInitOptions
    processor?: ImageProcessorBackend
  }
): FilePreprocessor {
  const processorType = options?.processor ?? "vips"

  // Create the appropriate processor lazily
  let processor: BufferImageProcessor | undefined

  const getProcessor = async (): Promise<BufferImageProcessor> => {
    if (!processor) {
      if (processorType === "canvas") {
        processor = createCanvasProcessor()
      } else {
        const { createVipsProcessor } = await import("../processor/vips.js")
        processor = createVipsProcessor(options?.vipsOptions)
      }
    }
    return processor
  }

  return async (file: File) => {
    // Determine output format from input MIME type
    let format: "jpeg" | "webp" | "png" = "jpeg"
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

    // Get or create the processor (lazy init, dynamic import for vips)
    const proc = await getProcessor()

    // Initialize processor if needed
    if (!proc.isInitialized()) {
      await proc.init()
    }

    // Process the image
    const result = await proc.process(arrayBuffer, {
      maxDimension,
      format,
      quality: 90,
      keepIccProfile: true
    })

    // Use MemoryFile for React Native compatibility
    // React Native's File/Blob constructors don't properly support ArrayBuffer
    const processedFile = new MemoryFile(new Uint8Array(result.data), file.name, result.mimeType) as unknown as File
    return {
      file: processedFile,
      metadata: getFileMetadata(processedFile, { width: result.width, height: result.height })
    }
  }
}
