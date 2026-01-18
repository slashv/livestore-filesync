/**
 * Expo-based image processor implementation
 *
 * Uses expo-image-manipulator for image processing on React Native.
 * Implements the UriImageProcessor interface from @livestore-filesync/image.
 *
 * @module
 */

// Platform detection for WebP support
// We check for Android platform at runtime
interface PlatformModule {
  OS: string
}

let _platform: PlatformModule | null = null

const getPlatform = async (): Promise<PlatformModule> => {
  if (!_platform) {
    try {
      // Dynamic import to avoid bundling issues - react-native types provided by consuming app
      // @ts-ignore - react-native is a peer dependency
      const rn = (await import("react-native")) as { Platform: PlatformModule }
      _platform = rn.Platform
    } catch {
      // Fallback for non-RN environments (e.g., testing)
      _platform = { OS: "unknown" }
    }
  }
  return _platform
}

// Synchronous platform check - call after getPlatform() has been called
const getPlatformSync = (): PlatformModule => {
  if (!_platform) {
    // Default to non-Android if not initialized
    return { OS: "unknown" }
  }
  return _platform
}

// Types matching @livestore-filesync/image processor types
// We duplicate these here to avoid a circular dependency

export interface ProcessImageOptions {
  maxDimension: number
  format: "jpeg" | "webp" | "png"
  quality?: number
  keepIccProfile?: boolean
  losslessThreshold?: number
}

export interface ProcessedImageUri {
  uri: string
  width: number
  height: number
  mimeType: string
}

export interface ImageProcessorCapabilities {
  preservesIccProfile: boolean
  supportsLossless: boolean
  preservesMetadata: boolean
  supportedFormats: ReadonlyArray<"jpeg" | "webp" | "png">
  runsOffMainThread: boolean
}

export interface UriImageProcessor {
  readonly type: "uri"
  readonly capabilities: ImageProcessorCapabilities
  init(): Promise<void>
  isInitialized(): boolean
  process(inputUri: string, options: ProcessImageOptions): Promise<ProcessedImageUri>
  processMultiple(
    inputUri: string,
    sizes: Record<string, number>,
    options: Omit<ProcessImageOptions, "maxDimension">
  ): Promise<Record<string, ProcessedImageUri>>
}

// Expo Image Manipulator types
interface ImageManipulatorContext {
  resize(options: { width?: number; height?: number }): ImageManipulatorContext
  crop(options: {
    originX: number
    originY: number
    width: number
    height: number
  }): ImageManipulatorContext
  rotate(degrees: number): ImageManipulatorContext
  flip(direction: "vertical" | "horizontal"): ImageManipulatorContext
  renderAsync(): Promise<ImageRef>
}

interface ImageRef {
  width: number
  height: number
  saveAsync(options?: SaveOptions): Promise<SavedImage>
}

interface SaveOptions {
  format?: "jpeg" | "png" | "webp"
  compress?: number
  base64?: boolean
}

interface SavedImage {
  uri: string
  width: number
  height: number
  base64?: string
}

// Use imperative API (not hooks) for processor
interface ImageManipulatorStatic {
  manipulate(uri: string): ImageManipulatorContext
}

let _manipulator: ImageManipulatorStatic | null = null

const getManipulator = async (): Promise<ImageManipulatorStatic> => {
  if (!_manipulator) {
    // Dynamic import - expo-image-manipulator types provided by consuming app
    // @ts-ignore - expo-image-manipulator is a peer dependency
    const module = (await import("expo-image-manipulator")) as unknown as ImageManipulatorStatic
    _manipulator = module
  }
  return _manipulator
}

/**
 * Check if WebP is supported on the current platform (synchronous after init)
 */
const isWebPSupported = (): boolean => {
  // WebP encoding is only supported on Android
  const platform = getPlatformSync()
  return platform.OS === "android"
}

/**
 * Get the appropriate format, falling back to JPEG on iOS if WebP requested
 */
