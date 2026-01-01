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
