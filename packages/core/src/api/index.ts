/**
 * Promise-based API
 *
 * Simple, non-Effect API for file sync operations.
 *
 * @module
 */

// New simplified API
export {
  createFileSync,
  type CreateFileSyncConfig,
  type FileSyncInstance,
  type SyncEvent,
  type SyncFileOperationResult,
  type SyncFileRecord,
  type SyncLocalFilesState,
  type SyncLocalFileState,
  type SyncSchema,
  type SyncStore,
  type SyncTransferStatus
} from "./createFileSync.js"

// Singleton helpers
export {
  deleteFile,
  disposeFileSync,
  getFileUrl,
  initFileSync,
  type InitFileSyncConfig,
  isOnline,
  onFileSyncEvent,
  prioritizeDownload,
  readFile,
  resolveFileUrl,
  retryErrors,
  saveFile,
  setOnline,
  startFileSync,
  stopFileSync,
  triggerSync,
  updateFile
} from "./singleton.js"

// Sync status utilities
export {
  computeTotalProgress,
  createActiveTransferProgress,
  getSyncStatus,
  removeActiveTransfer,
  updateActiveTransfers
} from "./sync-status.js"
