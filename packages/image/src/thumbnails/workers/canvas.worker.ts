/**
 * Canvas-based thumbnail worker
 *
 * Uses Canvas API for lightweight thumbnail generation without WASM dependencies.
 * Note: This processor converts images to sRGB and strips metadata.
 *
 * @example
 * ```typescript
 * // In your app's thumbnail.worker.ts
 * import '@livestore-filesync/image/thumbnails/workers/canvas.worker'
 * ```
 *
 * @module
 */

import { createCanvasProcessor } from "../../processor/canvas.js"
import { setupThumbnailWorker } from "../worker-core.js"

setupThumbnailWorker(createCanvasProcessor())
