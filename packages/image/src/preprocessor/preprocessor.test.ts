import { describe, expect, it } from "vitest"
import { createCanvasImagePreprocessor } from "./canvas-preprocessor.js"
import {
  createImagePreprocessor,
  createResizeOnlyPreprocessor,
  defaultImagePreprocessorOptions,
  type ImagePreprocessorOptions
} from "./preprocessor.js"

/**
 * Note: Full integration tests for image processing require wasm-vips WASM file.
 * These tests focus on:
 * 1. Default options and configuration
 * 2. Size threshold skip behavior (no WASM needed)
 * 3. Format match skip behavior for early exit (no WASM needed when maxDimension=0)
 * 4. API contract and type correctness
 *
 * The skip behavior pattern is also tested in:
 * packages/core/src/utils/mime.test.ts > "applyPreprocessor - skip behavior patterns"
 * packages/core/src/services/file-sync/FileSync.storage.test.ts > "FileSync - Preprocessor integration"
 */

const withMockImageBitmap = async <T>(
  dimensions: { width: number; height: number },
  fn: () => Promise<T>
): Promise<T> => {
  const previous = globalThis.createImageBitmap
  globalThis.createImageBitmap = (async () => ({
    width: dimensions.width,
    height: dimensions.height,
    close: () => {}
  })) as typeof createImageBitmap
  try {
    return await fn()
  } finally {
    globalThis.createImageBitmap = previous
  }
}

const withRejectingImageBitmap = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = globalThis.createImageBitmap
  globalThis.createImageBitmap = (async () => {
    throw new Error("decode failed")
  }) as typeof createImageBitmap
  try {
    return await fn()
  } finally {
    globalThis.createImageBitmap = previous
  }
}

const withMockCanvasApi = async <T>(
  dimensions: { width: number; height: number },
  fn: () => Promise<T>
): Promise<T> => {
  const previousImageBitmap = globalThis.createImageBitmap
  const previousOffscreenCanvas = globalThis.OffscreenCanvas

  class MockOffscreenCanvas {
    readonly width: number
    readonly height: number

    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }

    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: () => {}
      }
    }

    async convertToBlob(options?: ImageEncodeOptions) {
      return new Blob(["processed"], { type: options?.type ?? "image/png" })
    }
  }

  globalThis.createImageBitmap = (async () => ({
    width: dimensions.width,
    height: dimensions.height,
    close: () => {}
  })) as typeof createImageBitmap
  globalThis.OffscreenCanvas = MockOffscreenCanvas as unknown as typeof OffscreenCanvas

  try {
    return await fn()
  } finally {
    globalThis.createImageBitmap = previousImageBitmap
    globalThis.OffscreenCanvas = previousOffscreenCanvas
  }
}

describe("defaultImagePreprocessorOptions", () => {
  it("should have correct default values", () => {
    expect(defaultImagePreprocessorOptions.maxDimension).toBe(1500)
    expect(defaultImagePreprocessorOptions.quality).toBe(90)
    expect(defaultImagePreprocessorOptions.format).toBe("jpeg")
    expect(defaultImagePreprocessorOptions.minSizeThreshold).toBe(0)
  })

  it("should have all required keys", () => {
    const keys = Object.keys(defaultImagePreprocessorOptions)
    expect(keys).toContain("maxDimension")
    expect(keys).toContain("quality")
    expect(keys).toContain("format")
    expect(keys).toContain("minSizeThreshold")
  })
})

