/**
 * Service Worker Registration Helpers
 *
 * Utilities for registering the file sync service worker from the main thread.
 *
 * @module
 */

/**
 * Options for initializing the file sync service worker.
 *
 * The service worker intercepts GET requests to /livestore-filesync-files/*
 * and serves files from OPFS when available, falling back to remote storage.
 */
export interface ServiceWorkerOptions {
  /**
   * Path to the service worker script.
   * @default '/file-sync-sw.js'
   */
  scriptUrl?: string

  /**
   * Base URL for remote file fetches (used when file not in OPFS).
   * @default window.location.origin
   */
  filesBaseUrl?: string

  /**
   * Optional bearer token for authenticated remote fetches.
   * If provided, adds Authorization: Bearer <token> header.
   */
  authToken?: string
}

/**
 * Low-level options for registering the file sync service worker
 */
export interface RegisterOptions {
  /**
   * Path to the service worker script
   * @default '/file-sync-sw.js'
   */
  scriptUrl?: string

  /**
   * Scope for the service worker
   * @default '/'
   */
  scope?: string

  /**
   * Update behavior
   * @default 'imports'
   */
  updateViaCache?: ServiceWorkerUpdateViaCache

  /**
   * Script type
   */
  type?: "classic" | "module"

  /**
   * Callback when registration succeeds
   */
  onSuccess?: (registration: ServiceWorkerRegistration) => void

  /**
   * Callback when registration fails
   */
  onError?: (error: Error) => void

  /**
   * Callback when a new version is available
   */
  onUpdate?: (registration: ServiceWorkerRegistration) => void
}

/**
 * Check if service workers are supported
 */
export function isServiceWorkerSupported(): boolean {
  return "serviceWorker" in navigator
}

/**
 * Register the file sync service worker
 *
 * @example
 * ```typescript
 * import { registerFileSyncServiceWorker } from 'livestore-filesync/worker'
 *
 * registerFileSyncServiceWorker({
 *   scriptUrl: '/file-sync-sw.js',
 *   onSuccess: (reg) => console.log('SW registered:', reg),
 *   onUpdate: (reg) => console.log('SW update available:', reg),
 *   onError: (err) => console.error('SW registration failed:', err)
 * })
 * ```
 */
export async function registerFileSyncServiceWorker(
  options: RegisterOptions = {}
): Promise<ServiceWorkerRegistration | null> {
  const {
    onError,
    onSuccess,
    onUpdate,
    scope = "/",
    scriptUrl = "/file-sync-sw.js",
    type,
    updateViaCache = "imports"
  } = options

  if (!isServiceWorkerSupported()) {
    const error = new Error("Service workers are not supported in this browser")
    onError?.(error)
    return null
  }

  try {
    const registration = await navigator.serviceWorker.register(scriptUrl, {
      scope,
      updateViaCache,
      ...(type ? { type } : {})
    })

    // Check for updates
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing
      if (newWorker) {
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            // New version available
            onUpdate?.(registration)
          }
        })
      }
    })

    onSuccess?.(registration)
    return registration
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)))
    return null
  }
}

/**
 * Unregister all file sync service workers
 */
export async function unregisterFileSyncServiceWorker(): Promise<boolean> {
  if (!isServiceWorkerSupported()) {
    return false
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((reg) => reg.unregister()))
    return true
  } catch {
    return false
  }
}

/**
 * Send a message to the active service worker
 */
export async function sendMessageToServiceWorker<T = unknown>(
  message: { type: string; payload?: unknown }
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker.controller) {
      reject(new Error("No active service worker"))
      return
    }

    const channel = new MessageChannel()

    channel.port1.onmessage = (event) => {
      if (event.data.error) {
        reject(new Error(event.data.error))
      } else {
        resolve(event.data as T)
      }
    }

    navigator.serviceWorker.controller.postMessage(message, [channel.port2])
  })
}

/**
 * Request the service worker to clear its cache
 */
export async function clearServiceWorkerCache(): Promise<void> {
  await sendMessageToServiceWorker({ type: "CLEAR_CACHE" })
}

/**
 * Request the service worker to prefetch files
 */
export async function prefetchFiles(paths: Array<string>): Promise<void> {
  await sendMessageToServiceWorker({ type: "PREFETCH", payload: { paths } })
}

// ============================================================================
// High-level initialization API
// ============================================================================

/**
 * Initialize and register the file sync service worker.
 *
 * This function handles:
 * - Building the SW URL with configuration parameters
 * - Registering the service worker
 * - Waiting for the SW to be ready
 *
 * Call this before rendering any components that use file URLs.
 * The service worker must be ready before it can intercept requests.
 *
 * **Setup required:** Copy the bundled SW to your public folder:
 * ```bash
 * cp node_modules/@livestore-filesync/core/dist/file-sync-sw.iife.js public/file-sync-sw.js
 * ```
 *
 * @example
 * ```typescript
 * import { initServiceWorker } from '@livestore-filesync/core/worker'
 *
 * // Before rendering (this must complete before file URLs will work)
 * await initServiceWorker({ authToken: 'my-token' })
 * ```
 */
export async function initServiceWorker(options: ServiceWorkerOptions = {}): Promise<void> {
  if (!isServiceWorkerSupported()) {
    return
  }

  const filesBaseUrl = options.filesBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "")

  const swUrl = new URL(options.scriptUrl ?? "/file-sync-sw.js", filesBaseUrl)
  swUrl.searchParams.set("filesBaseUrl", filesBaseUrl)
  if (options.authToken) {
    swUrl.searchParams.set("token", options.authToken)
  }

  await registerFileSyncServiceWorker({
    scriptUrl: swUrl.toString()
  })

  await navigator.serviceWorker.ready
}
