/**
 * wasm-vips initialization and lazy loading
 *
 * Shared module for initializing wasm-vips across the image package.
 * Used by both the preprocessor (main thread) and worker (thumbnail generation).
 *
 * @module
 */

// @ts-ignore - wasm-vips module requires special import handling
import Vips from "wasm-vips"

// Vips instance type - inferred from the module
type VipsInstance = Awaited<ReturnType<typeof Vips>>

let vipsInstance: VipsInstance | null = null
let vipsInitPromise: Promise<VipsInstance> | null = null

/**
 * Options for initializing wasm-vips
 */
export interface VipsInitOptions {
  /**
   * Custom function to locate the WASM file.
   * By default, assumes the WASM file is in the root public directory.
   *
   * @example
   * ```typescript
   * // Custom path
   * locateFile: (path) => `/wasm/${path}`
   *
   * // CDN
   * locateFile: (path) => `https://cdn.example.com/wasm/${path}`
   * ```
   */
  locateFile?: (path: string) => string
}

/**
 * Default WASM file locator
 * Assumes the WASM file is in the root public directory
 */
const defaultLocateFile = (path: string): string => {
  if (path.endsWith(".wasm")) {
    return `/${path}`
  }
  return path
}

/**
 * Initialize wasm-vips lazily (only when first image is processed).
 * WASM is cached by browser after first load.
 *
 * @param options - Initialization options
 * @returns Promise resolving to the Vips instance
 *
 * @example
 * ```typescript
 * const vips = await initVips()
 * const image = vips.Image.newFromBuffer(buffer)
 * ```
 */
export async function initVips(options: VipsInitOptions = {}): Promise<VipsInstance> {
  if (vipsInstance) {
    return vipsInstance
  }

  if (vipsInitPromise) {
    return vipsInitPromise
  }

  const locateFile = options.locateFile ?? defaultLocateFile

  vipsInitPromise = Vips({
    // Disable dynamic libraries to reduce complexity
    dynamicLibraries: [],
    // Locate the WASM file
    locateFile
  }).then((instance: VipsInstance) => {
    vipsInstance = instance
    return instance
  })

  return vipsInitPromise
}

/**
 * Check if wasm-vips is initialized
 */
export function isVipsInitialized(): boolean {
  return vipsInstance !== null
}

/**
 * Get the current Vips instance if initialized, or null
 */
export function getVipsInstance(): VipsInstance | null {
  return vipsInstance
}
