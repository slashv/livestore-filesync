/**
 * Thumbnail Worker - Canvas-based processor
 *
 * This worker uses the canvas-based processor instead of wasm-vips.
 * This is a lightweight alternative that doesn't require WASM loading.
 *
 * Note: Canvas processor has limitations:
 * - Converts all images to sRGB (no ICC profile preservation)
 * - No lossless WebP support
 * - Strips all metadata
 */
import "@livestore-filesync/image/thumbnails/workers/canvas.worker"
