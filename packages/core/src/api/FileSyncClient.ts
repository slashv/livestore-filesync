/**
 * Promise-based File Sync Client
 *
 * A simple, non-Effect API for file syncing operations.
 * This wraps the Effect-based services for users who prefer Promise-based code.
 *
 * @module
 */

import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { RemoteStorageAdapter } from "../services/remote-file-storage/index.js"
import type { FileOperationResult, TransferProgress } from "../types/index.js"
import {
  LocalFileStorage,
  LocalFileStorageLive,
  RemoteStorage,
  type RemoteStorageService
} from "../services/index.js"
import { hashFile, makeStoredPath } from "../utils/index.js"

/**
 * Configuration for the FileSyncClient
 */
export interface FileSyncClientConfig {
  /**
   * Remote storage adapter for uploading/downloading files
   */
  remoteAdapter: RemoteStorageAdapter

  /**
   * Callback for transfer progress updates
   */
  onProgress?: (fileId: string, progress: TransferProgress) => void

  /**
   * Callback for errors
   */
  onError?: (error: FileSyncError) => void
}

/**
 * Error from file sync operations
 */
export interface FileSyncError {
  type: "storage" | "network" | "hash" | "unknown"
  message: string
  fileId?: string
  cause?: unknown
}

/**
 * Promise-based File Sync Client
 *
 * @example
 * ```typescript
 * import { FileSyncClient, makeHttpRemoteStorage } from 'livestore-filesync'
 *
 * const client = await FileSyncClient.create({
 *   remoteAdapter: makeHttpRemoteStorage({
 *     baseUrl: '/api/files'
 *   }),
 *   onProgress: (fileId, progress) => {
 *     console.log(`${fileId}: ${progress.loaded}/${progress.total}`)
 *   }
 * })
 *
 * // Save a file
 * const result = await client.saveFile(file)
 * console.log('File saved with hash:', result.contentHash)
 *
 * // Clean up when done
 * client.dispose()
 * ```
 */
export class FileSyncClient {
  private runtime: ManagedRuntime.ManagedRuntime<LocalFileStorage | RemoteStorage, never>
  private disposed = false

  private constructor(
    runtime: ManagedRuntime.ManagedRuntime<LocalFileStorage | RemoteStorage, never>,
    private config: FileSyncClientConfig
  ) {
    this.runtime = runtime
  }

  /**
   * Create a new FileSyncClient
   */
  static async create(config: FileSyncClientConfig): Promise<FileSyncClient> {
    // Create the remote storage service that wraps the adapter
    const remoteService: RemoteStorageService = {
      upload: (file: File) => config.remoteAdapter.upload(file),
      download: (url: string) => config.remoteAdapter.download(url),
      delete: (url: string) => config.remoteAdapter.delete(url),
      checkHealth: () => config.remoteAdapter.checkHealth(),
      getConfig: () => ({ baseUrl: "" }) // Adapter doesn't expose config
    }

    const RemoteStorageLive = Layer.succeed(RemoteStorage, remoteService)

    const MainLayer = Layer.merge(
      LocalFileStorageLive,
      RemoteStorageLive
    )

    const runtime = ManagedRuntime.make(MainLayer)

    return new FileSyncClient(runtime, config)
  }

  /**
   * Save a file to local storage (content-addressable by hash)
   */
  async saveFile(file: File): Promise<FileOperationResult> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage

      // Hash file content
      const contentHash = yield* hashFile(file)

      // Generate path from hash (content-addressable)
      const path = makeStoredPath(contentHash)

      // Write to local storage
      yield* localStorage.writeFile(path, file)

      return { fileId: contentHash, path, contentHash }
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Update a file (replace content, returns new hash if content changed)
   */
  async updateFile(oldPath: string, file: File): Promise<FileOperationResult> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage

      // Hash new content
      const contentHash = yield* hashFile(file)
      const path = makeStoredPath(contentHash)

