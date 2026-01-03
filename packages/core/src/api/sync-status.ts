/**
 * Sync Status Utilities
 *
 * Pure functions for deriving aggregate sync status from LocalFilesState.
 * Framework-agnostic - works with any subscription mechanism.
 *
 * @module
 */

import type { LocalFilesState, SyncStatus, SyncError } from "../types/index.js"

/**
 * Compute aggregate sync status from local files state
 *
 * This is a pure function that derives sync status from the localFileState
 * client document. Use with store.subscribe or framework-specific hooks
 * like useClientDocument.
 *
 * @example
 * ```typescript
 * // With store.query (one-time read)
 * const localState = store.query(queryDb(tables.localFileState.get()))
 * const status = getSyncStatus(localState.localFiles)
 *
 * // With React useClientDocument
 * const [localFileState] = store.useClientDocument(tables.localFileState)
 * const status = getSyncStatus(localFileState?.localFiles ?? {})
 *
 * // With Vue useClientDocument
 * const localFileState = useClientDocument(tables.localFileState)
 * const status = computed(() => getSyncStatus(localFileState.value?.localFiles ?? {}))
 *
 * // With store.subscribe (vanilla JS)
 * store.subscribe(queryDb(tables.localFileState.get()), (state) => {
 *   const status = getSyncStatus(state.localFiles)
 *   console.log('Uploading:', status.uploadingCount)
 * })
 * ```
 *
 * @param localFilesState - The localFiles map from the localFileState client document
 * @returns Aggregate sync status with counts and file ID lists
 */
export function getSyncStatus(localFilesState: LocalFilesState): SyncStatus {
  const uploadingFileIds: string[] = []
  const downloadingFileIds: string[] = []
  const queuedUploadFileIds: string[] = []
  const queuedDownloadFileIds: string[] = []
  const pendingUploadFileIds: string[] = []
  const pendingDownloadFileIds: string[] = []
  const errors: SyncError[] = []
  const seenErrorFileIds = new Set<string>()

  for (const [fileId, state] of Object.entries(localFilesState)) {
    // Upload status
    switch (state.uploadStatus) {
      case "inProgress":
        uploadingFileIds.push(fileId)
        break
      case "queued":
        queuedUploadFileIds.push(fileId)
        break
      case "pending":
        pendingUploadFileIds.push(fileId)
        break
      case "error":
        if (state.lastSyncError && !seenErrorFileIds.has(fileId)) {
          errors.push({ fileId, error: state.lastSyncError })
          seenErrorFileIds.add(fileId)
        }
        break
    }

    // Download status
    switch (state.downloadStatus) {
      case "inProgress":
        downloadingFileIds.push(fileId)
        break
      case "queued":
        queuedDownloadFileIds.push(fileId)
        break
      case "pending":
        pendingDownloadFileIds.push(fileId)
        break
      case "error":
        // Avoid duplicates if both upload and download errored
        if (state.lastSyncError && !seenErrorFileIds.has(fileId)) {
          errors.push({ fileId, error: state.lastSyncError })
          seenErrorFileIds.add(fileId)
        }
        break
    }
  }

  const uploadingCount = uploadingFileIds.length
  const downloadingCount = downloadingFileIds.length
  const queuedUploadCount = queuedUploadFileIds.length
  const queuedDownloadCount = queuedDownloadFileIds.length
  const pendingUploadCount = pendingUploadFileIds.length
  const pendingDownloadCount = pendingDownloadFileIds.length

  return {
    uploadingCount,
    downloadingCount,
    queuedUploadCount,
    queuedDownloadCount,
    pendingUploadCount,
    pendingDownloadCount,
    errorCount: errors.length,
    isSyncing: uploadingCount > 0 || downloadingCount > 0,
    hasPending:
      queuedUploadCount > 0 ||
      queuedDownloadCount > 0 ||
      pendingUploadCount > 0 ||
      pendingDownloadCount > 0,
    uploadingFileIds,
    downloadingFileIds,
    queuedUploadFileIds,
    queuedDownloadFileIds,
    pendingUploadFileIds,
    pendingDownloadFileIds,
    errors
  }
}
