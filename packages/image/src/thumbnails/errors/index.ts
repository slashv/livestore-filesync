/**
 * Error types for image-thumbnails
 *
 * @module
 */

import { Data } from "effect"

/**
 * Error during thumbnail generation
 */
export class ThumbnailGenerationError extends Data.TaggedError("ThumbnailGenerationError")<{
  readonly message: string
  readonly fileId?: string
  readonly cause?: unknown
}> {}

/**
 * Error initializing wasm-vips in worker
 */
export class VipsInitializationError extends Data.TaggedError("VipsInitializationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error communicating with worker
 */
export class WorkerCommunicationError extends Data.TaggedError("WorkerCommunicationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Worker timed out
 */
export class WorkerTimeoutError extends Data.TaggedError("WorkerTimeoutError")<{
  readonly message: string
  readonly requestId: string
  readonly timeoutMs: number
}> {}

/**
 * File not found in local storage
 */
export class ThumbnailFileNotFoundError extends Data.TaggedError("ThumbnailFileNotFoundError")<{
  readonly path: string
}> {}

/**
 * Unsupported image format
 */
export class UnsupportedImageFormatError extends Data.TaggedError("UnsupportedImageFormatError")<{
  readonly mimeType: string
  readonly fileId: string
}> {}

/**
 * Thumbnail storage error
 */
export class ThumbnailStorageError extends Data.TaggedError("ThumbnailStorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
