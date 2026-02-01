/**
 * Image processor abstraction
 *
 * Provides a unified interface for image processing across different backends:
 * - vips: wasm-vips (high quality, ~3MB WASM, preserves ICC profiles)
 * - canvas: Canvas API (lightweight, no WASM, converts to sRGB)
 * - expo: React Native (future support)
 *
 * @module
 */

// Export types
// Import for factory function
import { createCanvasProcessor } from "./canvas.js"
import type { ImageProcessor, ImageProcessorType } from "./types.js"

export type {
  BufferImageProcessor,
  ImageProcessor,
  ImageProcessorCapabilities,
  ImageProcessorType,
  ProcessedImage,
  ProcessedImageUri,
  ProcessImageOptions,
  UriImageProcessor
} from "./types.js"

export { isBufferProcessor, isUriProcessor } from "./types.js"

// Export processor factories
export { createCanvasProcessor } from "./canvas.js"
export { createVipsProcessor, type VipsProcessorOptions } from "./vips.js"

/**
 * Options for creating an image processor
 */
export interface CreateImageProcessorOptions {
  /**
   * Vips-specific options (only used when type is 'vips')
   */
  vipsOptions?: import("./vips.js").VipsProcessorOptions
}

/**
 * Create an image processor of the specified type
 *
 * @param type - The processor type to create
 * @param options - Options for the processor
 * @returns An ImageProcessor instance
 *
 * @example
 * ```typescript
 * // Create vips processor (high quality, ~3MB WASM)
 * const vipsProcessor = createImageProcessor('vips', {
 *   vipsOptions: { locateFile: (path) => `/wasm/${path}` }
 * })
 *
 * // Create canvas processor (lightweight, no WASM)
 * const canvasProcessor = createImageProcessor('canvas')
 * ```
 */
export async function createImageProcessor(
  type: ImageProcessorType,
  options: CreateImageProcessorOptions = {}
): Promise<ImageProcessor> {
  switch (type) {
    case "vips": {
      // Dynamic import to avoid bundling wasm-vips when not used
      const { createVipsProcessor } = await import("./vips.js")
      return createVipsProcessor(options.vipsOptions)
    }
    case "canvas":
      return createCanvasProcessor()
    case "expo":
      throw new Error("Expo processor is not yet implemented. Use 'vips' or 'canvas' for now.")
    default:
      throw new Error(`Unknown processor type: ${type}`)
  }
}
