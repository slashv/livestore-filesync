/**
 * @livestore-filesync/vue
 *
 * Vue adapter for livestore-filesync
 *
 * @module
 */

// Provider
export { FileSyncProvider } from "./FileSyncProvider.js"
export { FileSyncKey, useFileSyncContext } from "./FileSyncContext.js"

// Composables
export {
  useFileSync,
  useSaveFile,
  useFileUrl,
  useFileStatus,
  useIsOnline,
  useFileExistsLocally,
  useDeleteFile
} from "./composables.js"

// Types
export type {
  FileSyncProviderConfig,
  FileSyncService,
  LocalFileState,
  LocalFilesState,
  FileSyncEvent,
  FileSyncEventCallback,
  FileSaveResult,
  RemoteStorageAdapter,
  TransferStatus
} from "./types.js"
