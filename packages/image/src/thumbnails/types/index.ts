/**
 * TypeScript types for image-thumbnails
 *
 * Types are derived from Effect Schema definitions to ensure
 * a single source of truth.
 *
 * @module
 */

import type {
  FileThumbnailStateSchema,
  ThumbnailFilesStateSchema,
  ThumbnailGenerationStatusSchema,
  ThumbnailSchema,
  ThumbnailSizeStateSchema,
  ThumbnailStateDocumentSchema
} from "../schema/index.js"

// ============================================
// Service Configuration Types
// ============================================

import type { FileSystem } from "@effect/platform/FileSystem"
import type { Layer } from "effect"

// ============================================
// Schema-Derived Types
// ============================================

/**
 * Thumbnail generation status
 */
export type ThumbnailGenerationStatus = typeof ThumbnailGenerationStatusSchema.Type

/**
 * State for a single thumbnail size
 */
export type ThumbnailSizeState = typeof ThumbnailSizeStateSchema.Type

/**
 * State for all thumbnail sizes of a single file
 */
export type FileThumbnailState = typeof FileThumbnailStateSchema.Type

/**
 * Map of file IDs to thumbnail states
 */
export type ThumbnailFilesState = typeof ThumbnailFilesStateSchema.Type

/**
 * Root thumbnail state document
 */
export type ThumbnailStateDocument = typeof ThumbnailStateDocumentSchema.Type

/**
 * Thumbnail tables type
 */
export type ThumbnailTables = ThumbnailSchema["tables"]

// ============================================
// Configuration Types
// ============================================

/**
 * Thumbnail size configuration
 * Maps size names to max dimension (longest side in pixels)
 *
 * @example
 * ```typescript
 * const sizes: ThumbnailSizes = {
 *   small: 128,
 *   medium: 256,
 *   large: 512
 * }
 * ```
 */
export type ThumbnailSizes = Record<string, number>

/**
 * Supported thumbnail output formats
 */
export type ThumbnailFormat = "webp" | "jpeg" | "png"

/**
 * Supported input image MIME types
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff"
] as const

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number]

/**
 * Check if a MIME type is a supported image type
 */
export const isSupportedImageMimeType = (mimeType: string): mimeType is SupportedImageMimeType =>
  (SUPPORTED_IMAGE_MIME_TYPES as ReadonlyArray<string>).includes(mimeType)

// ============================================
// Worker Message Types
// ============================================

/**
 * Quality settings for thumbnail generation
 */
export interface ThumbnailQualitySettings {
  /**
   * Quality factor for lossy compression (1-100).
   * Higher values = better quality, larger files.
   * @default 90
   */
  quality?: number

  /**
   * Use lossless compression for thumbnails at or below this pixel dimension.
   * This preserves exact colors for small thumbnails where file size is negligible.
   * Set to 0 to disable lossless mode.
   * @default 200
   */
  losslessThreshold?: number

  /**
   * Keep ICC color profile in output thumbnails.
   * Preserves color accuracy for wide-gamut images.
   * @default true
   */
  keepIccProfile?: boolean
}

/**
 * Request to generate thumbnails for an image
 */
export interface ThumbnailGenerateRequest {
  type: "generate"
  id: string // Request ID for correlation
  imageData: ArrayBuffer
  fileName: string
  contentHash: string
  sizes: ThumbnailSizes
  format: ThumbnailFormat
  /**
   * Quality settings for thumbnail generation
   */
  qualitySettings?: ThumbnailQualitySettings
}

/**
 * A single generated thumbnail
 */
export interface GeneratedThumbnail {
  sizeName: string
  data: ArrayBuffer
  width: number
  height: number
  mimeType: string
}

/**
 * Successful generation response
 */
export interface ThumbnailGenerateResponse {
  type: "complete"
  id: string
  thumbnails: Array<GeneratedThumbnail>
}

/**
 * Error response from worker
 */
export interface ThumbnailErrorResponse {
  type: "error"
  id: string
  error: string
}

