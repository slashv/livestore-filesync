/**
 * RemoteStorage service exports
 *
 * @module
 */

export {
  makeS3SignerRemoteStorage,
  makeRemoteStorageLive,
  RemoteStorage,
  RemoteStorageConfigTag,
  RemoteStorageLive,
  type RemoteStorageAdapter,
  type RemoteStorageConfig,
  type RemoteUploadResult,
  type RemoteStorageService
} from "./RemoteStorage.js"

export {
  makeMemoryRemoteStorage,
  makeRemoteStorageMemoryWithRefs,
  type MemoryRemoteStorageOptions,
  RemoteStorageMemory
} from "./RemoteStorageMemory.js"
