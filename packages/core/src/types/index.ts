/**
 * Core types for LiveStore FileSync
 *
 * Types related to LiveStore schema are derived from Effect Schema definitions
 * in schema/index.ts to ensure a single source of truth.
 *
 * This module imports the schemas and exports both readonly and mutable
 * type variants as needed.
 *
 * @module
 */

import type { Schema } from "@livestore/livestore"
import type {
  FileCreatedPayloadSchema,
  FileDeletedPayloadSchema,
  FileSyncCursorSchema,
  FileSyncTables,
  FileUpdatedPayloadSchema,
  LocalFilesStateSchema,
  LocalFileStateRowSchema,
  LocalFileStateSchema,
  TransferStatusSchema
} from "../schema/index.js"

// ============================================
// Types derived from Effect Schema
// ============================================

/**
 * Transfer status - tracks the state of file uploads/downloads
 */
export type TransferStatus = typeof TransferStatusSchema.Type

/**
 * Local file state - tracks sync status for a single file (readonly)
 */
export type LocalFileState = typeof LocalFileStateSchema.Type

/**
 * Local file state - mutable variant for internal sync operations
 */
export type LocalFileStateMutable = Schema.Schema.Type<ReturnType<typeof Schema.mutable<typeof LocalFileStateSchema>>>

/**
 * Local file state row - includes fileId, used for SQLite table operations
 */
export type LocalFileStateRow = typeof LocalFileStateRowSchema.Type

/**
 * Wider type for local file state that accepts both strongly-typed LocalFileState
 * and raw table rows (where status fields are plain strings).
 * Used by getFileDisplayState to accept query results directly.
 */
export interface LocalFileStateLike {
  readonly localHash?: string
  readonly uploadStatus?: string
  readonly downloadStatus?: string
  readonly lastSyncError?: string
  readonly [key: string]: unknown
}

/**
 * Map of file IDs to local file states (readonly)
 */
export type LocalFilesState = typeof LocalFilesStateSchema.Type

/**
 * File sync cursor document (readonly)
 */
export type FileSyncCursor = typeof FileSyncCursorSchema.Type

/**
 * Map of file IDs to local file states - mutable variant for internal sync operations
 */
export type LocalFilesStateMutable = Schema.Schema.Type<ReturnType<typeof Schema.mutable<typeof LocalFilesStateSchema>>>

/**
 * File record stored in the files table (synced across clients)
 * Derived from the files table schema
 */
export type FileRecord = FileSyncTables["files"]["rowSchema"]["Type"]

/**
 * File created event payload
 */
export type FileCreatedPayload = typeof FileCreatedPayloadSchema.Type

/**
 * File updated event payload
 */
export type FileUpdatedPayload = typeof FileUpdatedPayloadSchema.Type

/**
 * File deleted event payload
 */
export type FileDeletedPayload = typeof FileDeletedPayloadSchema.Type

// ============================================
// Application-level types (not part of LiveStore schema)
// ============================================

/**
 * Progress information for file transfers
 */
export interface TransferProgress {
  readonly kind: "upload" | "download"
  readonly fileId: string
  readonly status: TransferStatus
  readonly loaded: number
  readonly total: number
}

/**
 * File sync event types
 */
export type FileSyncEvent =
  | { readonly type: "sync:start" }
  | { readonly type: "sync:complete" }
  | { readonly type: "sync:error"; readonly error: unknown; readonly context?: string }
  | { readonly type: "sync:stream-error"; readonly error: unknown; readonly attempt?: number }
  | { readonly type: "sync:stream-exhausted"; readonly error: unknown; readonly attempts: number }
  | { readonly type: "sync:recovery"; readonly from: "stream-error" | "error-retry" }
  | { readonly type: "sync:heartbeat-recovery"; readonly reason: "stream-dead" | "stuck-queue" | "stream-stalled" }
  | { readonly type: "sync:error-retry-start"; readonly fileIds: ReadonlyArray<string> }
  | { readonly type: "download:start"; readonly fileId: string }
  | { readonly type: "download:progress"; readonly fileId: string; readonly progress: TransferProgress }
  | { readonly type: "download:complete"; readonly fileId: string }
  | { readonly type: "download:error"; readonly fileId: string; readonly error: unknown }
  | { readonly type: "upload:start"; readonly fileId: string }
  | { readonly type: "upload:progress"; readonly fileId: string; readonly progress: TransferProgress }
  | { readonly type: "upload:complete"; readonly fileId: string }
  | { readonly type: "upload:error"; readonly fileId: string; readonly error: unknown }
  | {
    readonly type: "transfer:exhausted"
    readonly kind: "upload" | "download"
    readonly fileId: string
    readonly error: unknown
  }
  | { readonly type: "online" }
  | { readonly type: "offline" }

