/**
 * FileStorage Service
 *
 * High-level file storage service that coordinates saving, updating,
 * and deleting files with automatic sync to remote storage.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { LocalFileStorage } from "../local-file-storage/index.js"
import { FileSync, FileSyncStoreTag } from "../file-sync/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import type { FileOperationResult } from "../../types/index.js"
import type { HashError, StorageError, FileNotFoundError } from "../../errors/index.js"

/**
 * Store operations for file management
 */
export interface FileStorageStore {
  /**
   * Create a new file record
   */
  readonly createFile: (params: {
    id: string
    path: string
    contentHash: string
  }) => Effect.Effect<void>

  /**
   * Update a file record
   */
  readonly updateFile: (params: {
    id: string
    path: string
    contentHash: string
  }) => Effect.Effect<void>

  /**
   * Delete a file record (soft delete)
   */
  readonly deleteFile: (id: string) => Effect.Effect<void>

  /**
   * Get a file record by ID
   */
  readonly getFile: (id: string) => Effect.Effect<{
    id: string
    path: string
    remoteUrl: string | null
    contentHash: string
  } | undefined>

  /**
   * Generate a unique file ID
   */
  readonly generateId: () => string
}

/**
 * FileStorageStore service tag
 */
export class FileStorageStoreTag extends Context.Tag("FileStorageStore")<
  FileStorageStoreTag,
  FileStorageStore
>() {}

/**
 * FileStorage service interface
 */
export interface FileStorageService {
  /**
   * Save a new file
   *
   * This will:
   * 1. Hash the file content
   * 2. Write to local OPFS storage
   * 3. Create a file record
   * 4. Queue for sync to remote
   *
   * @returns The file ID and metadata
   */
  readonly saveFile: (file: File) => Effect.Effect<FileOperationResult, HashError | StorageError>

  /**
   * Update an existing file
   *
   * This will:
   * 1. Hash the new content
   * 2. Write to local storage (new path if hash changed)
   * 3. Update file record
   * 4. Queue for sync to remote
   * 5. Clean up old local file if path changed
   *
   * @returns The updated file metadata
   */
  readonly updateFile: (fileId: string, file: File) => Effect.Effect<FileOperationResult, Error | HashError | StorageError>

  /**
   * Delete a file
   *
   * This will:
   * 1. Mark file as deleted in store
   * 2. Delete from local storage
   * 3. Delete from remote storage (async)
   */
  readonly deleteFile: (fileId: string) => Effect.Effect<void>

  /**
   * Get a file URL for display
   *
   * Returns an object URL from local storage if available,
   * otherwise returns the remote URL.
   *
   * @returns URL to the file content
   */
  readonly getFileUrl: (fileId: string) => Effect.Effect<string | null, StorageError | FileNotFoundError>
}

/**
 * FileStorage service tag
 */
export class FileStorage extends Context.Tag("FileStorage")<
  FileStorage,
  FileStorageService
>() {}

/**
 * Create the FileStorage service
 */
export const makeFileStorage = (): Effect.Effect<
  FileStorageService,
  never,
  LocalFileStorage | FileSync | FileStorageStoreTag | FileSyncStoreTag
> =>
  Effect.gen(function*() {
    const localStorage = yield* LocalFileStorage
    const fileSync = yield* FileSync
    const store = yield* FileStorageStoreTag
    const syncStore = yield* FileSyncStoreTag

    const saveFile = (file: File): Effect.Effect<FileOperationResult, HashError | StorageError> =>
      Effect.gen(function*() {
        // Generate ID
        const id = store.generateId()

        // Hash file content
        const contentHash = yield* hashFile(file)

        // Generate path from hash (content-addressable)
        const path = makeStoredPath(contentHash)

        // Write to local storage
        yield* localStorage.writeFile(path, file)

        // Create file record
        yield* store.createFile({ id, path, contentHash })

        // Mark as changed for sync
        yield* fileSync.markLocalFileChanged(id, path, contentHash)

        return { fileId: id, path, contentHash }
      })

    const updateFile = (
      fileId: string,
      file: File
    ): Effect.Effect<FileOperationResult, Error | HashError | StorageError> =>
      Effect.gen(function*() {
        // Get existing file
        const existingFile = yield* store.getFile(fileId)
        if (!existingFile) {
          return yield* Effect.fail(new Error(`File not found: ${fileId}`))
        }

        // Hash new content
        const contentHash = yield* hashFile(file)
        const path = makeStoredPath(contentHash)

        // Only update if content changed
        if (contentHash !== existingFile.contentHash) {
          // Write new file to local storage
          yield* localStorage.writeFile(path, file)

          // Update file record
          yield* store.updateFile({ id: fileId, path, contentHash })

          // Clean up old file if path changed
          if (path !== existingFile.path) {
            yield* localStorage.deleteFile(existingFile.path).pipe(
              Effect.catchAll(() => Effect.void) // Ignore errors
            )
          }

          // Mark as changed for sync
          yield* fileSync.markLocalFileChanged(fileId, path, contentHash)
        }

        return { fileId, path, contentHash }
      })

    const deleteFileOp = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Get existing file
        const existingFile = yield* store.getFile(fileId)
        if (!existingFile) {
          return // Already deleted
        }

        // Delete file record (soft delete)
        yield* store.deleteFile(fileId)

        // Delete from local storage
        yield* localStorage.deleteFile(existingFile.path).pipe(
          Effect.catchAll(() => Effect.void) // Ignore errors
        )

        // Note: Remote deletion happens via sync process
        // when it sees the file is marked as deleted
      })

    const getFileUrl = (fileId: string): Effect.Effect<string | null, StorageError | FileNotFoundError> =>
      Effect.gen(function*() {
        // Get file record
        const file = yield* store.getFile(fileId)
        if (!file) {
          return null
        }

        // Check local files state
        const localState = yield* syncStore.getLocalFilesState()
        const local = localState[fileId]

        // Try local first
        if (local?.localHash) {
          const exists = yield* localStorage.fileExists(file.path)
          if (exists) {
            return yield* localStorage.getFileUrl(file.path)
          }
        }

        // Fall back to remote URL
        return file.remoteUrl
      })

    return {
      saveFile,
      updateFile,
      deleteFile: deleteFileOp,
      getFileUrl
    }
  })

/**
 * Create a Layer for FileStorage
 */
export const FileStorageLive: Layer.Layer<
  FileStorage,
  never,
  LocalFileStorage | FileSync | FileStorageStoreTag | FileSyncStoreTag
> = Layer.effect(FileStorage, makeFileStorage())
