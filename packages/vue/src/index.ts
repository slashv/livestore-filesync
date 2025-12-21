/**
 * @livestore-filesync/vue
 *
 * Vue adapter for livestore-filesync
 *
 * @module
 */

// Provider
export { FileSyncProvider, type FileSyncProviderProps } from "./FileSyncProvider.js"

// Context
export { FileSyncKey, useFileSync } from "./context.js"

// Re-export core types
export type {
  FileSyncInstance,
  CreateFileSyncConfig,
  SyncEvent,
  SyncFileOperationResult,
  SyncLocalFileState,
  SyncTransferStatus
} from "@livestore-filesync/core"
