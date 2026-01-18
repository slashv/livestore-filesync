/**
 * Thumbnail Worker Entry Point (wasm-vips)
 *
 * This file should be imported by apps in their own worker file.
 * It handles thumbnail generation using wasm-vips.
 *
 * For canvas-based processing (no WASM), import from './workers/canvas.worker.js' instead.
 *
 * @example
 * ```typescript
 * // In your app's thumbnail.worker.ts (using vips - recommended)
 * import '@livestore-filesync/image/thumbnails/worker'
 *
 * // Or for canvas-based processing (lightweight, no WASM)
 * import '@livestore-filesync/image/thumbnails/workers/canvas.worker'
 * ```
 *
 * @module
 */

// Re-export the vips worker for backwards compatibility
import "./workers/vips.worker.js"
