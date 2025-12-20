/**
 * RemoteStorage service exports
 *
 * @module
 */

export {
  makeHttpRemoteStorage,
  makeRemoteStorageLive,
  RemoteStorage,
  RemoteStorageConfigTag,
  RemoteStorageLive,
  type RemoteStorageAdapter,
  type RemoteStorageConfig,
  type RemoteStorageService
} from "./RemoteStorage.js"

export {
  makeMemoryRemoteStorage,
  makeRemoteStorageMemoryWithRefs,
  type MemoryRemoteStorageOptions,
  RemoteStorageMemory
} from "./RemoteStorageMemory.js"
