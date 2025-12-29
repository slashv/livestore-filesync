/**
 * Core types for LiveStore FileSync
 *
 * @module
 */

import type { TransferStatus } from "../services/sync-executor/index.js"

/**
 * File record stored in the files table (synced across clients)
 */
export interface FileRecord {
  readonly id: string
  readonly path: string
  readonly remoteKey: string
  readonly contentHash: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly deletedAt: Date | null
}

/**
 * Local file state for sync tracking (client-only, not synced to server)
 */
export interface LocalFileState {
  readonly path: string
  readonly localHash: string
  readonly downloadStatus: TransferStatus
  readonly uploadStatus: TransferStatus
  readonly lastSyncError: string
}

/**
 * Map of file IDs to local file states
 */
export type LocalFilesState = Record<string, LocalFileState>

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

export type { TransferStatus } from "../services/sync-executor/index.js"

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
