/**
 * Expo adapters for livestore-filesync
 *
 * This package provides Expo/React Native implementations for:
 * - FileSystem: Effect Platform FileSystem using expo-file-system
 * - ImageProcessor: UriImageProcessor using expo-image-manipulator
 * - ExpoFile: File-like wrapper for URI-based files
 *
 * @example
 * ```typescript
 * // FileSystem usage
 * import { layer as expoFileSystemLayer } from '@livestore-filesync/expo'
 * import { initFileSync } from '@livestore-filesync/core'
 *
 * initFileSync(store, {
 *   fileSystem: expoFileSystemLayer(),
 *   remote: { signerBaseUrl: 'https://api.example.com' }
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Image processor usage
 * import { createExpoImageProcessor, ExpoFile } from '@livestore-filesync/expo'
 *
 * const processor = createExpoImageProcessor()
 * await processor.init()
 *
 * const result = await processor.process('file:///path/to/image.jpg', {
 *   maxDimension: 1500,
 *   format: 'jpeg',
 *   quality: 85
 * })
 *
 * // Convert result URI to File-like object for use with FilePreprocessor
 * const file = ExpoFile.fromUri(result.uri, {
 *   type: result.mimeType
 * })
 * ```
 *
 * @module
 */

// FileSystem exports
export {
  ExpoFileSystemNotAvailableError,
  type ExpoFileSystemOptions,
  layer,
  layerDefault,
  makeExpoFileSystem
} from "./ExpoFileSystem.js"

// Image processor exports
export {
  createExpoImageProcessor,
  type ExpoImageProcessorOptions,
  type ImageProcessorCapabilities,
  type ProcessedImageUri,
  type ProcessImageOptions,
  type UriImageProcessor
} from "./ExpoImageProcessor.js"

// File wrapper exports
export { ExpoFile } from "./ExpoFile.js"