describe("createImagePreprocessor", () => {
  it("returns a function", () => {
    const preprocessor = createImagePreprocessor()
    expect(typeof preprocessor).toBe("function")
  })

  it("accepts custom options", () => {
    const options: ImagePreprocessorOptions = {
      maxDimension: 800,
      quality: 75,
      format: "webp",
      minSizeThreshold: 1024
    }
    const preprocessor = createImagePreprocessor(options)
    expect(typeof preprocessor).toBe("function")
  })

  it("accepts empty options object", () => {
    const preprocessor = createImagePreprocessor({})
    expect(typeof preprocessor).toBe("function")
  })

  describe("minSizeThreshold skip behavior", () => {
    it("skips files below size threshold without loading WASM", async () => {
      const preprocessor = createImagePreprocessor({
        minSizeThreshold: 1000 // Skip files under 1KB
      })

      // Create a small file (under threshold)
      const smallFile = new File(["tiny"], "small.png", { type: "image/png" })
      expect(smallFile.size).toBeLessThan(1000)

      // Should return original file unchanged (no WASM needed)
      const result = await preprocessor(smallFile)
      expect(result).toEqual({
        file: smallFile,
        metadata: {
          mimeType: "image/png",
          sizeBytes: smallFile.size
        }
      })
    })

    it("returns dimensions for skipped files when dimensions can be extracted", async () => {
      const preprocessor = createImagePreprocessor({
        minSizeThreshold: 1000
      })
      const smallFile = new File(["tiny"], "small.png", { type: "image/png" })

      const result = await withMockImageBitmap({ width: 40, height: 20 }, () => preprocessor(smallFile))

      expect(result).toEqual({
        file: smallFile,
        metadata: {
          mimeType: "image/png",
          sizeBytes: smallFile.size,
          image: { width: 40, height: 20 }
        }
      })
    })

    it("does not skip files at or above size threshold", async () => {
      const preprocessor = createImagePreprocessor({
        minSizeThreshold: 10
      })

      // Create a file at threshold
      const content = "x".repeat(15)
      const file = new File([content], "image.png", { type: "image/png" })
      expect(file.size).toBeGreaterThanOrEqual(10)

      // This would try to load WASM and fail in test environment
      // We expect it to throw because WASM isn't available
      await expect(preprocessor(file)).rejects.toThrow()
    })
  })

  describe("format match early exit", () => {
    it("skips already-matching format when maxDimension is 0", async () => {
      const preprocessor = createImagePreprocessor({
        format: "jpeg",
        maxDimension: 0 // Disable resizing
      })

      // File is already JPEG
      const jpegFile = new File(["jpeg data"], "photo.jpg", { type: "image/jpeg" })

      // Should return original file (early exit before WASM load)
      const result = await preprocessor(jpegFile)
      expect(result).toEqual({
        file: jpegFile,
        metadata: {
          mimeType: "image/jpeg",
          sizeBytes: jpegFile.size
        }
      })
    })

    it("skips already-matching webp format when maxDimension is 0", async () => {
      const preprocessor = createImagePreprocessor({
        format: "webp",
        maxDimension: 0
      })

      const webpFile = new File(["webp data"], "image.webp", { type: "image/webp" })
      const result = await preprocessor(webpFile)
      expect(result).toEqual({
        file: webpFile,
        metadata: {
          mimeType: "image/webp",
          sizeBytes: webpFile.size
        }
      })
    })

    it("skips already-matching png format when maxDimension is 0", async () => {
      const preprocessor = createImagePreprocessor({
        format: "png",
        maxDimension: 0
      })

      const pngFile = new File(["png data"], "image.png", { type: "image/png" })
      const result = await preprocessor(pngFile)
      expect(result).toEqual({
        file: pngFile,
        metadata: {
          mimeType: "image/png",
          sizeBytes: pngFile.size
        }
      })
    })

    it("returns final dimensions for unchanged target-format files", async () => {
      const preprocessor = createImagePreprocessor({
        format: "jpeg",
        maxDimension: 0
      })
      const jpegFile = new File(["jpeg data"], "photo.jpg", { type: "image/jpeg" })

      const result = await withMockImageBitmap({ width: 640, height: 480 }, () => preprocessor(jpegFile))

      expect(result).toEqual({
        file: jpegFile,
        metadata: {
          mimeType: "image/jpeg",
          sizeBytes: jpegFile.size,
          image: { width: 640, height: 480 }
        }
      })
    })

    it("preserves skip behavior when dimension probing fails", async () => {
      const preprocessor = createImagePreprocessor({
        format: "png",
        maxDimension: 0
      })
      const pngFile = new File(["png data"], "image.png", { type: "image/png" })

      const result = await withRejectingImageBitmap(() => preprocessor(pngFile))

      expect(result).toEqual({
        file: pngFile,
        metadata: {
          mimeType: "image/png",
          sizeBytes: pngFile.size
        }
      })
    })

    it("returns final dimensions for transformed canvas-backed images", async () => {
      const preprocessor = createImagePreprocessor({
        processor: "canvas",
        format: "jpeg",
        maxDimension: 50
      })
      const pngFile = new File(["png data"], "image.png", { type: "image/png" })

      const result = await withMockCanvasApi({ width: 100, height: 50 }, () => preprocessor(pngFile))

      expect(result).toMatchObject({
        metadata: {
          mimeType: "image/jpeg",
          sizeBytes: "processed".length,
          image: { width: 50, height: 25 }
        }
      })
      expect((result as { file: File }).file.type).toBe("image/jpeg")
    })

    it("does not skip when format does not match (even with maxDimension=0)", async () => {
      const preprocessor = createImagePreprocessor({
        format: "jpeg",
        maxDimension: 0
      })

      // File is PNG, target is JPEG - needs conversion
      const pngFile = new File(["png data"], "image.png", { type: "image/png" })

      // Should try to process (and fail because WASM isn't available)
      await expect(preprocessor(pngFile)).rejects.toThrow()
    })
  })
})

