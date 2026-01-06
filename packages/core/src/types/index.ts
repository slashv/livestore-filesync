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

import { Schema } from "@livestore/livestore"
import {
  TransferStatusSchema,
  LocalFileStateSchema,
  LocalFilesStateSchema,
  FileCreatedPayloadSchema,
  FileUpdatedPayloadSchema,
  FileDeletedPayloadSchema,
  type FileSyncTables
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
const LocalFileStateMutableSchema = Schema.mutable(LocalFileStateSchema)
export type LocalFileStateMutable = typeof LocalFileStateMutableSchema.Type

/**
 * Map of file IDs to local file states (readonly)
 */
export type LocalFilesState = typeof LocalFilesStateSchema.Type

/**
 * Map of file IDs to local file states - mutable variant for internal sync operations
 */
const LocalFilesStateMutableSchema = Schema.mutable(LocalFilesStateSchema)
export type LocalFilesStateMutable = typeof LocalFilesStateMutableSchema.Type

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
  | { readonly type: "download:start"; readonly fileId: string }
  | { readonly type: "download:progress"; readonly fileId: string; readonly progress: TransferProgress }
  | { readonly type: "download:complete"; readonly fileId: string }
  | { readonly type: "download:error"; readonly fileId: string; readonly error: unknown }
  | { readonly type: "upload:start"; readonly fileId: string }
  | { readonly type: "upload:progress"; readonly fileId: string; readonly progress: TransferProgress }
  | { readonly type: "upload:complete"; readonly fileId: string }
  | { readonly type: "upload:error"; readonly fileId: string; readonly error: unknown }
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
  readonly uploadingFileIds: readonly string[]
  /** File IDs currently downloading */
  readonly downloadingFileIds: readonly string[]
  /** File IDs queued for upload */
  readonly queuedUploadFileIds: readonly string[]
  /** File IDs queued for download */
  readonly queuedDownloadFileIds: readonly string[]
  /** File IDs pending upload (waiting to be queued) */
  readonly pendingUploadFileIds: readonly string[]
  /** File IDs pending download (waiting to be queued) */
  readonly pendingDownloadFileIds: readonly string[]
  /** Files with sync errors and their error messages */
  readonly errors: readonly SyncError[]
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
  /** True if upload is currently in progress or queued */
  readonly isUploading: boolean
  /** True if download is currently in progress or queued */
  readonly isDownloading: boolean
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
 * // In a React component
 * const [localFileState] = store.useClientDocument(tables.localFileState)
 * const displayState = getFileDisplayState(file, localFileState?.localFiles ?? {})
 *
 * return displayState.canDisplay
 *   ? <img src={`/${file.path}`} />
 *   : <Placeholder />
 * ```
 *
 * @param file - The file record from the files table
 * @param localFilesState - The local files state map from the client document
 * @returns The display state for the file
 */
export function getFileDisplayState(
  file: FileRecord,
  localFilesState: LocalFilesState
): FileDisplayState {
  const localState = localFilesState[file.id]
  // hasLocalCopy is true only if local hash matches the file's content hash
  // This ensures we have the correct version of the file locally
  const hasLocalCopy = !!localState?.localHash && localState.localHash === file.contentHash
  const isUploaded = file.remoteKey !== ""
  const isUploading =
    localState?.uploadStatus === "inProgress" ||
    localState?.uploadStatus === "queued"
  const isDownloading =
    localState?.downloadStatus === "inProgress" ||
    localState?.downloadStatus === "queued"

  return {
    file,
    localState,
    canDisplay: hasLocalCopy || isUploaded,
    hasLocalCopy,
    isUploaded,
    isUploading,
    isDownloading
  }
}
