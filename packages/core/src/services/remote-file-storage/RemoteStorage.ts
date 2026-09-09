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
   * Optional authorization token.
   * Can be a static string or a getter function that returns the current token,
   * which is useful when tokens may change (e.g. after logout/re-login).
   */
  readonly authToken?: string | (() => string | null)

  /**
   * Optional custom headers
   */
  readonly headers?: Record<string, string>

  /**
   * Whether to include credentials (cookies) in cross-origin requests.
   * Required for cookie-based auth when the signer is on a different origin.
   * @default false
   */
  readonly includeCredentials?: boolean
}

/**
 * Remote configuration used when FileSync is explicitly running without a
 * remote backend.
 */
export interface LocalOnlyRemoteStorageConfig {
  readonly mode: "local-only"
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
  readonly getConfig: () => RemoteStorageConfig | LocalOnlyRemoteStorageConfig
}

/**
 * RemoteStorage service tag
 */
export class RemoteStorage extends Context.Service<RemoteStorage, RemoteStorageService>()("RemoteStorage") {}

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
    const token = typeof config.authToken === "function" ? config.authToken() : config.authToken
    if (token) {
      headers["Authorization"] = `Bearer ${token}`
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

  const validateSignUploadResponse = (data: unknown): SignUploadResponse => {
    if (typeof data !== "object" || data === null) {
      throw new Error("Signer upload response is not an object")
    }
    const obj = data as Record<string, unknown>
    if (typeof obj.url !== "string" || obj.url.length === 0) {
      throw new Error("Signer upload response missing required 'url' string")
    }
    if (obj.method !== "PUT" && obj.method !== "POST") {
      throw new Error(`Signer upload response has invalid 'method': ${String(obj.method)}`)
    }
    return data as SignUploadResponse
  }

  const validateSignDownloadResponse = (data: unknown): SignDownloadResponse => {
    if (typeof data !== "object" || data === null) {
      throw new Error("Signer download response is not an object")
    }
    const obj = data as Record<string, unknown>
    if (typeof obj.url !== "string" || obj.url.length === 0) {
      throw new Error("Signer download response missing required 'url' string")
    }
    return data as SignDownloadResponse
  }

  const fetchOptions = config.includeCredentials ? { credentials: "include" as const } : {}

  const signUpload = (params: {
    key: string
    contentType?: string
    contentLength?: number
  }): Effect.Effect<SignUploadResponse, UploadError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(signerUrl("/v1/sign/upload"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify(params),
          ...fetchOptions,
          signal
        })
        if (!response.ok) throw new Error(`Signer upload signing failed: ${response.status}`)
        return validateSignUploadResponse(await response.json())
      },
      catch: (error) =>
        new UploadError({
          message: `Failed to sign upload`,
          cause: error
        })
    })

  const signDownload = (key: string): Effect.Effect<SignDownloadResponse, DownloadError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(signerUrl("/v1/sign/download"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify({ key }),
          ...fetchOptions,
          signal
        })

        if (!response.ok) throw new Error(`Signer download signing failed: ${response.status}`)
        return validateSignDownloadResponse(await response.json())
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

      // Node has fetch but no XHR, even when the executor requests progress.
      if (!options.onProgress || typeof XMLHttpRequest === "undefined") {
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
          try: async (signal) => {
            const r = await fetch(signed.url, {
              method: signed.method,
              ...(signed.headers ? { headers: signed.headers } : {}),
              body: arrayBuffer,
              signal
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
        try: (signal) =>
          new Promise<{ etag?: string }>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            let settled = false
            const cleanup = () => {
              settled = true
              signal.removeEventListener("abort", abort)
              xhr.upload.onprogress = null
              xhr.onload = null
              xhr.onerror = null
              xhr.ontimeout = null
              xhr.onabort = null
            }
            const fail = (error: unknown) => {
              if (settled) return
              cleanup()
              reject(error)
            }
            const abort = () => {
              fail(new Error("Upload aborted"))
              xhr.abort()
            }

            xhr.upload.onprogress = (event) => {
              if (!settled && !signal.aborted && event.lengthComputable) {
                options.onProgress!({ loaded: event.loaded, total: event.total })
              }
            }
            xhr.onload = () => {
              if (settled || signal.aborted) return
              if (xhr.status >= 200 && xhr.status < 300) {
                const etag = xhr.getResponseHeader("ETag")
                cleanup()
                resolve(etag ? { etag } : {})
              } else {
                fail(new Error(`Upload failed with status: ${xhr.status}`))
              }
            }
            xhr.onerror = () => fail(new Error("Upload network error"))
            xhr.ontimeout = () => fail(new Error("Upload timeout"))
            xhr.onabort = () => fail(new Error("Upload aborted"))
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) {
              abort()
              return
            }
            try {
              xhr.open(signed.method, signed.url)
              if (signed.headers) {
                Object.entries(signed.headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
              }
              xhr.send(xhrArrayBuffer)
            } catch (error) {
              fail(error)
            }
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
      // One interruption scope owns both fetch and consumption of its body.
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(signed.url, {
            method: "GET",
            ...(signed.headers ? { headers: signed.headers } : {}),
            signal
          })
          signal.throwIfAborted()
          if (!response.ok) throw new Error(`Download failed with status: ${response.status}`)

          const filename = key.split("/").pop() || "file"
          const contentType = response.headers.get("Content-Type") || "application/octet-stream"
          // Do not lock the body with getReader when arrayBuffer will consume it.
          if (!options?.onProgress || !response.body) {
            const data = await response.arrayBuffer()
            signal.throwIfAborted()
            return new MemoryFile(new Uint8Array(data), filename, contentType) as unknown as File
          }

          const reader = response.body.getReader()
          const cancel = () => {
            // Cancellation can be asynchronous (or reject); shutdown does not wait
            // for a non-cooperative stream, and no more progress is published.
            void reader.cancel().catch(() => {})
          }
          signal.addEventListener("abort", cancel, { once: true })
          const chunks: Array<Uint8Array> = []
          let loaded = 0
          const total = parseInt(response.headers.get("Content-Length") || "0", 10)
          try {
            while (true) {
              signal.throwIfAborted()
              const result = await reader.read()
              signal.throwIfAborted()
              if (result.done) break
              chunks.push(result.value)
              loaded += result.value.length
              options.onProgress({ loaded, total })
            }
          } finally {
            signal.removeEventListener("abort", cancel)
            if (!signal.aborted) cancel()
            reader.releaseLock()
          }

          const data = new Uint8Array(loaded)
          let offset = 0
          for (const chunk of chunks) {
            data.set(chunk, offset)
            offset += chunk.length
          }
          return new MemoryFile(data, filename, contentType) as unknown as File
        },
        catch: (error) =>
          new DownloadError({
            message: "Failed to download",
            url: key,
            cause: error
          })
      })
    })

  const getDownloadUrl = (key: string): Effect.Effect<string, DownloadError> =>
    signDownload(key).pipe(Effect.map((r) => r.url))

  const deleteFile = (key: string): Effect.Effect<void, DeleteError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(signerUrl("/v1/delete"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...makeHeaders()
          },
          body: JSON.stringify({ key }),
          ...fetchOptions,
          signal
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
      try: async (signal) => {
        const response = await fetch(signerUrl("/health"), {
          method: "GET",
          headers: makeHeaders(),
          ...fetchOptions,
          signal
        })
        return response.ok
      },
      catch: () => false
    }).pipe(Effect.catch(() => Effect.succeed(false)))

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
 * Create a RemoteStorage implementation for explicit local-only FileSync mode.
 *
 * FileSync orchestration should not call transfer methods in this mode. The
 * adapter exists only to keep Effect layer wiring simple and fails loudly if a
 * remote operation accidentally leaks through.
 */
export const makeLocalOnlyRemoteStorage = (): RemoteStorageService => {
  const disabledUpload = () =>
    Effect.fail(
      new UploadError({
        message: "Remote upload is disabled because FileSync is running in local-only mode"
      })
    )

  const disabledDownload = (key: string) =>
    Effect.fail(
      new DownloadError({
        message: "Remote download is disabled because FileSync is running in local-only mode",
        url: key
      })
    )

  const disabledDownloadUrl = (key: string) =>
    Effect.fail(
      new DownloadError({
        message: "Remote download URL signing is disabled because FileSync is running in local-only mode",
        url: key
      })
    )

  const disabledDelete = (key: string) =>
    Effect.fail(
      new DeleteError({
        message: "Remote delete is disabled because FileSync is running in local-only mode",
        path: key
      })
    )

  return {
    upload: disabledUpload,
    download: disabledDownload,
    delete: disabledDelete,
    getDownloadUrl: disabledDownloadUrl,
    checkHealth: () => Effect.succeed(true),
    getConfig: () => ({ mode: "local-only" })
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
export class RemoteStorageConfigTag extends Context.Service<RemoteStorageConfigTag, RemoteStorageConfig>()(
  "RemoteStorageConfig"
) {}

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
