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
import { RemoteStorage } from "../remote-file-storage/index.js"
import { FileSync } from "../file-sync/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import type { LiveStoreDeps } from "../../livestore/types.js"
import type { FileOperationResult, FileRecord, LocalFilesState } from "../../types/index.js"
import { StorageError } from "../../errors/index.js"
import type { HashError, FileNotFoundError } from "../../errors/index.js"

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
>() { }

/**
 * Create the FileStorage service
 */
const isNode = (): boolean => typeof process !== "undefined" && !!process.versions?.node

const resolveLocalFileUrl = (root: string | undefined, storedPath: string): string => {
  // Build a file:// URL (for Node/Electron main) without node:* imports so bundlers (Vite/webpack) don't externalize node modules in browser builds.
  const normalize = (value: string): string => value.replace(/\\/g, "/")
  const normalizedRoot = root ? normalize(root).replace(/\/+$/, "") : ""
  const rootWithSlash = normalizedRoot
    ? normalizedRoot.startsWith("/")
      ? normalizedRoot
      : `/${normalizedRoot}`
    : ""
  const normalizedPath = normalize(storedPath).replace(/^\/+/, "")
  const fullPath = `${rootWithSlash || ""}/${normalizedPath}`.replace(/\/{2,}/g, "/")
  return `file://${fullPath}`
}

export const makeFileStorage = (
  deps: LiveStoreDeps
): Effect.Effect<FileStorageService, never, LocalFileStorage | RemoteStorage | FileSync> =>
  Effect.gen(function* () {
    const localStorage = yield* LocalFileStorage
    const remoteStorage = yield* RemoteStorage
    const fileSync = yield* FileSync
    const { store, schema, storeId } = deps
    const { tables, events, queryDb } = schema

    const getFileRecord = (id: string): Effect.Effect<FileRecord | undefined> =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id })))
        return files[0]
      })

    const getLocalFilesState = (): Effect.Effect<LocalFilesState> =>
      Effect.sync(() => {
        const state = store.query<{ localFiles: LocalFilesState }>(
          queryDb(tables.localFileState.get())
        )
        return state.localFiles ?? {}
      })

    const createFileRecord = (params: { id: string; path: string; contentHash: string }) =>
      Effect.sync(() => {
        store.commit(
          events.fileCreated({
            id: params.id,
            path: params.path,
            contentHash: params.contentHash,
            createdAt: new Date(),
            updatedAt: new Date()
          })
        )
      })

    const updateFileRecord = (params: {
      id: string
      path: string
      contentHash: string
      remoteKey?: string
    }) =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id: params.id })))
        const file = files[0]
        if (!file) return
        store.commit(
          events.fileUpdated({
            id: params.id,
            path: params.path,
            remoteKey: params.remoteKey ?? file.remoteKey,
            contentHash: params.contentHash,
            updatedAt: new Date()
          })
        )
      })

    const deleteFileRecord = (id: string) =>
      Effect.sync(() => {
        store.commit(events.fileDeleted({ id, deletedAt: new Date() }))
      })

    const saveFile = (file: File): Effect.Effect<FileOperationResult, HashError | StorageError> =>
      Effect.gen(function* () {
        // Generate ID
        const id = crypto.randomUUID()

        // Hash file content
        const contentHash = yield* hashFile(file)

        // Generate path from hash (content-addressable)
        const path = makeStoredPath(storeId, contentHash)

        // Write to local storage
        yield* localStorage.writeFile(path, file)

        // Create file record
        yield* createFileRecord({ id, path, contentHash })

        // Mark as changed for sync
        yield* fileSync.markLocalFileChanged(id, path, contentHash)

        return { fileId: id, path, contentHash }
      })

    const updateFile = (
      fileId: string,
      file: File
    ): Effect.Effect<FileOperationResult, Error | HashError | StorageError> =>
      Effect.gen(function* () {
        // Get existing file
        const existingFile = yield* getFileRecord(fileId)
        if (!existingFile) {
          return yield* Effect.fail(new Error(`File not found: ${fileId}`))
        }

        // Hash new content
        const contentHash = yield* hashFile(file)
        const path = makeStoredPath(storeId, contentHash)

        // Only update if content changed
        if (contentHash !== existingFile.contentHash) {
          // Write new file to local storage
          yield* localStorage.writeFile(path, file)

          // Update file record (clear remoteKey until upload completes)
          yield* updateFileRecord({ id: fileId, path, contentHash, remoteKey: "" })

          // Clean up old file if path changed
          if (path !== existingFile.path) {
            yield* localStorage.deleteFile(existingFile.path).pipe(
              Effect.catchAll(() => Effect.void) // Ignore errors
            )
          }

          // Delete old remote file
          if (existingFile.remoteKey) {
            yield* remoteStorage.delete(existingFile.remoteKey).pipe(
              Effect.catchAll(() => Effect.void) // Ignore errors
            )
          }

          // Mark as changed for sync
          yield* fileSync.markLocalFileChanged(fileId, path, contentHash)
        }

        return { fileId, path, contentHash }
      })

    const deleteFileOp = (fileId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Get existing file
        const existingFile = yield* getFileRecord(fileId)
        if (!existingFile) {
          return // Already deleted
        }

        // Delete file record (soft delete)
        yield* deleteFileRecord(fileId)

        // Delete from local storage
        yield* localStorage.deleteFile(existingFile.path).pipe(
          Effect.catchAll(() => Effect.void) // Ignore errors
        )

        // Best-effort remote cleanup
        if (existingFile.remoteKey) {
          yield* remoteStorage.delete(existingFile.remoteKey).pipe(
            Effect.catchAll(() => Effect.void) // Ignore errors
          )
        }
      })

    const getFileUrl = (fileId: string): Effect.Effect<string | null, StorageError | FileNotFoundError> =>
      Effect.gen(function* () {
        // Get file record
        const file = yield* getFileRecord(fileId)
        if (!file) {
          return null
        }

        // Check local files state
        const localState = yield* getLocalFilesState()
        const local = localState[fileId]

        // Try local first
        if (local?.localHash) {
          const exists = yield* localStorage.fileExists(file.path)
          if (exists) {
            if (isNode()) {
              return resolveLocalFileUrl(deps.localPathRoot, file.path)
            }
            console.log("returning local URL", file.path)
            return yield* localStorage.getFileUrl(file.path)
          }
        }

        // Fall back to remote URL when present (minted on demand)
        if (!file.remoteKey) return null
        return yield* remoteStorage.getDownloadUrl(file.remoteKey).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: "Failed to resolve remote URL",
                cause: error
              })
          )
        )
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
export const FileStorageLive = (
  deps: LiveStoreDeps
): Layer.Layer<FileStorage, never, LocalFileStorage | RemoteStorage | FileSync> =>
  Layer.effect(FileStorage, makeFileStorage(deps))
