/**
 * Service Worker exports
 *
 * @module
 */

// Service worker initialization (for use in SW context)
export {
  createMessageHandler,
  initFileSyncServiceWorker,
  type FileSyncSWConfig
} from "./file-sync-sw.js"

// Registration helpers (for use in main thread)
export {
  clearServiceWorkerCache,
  isServiceWorkerSupported,
  prefetchFiles,
  registerFileSyncServiceWorker,
  sendMessageToServiceWorker,
  unregisterFileSyncServiceWorker,
  type RegisterOptions
} from "./registration.js"
