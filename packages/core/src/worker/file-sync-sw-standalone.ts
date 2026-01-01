/**
 * Standalone File Sync Service Worker
 *
 * This is a self-initializing version of the service worker that reads
 * configuration from URL search parameters.
 *
 * Supported URL parameters:
 * - filesBaseUrl: Base URL for remote file fetches (e.g., window.location.origin)
 * - token: Optional bearer token for authentication
 *
 * @module
 */

/// <reference lib="webworker" />

import { initFileSyncServiceWorker } from "./file-sync-sw.js"

declare const self: ServiceWorkerGlobalScope

// Read configuration from URL search params
const params = new URLSearchParams(self.location.search)
const filesBaseUrl = params.get("filesBaseUrl") || ""
const token = params.get("token") || ""
const baseUrl = filesBaseUrl.replace(/\/$/, "")

// Initialize the service worker with URL-based configuration
initFileSyncServiceWorker({
  pathPrefix: "/livestore-filesync-files/",
  cacheRemoteResponses: true,
  getRemoteUrl: async (path) => (baseUrl ? `${baseUrl}/${path}` : `/${path}`),
  ...(token ? { getRemoteHeaders: async () => ({ Authorization: `Bearer ${token}` }) } : {})
})
