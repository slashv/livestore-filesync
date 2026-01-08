/**
 * Service Worker exports
 *
 * @module
 */

// Service worker initialization (for use in SW context)
export { createMessageHandler, type FileSyncSWConfig, initFileSyncServiceWorker } from "./file-sync-sw.js"

// Registration helpers (for use in main thread)
export {
  clearServiceWorkerCache,
  initServiceWorker,
  isServiceWorkerSupported,
  prefetchFiles,
  registerFileSyncServiceWorker,
  type RegisterOptions,
  sendMessageToServiceWorker,
  type ServiceWorkerOptions,
  unregisterFileSyncServiceWorker
} from "./registration.js"
