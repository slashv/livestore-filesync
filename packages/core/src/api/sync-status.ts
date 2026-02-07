/**
 * Sync Status Utilities
 *
 * Pure functions for deriving aggregate sync status from LocalFilesState.
 * Framework-agnostic - works with any subscription mechanism.
 *
 * @module
 */

import type { ActiveTransferProgress, ActiveTransfers, LocalFilesState, SyncError, SyncStatus } from "../types/index.js"

/**
 * Convert an array of localFileState rows into a LocalFilesState map.
 *
 * Use this when reading the localFileState SQLite table (which returns rows)
 * and you need the map format expected by {@link getSyncStatus} or
 * `getFileDisplayState`.
 *
 * @example
 * ```typescript
 * const rows = store.query(queryDb(tables.localFileState.select()))
 * const localFilesState = rowsToLocalFilesState(rows)
 * const status = getSyncStatus(localFilesState)
 * ```
 */
export function rowsToLocalFilesState(
  rows: ReadonlyArray<{ readonly fileId: string; readonly [key: string]: unknown }>
): LocalFilesState {
  const map: Record<string, unknown> = {}
  for (const row of rows) {
    map[row.fileId] = row
  }
  return map as LocalFilesState
}

/**
 * Compute aggregate sync status from local files state
 *
 * This is a pure function that derives sync status from the localFileState
 * SQLite table. Use {@link rowsToLocalFilesState} to convert query results
 * into the expected map format, then pass to this function.
 *
 * @example
 * ```typescript
 * // With React useQuery
 * const rows = store.useQuery(queryDb(tables.localFileState.select()))
 * const localFilesState = useMemo(() => rowsToLocalFilesState(rows), [rows])
 * const status = getSyncStatus(localFilesState)
 *
 * // With Vue useQuery
 * const rows = useQuery(queryDb(tables.localFileState.select()))
 * const status = computed(() => getSyncStatus(rowsToLocalFilesState(rows.value)))
 *
 * // With store.query (one-time read)
 * const rows = store.query(queryDb(tables.localFileState.select()))
 * const status = getSyncStatus(rowsToLocalFilesState(rows))
 * ```
 *
 * @param localFilesState - Map of file IDs to local file state objects
 * @returns Aggregate sync status with counts and file ID lists
 */
export function getSyncStatus(localFilesState: LocalFilesState): SyncStatus {
  const uploadingFileIds: Array<string> = []
  const downloadingFileIds: Array<string> = []
  const queuedUploadFileIds: Array<string> = []
  const queuedDownloadFileIds: Array<string> = []
  const pendingUploadFileIds: Array<string> = []
  const pendingDownloadFileIds: Array<string> = []
  const errors: Array<SyncError> = []
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
    hasPending: queuedUploadCount > 0 ||
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

/**
 * Create an ActiveTransferProgress object from progress values
 *
 * @param fileId - The file ID being transferred
 * @param kind - Whether this is an upload or download
 * @param loaded - Bytes transferred so far
 * @param total - Total bytes to transfer
 * @returns An ActiveTransferProgress object
 */
export function createActiveTransferProgress(
  fileId: string,
  kind: "upload" | "download",
  loaded: number,
  total: number
): ActiveTransferProgress {
  const percent = total > 0 ? Math.round((loaded / total) * 100) : null
  return { fileId, kind, loaded, total, percent }
}

/**
 * Update an ActiveTransfers map with new progress
 *
 * @param transfers - Current active transfers map
 * @param progress - New progress to merge
 * @returns Updated active transfers map
 */
export function updateActiveTransfers(
  transfers: ActiveTransfers,
  progress: ActiveTransferProgress
): ActiveTransfers {
  return { ...transfers, [progress.fileId]: progress }
}

/**
 * Remove a file from the active transfers map
 *
 * @param transfers - Current active transfers map
 * @param fileId - File ID to remove
 * @returns Updated active transfers map
 */
export function removeActiveTransfer(
  transfers: ActiveTransfers,
  fileId: string
): ActiveTransfers {
  const { [fileId]: _, ...rest } = transfers
  return rest
}

/**
 * Compute total progress across all active transfers
 *
 * @param transfers - Active transfers map
 * @returns Object with totalLoaded, totalSize, and overall percent
 */
export function computeTotalProgress(transfers: ActiveTransfers): {
  totalLoaded: number
  totalSize: number
  percent: number | null
  count: number
} {
  const values = Object.values(transfers)
  if (values.length === 0) {
    return { totalLoaded: 0, totalSize: 0, percent: null, count: 0 }
  }

  let totalLoaded = 0
  let totalSize = 0
  let hasUnknownSize = false

  for (const transfer of values) {
    totalLoaded += transfer.loaded
    if (transfer.total > 0) {
      totalSize += transfer.total
    } else {
      hasUnknownSize = true
    }
  }

  const percent = hasUnknownSize || totalSize === 0
    ? null
    : Math.round((totalLoaded / totalSize) * 100)

  return { totalLoaded, totalSize, percent, count: values.length }
}
