/**
 * File Sync Service Worker
 *
 * This service worker intercepts file requests and serves them from OPFS
 * when available, falling back to remote URLs when not.
 *
 * @module
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope

/**
 * Configuration for the file sync service worker
 */
export interface FileSyncSWConfig {
  /**
   * URL path prefix for file requests (default: '/livestore-filesync-files/')
   */
  pathPrefix: string

  /**
   * Whether to cache remote responses in OPFS (default: true)
   */
  cacheRemoteResponses: boolean

  /**
   * Function to get the remote URL for a file path
   * This is called when the file is not found in OPFS.
   * The path includes the full storage prefix (no leading slash).
   */
  getRemoteUrl?: (path: string) => Promise<string | null>

  /**
   * Optional headers to include when fetching remote files
   * The path includes the full storage prefix (no leading slash).
   */
  getRemoteHeaders?: (path: string) => Promise<HeadersInit | null> | HeadersInit | null
}

const defaultConfig: FileSyncSWConfig = {
  pathPrefix: "/livestore-filesync-files/",
  cacheRemoteResponses: true
}

/**
 * OPFS helper functions for the service worker context
 */
const opfs = {
  async getRoot(): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await navigator.storage.getDirectory()
    } catch {
      return null
    }
  },

  async getFile(path: string): Promise<File | null> {
    const root = await this.getRoot()
    if (!root) return null

    try {
      const segments = path.split("/").filter((s) => s.length > 0)
      let current: FileSystemDirectoryHandle = root

      // Navigate to parent directory
      for (let i = 0; i < segments.length - 1; i++) {
        current = await current.getDirectoryHandle(segments[i]!)
      }

      // Get the file
      const filename = segments[segments.length - 1]!
      const fileHandle = await current.getFileHandle(filename)
      return await fileHandle.getFile()
    } catch {
      return null
    }
  },

  async writeFile(path: string, data: ArrayBuffer, mimeType: string): Promise<boolean> {
    const root = await this.getRoot()
    if (!root) return false

    try {
      const segments = path.split("/").filter((s) => s.length > 0)
      let current: FileSystemDirectoryHandle = root

      // Create directories as needed
      for (let i = 0; i < segments.length - 1; i++) {
        current = await current.getDirectoryHandle(segments[i]!, { create: true })
      }

      // Create/write the file
      const filename = segments[segments.length - 1]!
      const fileHandle = await current.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(new Blob([data], { type: mimeType }))
      await writable.close()
      return true
    } catch {
      return false
    }
  }
}

/**
 * Handle a file request
 */
async function handleFileRequest(
  request: Request,
  config: FileSyncSWConfig
): Promise<Response> {
  const url = new URL(request.url)
  const storedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname

  // Try to get from OPFS first
  const localFile = await opfs.getFile(storedPath)
  if (localFile) {
    return new Response(localFile, {
      headers: {
        "Content-Type": localFile.type || "application/octet-stream",
        "Content-Length": String(localFile.size),
        "X-Source": "opfs"
      }
    })
  }

  // If not in OPFS, try to get remote URL
  if (config.getRemoteUrl) {
    const remoteUrl = await config.getRemoteUrl(storedPath)
    if (remoteUrl) {
      try {
        const remoteHeaders = config.getRemoteHeaders
          ? await config.getRemoteHeaders(storedPath)
          : null
        const response = await fetch(remoteUrl, remoteHeaders ? { headers: remoteHeaders } : undefined)
        if (response.ok) {
          // Cache in OPFS if enabled
          if (config.cacheRemoteResponses) {
            const clonedResponse = response.clone()
            const data = await clonedResponse.arrayBuffer()
            const mimeType = clonedResponse.headers.get("Content-Type") || "application/octet-stream"
            await opfs.writeFile(storedPath, data, mimeType)
          }

          // Return response with source header
          const headers = new Headers(response.headers)
          headers.set("X-Source", "remote")
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
          })
        }
      } catch (error) {
        console.error("Failed to fetch from remote:", error)
      }
    }
  }

  // File not found
  return new Response("File not found", {
    status: 404,
    headers: { "Content-Type": "text/plain" }
  })
}

/**
 * Initialize the file sync service worker
 *
 * Call this from your service worker file:
 *
 * @example
 * ```typescript
 * // sw.ts
 * import { initFileSyncServiceWorker } from 'livestore-filesync/worker'
 *
 * initFileSyncServiceWorker({
 *   pathPrefix: '/livestore-filesync-files/',
 *   getRemoteUrl: async (path) => {
 *     // Look up remote URL from your app state
 *     return `https://cdn.example.com/${path}`
 *   }
 * })
 * ```
 */
export function initFileSyncServiceWorker(
  config: Partial<FileSyncSWConfig> = {}
): void {
  const mergedConfig: FileSyncSWConfig = { ...defaultConfig, ...config }

  // Handle fetch events
  self.addEventListener("fetch", (event: FetchEvent) => {
    const url = new URL(event.request.url)

    // Only handle requests matching our path prefix
    if (url.pathname.startsWith(mergedConfig.pathPrefix)) {
      event.respondWith(handleFileRequest(event.request, mergedConfig))
    }
  })

  // Handle install - skip waiting to activate immediately
  self.addEventListener("install", () => {
    self.skipWaiting()
  })

  // Handle activate - claim all clients
  self.addEventListener("activate", (event: ExtendableEvent) => {
    event.waitUntil(self.clients.claim())
  })

  console.log("[FileSyncSW] Initialized with config:", mergedConfig)
}

/**
 * Create a message handler for communication with the main thread
 *
 * This allows the main thread to send commands to the service worker,
 * such as clearing the OPFS cache or updating configuration.
 */
export function createMessageHandler(
  handlers: {
    onClearCache?: () => Promise<void>
    onPrefetch?: (paths: string[]) => Promise<void>
  } = {}
): void {
  self.addEventListener("message", async (event: ExtendableMessageEvent) => {
    const { type, payload } = event.data || {}

    switch (type) {
      case "CLEAR_CACHE":
        if (handlers.onClearCache) {
          await handlers.onClearCache()
        }
        event.ports[0]?.postMessage({ success: true })
        break

      case "PREFETCH":
        if (handlers.onPrefetch && Array.isArray(payload?.paths)) {
          await handlers.onPrefetch(payload.paths)
        }
        event.ports[0]?.postMessage({ success: true })
        break

      default:
        event.ports[0]?.postMessage({ success: false, error: "Unknown message type" })
    }
  })
}