describe("createCanvasImagePreprocessor", () => {
  it("returns metadata for unchanged images", async () => {
    const preprocessor = createCanvasImagePreprocessor({
      format: "png",
      maxDimension: 0
    })
    const pngFile = new File(["png data"], "image.png", { type: "image/png" })

    const result = await withMockImageBitmap({ width: 100, height: 75 }, () => preprocessor(pngFile))

    expect(result).toEqual({
      file: pngFile,
      metadata: {
        mimeType: "image/png",
        sizeBytes: pngFile.size,
        image: { width: 100, height: 75 }
      }
    })
  })
})

describe("createResizeOnlyPreprocessor", () => {
  it("returns a function", () => {
    const preprocessor = createResizeOnlyPreprocessor(1200)
    expect(typeof preprocessor).toBe("function")
  })

  it("accepts custom vipsOptions", () => {
    const preprocessor = createResizeOnlyPreprocessor(1200, {
      vipsOptions: {
        locateFile: (path: string) => `/custom/${path}`
      }
    })
    expect(typeof preprocessor).toBe("function")
  })

  it("accepts canvas processor option", () => {
    const preprocessor = createResizeOnlyPreprocessor(1200, {
      processor: "canvas"
    })
    expect(typeof preprocessor).toBe("function")
  })

  // Note: Cannot test actual resize behavior without WASM
  // The dimension check happens after loading the image in WASM
})

describe("skip behavior contract", () => {
  /**
   * Documents the expected skip behavior for reference.
   * Actual skip logic is tested in the specific tests above.
   */

  it("documents createImagePreprocessor skip conditions", () => {
    const skipConditions = {
      condition1: "file.size < minSizeThreshold (if minSizeThreshold > 0)",
      condition2: "file.type === targetMimeType AND maxDimension === 0",
      condition3: "file.type === targetMimeType AND image dimensions <= maxDimension (requires WASM)",
      result: "return original file unchanged to prevent quality degradation"
    }

    expect(skipConditions.result).toContain("original file unchanged")
  })

  it("documents createResizeOnlyPreprocessor skip conditions", () => {
    const skipConditions = {
      condition: "image.width <= maxDimension AND image.height <= maxDimension",
      result: "return original file unchanged (preserves original quality)"
    }

    expect(skipConditions.result).toContain("original file unchanged")
  })
})

describe("type safety", () => {
  it("ImagePreprocessorOptions accepts valid formats", () => {
    const jpegOptions: ImagePreprocessorOptions = { format: "jpeg" }
    const webpOptions: ImagePreprocessorOptions = { format: "webp" }
    const pngOptions: ImagePreprocessorOptions = { format: "png" }

    expect(jpegOptions.format).toBe("jpeg")
    expect(webpOptions.format).toBe("webp")
    expect(pngOptions.format).toBe("png")
  })

  it("ImagePreprocessorOptions accepts all optional fields", () => {
    const fullOptions: ImagePreprocessorOptions = {
      maxDimension: 800,
      quality: 85,
      format: "webp",
      minSizeThreshold: 512,
      vipsOptions: {
        locateFile: (path) => path
      }
    }

    expect(fullOptions.maxDimension).toBe(800)
    expect(fullOptions.quality).toBe(85)
    expect(fullOptions.format).toBe("webp")
    expect(fullOptions.minSizeThreshold).toBe(512)
    expect(fullOptions.vipsOptions).toBeDefined()
  })
})
