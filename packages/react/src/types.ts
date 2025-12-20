/**
 * React adapter types
 *
 * @module
 */

import type {
  RemoteStorageAdapter,
  TransferStatus
} from "@livestore-filesync/core"

/**
 * Local file state for tracking sync status
 */
export interface LocalFileState {
  path: string
  localHash: string
  downloadStatus: TransferStatus
  uploadStatus: TransferStatus
  lastSyncError: string
}

/**
 * Map of file IDs to local file states
 */
export type LocalFilesState = Record<string, LocalFileState>

/**
 * File sync event types
 */
export type FileSyncEvent =
  | { type: "download:start"; fileId: string }
  | { type: "download:progress"; fileId: string; loaded: number; total: number }
  | { type: "download:complete"; fileId: string }
  | { type: "download:error"; fileId: string; error: unknown }
  | { type: "upload:start"; fileId: string }
  | { type: "upload:progress"; fileId: string; loaded: number; total: number }
  | { type: "upload:complete"; fileId: string }
  | { type: "upload:error"; fileId: string; error: unknown }
  | { type: "online" }
  | { type: "offline" }

/**
 * Callback for file sync events
 */
export type FileSyncEventCallback = (event: FileSyncEvent) => void

/**
 * Configuration for the FileSyncProvider
 */
export interface FileSyncProviderConfig {
  /**
   * Remote storage adapter for uploading/downloading files
   */
  remoteAdapter: RemoteStorageAdapter

  /**
   * Max concurrent downloads (default: 2)
   */
  maxConcurrentDownloads?: number

  /**
   * Max concurrent uploads (default: 2)
   */
  maxConcurrentUploads?: number

  /**
   * Callback for sync events
   */
  onEvent?: FileSyncEventCallback
}

/**
 * Result of a file save operation
 */
export interface FileSaveResult {
  fileId: string
  path: string
  contentHash: string
}

/**
 * Promise-based local file storage interface for React
 */
export interface LocalStorageService {
  writeFile: (path: string, file: File) => Promise<void>
  writeBytes: (path: string, data: Uint8Array, mimeType?: string) => Promise<void>
  readFile: (path: string) => Promise<File>
  readBytes: (path: string) => Promise<Uint8Array>
  fileExists: (path: string) => Promise<boolean>
  deleteFile: (path: string) => Promise<void>
  getFileUrl: (path: string) => Promise<string>
  listFiles: (directory: string) => Promise<string[]>
  getRoot: () => Promise<FileSystemDirectoryHandle>
  ensureDirectory: (path: string) => Promise<void>
}

/**
 * File sync service interface exposed via context
 */
export interface FileSyncService {
  /**
   * Save a file locally and queue for upload
   */
  saveFile: (file: File) => Promise<FileSaveResult>

  /**
   * Delete a file (soft delete)
   */
  deleteFile: (fileId: string) => Promise<void>

  /**
   * Get a URL for a file (local blob URL if available, otherwise remote URL)
   */
  getFileUrl: (fileId: string) => Promise<string | null>

  /**
   * Check if a file exists locally
   */
  fileExistsLocally: (fileId: string) => Promise<boolean>

  /**
   * Get the current sync status of a file
   */
  getFileStatus: (fileId: string) => LocalFileState | undefined

  /**
   * Check if the service is online
   */
  isOnline: () => boolean

  /**
   * Manually trigger a sync check
   */
  triggerSync: () => void

  /**
   * Get the local storage service for direct access (Promise-based)
   */
  localStorage: LocalStorageService
}

// Re-export types from core that are commonly needed
export type { RemoteStorageAdapter, TransferStatus }
