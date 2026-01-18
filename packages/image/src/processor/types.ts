/**
 * Image processor abstraction types
 *
 * Provides a unified interface for image processing across different backends:
 * - vips: wasm-vips (high quality, ~3MB WASM, preserves ICC profiles)
 * - canvas: Canvas API (lightweight, no WASM, converts to sRGB)
 * - expo: React Native (future support)
 *
 * @module
 */

// ============================================
// Processor Types
// ============================================

/**
 * Available image processor backends
 */
export type ImageProcessorType = "vips" | "canvas" | "expo"

/**
 * Options for processing an image
 */
export interface ProcessImageOptions {
  /**
   * Maximum dimension (width or height) in pixels.
   * Images larger than this will be resized, maintaining aspect ratio.
   */
  maxDimension: number

  /**
   * Output format for the processed image
   */
  format: "jpeg" | "webp" | "png"

  /**
   * Output quality (1-100).
   * Only applies to JPEG and WebP formats.
   * @default 90
   */
  quality?: number

  /**
   * Keep ICC color profile in output.
   * Only effective for vips processor.
   * @default true
   */
  keepIccProfile?: boolean

  /**
   * Use lossless compression for images at or below this pixel dimension.
   * Only effective for vips processor with WebP format.
   * @default 0 (disabled)
   */
  losslessThreshold?: number
}

/**
 * Result of processing an image (buffer-based)
 */
export interface ProcessedImage {
  /** Processed image data */
  data: ArrayBuffer
  /** Width of the processed image */
  width: number
  /** Height of the processed image */
  height: number
  /** MIME type of the processed image */
  mimeType: string
}

/**
 * Result of processing an image (URI-based, for React Native)
 */
export interface ProcessedImageUri {
  /** file:// URI to processed image */
  uri: string
  /** Width of the processed image */
  width: number
  /** Height of the processed image */
  height: number
  /** MIME type of the processed image */
  mimeType: string
}

// ============================================
// Processor Capabilities
// ============================================

/**
 * Capabilities of an image processor
 */
export interface ImageProcessorCapabilities {
  /**
   * Whether the processor preserves ICC color profiles.
   * - vips: true (can preserve ICC profiles)
   * - canvas: false (converts to sRGB)
   * - expo: false (converts to sRGB)
   */
  preservesIccProfile: boolean

  /**
   * Whether the processor supports lossless compression.
   * - vips: true (supports lossless WebP)
   * - canvas: false (no lossless WebP support)
   * - expo: false (no lossless support)
   */
  supportsLossless: boolean

  /**
   * Whether the processor preserves image metadata.
   * - vips: true (can preserve metadata)
   * - canvas: false (strips all metadata)
   * - expo: false (strips all metadata)
   */
  preservesMetadata: boolean

  /**
   * Supported output formats
   */
  supportedFormats: ReadonlyArray<"jpeg" | "webp" | "png">

  /**
   * Whether the processor runs off the main thread.
   * - vips: true (in worker)
   * - canvas: true (OffscreenCanvas in worker)
   * - expo: true (native thread)
   */
  runsOffMainThread: boolean
}

// ============================================
// Processor Interfaces
// ============================================

/**
 * Base processor interface shared by all processor types
 */
interface BaseImageProcessor {
  /** Processor capabilities */
  readonly capabilities: ImageProcessorCapabilities

  /**
   * Initialize the processor.
   * Must be called before processing images.
   * Safe to call multiple times (idempotent).
   */
  init(): Promise<void>

  /**
   * Check if the processor is initialized
   */
  isInitialized(): boolean
}

/**
 * Buffer-based image processor (vips, canvas)
 * Used for web/Electron where images are processed as ArrayBuffers
 */
export interface BufferImageProcessor extends BaseImageProcessor {
  /** Discriminator for type narrowing */
  readonly type: "buffer"

  /**
   * Process a single image
   *
   * @param input - Input image as ArrayBuffer
   * @param options - Processing options
   * @returns Processed image with data as ArrayBuffer
   */
  process(input: ArrayBuffer, options: ProcessImageOptions): Promise<ProcessedImage>

  /**
   * Process an image into multiple sizes.
   * More efficient than calling process() multiple times because
   * the source image is only loaded once.
   *
   * @param input - Input image as ArrayBuffer
   * @param sizes - Map of size names to max dimensions
   * @param options - Processing options (excluding maxDimension)
   * @returns Map of size names to processed images
   */
  processMultiple(
    input: ArrayBuffer,
    sizes: Record<string, number>,
    options: Omit<ProcessImageOptions, "maxDimension">
  ): Promise<Record<string, ProcessedImage>>
}

/**
 * URI-based image processor (expo)
 * Used for React Native where images are processed via file URIs
 */
export interface UriImageProcessor extends BaseImageProcessor {
  /** Discriminator for type narrowing */
  readonly type: "uri"

  /**
   * Process a single image
   *
   * @param inputUri - Input image URI (file:// or content://)
   * @param options - Processing options
   * @returns Processed image with URI to result
   */
  process(inputUri: string, options: ProcessImageOptions): Promise<ProcessedImageUri>

  /**
   * Process an image into multiple sizes.
   *
   * @param inputUri - Input image URI
   * @param sizes - Map of size names to max dimensions
   * @param options - Processing options (excluding maxDimension)
   * @returns Map of size names to processed images
   */
  processMultiple(
    inputUri: string,
    sizes: Record<string, number>,
    options: Omit<ProcessImageOptions, "maxDimension">
  ): Promise<Record<string, ProcessedImageUri>>
}

/**
 * Union type for all image processors
 */
export type ImageProcessor = BufferImageProcessor | UriImageProcessor

// ============================================
// Type Guards
// ============================================

/**
 * Check if a processor is buffer-based (vips, canvas)
 */
export function isBufferProcessor(processor: ImageProcessor): processor is BufferImageProcessor {
  return processor.type === "buffer"
}

/**
 * Check if a processor is URI-based (expo)
 */
export function isUriProcessor(processor: ImageProcessor): processor is UriImageProcessor {
  return processor.type === "uri"
}
