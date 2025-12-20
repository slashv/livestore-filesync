/**
 * @livestore-filesync/react
 *
 * React adapter for livestore-filesync
 *
 * @module
 */

// Provider
export { FileSyncProvider } from "./FileSyncProvider.js"
export { FileSyncContext, useFileSyncContext } from "./FileSyncContext.js"

// Hooks
export {
  useFileSync,
  useSaveFile,
  useFileUrl,
  useFileStatus,
  useIsOnline,
  useFileExistsLocally,
  useDeleteFile
} from "./hooks.js"

// Types
export type {
  FileSyncProviderConfig,
  FileSyncService,
  LocalFileState,
  LocalFilesState,
  FileSyncEvent,
  FileSyncEventCallback,
  FileSaveResult
} from "./types.js"

// Re-export core utilities that are commonly needed
export {
  createFileSyncSchema,
  hashFile,
  makeStoredPath,
  makeHttpRemoteStorage,
  type RemoteStorageAdapter,
  type RemoteStorageConfig
} from "@livestore-filesync/core"
