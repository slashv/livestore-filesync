/**
 * Utility exports
 *
 * @module
 */

import type { FileThumbnailState, ThumbnailFilesState, ThumbnailSizeState } from "../types/index.js"

export { isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "../types/index.js"

/**
 * Parse the sizesJson string from a thumbnailState row into a typed record.
 */
const parseSizesJson = (sizesJson: string): Record<string, ThumbnailSizeState> => {
  try {
    return JSON.parse(sizesJson) as Record<string, ThumbnailSizeState>
  } catch {
    return {}
  }
}

/**
 * Convert an array of thumbnailState table rows into a ThumbnailFilesState map.
 *
 * Use this when reading the thumbnailState SQLite table (which returns rows)
 * and you need the map format keyed by fileId with parsed `sizes`.
 *
 * @example
 * ```typescript
 * // React
 * const rows = store.useQuery(queryDb(tables.thumbnailState.select()))
 * const thumbnailFiles = useMemo(() => rowsToThumbnailFilesState(rows), [rows])
 * const status = thumbnailFiles[fileId]?.sizes?.['small']?.status ?? 'pending'
 *
 * // Vue
 * const rows = useQuery(queryDb(tables.thumbnailState.select()))
 * const thumbnailFiles = computed(() => rowsToThumbnailFilesState(rows.value))
 * ```
 */
export function rowsToThumbnailFilesState(
  rows: ReadonlyArray<{ readonly fileId: string; readonly sizesJson?: string; readonly [key: string]: unknown }>
): ThumbnailFilesState {
  const map: Record<string, FileThumbnailState> = {}
  for (const row of rows) {
    map[row.fileId] = {
      fileId: row.fileId,
      contentHash: (row.contentHash as string) ?? "",
      mimeType: (row.mimeType as string) ?? "",
      sizes: parseSizesJson(row.sizesJson ?? "{}")
    }
  }
  return map
}