      // Write new file
      yield* localStorage.writeFile(path, file)

      // Delete old file if path changed
      if (path !== oldPath) {
        yield* localStorage.deleteFile(oldPath).pipe(Effect.ignore)
      }

      return { fileId: contentHash, path, contentHash }
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Delete a file from local storage
   */
  async deleteFile(path: string): Promise<void> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      yield* localStorage.deleteFile(path).pipe(Effect.ignore)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Get a blob URL for a local file
   */
  async getFileUrl(path: string): Promise<string | null> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      const exists = yield* localStorage.fileExists(path)
      if (!exists) return null
      return yield* localStorage.getFileUrl(path)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Check if a file exists locally
   */
  async fileExists(path: string): Promise<boolean> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      return yield* localStorage.fileExists(path)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Read a file from local storage
   */
  async readFile(path: string): Promise<File> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      return yield* localStorage.readFile(path)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * List all files in a directory
   */
  async listFiles(directory: string = "files"): Promise<string[]> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      return yield* localStorage.listFiles(directory)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Upload a file to remote storage
   */
  async uploadFile(file: File): Promise<string> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const remoteStorage = yield* RemoteStorage
      return yield* remoteStorage.upload(file)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Download a file from remote storage
   */
  async downloadFile(url: string): Promise<File> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const remoteStorage = yield* RemoteStorage
      return yield* remoteStorage.download(url)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Download a file from remote and save to local storage
   */
  async downloadAndSave(url: string, path: string): Promise<void> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      const remoteStorage = yield* RemoteStorage

      const file = yield* remoteStorage.download(url)
      yield* localStorage.writeFile(path, file)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Upload a local file to remote storage
   */
  async uploadFromLocal(path: string): Promise<string> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const localStorage = yield* LocalFileStorage
      const remoteStorage = yield* RemoteStorage

      const file = yield* localStorage.readFile(path)
      return yield* remoteStorage.upload(file)
    })

    const exit = await this.runtime.runPromiseExit(effect)
    return this.handleExit(exit)
  }

  /**
   * Check if remote storage is available
   */
  async checkRemoteHealth(): Promise<boolean> {
    this.ensureNotDisposed()

    const effect = Effect.gen(function* () {
      const remoteStorage = yield* RemoteStorage
      return yield* remoteStorage.checkHealth()
    })

    const exit = await this.runtime.runPromiseExit(effect)
    try {
      return this.handleExit(exit)
    } catch {
      return false
    }
  }

  /**
   * Hash a file's content (SHA-256)
   */
  async hashFile(file: File): Promise<string> {
    this.ensureNotDisposed()

    const exit = await this.runtime.runPromiseExit(hashFile(file))
    return this.handleExit(exit)
  }

  /**
   * Dispose of the client and release resources
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.runtime.dispose()
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("FileSyncClient has been disposed")
    }
  }

  private handleExit<A, E>(exit: Exit.Exit<A, E>): A {
    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const error = exit.cause
    const fileSyncError = this.toFileSyncError(error)
    this.config.onError?.(fileSyncError)
    throw fileSyncError
  }

  private toFileSyncError(cause: unknown): FileSyncError {
    if (cause && typeof cause === "object") {
      // Check for tagged errors
      if ("_tag" in cause) {
        const tagged = cause as { _tag: string; message?: string; path?: string }
        switch (tagged._tag) {
          case "StorageError":
            return {
              type: "storage",
              message: tagged.message || "Storage error",
              cause
            }
          case "FileNotFoundError":
            return {
              type: "storage",
              message: `File not found: ${tagged.path}`,
              cause
            }
          case "HashError":
            return {
              type: "hash",
              message: tagged.message || "Hash error",
              cause
            }
          case "UploadError":
          case "DownloadError":
            return {
              type: "network",
              message: tagged.message || "Network error",
              cause
            }
        }
      }
    }

    return {
      type: "unknown",
      message: String(cause),
      cause
    }
  }
}
