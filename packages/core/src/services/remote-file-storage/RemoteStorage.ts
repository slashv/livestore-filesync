/**
 * RemoteStorage Service
 *
 * Provides an Effect-based abstraction for remote file storage.
 * This uses a pluggable adapter pattern allowing different backends
 * (S3, Cloudflare R2, Supabase Storage, custom APIs, etc.)
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"

/**
 * Configuration for remote storage
 */
export interface RemoteStorageConfig {
  /**
   * Base URL for the remote storage API
   */
  readonly baseUrl: string

  /**
   * Optional authorization token
   */
  readonly authToken?: string

  /**
   * Optional custom headers
   */
  readonly headers?: Record<string, string>
}

/**
 * Progress information for upload/download
 */
export interface TransferProgress {
  readonly loaded: number
  readonly total: number
  readonly percentage: number
}

/**
 * RemoteStorage adapter interface
 *
 * Implement this interface to create custom storage backends.
 */
export interface RemoteStorageAdapter {
  /**
   * Upload a file to remote storage
   * @returns The URL where the file is stored
   */
  readonly upload: (
    file: File,
    options?: { key?: string }
  ) => Effect.Effect<string, UploadError>

  /**
   * Download a file from remote storage
   */
  readonly download: (url: string) => Effect.Effect<File, DownloadError>

  /**
   * Delete a file from remote storage
   */
  readonly delete: (url: string) => Effect.Effect<void, DeleteError>

  /**
   * Check if the remote storage is available
   */
  readonly checkHealth: () => Effect.Effect<boolean, never>
}

/**
 * RemoteStorage service interface
 */
export interface RemoteStorageService extends RemoteStorageAdapter {
  /**
   * Get the current configuration
   */
  readonly getConfig: () => RemoteStorageConfig
}

/**
 * RemoteStorage service tag
 */
export class RemoteStorage extends Context.Tag("RemoteStorage")<
  RemoteStorage,
  RemoteStorageService
>() {}

/**
 * Create a generic HTTP-based remote storage adapter
 *
 * This adapter expects:
 * - POST /upload with FormData containing the file (optional `key` field)
 * - GET {url} to download files
 * - DELETE {url} to delete files
 * - GET /health for health checks
 */
export const makeHttpRemoteStorage = (config: RemoteStorageConfig): RemoteStorageService => {
  const makeHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      ...config.headers
    }
    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`
    }
    return headers
  }

  const upload = (
    file: File,
    options: { key?: string } = {}
  ): Effect.Effect<string, UploadError> =>
    Effect.tryPromise({
      try: async () => {
        const formData = new FormData()
        const key = options.key ?? file.name
        formData.append("file", file, key)
        if (options.key) {
          formData.append("key", key)
        }

        const response = await fetch(`${config.baseUrl}/upload`, {
          method: "POST",
          headers: makeHeaders(),
          body: formData
        })

        if (!response.ok) {
          throw new Error(`Upload failed with status: ${response.status}`)
        }

        const result = await response.json()
        return result.url as string
      },
      catch: (error) =>
        new UploadError({
          message: `Failed to upload file: ${file.name}`,
          cause: error
        })
    })

  const download = (url: string): Effect.Effect<File, DownloadError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: makeHeaders()
        })

        if (!response.ok) {
          throw new Error(`Download failed with status: ${response.status}`)
        }

        const blob = await response.blob()
        const filename = url.split("/").pop() || "file"
        return new File([blob], filename, { type: blob.type })
      },
      catch: (error) =>
        new DownloadError({
          message: `Failed to download file`,
          url,
          cause: error
        })
    })

  const deleteFile = (url: string): Effect.Effect<void, DeleteError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "DELETE",
          headers: makeHeaders()
        })

        if (!response.ok) {
          throw new Error(`Delete failed with status: ${response.status}`)
        }
      },
      catch: (error) =>
        new DeleteError({
          message: `Failed to delete file`,
          path: url,
          cause: error
        })
    })

  const checkHealth = (): Effect.Effect<boolean, never> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${config.baseUrl}/health`, {
          method: "GET",
          headers: makeHeaders()
        })
        return response.ok
      },
      catch: () => false
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))

  const getConfig = () => config

  return {
    upload,
    download,
    delete: deleteFile,
    checkHealth,
    getConfig
  }
}

/**
 * Create a Layer for HTTP-based remote storage
 */
export const makeRemoteStorageLive = (
  config: RemoteStorageConfig
): Layer.Layer<RemoteStorage> =>
  Layer.succeed(RemoteStorage, makeHttpRemoteStorage(config))

/**
 * RemoteStorageConfig service tag for dependency injection
 */
export class RemoteStorageConfigTag extends Context.Tag("RemoteStorageConfig")<
  RemoteStorageConfigTag,
  RemoteStorageConfig
>() {}

/**
 * Layer that reads config from RemoteStorageConfig service
 */
export const RemoteStorageLive: Layer.Layer<RemoteStorage, never, RemoteStorageConfigTag> =
  Layer.effect(
    RemoteStorage,
    Effect.gen(function*() {
      const config = yield* RemoteStorageConfigTag
      return makeHttpRemoteStorage(config)
    })
  )
