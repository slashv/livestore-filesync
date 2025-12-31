/**
 * Error types for LiveStore FileSync
 *
 * Uses Effect's Data.TaggedError for typed error handling.
 * FileSystem errors use PlatformError from @effect/platform.
 *
 * @module
 */

import { Data } from "effect"

// Re-export PlatformError for filesystem operations
export { PlatformError, SystemError, BadArgument } from "@effect/platform/Error"

/**
 * Base error for all file storage operations
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error when a file is not found in storage
 */
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string
}> {
  get message(): string {
    return `File not found: ${this.path}`
  }
}

/**
 * Error when a directory is not found
 */
export class DirectoryNotFoundError extends Data.TaggedError("DirectoryNotFoundError")<{
  readonly path: string
}> {
  get message(): string {
    return `Directory not found: ${this.path}`
  }
}

/**
 * Error when file upload fails
 */
export class UploadError extends Data.TaggedError("UploadError")<{
  readonly message: string
  readonly fileId?: string
  readonly cause?: unknown
}> {}

/**
 * Error when file download fails
 */
export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly message: string
  readonly url?: string
  readonly cause?: unknown
}> {}

/**
 * Error when file deletion fails
 */
export class DeleteError extends Data.TaggedError("DeleteError")<{
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}> {}

/**
 * Error when hashing a file fails
 */
export class HashError extends Data.TaggedError("HashError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Union type of all storage-related errors
 */
export type FileStorageError =
  | StorageError
  | FileNotFoundError
  | DirectoryNotFoundError
  | UploadError
  | DownloadError
  | DeleteError
  | HashError
