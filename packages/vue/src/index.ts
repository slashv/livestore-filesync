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

// Schema - pre-configured file sync schema
export { fileSyncSchema } from "./schema.js"

// Re-export core types
export type {
  FileSyncInstance,
  CreateFileSyncConfig,
  SyncEvent,
  SyncFileOperationResult,
  SyncLocalFileState,
  SyncTransferStatus
} from "@livestore-filesync/core"
