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
   * Base URL for the signer API
   */
  readonly signerBaseUrl: string

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
 * Result of an upload
 */
export interface RemoteUploadResult {
  readonly key: string
  readonly etag?: string
}

/**
 * RemoteStorage adapter interface
 *
 * Implement this interface to create custom storage backends.
 */
export interface RemoteStorageAdapter {
  /**
   * Upload a file to remote storage under a stable remote key
   */
  readonly upload: (
    file: File,
    options: { key: string }
  ) => Effect.Effect<RemoteUploadResult, UploadError>

  /**
   * Download a file from remote storage
   */
  readonly download: (key: string) => Effect.Effect<File, DownloadError>

  /**
   * Delete a file from remote storage
   */
  readonly delete: (key: string) => Effect.Effect<void, DeleteError>

  /**
   * Get a short-lived download URL for a remote key
   */
  readonly getDownloadUrl: (key: string) => Effect.Effect<string, DownloadError>

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
>() { }

/**
 * Create a signer-backed S3-compatible remote storage implementation.
 *
 * The signer is responsible for minting presigned URLs against any S3-compatible
 * endpoint and enforcing authorization.
 *
 * Expected signer endpoints:
 * - GET /health
 * - POST /v1/sign/upload   { key, contentType?, contentLength? } -> { method, url, headers?, expiresAt }
 * - POST /v1/sign/download { key } -> { url, headers?, expiresAt }
 * - POST /v1/delete        { key } -> 204
 */
export const makeS3SignerRemoteStorage = (config: RemoteStorageConfig): RemoteStorageService => {
  const makeHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      ...config.headers
    }
    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`
    }
    return headers
  }

  const signerUrl = (path: string) =>
    `${config.signerBaseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`

  type SignUploadResponse = {
    readonly method: "PUT" | "POST"
    readonly url: string
    readonly headers?: Record<string, string>
    readonly expiresAt: string
  }

  type SignDownloadResponse = {
    readonly url: string
    readonly headers?: Record<string, string>
    readonly expiresAt: string
  }

  const signUpload = (params: {
    key: string
    contentType?: string
    contentLength?: number
  }): Effect.Effect<SignUploadResponse, UploadError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(signerUrl("/v1/sign/upload"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify(params)
        })
        if (!response.ok) throw new Error(`Signer upload signing failed: ${response.status}`)
        return (await response.json()) as SignUploadResponse
      },
      catch: (error) =>
        new UploadError({
          message: `Failed to sign upload`,
          cause: error
        })
    })

  const signDownload = (key: string): Effect.Effect<SignDownloadResponse, DownloadError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(signerUrl("/v1/sign/download"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify({ key })
        })

        if (!response.ok) throw new Error(`Signer download signing failed: ${response.status}`)
        return (await response.json()) as SignDownloadResponse
      },
      catch: (error) =>
        new DownloadError({
          message: `Failed to sign download`,
          url: key,
          cause: error
        })
    })

  const upload = (
    file: File,
    options: { key: string }
  ): Effect.Effect<RemoteUploadResult, UploadError> =>
    Effect.gen(function* () {
      const signed = yield* signUpload({
        key: options.key,
        ...(file.type ? { contentType: file.type } : {}),
        contentLength: file.size
      })

      const response = yield* Effect.tryPromise({
        try: async () => {
          const r = await fetch(signed.url, {
            method: signed.method,
            ...(signed.headers ? { headers: signed.headers } : {}),
            body: file
          })
          return r
        },
        catch: (error) =>
          new UploadError({
            message: `Failed to upload`,
            cause: error
          })
      })

      if (!response.ok) {
        return yield* Effect.fail(
          new UploadError({
            message: `Upload failed with status: ${response.status}`
          })
        )
      }

      const etag = response.headers.get("ETag")
      return etag ? { key: options.key, etag } : { key: options.key }
    })

  const download = (key: string): Effect.Effect<File, DownloadError> =>
    Effect.gen(function* () {
      const signed = yield* signDownload(key)
      const response = yield* Effect.tryPromise({
        try: async () => {
          const r = await fetch(signed.url, {
            method: "GET",
            ...(signed.headers ? { headers: signed.headers } : {})
          })
          return r
        },
        catch: (error) =>
          new DownloadError({
            message: `Failed to download`,
            url: key,
            cause: error
          })
      })

      if (!response.ok) {
        return yield* Effect.fail(
          new DownloadError({
            message: `Download failed with status: ${response.status}`,
            url: key
          })
        )
      }

      const blob = yield* Effect.tryPromise({
        try: async () => await response.blob(),
        catch: (error) =>
          new DownloadError({
            message: `Failed to read response body`,
            url: key,
            cause: error
          })
      })

      const filename = key.split("/").pop() || "file"
      return new File([blob], filename, { type: blob.type })
    })

  const getDownloadUrl = (key: string): Effect.Effect<string, DownloadError> =>
    signDownload(key).pipe(Effect.map((r) => r.url))

  const deleteFile = (key: string): Effect.Effect<void, DeleteError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(signerUrl("/v1/delete"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify({ key })
        })

        if (!response.ok) {
          throw new Error(`Delete failed with status: ${response.status}`)
        }
      },
      catch: (error) =>
        new DeleteError({
          message: `Failed to delete file`,
          path: key,
          cause: error
        })
    })

  const checkHealth = (): Effect.Effect<boolean, never> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(signerUrl("/health"), {
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
    getDownloadUrl,
    checkHealth,
    getConfig
  }
}

/**
 * Create a Layer for signer-backed remote storage
 */
export const makeRemoteStorageLive = (
  config: RemoteStorageConfig
): Layer.Layer<RemoteStorage> =>
  Layer.succeed(RemoteStorage, makeS3SignerRemoteStorage(config))

/**
 * RemoteStorageConfig service tag for dependency injection
 */
export class RemoteStorageConfigTag extends Context.Tag("RemoteStorageConfig")<
  RemoteStorageConfigTag,
  RemoteStorageConfig
>() { }

/**
 * Layer that reads config from RemoteStorageConfig service
 */
export const RemoteStorageLive: Layer.Layer<RemoteStorage, never, RemoteStorageConfigTag> =
  Layer.effect(
    RemoteStorage,
    Effect.gen(function* () {
      const config = yield* RemoteStorageConfigTag
      return makeS3SignerRemoteStorage(config)
    })
  )