/**
 * Worker ready message (sent after wasm-vips initializes)
 */
export interface ThumbnailWorkerReady {
  type: "ready"
}

/**
 * All possible worker responses
 */
export type ThumbnailWorkerResponse =
  | ThumbnailGenerateResponse
  | ThumbnailErrorResponse
  | ThumbnailWorkerReady

/**
 * All possible worker requests
 */
export type ThumbnailWorkerRequest = ThumbnailGenerateRequest

/**
 * A queryDb function from the app's schema
 */
export type QueryDbFn = (query: any) => any

/**
 * Files table type (from @livestore-filesync/core)
 */
export interface FilesTable {
  select: () => any
  where: (conditions: any) => any
}

/**
 * Schema tables object that contains a files table.
 * This allows passing the entire tables object from your schema.
 */
export type TablesWithFiles = {
  readonly files: FilesTable
} & Record<string, unknown>

/**
 * Configuration for initThumbnails
 */
export interface InitThumbnailsConfig {
  /**
   * Thumbnail size configuration
   * Maps size names to max dimension (longest side in pixels)
   */
  sizes: ThumbnailSizes

  /**
   * FileSystem layer - required
   * Use @livestore-filesync/opfs for browsers or @effect/platform-node for Node
   */
  fileSystem: Layer.Layer<FileSystem>

  /**
   * Output format for thumbnails
   * @default "webp"
   */
  format?: ThumbnailFormat

  /**
   * URL to the thumbnail worker
   * Apps create their own worker file that imports the package worker
   */
  workerUrl: URL | string

  /**
   * Maximum concurrent thumbnail generations
   * @default 2
   */
  concurrency?: number

  /**
   * Supported input MIME types
   * @default All common image types
   */
  supportedMimeTypes?: Array<string>

  /**
   * Whether to start thumbnail generation automatically
   * @default true
   */
  autoStart?: boolean

  /**
   * Callback for thumbnail events
   */
  onEvent?: (event: ThumbnailEvent) => void

  /**
   * Quality settings for thumbnail generation.
   * Controls compression quality, lossless mode, and ICC profile preservation.
   */
  qualitySettings?: ThumbnailQualitySettings

  /**
   * The schema tables object containing the files table.
   * Pass your app's `tables` object here. The files table will be extracted automatically.
   * This is the recommended way to configure file scanning.
   *
   * @example
   * ```typescript
   * import { tables } from './schema'
   *
   * initThumbnails(store, {
   *   schema: { tables },
   *   // ... other config
   * })
   * ```
   */
  schema?: { tables: TablesWithFiles }

  /**
   * @deprecated Use `schema: { tables }` instead for simpler configuration.
   * The queryDb function from livestore.
   */
  queryDb?: QueryDbFn

  /**
   * @deprecated Use `schema: { tables }` instead for simpler configuration.
   * The files table from @livestore-filesync/core.
   */
  filesTable?: FilesTable
}

// ============================================
// Event Types
// ============================================

/**
 * Thumbnail generation started event
 */
export interface ThumbnailGenerationStartedEvent {
  type: "thumbnail:generation-started"
  fileId: string
  sizes: Array<string>
}

/**
 * Thumbnail generation completed event
 */
export interface ThumbnailGenerationCompletedEvent {
  type: "thumbnail:generation-completed"
  fileId: string
  sizes: Array<string>
}

/**
 * Thumbnail generation error event
 */
export interface ThumbnailGenerationErrorEvent {
  type: "thumbnail:generation-error"
  fileId: string
  error: string
}

/**
 * Thumbnail cleanup event
 */
export interface ThumbnailCleanupEvent {
  type: "thumbnail:cleanup"
  fileId: string
}

/**
 * All thumbnail events
 */
export type ThumbnailEvent =
  | ThumbnailGenerationStartedEvent
  | ThumbnailGenerationCompletedEvent
  | ThumbnailGenerationErrorEvent
  | ThumbnailCleanupEvent
