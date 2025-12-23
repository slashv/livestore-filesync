/**
 * Path utilities for content-addressable storage
 *
 * @module
 */

/**
 * Base directory for file storage
 */
export const FILES_DIRECTORY = "files"

/**
 * Generate a storage path from a content hash
 *
 * Uses content-addressable storage pattern where files are stored
 * by their hash, enabling automatic deduplication.
 *
 * @example
 * ```ts
 * makeStoredPath("abc123...") // => "files/abc123..."
 * ```
 */
export const makeStoredPath = (hash: string): string => `${FILES_DIRECTORY}/${hash}`

/**
 * Extract the hash from a stored path
 *
 * @example
 * ```ts
 * extractHashFromPath("files/abc123...") // => "abc123..."
 * ```
 */
export const extractHashFromPath = (path: string): string => {
  const prefix = `${FILES_DIRECTORY}/`
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length)
  }
  return path
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
export const joinPath = (...segments: string[]): string =>
  segments.filter((s) => s.length > 0).join("/")
