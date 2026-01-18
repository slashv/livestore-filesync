/**
 * @livestore-filesync/image
 *
 * Image processing for livestore-filesync applications.
 * Provides both image preprocessing (resize, format conversion) and thumbnail generation.
 *
 * ## Features
 *
 * - **Preprocessor**: Resize and convert images before saving (main thread)
 * - **Thumbnails**: Generate multiple thumbnail sizes in background (Web Worker)
 *
 * ## Setup
 *
 * ```bash
 * pnpm add @livestore-filesync/image wasm-vips
 * ```
 *
 * Copy the wasm-vips WASM file to your public directory:
 * ```bash
 * cp node_modules/wasm-vips/lib/vips.wasm public/
 * ```
 *
 * ## Usage
 *
 * ### Image Preprocessing
 *
 * ```typescript
 * import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'
 * import { initFileSync } from '@livestore-filesync/core'
 *
 * const imagePreprocessor = createImagePreprocessor({
 *   maxDimension: 1500,
 *   quality: 90,
 *   format: 'jpeg'
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
 *
 * ### Thumbnail Generation
 *
 * ```typescript
 * import { initThumbnails, resolveThumbnailUrl } from '@livestore-filesync/image/thumbnails'
 *
 * initThumbnails(store, {
 *   sizes: { small: 128, medium: 256, large: 512 },
 *   fileSystem: opfsLayer(),
 *   workerUrl: new URL('./thumbnail.worker.ts', import.meta.url)
 * })
 *
 * const url = await resolveThumbnailUrl(fileId, 'small')
 * ```
 *
 * @module
 */

// ============================================
// Preprocessor exports
// ============================================

export {
  createImagePreprocessor,
  createResizeOnlyPreprocessor,
  defaultImagePreprocessorOptions,
  type ImageFormat,
  type ImagePreprocessorOptions,
  type ImageProcessorBackend
} from "./preprocessor/index.js"

// ============================================
// Image Processor exports
// ============================================

export {
  createCanvasProcessor,
  createImageProcessor,
  type CreateImageProcessorOptions,
  createVipsProcessor,
  isBufferProcessor,
  isUriProcessor,
  type VipsProcessorOptions
} from "./processor/index.js"

export type {
  BufferImageProcessor,
  ImageProcessor,
  ImageProcessorCapabilities,
  ImageProcessorType,
  ProcessedImage,
  ProcessedImageUri,
  ProcessImageOptions,
  UriImageProcessor
} from "./processor/index.js"

// ============================================
// Shared vips exports
// ============================================

export { getVipsInstance, initVips, isVipsInitialized, type VipsInitOptions } from "./vips.js"

// ============================================
// Thumbnail exports
// ============================================

// Schema
export { createThumbnailSchema, type ThumbnailSchema, type ThumbnailTables } from "./thumbnails/schema/index.js"

// Types
export type {
  FileThumbnailState,
  GeneratedThumbnail,
  InitThumbnailsConfig,
  SupportedImageMimeType,
  ThumbnailEvent,
  ThumbnailFilesState,
  ThumbnailFormat,
  ThumbnailGenerateRequest,
  ThumbnailGenerateResponse,
  ThumbnailGenerationCompletedEvent,
  ThumbnailGenerationErrorEvent,
  ThumbnailGenerationStartedEvent,
  ThumbnailGenerationStatus,
  ThumbnailSizes,
  ThumbnailSizeState,
  ThumbnailStateDocument,
  ThumbnailWorkerRequest,
  ThumbnailWorkerResponse
} from "./thumbnails/types/index.js"

export { isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "./thumbnails/types/index.js"

// Errors
export {
  ThumbnailFileNotFoundError,
  ThumbnailGenerationError,
  ThumbnailStorageError,
  UnsupportedImageFormatError,
  VipsInitializationError,
  WorkerCommunicationError,
  WorkerTimeoutError
} from "./thumbnails/errors/index.js"

// Services
export {
  type FileRecord,
  type GeneratedThumbnails,
  LocalThumbnailStorage,
  LocalThumbnailStorageLive,
  type LocalThumbnailStorageService,
  makeThumbnailService,
  ThumbnailService,
  type ThumbnailServiceConfig,
  ThumbnailServiceLive,
  type ThumbnailServiceService,
  ThumbnailWorkerClient,
  ThumbnailWorkerClientLive,
  type ThumbnailWorkerClientService
} from "./thumbnails/services/index.js"

// API
export {
  createThumbnails,
  type CreateThumbnailsConfig,
  getThumbnailState,
  initThumbnails,
  onThumbnailEvent,
  regenerateThumbnail,
  resolveThumbnailOrFileUrl,
  resolveThumbnailUrl,
  startThumbnails,
  stopThumbnails,
  type ThumbnailInstance
} from "./thumbnails/index.js"