const resolveFormat = (requestedFormat: "jpeg" | "webp" | "png"): "jpeg" | "webp" | "png" => {
  if (requestedFormat === "webp" && !isWebPSupported()) {
    return "jpeg"
  }
  return requestedFormat
}

/**
 * Get MIME type from format
 */
const getMimeType = (format: "jpeg" | "webp" | "png"): string => {
  switch (format) {
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "png":
      return "image/png"
  }
}

export interface ExpoImageProcessorOptions {
  /**
   * Default quality for JPEG/WebP compression (0-100)
   * @default 90
   */
  defaultQuality?: number
}

/**
 * Create an Expo-based image processor using expo-image-manipulator
 *
 * @param options - Processor options
 * @returns A UriImageProcessor instance
 *
 * @example
 * ```typescript
 * import { createExpoImageProcessor } from '@livestore-filesync/expo'
 *
 * const processor = createExpoImageProcessor()
 * await processor.init()
 *
 * const result = await processor.process('file:///path/to/image.jpg', {
 *   maxDimension: 1500,
 *   format: 'jpeg',
 *   quality: 85
 * })
 * console.log(result.uri, result.width, result.height)
 * ```
 */
export function createExpoImageProcessor(
  options: ExpoImageProcessorOptions = {}
): UriImageProcessor {
  const defaultQuality = options.defaultQuality ?? 90
  let initialized = false

  const capabilities: ImageProcessorCapabilities = {
    preservesIccProfile: false, // expo-image-manipulator converts to sRGB
    supportsLossless: false, // No lossless WebP support
    preservesMetadata: false, // Metadata is stripped
    supportedFormats: isWebPSupported() ? ["jpeg", "webp", "png"] : ["jpeg", "png"],
    runsOffMainThread: true // Native processing runs on native thread
  }

  const init = async (): Promise<void> => {
    if (initialized) return

    // Pre-load the platform and manipulator modules
    await getPlatform()
    await getManipulator()
    initialized = true
  }

  const isInitialized = (): boolean => initialized

  const process = async (
    inputUri: string,
    processOptions: ProcessImageOptions
  ): Promise<ProcessedImageUri> => {
    if (!initialized) {
      await init()
    }

    const manipulator = await getManipulator()
    const format = resolveFormat(processOptions.format)
    const quality = processOptions.quality ?? defaultQuality

    // Start manipulation context
    let context = manipulator.manipulate(inputUri)

    // Resize if maxDimension is specified
    if (processOptions.maxDimension > 0) {
      // We resize by setting one dimension and letting aspect ratio be preserved
      // The manipulator will scale proportionally
      context = context.resize({
        width: processOptions.maxDimension,
        height: processOptions.maxDimension
      })
    }

    // Render the manipulations
    const rendered = await context.renderAsync()

    // Save with the specified format and quality
    const saved = await rendered.saveAsync({
      format,
      compress: quality / 100 // expo-image-manipulator uses 0-1 range
    })

    return {
      uri: saved.uri,
      width: saved.width,
      height: saved.height,
      mimeType: getMimeType(format)
    }
  }

  const processMultiple = async (
    inputUri: string,
    sizes: Record<string, number>,
    processOptions: Omit<ProcessImageOptions, "maxDimension">
  ): Promise<Record<string, ProcessedImageUri>> => {
    if (!initialized) {
      await init()
    }

    const results: Record<string, ProcessedImageUri> = {}

    // Process each size
    // Note: Unlike vips, we can't efficiently reuse the decoded image
    // Each resize operation will reload the source
    for (const [sizeName, maxDimension] of Object.entries(sizes)) {
      results[sizeName] = await process(inputUri, {
        ...processOptions,
        maxDimension
      })
    }

    return results
  }

  return {
    type: "uri",
    capabilities,
    init,
    isInitialized,
    process,
    processMultiple
  }
}
