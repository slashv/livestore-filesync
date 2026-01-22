/**
 * RemoteStorage Service
 *
 * Provides an Effect-based abstraction for remote file storage.
 *
 * The built-in/default implementation is signer-backed and targets any
 * S3-compatible object store by minting short-lived presigned URLs (key-based).
 * The primary extension point is the signer API contract (/health, /v1/sign/*, /v1/delete).
 *
 * Custom backends are still possible by providing your own `RemoteStorageAdapter`
 * implementation and wiring it into the `RemoteStorage` service.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"
import { MemoryFile } from "../../utils/MemoryFile.js"

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
 * Progress event for file transfers
 */
export interface TransferProgressEvent {
  /** Bytes transferred so far */
  readonly loaded: number
  /** Total bytes to transfer (may be 0 if unknown) */
  readonly total: number
}

/**
 * Options for upload operations
 */
export interface UploadOptions {
  /** Storage key for the file */
  readonly key: string
  /**
   * Progress callback, called periodically during transfer.
   *
   * **Implementation note:** When provided, uploads use `XMLHttpRequest` instead of `fetch()`
   * to enable progress tracking. This is necessary because the Fetch API does not expose
   * upload progress events. XHR's `upload.onprogress` provides byte-level progress during
   * the request body transmission.
   */
  readonly onProgress?: (progress: TransferProgressEvent) => void
}

/**
 * Options for download operations
 */
export interface DownloadOptions {
  /**
   * Progress callback, called periodically during transfer.
   *
   * **Implementation note:** When provided, downloads use streaming via `response.body.getReader()`
   * instead of `response.blob()` to enable byte-level progress tracking as chunks arrive.
   */
  readonly onProgress?: (progress: TransferProgressEvent) => void
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
    options: UploadOptions
  ) => Effect.Effect<RemoteUploadResult, UploadError>

  /**
   * Download a file from remote storage
   */
  readonly download: (key: string, options?: DownloadOptions) => Effect.Effect<File, DownloadError>

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
>() {}

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
    options: UploadOptions
  ): Effect.Effect<RemoteUploadResult, UploadError> =>
    Effect.gen(function*() {
      const signed = yield* signUpload({
        key: options.key,
        ...(file.type ? { contentType: file.type } : {}),
        contentLength: file.size
      })

      // If no progress callback, use simple fetch
      if (!options.onProgress) {
        // Convert file to ArrayBuffer to ensure React Native's fetch properly sends the bytes.
        // Passing a File/Blob-like object directly doesn't work reliably in React Native.
        const arrayBuffer = yield* Effect.tryPromise({
          try: () => file.arrayBuffer(),
          catch: (error) =>
            new UploadError({
              message: `Failed to read file bytes`,
              cause: error
            })
        })

        const response = yield* Effect.tryPromise({
          try: async () => {
            const r = await fetch(signed.url, {
              method: signed.method,
              ...(signed.headers ? { headers: signed.headers } : {}),
              body: arrayBuffer
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
      }

      // Use XMLHttpRequest for upload progress tracking
      // Convert file to ArrayBuffer for React Native compatibility
      const xhrArrayBuffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (error) =>
          new UploadError({
            message: `Failed to read file bytes`,
            cause: error
          })
      })

      const result = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ etag?: string }>((resolve, reject) => {
            const xhr = new XMLHttpRequest()

            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                options.onProgress!({ loaded: event.loaded, total: event.total })
              }
            }

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader("ETag")
                resolve(etag ? { etag } : {})
              } else {
                reject(new Error(`Upload failed with status: ${xhr.status}`))
              }
            }

            xhr.onerror = () => reject(new Error("Upload network error"))
            xhr.ontimeout = () => reject(new Error("Upload timeout"))

            xhr.open(signed.method, signed.url)
            if (signed.headers) {
              Object.entries(signed.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
            }
            xhr.send(xhrArrayBuffer)
          }),
        catch: (error) =>
          new UploadError({
            message: `Failed to upload`,
            cause: error
          })
      })

      return result.etag ? { key: options.key, etag: result.etag } : { key: options.key }
    })

  const download = (key: string, options?: DownloadOptions): Effect.Effect<File, DownloadError> =>
    Effect.gen(function*() {
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

      const contentLength = parseInt(response.headers.get("Content-Length") || "0", 10)
      const reader = response.body?.getReader()

      // If no progress callback or no reader (streaming not supported), use arrayBuffer
      if (!options?.onProgress || !reader) {
        const arrayBuffer = yield* Effect.tryPromise({
          try: async () => await response.arrayBuffer(),
          catch: (error) =>
            new DownloadError({
              message: `Failed to read response body`,
              url: key,
              cause: error
            })
        })

        const filename = key.split("/").pop() || "file"
        const contentType = response.headers.get("Content-Type") || "application/octet-stream"
        // Use MemoryFile for React Native compatibility
        // React Native's File/Blob constructors don't properly support ArrayBuffer
        return new MemoryFile(new Uint8Array(arrayBuffer), filename, contentType) as unknown as File
      }

      // Stream download with progress tracking
      const chunks: Array<Uint8Array> = []
      let loaded = 0

      while (true) {
        const readResult = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: (error) =>
            new DownloadError({
              message: `Stream read failed`,
              url: key,
              cause: error
            })
        })

        if (readResult.done) break

        chunks.push(readResult.value)
        loaded += readResult.value.length
        options.onProgress({ loaded, total: contentLength })
      }

      // Concatenate chunks into a single Uint8Array
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const data = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.length
      }

      const filename = key.split("/").pop() || "file"
      const contentType = response.headers.get("Content-Type") || "application/octet-stream"
      // Use MemoryFile for React Native compatibility
      return new MemoryFile(data, filename, contentType) as unknown as File
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
): Layer.Layer<RemoteStorage> => Layer.succeed(RemoteStorage, makeS3SignerRemoteStorage(config))

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
export const RemoteStorageLive: Layer.Layer<RemoteStorage, never, RemoteStorageConfigTag> = Layer.effect(
  RemoteStorage,
  Effect.gen(function*() {
    const config = yield* RemoteStorageConfigTag
    return makeS3SignerRemoteStorage(config)
  })
)
