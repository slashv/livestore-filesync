/**
 * Image preprocessing for livestore-filesync
 *
 * This module provides high-quality image preprocessing using wasm-vips.
 * Use it to resize, compress, and convert images before saving.
 *
 * ## Setup
 *
 * 1. Install the package:
 *    ```bash
 *    pnpm add @livestore-filesync/image wasm-vips
 *    ```
 *
 * 2. Copy the wasm-vips WASM file to your public directory:
 *    ```bash
 *    cp node_modules/wasm-vips/lib/vips.wasm public/
 *    ```
 *
 * 3. Configure the preprocessor:
 *    ```typescript
 *    import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'
 *    import { initFileSync } from '@livestore-filesync/core'
 *    import { layer as opfsLayer } from '@livestore-filesync/opfs'
 *
 *    initFileSync(store, {
 *      fileSystem: opfsLayer(),
 *      remote: { signerBaseUrl: '/api' },
 *      options: {
 *        preprocessors: {
 *          'image/*': createImagePreprocessor({
 *            maxDimension: 1500,  // Max width/height in pixels
 *            quality: 90,         // JPEG/WebP quality (1-100)
 *            format: 'jpeg'       // Output format: 'jpeg', 'webp', or 'png'
 *          })
 *        }
 *      }
 *    })
 *    ```
 *
 * @module
 */

export {
  createImagePreprocessor,
  createResizeOnlyPreprocessor,
  defaultImagePreprocessorOptions,
  type ImageFormat,
  type ImagePreprocessorOptions
} from "./preprocessor.js"

export { getVipsInstance, initVips, isVipsInitialized, type VipsInitOptions } from "../vips.js"
