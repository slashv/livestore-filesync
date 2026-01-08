/**
 * RemoteStorage service exports
 *
 * @module
 */

export {
  type DownloadOptions,
  makeRemoteStorageLive,
  makeS3SignerRemoteStorage,
  RemoteStorage,
  type RemoteStorageAdapter,
  type RemoteStorageConfig,
  RemoteStorageConfigTag,
  RemoteStorageLive,
  type RemoteStorageService,
  type RemoteUploadResult,
  type TransferProgressEvent,
  type UploadOptions
} from "./RemoteStorage.js"

export {
  makeMemoryRemoteStorage,
  makeRemoteStorageMemoryWithRefs,
  type MemoryRemoteStorageOptions,
  RemoteStorageMemory
} from "./RemoteStorageMemory.js"
