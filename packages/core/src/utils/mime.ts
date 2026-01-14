/**
 * MIME type utilities for file preprocessors
 *
 * @module
 */

import type { FilePreprocessor, PreprocessorMap } from "../types/index.js"

/**
 * Match a MIME type against a pattern with wildcard support.
 *
 * Pattern matching rules:
 * - Exact match: 'image/png' matches only 'image/png'
 * - Wildcard subtype: 'image/*' matches 'image/png', 'image/jpeg', etc.
 * - Universal wildcard: '*' or '*\/*' matches any MIME type
 *
 * @param pattern - The pattern to match against (e.g., 'image/*', 'image/png', '*')
 * @param mimeType - The MIME type to test (e.g., 'image/png')
 * @returns true if the MIME type matches the pattern
 *
 * @example
 * ```typescript
 * matchMimeType('image/*', 'image/png')     // true
 * matchMimeType('image/png', 'image/png')   // true
 * matchMimeType('image/png', 'image/jpeg')  // false
 * matchMimeType('*', 'video/mp4')           // true
 * ```
 */
export function matchMimeType(pattern: string, mimeType: string): boolean {
  // Normalize inputs
  const normalizedPattern = pattern.toLowerCase().trim()
  const normalizedMimeType = mimeType.toLowerCase().trim()

  // Universal wildcards
  if (normalizedPattern === "*" || normalizedPattern === "*/*") {
    return true
  }

  // Exact match
  if (normalizedPattern === normalizedMimeType) {
    return true
  }

  // Wildcard subtype (e.g., 'image/*')
  if (normalizedPattern.endsWith("/*")) {
    const patternType = normalizedPattern.slice(0, -2) // Remove '/*'
    const mimeTypeParts = normalizedMimeType.split("/")
    if (mimeTypeParts.length >= 1) {
      return mimeTypeParts[0] === patternType
    }
  }

  return false
}

/**
 * Find a matching preprocessor for a given MIME type.
 *
 * The function checks patterns in the following priority order:
 * 1. Exact match (e.g., 'image/png')
 * 2. Wildcard match (e.g., 'image/*')
 * 3. Universal wildcard ('*' or '*\/*')
 *
 * @param preprocessors - Map of MIME patterns to preprocessor functions
 * @param mimeType - The MIME type to find a preprocessor for
 * @returns The matching preprocessor function, or undefined if no match
 *
 * @example
 * ```typescript
 * const preprocessors = {
 *   'image/png': convertPng,
 *   'image/*': resizeImage,
 *   '*': logFile
 * }
 *
 * findPreprocessor(preprocessors, 'image/png')  // Returns convertPng (exact match)
 * findPreprocessor(preprocessors, 'image/jpeg') // Returns resizeImage (wildcard)
 * findPreprocessor(preprocessors, 'video/mp4')  // Returns logFile (universal)
 * ```
 */
export function findPreprocessor(
  preprocessors: PreprocessorMap,
  mimeType: string
): FilePreprocessor | undefined {
  const normalizedMimeType = mimeType.toLowerCase().trim()

  // Priority 1: Exact match
  if (preprocessors[normalizedMimeType]) {
    return preprocessors[normalizedMimeType]
  }

  // Also check for case variations in the map
  for (const pattern of Object.keys(preprocessors)) {
    if (pattern.toLowerCase().trim() === normalizedMimeType) {
      return preprocessors[pattern]
    }
  }

  // Priority 2: Wildcard subtype match (e.g., 'image/*')
  const mimeTypeParts = normalizedMimeType.split("/")
  if (mimeTypeParts.length >= 1) {
    const wildcardPattern = `${mimeTypeParts[0]}/*`
    if (preprocessors[wildcardPattern]) {
      return preprocessors[wildcardPattern]
    }
    // Check case variations
    for (const pattern of Object.keys(preprocessors)) {
      if (pattern.toLowerCase().trim() === wildcardPattern) {
        return preprocessors[pattern]
      }
    }
  }

  // Priority 3: Universal wildcard
  if (preprocessors["*"]) {
    return preprocessors["*"]
  }
  if (preprocessors["*/*"]) {
    return preprocessors["*/*"]
  }

  return undefined
}

/**
 * Apply the appropriate preprocessor to a file based on its MIME type.
 *
 * If no matching preprocessor is found, the original file is returned unchanged.
 *
 * @param preprocessors - Map of MIME patterns to preprocessor functions
 * @param file - The file to preprocess
 * @returns The preprocessed file (or original if no preprocessor matched)
 *
 * @example
 * ```typescript
 * const preprocessors = {
 *   'image/*': async (file) => resizeImage(file, { maxDimension: 1500 })
 * }
 *
 * const processedFile = await applyPreprocessor(preprocessors, imageFile)
 * ```
 */
export async function applyPreprocessor(
  preprocessors: PreprocessorMap | undefined,
  file: File
): Promise<File> {
  if (!preprocessors || Object.keys(preprocessors).length === 0) {
    return file
  }

  const preprocessor = findPreprocessor(preprocessors, file.type)
  if (!preprocessor) {
    return file
  }

  return preprocessor(file)
}
