import { getSyncStatus } from "@livestore-filesync/core"
import { useStore } from "@livestore/react"
import React, { useCallback, useEffect, useState } from "react"
import { reactStoreOptions } from "../App.tsx"
import { tables } from "../livestore/schema.ts"

export const SyncStatus: React.FC = () => {
  const store = useStore(reactStoreOptions)
  const [localFileState] = store.useClientDocument(tables.localFileState)
  const syncStatus = getSyncStatus(localFileState?.localFiles ?? {})

  // Network status (browser's navigator.onLine)
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  )

  // LiveStore sync status (controlled via _dev API)
  const [isSyncEnabled, setIsSyncEnabled] = useState(true)

  // Listen to browser online/offline events
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  // Toggle LiveStore sync via _dev API
  const toggleLiveStoreSync = useCallback(() => {
    // LiveStore exposes the store as __debugLiveStore._ (first store) or __debugLiveStore[storeId]
    const debugStore = (window as unknown as {
      __debugLiveStore?: { _?: { _dev?: { overrideNetworkStatus: (status: string) => void } } }
    }).__debugLiveStore?._
    if (debugStore?._dev?.overrideNetworkStatus) {
      const newStatus = isSyncEnabled ? "offline" : "online"
      debugStore._dev.overrideNetworkStatus(newStatus)
      setIsSyncEnabled(!isSyncEnabled)
      console.log(`[SyncStatus] LiveStore sync ${!isSyncEnabled ? "enabled" : "disabled"}`)
    } else {
      console.warn("[SyncStatus] LiveStore _dev API not available")
    }
  }, [isSyncEnabled])

  // Simulate browser offline (dispatches offline event)
  const toggleBrowserOnline = useCallback(() => {
    if (isOnline) {
      // Go offline
      window.dispatchEvent(new Event("offline"))
      setIsOnline(false)
    } else {
      // Go online
      window.dispatchEvent(new Event("online"))
      setIsOnline(true)
    }
    console.log(`[SyncStatus] Browser online status: ${!isOnline}`)
  }, [isOnline])

  return (
    <div className="sync-status" data-testid="sync-status-panel">
      <h3>Sync Status</h3>

      {/* Network & Sync Controls */}
      <div className="controls-section">
        <h4>Controls</h4>
        <div className="control-row">
          <span>Browser Online:</span>
          <button
            onClick={toggleBrowserOnline}
            className={isOnline ? "active" : "inactive"}
            data-testid="toggle-browser-online"
          >
            {isOnline ? "Online" : "Offline"}
          </button>
        </div>
        <div className="control-row">
          <span>LiveStore Sync:</span>
          <button
            onClick={toggleLiveStoreSync}
            className={isSyncEnabled ? "active" : "inactive"}
            data-testid="toggle-livestore-sync"
          >
            {isSyncEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>
      </div>

      <table>
        <tbody>
          <tr>
            <td>Browser Online</td>
            <td data-testid="sync-browser-online">{isOnline ? "Yes" : "No"}</td>
          </tr>
          <tr>
            <td>LiveStore Sync</td>
            <td data-testid="sync-livestore-enabled">{isSyncEnabled ? "Enabled" : "Disabled"}</td>
          </tr>
          <tr>
            <td>File Syncing</td>
            <td data-testid="sync-is-syncing">{syncStatus.isSyncing ? "Yes" : "No"}</td>
          </tr>
          <tr>
            <td>Has Pending</td>
            <td data-testid="sync-has-pending">{syncStatus.hasPending ? "Yes" : "No"}</td>
          </tr>
        </tbody>
      </table>

      <h4>Counts</h4>
      <table>
        <tbody>
          <tr>
            <td>Uploading</td>
            <td data-testid="sync-uploading-count">{syncStatus.uploadingCount}</td>
          </tr>
          <tr>
            <td>Downloading</td>
            <td data-testid="sync-downloading-count">{syncStatus.downloadingCount}</td>
          </tr>
          <tr>
            <td>Queued Upload</td>
            <td data-testid="sync-queued-upload-count">{syncStatus.queuedUploadCount}</td>
          </tr>
          <tr>
            <td>Queued Download</td>
            <td data-testid="sync-queued-download-count">{syncStatus.queuedDownloadCount}</td>
          </tr>
          <tr>
            <td>Pending Upload</td>
            <td data-testid="sync-pending-upload-count">{syncStatus.pendingUploadCount}</td>
          </tr>
          <tr>
            <td>Pending Download</td>
            <td data-testid="sync-pending-download-count">{syncStatus.pendingDownloadCount}</td>
          </tr>
          <tr>
            <td>Errors</td>
            <td data-testid="sync-error-count">{syncStatus.errorCount}</td>
          </tr>
        </tbody>
      </table>

      {syncStatus.uploadingFileIds.length > 0 && (
        <>
          <h4>Uploading Files</h4>
          <ul>
            {syncStatus.uploadingFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.downloadingFileIds.length > 0 && (
        <>
          <h4>Downloading Files</h4>
          <ul>
            {syncStatus.downloadingFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.queuedUploadFileIds.length > 0 && (
        <>
          <h4>Queued Uploads</h4>
          <ul>
            {syncStatus.queuedUploadFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.queuedDownloadFileIds.length > 0 && (
        <>
          <h4>Queued Downloads</h4>
          <ul>
            {syncStatus.queuedDownloadFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.pendingUploadFileIds.length > 0 && (
        <>
          <h4>Pending Uploads</h4>
          <ul>
            {syncStatus.pendingUploadFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.pendingDownloadFileIds.length > 0 && (
        <>
          <h4>Pending Downloads</h4>
          <ul>
            {syncStatus.pendingDownloadFileIds.map((id) => <li key={id}>{id}</li>)}
          </ul>
        </>
      )}

      {syncStatus.errors.length > 0 && (
        <>
          <h4>Errors</h4>
          <ul>
            {syncStatus.errors.map((err) => (
              <li key={err.fileId}>
                <strong>{err.fileId}:</strong> {err.error}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