/**
 * Callback for file sync events
 */
export type FileSyncEventCallback = (event: FileSyncEvent) => void

/**
 * Options for creating a new file
 */
export interface CreateFileOptions {
  readonly file: File
}

/**
 * Options for updating a file
 */
export interface UpdateFileOptions {
  readonly fileId: string
  readonly file: File
}

/**
 * Result of a file operation
 */
export interface FileOperationResult {
  readonly fileId: string
  readonly path: string
  readonly contentHash: string
}

// ============================================
// Sync Status Types
// ============================================

/**
 * A file sync error with the file ID and error message
 */
export interface SyncError {
  readonly fileId: string
  readonly error: string
}

/**
 * Aggregate sync status derived from LocalFilesState
 *
 * This provides a summary of all file sync operations in progress,
 * queued, pending, or errored. Use with `getSyncStatus()` to compute
 * from the localFileState client document.
 */
export interface SyncStatus {
  /** Count of files currently uploading (status: "inProgress") */
  readonly uploadingCount: number
  /** Count of files currently downloading (status: "inProgress") */
  readonly downloadingCount: number
  /** Count of files queued for upload */
  readonly queuedUploadCount: number
  /** Count of files queued for download */
  readonly queuedDownloadCount: number
  /** Count of files pending upload (waiting to be queued) */
  readonly pendingUploadCount: number
  /** Count of files pending download (waiting to be queued) */
  readonly pendingDownloadCount: number
  /** Count of files with sync errors */
  readonly errorCount: number

  /** Whether any sync operation is active (uploading or downloading) */
  readonly isSyncing: boolean
  /** Whether any files are pending or queued (not yet completed) */
  readonly hasPending: boolean

  /** File IDs currently uploading */
  readonly uploadingFileIds: ReadonlyArray<string>
  /** File IDs currently downloading */
  readonly downloadingFileIds: ReadonlyArray<string>
  /** File IDs queued for upload */
  readonly queuedUploadFileIds: ReadonlyArray<string>
  /** File IDs queued for download */
  readonly queuedDownloadFileIds: ReadonlyArray<string>
  /** File IDs pending upload (waiting to be queued) */
  readonly pendingUploadFileIds: ReadonlyArray<string>
  /** File IDs pending download (waiting to be queued) */
  readonly pendingDownloadFileIds: ReadonlyArray<string>
  /** Files with sync errors and their error messages */
  readonly errors: ReadonlyArray<SyncError>
}

// ============================================
// Transfer Progress Types
// ============================================

/**
 * Active transfer progress for a single file
 * This tracks the byte-level progress of an ongoing upload or download.
 */
export interface ActiveTransferProgress {
  /** File ID being transferred */
  readonly fileId: string
  /** Whether this is an upload or download */
  readonly kind: "upload" | "download"
  /** Bytes transferred so far */
  readonly loaded: number
  /** Total bytes to transfer (may be 0 if unknown) */
  readonly total: number
  /** Progress percentage (0-100), or null if total is unknown */
  readonly percent: number | null
}

/**
 * Map of file IDs to their active transfer progress
 */
export type ActiveTransfers = Readonly<Record<string, ActiveTransferProgress>>

// ============================================
// File Preprocessor Types
// ============================================

