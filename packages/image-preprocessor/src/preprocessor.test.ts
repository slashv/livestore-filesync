import { describe, expect, it } from "vitest"
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
      expect(result).toBe(smallFile)
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
      expect(result).toBe(jpegFile)
    })

    it("skips already-matching webp format when maxDimension is 0", async () => {
      const preprocessor = createImagePreprocessor({
        format: "webp",
        maxDimension: 0
      })

      const webpFile = new File(["webp data"], "image.webp", { type: "image/webp" })
      const result = await preprocessor(webpFile)
      expect(result).toBe(webpFile)
    })

    it("skips already-matching png format when maxDimension is 0", async () => {
      const preprocessor = createImagePreprocessor({
        format: "png",
        maxDimension: 0
      })

      const pngFile = new File(["png data"], "image.png", { type: "image/png" })
      const result = await preprocessor(pngFile)
      expect(result).toBe(pngFile)
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

describe("createResizeOnlyPreprocessor", () => {
  it("returns a function", () => {
    const preprocessor = createResizeOnlyPreprocessor(1200)
    expect(typeof preprocessor).toBe("function")
  })

  it("accepts custom vipsOptions", () => {
    const preprocessor = createResizeOnlyPreprocessor(1200, {
      locateFile: (path) => `/custom/${path}`
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
