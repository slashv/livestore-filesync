/**
 * Utility exports
 *
 * @module
 */

import type { ThumbnailSizeState } from "../types/index.js"

export { isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "../types/index.js"

/**
 * Parse the `sizesJson` string from a thumbnailState table row into a typed record.
 *
 * The thumbnailState table stores thumbnail generation status per size as a JSON
 * string in the `sizesJson` column. Use this to access individual size statuses.
 *
 * @example
 * ```typescript
 * // React — per-file query
 * const thumbRow = store.useQuery(
 *   queryDb(tables.thumbnailState.where({ fileId: file.id }).first())
 * )
 * const sizes = parseThumbnailSizes(thumbRow?.sizesJson)
 * const smallStatus = sizes['small']?.status ?? 'pending'
 *
 * // Vue — per-file query
 * const thumbRow = useQuery(
 *   queryDb(tables.thumbnailState.where({ fileId: file.id }).first())
 * )
 * const sizes = computed(() => parseThumbnailSizes(thumbRow.value?.sizesJson))
 * ```
 *
 * @param sizesJson - The JSON string from the thumbnailState row's sizesJson column
 * @returns Parsed record of size name to thumbnail size state
 */
export function parseThumbnailSizes(
  sizesJson?: string | null
): Record<string, ThumbnailSizeState> {
  if (!sizesJson) return {}
  try {
    return JSON.parse(sizesJson) as Record<string, ThumbnailSizeState>
  } catch {
    return {}
  }
}