/**
 * A file preprocessor transforms a file before it's saved.
 * Returns the transformed file (or the original if no transformation needed).
 *
 * @example
 * ```typescript
 * const resizeImage: FilePreprocessor = async (file) => {
 *   // Transform the file...
 *   return transformedFile
 * }
 * ```
 */
export type FilePreprocessor = (file: File) => Promise<File>

/**
 * Map of MIME type patterns to preprocessor functions.
 * Patterns support wildcards: 'image/*' matches 'image/png', 'image/jpeg', etc.
 *
 * Pattern matching rules:
 * - Exact match: 'image/png' matches only 'image/png'
 * - Wildcard subtype: 'image/*' matches 'image/png', 'image/jpeg', etc.
 * - Universal wildcard: '*' or '*\/*' matches any MIME type
 *
 * @example
 * ```typescript
 * const preprocessors: PreprocessorMap = {
 *   'image/*': async (file) => resizeImage(file, { maxDimension: 1500 }),
 *   'video/mp4': async (file) => compressVideo(file)
 * }
 * ```
 */
export type PreprocessorMap = Record<string, FilePreprocessor>

// ============================================
// Display State Utilities
// ============================================

/**
 * Display state for a file, combining synced file record with local state
 *
 * This provides the information needed to correctly render a file in the UI,
 * accounting for whether the file is available locally, remotely, or still uploading.
 */
export interface FileDisplayState {
  /** The file record from the synced files table */
  readonly file: FileRecord
  /** Local file state for this client (may be undefined if no local state exists) */
  readonly localState: LocalFileState | undefined
  /** True if file can be displayed (available locally or remotely) */
  readonly canDisplay: boolean
  /** True if file exists in local storage (OPFS) */
  readonly hasLocalCopy: boolean
  /** True if file has been uploaded to remote storage */
  readonly isUploaded: boolean
  /** True if upload is actively in progress (status: "inProgress") */
  readonly isUploading: boolean
  /** True if download is actively in progress (status: "inProgress") */
  readonly isDownloading: boolean
  /** True if upload is queued waiting to start (status: "queued") */
  readonly isUploadQueued: boolean
  /** True if download is queued waiting to start (status: "queued") */
  readonly isDownloadQueued: boolean
}

/**
 * Get the display state for a file
 *
 * This utility combines a file record with its local state to determine
 * whether the file can be displayed and its current sync status.
 *
 * Use this to implement correct UI patterns:
 * - Show the file immediately if `canDisplay` is true
 * - Show a placeholder/spinner if `canDisplay` is false
 * - Show upload progress if `isUploading` is true
 * - Show download progress if `isDownloading` is true
 *
 * @example
 * ```typescript
 * // In a React component — query per-file for targeted reactivity
 * import { queryDb } from '@livestore/livestore'
 *
 * const localState = store.useQuery(
 *   queryDb(tables.localFileState.where({ fileId: file.id }).first())
 * )
 * const displayState = getFileDisplayState(file, localState)
 *
 * return displayState.canDisplay
 *   ? <img src={`/${file.path}`} />
 *   : <Placeholder />
 * ```
 *
 * @param file - The file record from the files table
 * @param localFileState - The local file state for this file (query result row, or undefined if not found)
 * @returns The display state for the file
 */
export function getFileDisplayState(
  file: FileRecord,
  localFileState?: LocalFileStateLike
): FileDisplayState {
  // hasLocalCopy is true only if local hash matches the file's content hash
  // This ensures we have the correct version of the file locally
  const hasLocalCopy = !!localFileState?.localHash && localFileState.localHash === file.contentHash
  const isUploaded = file.remoteKey !== ""
  const isUploading = localFileState?.uploadStatus === "inProgress"
  const isDownloading = localFileState?.downloadStatus === "inProgress"
  const isUploadQueued = localFileState?.uploadStatus === "queued"
  const isDownloadQueued = localFileState?.downloadStatus === "queued"

  return {
    file,
    localState: localFileState as LocalFileState | undefined,
    canDisplay: hasLocalCopy || isUploaded,
    hasLocalCopy,
    isUploaded,
    isUploading,
    isDownloading,
    isUploadQueued,
    isDownloadQueued
  }
}
