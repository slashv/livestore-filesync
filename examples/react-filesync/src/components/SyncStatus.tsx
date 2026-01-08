import { getSyncStatus } from "@livestore-filesync/core"
import { useStore } from "@livestore/react"
import React from "react"
import { reactStoreOptions } from "../App.tsx"
import { tables } from "../livestore/schema.ts"

export const SyncStatus: React.FC = () => {
  const store = useStore(reactStoreOptions)
  const [localFileState] = store.useClientDocument(tables.localFileState)
  const syncStatus = getSyncStatus(localFileState?.localFiles ?? {})

  return (
    <div className="sync-status" data-testid="sync-status-panel">
      <h3>Sync Status</h3>

      <table>
        <tbody>
          <tr>
            <td>Syncing</td>
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
