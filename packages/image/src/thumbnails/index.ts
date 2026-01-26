/**
 * @livestore-filesync/image - Thumbnails Module
 *
 * Image thumbnail generation for livestore-filesync applications.
 * Uses wasm-vips for efficient client-side image processing.
 *
 * @example
 * ```typescript
 * import { initThumbnails, resolveThumbnailUrl } from '@livestore-filesync/image/thumbnails'
 * import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 * // Initialize once
 * const dispose = initThumbnails(store, {
 *   sizes: { small: 128, medium: 256, large: 512 },
 *   fileSystem: opfsLayer(),
 *   workerUrl: new URL('./thumbnail.worker.ts', import.meta.url)
 * })
 *
 * // Get thumbnail URL
 * const url = await resolveThumbnailUrl(fileId, 'small')
 * ```
 *
 * @module
 */

// Schema
export { createThumbnailSchema, type ThumbnailSchema, type ThumbnailTables } from "./schema/index.js"

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
  ThumbnailQualitySettings,
  ThumbnailSizes,
  ThumbnailSizeState,
  ThumbnailStateDocument,
  ThumbnailWorkerRequest,
  ThumbnailWorkerResponse
} from "./types/index.js"

export { isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "./types/index.js"

// Errors
export {
  ThumbnailFileNotFoundError,
  ThumbnailGenerationError,
  ThumbnailStorageError,
  UnsupportedImageFormatError,
  VipsInitializationError,
  WorkerCommunicationError,
  WorkerTimeoutError
} from "./errors/index.js"

// Services (for advanced use cases)
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
} from "./services/index.js"

// API - Instance
export { createThumbnails, type CreateThumbnailsConfig, type ThumbnailInstance } from "./api/createThumbnails.js"

// API - Singleton
export {
  disposeThumbnails,
  getThumbnailState,
  initThumbnails,
  onThumbnailEvent,
  regenerateThumbnail,
  resolveThumbnailOrFileUrl,
  resolveThumbnailUrl,
  startThumbnails,
  stopThumbnails
} from "./api/singleton.js"

// Worker setup - for creating custom worker entry points
export { setupThumbnailWorker } from "./worker-core.js"
