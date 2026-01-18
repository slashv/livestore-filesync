/**
 * Vips-based thumbnail worker
 *
 * Uses wasm-vips for high-quality thumbnail generation with ICC profile preservation.
 *
 * @example
 * ```typescript
 * // In your app's thumbnail.worker.ts
 * import '@livestore-filesync/image/thumbnails/workers/vips.worker'
 * ```
 *
 * @module
 */

import { createVipsProcessor } from "../../processor/vips.js"
import { setupThumbnailWorker } from "../worker-core.js"

setupThumbnailWorker(createVipsProcessor())
