/**
 * Path utilities for content-addressable storage
 *
 * @module
 */

/**
 * Join path segments
 */
export const joinPath = (...segments: Array<string>): string => segments.filter((s) => s.length > 0).join("/")

/**
 * Base directory for file storage
 */
export const FILES_ROOT = "livestore-filesync-files"

/**
 * Backwards-compatible alias
 */
export const FILES_DIRECTORY = FILES_ROOT

/**
 * Sanitize storeId for filesystem-safe usage
 */
export const sanitizeStoreId = (storeId: string): string => storeId.replace(/[^A-Za-z0-9._-]/g, "_")

/**
 * Build the store-scoped root path
 */
export const makeStoreRoot = (storeId: string): string => joinPath(FILES_ROOT, sanitizeStoreId(storeId))

/**
 * Generate a storage path from a content hash
 *
 * Uses content-addressable storage pattern where files are stored
 * by their hash, enabling automatic deduplication.
 *
 * @example
 * ```ts
 * makeStoredPath("store-1", "abc123...") // => "livestore-filesync-files/store-1/abc123..."
 * ```
 */
export const makeStoredPath = (storeId: string, hash: string): string => joinPath(makeStoreRoot(storeId), hash)

/**
 * Strip the files root prefix from a stored path for remote storage keys.
 */
export const stripFilesRoot = (path: string): string => {
  const normalized = path.startsWith("/") ? path.slice(1) : path
  const prefix = `${FILES_ROOT}/`
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length)
  }
  return normalized
}

/**
 * Extract the hash from a stored path
 *
 * @example
 * ```ts
 * extractHashFromPath("livestore-filesync-files/store-1/abc123...") // => "abc123..."
 * ```
 */
export const extractHashFromPath = (path: string): string => {
  const parts = path.split("/").filter((segment) => segment.length > 0)
  return parts[parts.length - 1] ?? path
}

/**
 * Parse a path into directory and filename components
 */
export const parsePath = (path: string): { directory: string; filename: string } => {
  const lastSlashIndex = path.lastIndexOf("/")
  if (lastSlashIndex === -1) {
    return { directory: "", filename: path }
  }
  return {
    directory: path.slice(0, lastSlashIndex),
    filename: path.slice(lastSlashIndex + 1)
  }
}

/**
 * Join path segments
 */
