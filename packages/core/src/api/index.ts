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
  type SyncStore,
  type SyncSchema,
  type SyncEvent,
  type SyncFileOperationResult,
  type SyncFileRecord,
  type SyncLocalFileState,
  type SyncLocalFilesState,
  type SyncTransferStatus
} from "./createFileSync.js"
