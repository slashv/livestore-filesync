import { describe, expect, it } from "vitest"
import type { PreprocessorMap } from "../types/index.js"
import { applyPreprocessor, findPreprocessor, matchMimeType } from "./mime.js"

describe("matchMimeType", () => {
  describe("exact matches", () => {
    it("should match exact MIME types", () => {
      expect(matchMimeType("image/png", "image/png")).toBe(true)
      expect(matchMimeType("image/jpeg", "image/jpeg")).toBe(true)
      expect(matchMimeType("video/mp4", "video/mp4")).toBe(true)
      expect(matchMimeType("application/pdf", "application/pdf")).toBe(true)
    })

    it("should not match different MIME types", () => {
      expect(matchMimeType("image/png", "image/jpeg")).toBe(false)
      expect(matchMimeType("image/png", "video/mp4")).toBe(false)
      expect(matchMimeType("text/plain", "text/html")).toBe(false)
    })

    it("should be case-insensitive", () => {
      expect(matchMimeType("IMAGE/PNG", "image/png")).toBe(true)
      expect(matchMimeType("image/png", "IMAGE/PNG")).toBe(true)
      expect(matchMimeType("Image/Png", "image/png")).toBe(true)
    })

    it("should trim whitespace", () => {
      expect(matchMimeType(" image/png ", "image/png")).toBe(true)
      expect(matchMimeType("image/png", " image/png ")).toBe(true)
    })
  })

  describe("wildcard subtype matches", () => {
    it("should match wildcard patterns", () => {
      expect(matchMimeType("image/*", "image/png")).toBe(true)
      expect(matchMimeType("image/*", "image/jpeg")).toBe(true)
      expect(matchMimeType("image/*", "image/gif")).toBe(true)
      expect(matchMimeType("image/*", "image/webp")).toBe(true)
      expect(matchMimeType("video/*", "video/mp4")).toBe(true)
      expect(matchMimeType("audio/*", "audio/mpeg")).toBe(true)
    })

    it("should not match different types with wildcard", () => {
      expect(matchMimeType("image/*", "video/mp4")).toBe(false)
      expect(matchMimeType("video/*", "image/png")).toBe(false)
      expect(matchMimeType("audio/*", "video/mp4")).toBe(false)
    })

    it("should be case-insensitive for wildcards", () => {
      expect(matchMimeType("IMAGE/*", "image/png")).toBe(true)
      expect(matchMimeType("image/*", "IMAGE/PNG")).toBe(true)
    })
  })

  describe("universal wildcards", () => {
    it("should match '*' to any MIME type", () => {
      expect(matchMimeType("*", "image/png")).toBe(true)
      expect(matchMimeType("*", "video/mp4")).toBe(true)
      expect(matchMimeType("*", "application/json")).toBe(true)
      expect(matchMimeType("*", "text/plain")).toBe(true)
    })

    it("should match '*/*' to any MIME type", () => {
      expect(matchMimeType("*/*", "image/png")).toBe(true)
      expect(matchMimeType("*/*", "video/mp4")).toBe(true)
      expect(matchMimeType("*/*", "application/json")).toBe(true)
    })
  })

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      expect(matchMimeType("", "")).toBe(true)
      expect(matchMimeType("image/png", "")).toBe(false)
      expect(matchMimeType("", "image/png")).toBe(false)
    })

    it("should handle malformed MIME types", () => {
      // Wildcard should still match types without subtype
      expect(matchMimeType("image/*", "image")).toBe(true)
      // Exact match requires exact match
      expect(matchMimeType("image", "image")).toBe(true)
    })
  })
})

describe("findPreprocessor", () => {
  const mockPreprocessors: PreprocessorMap = {
    "image/png": async (file) => new File([file], "png-processed.png"),
    "image/*": async (file) => new File([file], "image-processed.jpg"),
    "video/mp4": async (file) => new File([file], "video-processed.mp4"),
    "*": async (file) => new File([file], "universal-processed")
  }

  describe("priority ordering", () => {
    it("should prefer exact match over wildcard", () => {
      const preprocessor = findPreprocessor(mockPreprocessors, "image/png")
      expect(preprocessor).toBeDefined()
      // The exact match should be returned
      expect(preprocessor).toBe(mockPreprocessors["image/png"])
    })

    it("should use wildcard when no exact match", () => {
      const preprocessor = findPreprocessor(mockPreprocessors, "image/jpeg")
      expect(preprocessor).toBeDefined()
      expect(preprocessor).toBe(mockPreprocessors["image/*"])
    })

    it("should use universal wildcard as fallback", () => {
      const preprocessor = findPreprocessor(mockPreprocessors, "audio/mpeg")
      expect(preprocessor).toBeDefined()
      expect(preprocessor).toBe(mockPreprocessors["*"])
    })
  })

  describe("no match cases", () => {
    it("should return undefined when no preprocessors defined", () => {
      const preprocessor = findPreprocessor({}, "image/png")
      expect(preprocessor).toBeUndefined()
    })

    it("should return undefined when no matching pattern", () => {
      const limitedPreprocessors: PreprocessorMap = {
        "image/png": async (file) => file
      }
      const preprocessor = findPreprocessor(limitedPreprocessors, "video/mp4")
      expect(preprocessor).toBeUndefined()
    })
  })

  describe("case insensitivity", () => {
    it("should find preprocessor regardless of case", () => {
      const preprocessor = findPreprocessor(mockPreprocessors, "IMAGE/PNG")
      expect(preprocessor).toBeDefined()
    })
  })

  describe("*/* universal wildcard", () => {
    it("should match */* pattern", () => {
      const preprocessorsWithSlash: PreprocessorMap = {
        "*/*": async (file) => new File([file], "universal")
      }
      const preprocessor = findPreprocessor(preprocessorsWithSlash, "text/plain")
      expect(preprocessor).toBeDefined()
      expect(preprocessor).toBe(preprocessorsWithSlash["*/*"])
    })
  })
})

describe("applyPreprocessor", () => {
  it("should return original file when no preprocessors defined", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" })
    const result = await applyPreprocessor(undefined, file)
    expect(result).toBe(file)
  })

  it("should return original file when preprocessors is empty", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" })
    const result = await applyPreprocessor({}, file)
    expect(result).toBe(file)
  })

  it("should return original file when no matching preprocessor", async () => {
    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => new File([file], "processed.jpg")
    }
    const file = new File(["content"], "test.txt", { type: "text/plain" })
    const result = await applyPreprocessor(preprocessors, file)
    expect(result).toBe(file)
  })

  it("should apply matching preprocessor", async () => {
    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => new File([await file.arrayBuffer()], "processed.jpg", { type: "image/jpeg" })
    }
    const file = new File(["content"], "test.png", { type: "image/png" })
    const result = await applyPreprocessor(preprocessors, file)

    expect(result).not.toBe(file)
    expect(result.name).toBe("processed.jpg")
    expect(result.type).toBe("image/jpeg")
  })

  it("should handle async preprocessors", async () => {
    let preprocessorCalled = false
    const preprocessors: PreprocessorMap = {
      "text/*": async (file) => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10))
        preprocessorCalled = true
        return new File([await file.arrayBuffer()], "processed.txt", { type: "text/plain" })
      }
    }
    const file = new File(["content"], "test.txt", { type: "text/plain" })
    const result = await applyPreprocessor(preprocessors, file)

    expect(preprocessorCalled).toBe(true)
    expect(result.name).toBe("processed.txt")
  })

  it("should pass the file to preprocessor correctly", async () => {
    let receivedFile: File | null = null
    const preprocessors: PreprocessorMap = {
      "*": async (file) => {
        receivedFile = file
        return file
      }
    }
    const file = new File(["test content"], "test.txt", { type: "text/plain" })
    await applyPreprocessor(preprocessors, file)

    expect(receivedFile).toBe(file)
  })
})

describe("applyPreprocessor - skip behavior patterns", () => {
  /**
   * These tests verify the pattern used by image preprocessors to skip
   * already-processed files, preventing quality degradation on re-save.
   */

  it("preprocessor can return original file unchanged to skip processing", async () => {
    // Simulates: file is already in target format and within bounds
    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => {
        // Skip if already JPEG (simulating format check)
        if (file.type === "image/jpeg") {
          return file // Return original unchanged
        }
        return new File([await file.arrayBuffer()], "converted.jpg", { type: "image/jpeg" })
      }
    }

    // Already a JPEG - should be skipped
    const jpegFile = new File(["jpeg content"], "photo.jpg", { type: "image/jpeg" })
    const result1 = await applyPreprocessor(preprocessors, jpegFile)
    expect(result1).toBe(jpegFile) // Same object reference = skipped

    // PNG - should be converted
    const pngFile = new File(["png content"], "image.png", { type: "image/png" })
    const result2 = await applyPreprocessor(preprocessors, pngFile)
    expect(result2).not.toBe(pngFile) // Different object = processed
    expect(result2.type).toBe("image/jpeg")
  })

  it("preprocessor can implement conditional processing based on file properties", async () => {
    let processCount = 0
    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => {
        // Skip small files (simulating size threshold check)
        if (file.size < 100) {
          return file
        }
        processCount++
        return new File([await file.arrayBuffer()], "processed.jpg", { type: "image/jpeg" })
      }
    }

    // Small file - should be skipped
    const smallFile = new File(["tiny"], "small.png", { type: "image/png" })
    const result1 = await applyPreprocessor(preprocessors, smallFile)
    expect(result1).toBe(smallFile)
    expect(processCount).toBe(0)

    // Large file - should be processed
    const largeContent = "x".repeat(200)
    const largeFile = new File([largeContent], "large.png", { type: "image/png" })
    const result2 = await applyPreprocessor(preprocessors, largeFile)
    expect(result2).not.toBe(largeFile)
    expect(processCount).toBe(1)
  })

  it("preprocessor skip prevents repeated processing on multiple calls", async () => {
    let processCount = 0
    const targetType = "image/jpeg"

    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => {
        // Skip if already target format (prevents quality degradation)
        if (file.type === targetType) {
          return file
        }
        processCount++
        return new File([await file.arrayBuffer()], "output.jpg", { type: targetType })
      }
    }

    // First save: PNG -> JPEG (processed)
    const originalFile = new File(["original"], "photo.png", { type: "image/png" })
    const firstResult = await applyPreprocessor(preprocessors, originalFile)
    expect(processCount).toBe(1)
    expect(firstResult.type).toBe(targetType)

    // Simulate update: pass the already-processed file back
    // (This is what happens when updateFile is called with a previously saved file)
    const secondResult = await applyPreprocessor(preprocessors, firstResult)
    expect(processCount).toBe(1) // Still 1 - no additional processing
    expect(secondResult).toBe(firstResult) // Same object - skipped
  })

  it("demonstrates full skip-if-processed pattern with format and size check", async () => {
    const targetFormat = "image/webp"
    const maxSize = 1000 // bytes

    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => {
        const isTargetFormat = file.type === targetFormat
        const isSmallEnough = file.size <= maxSize

        // Skip if already processed (correct format AND size is acceptable)
        if (isTargetFormat && isSmallEnough) {
          return file
        }

        // Simulate compression/conversion
        const content = await file.arrayBuffer()
        return new File([content], file.name.replace(/\.[^.]+$/, ".webp"), { type: targetFormat })
      }
    }

    // Case 1: Wrong format - should process
    const pngFile = new File(["content"], "image.png", { type: "image/png" })
    const result1 = await applyPreprocessor(preprocessors, pngFile)
    expect(result1).not.toBe(pngFile)
    expect(result1.type).toBe(targetFormat)

    // Case 2: Right format, small size - should skip
    const smallWebp = new File(["small"], "image.webp", { type: "image/webp" })
    const result2 = await applyPreprocessor(preprocessors, smallWebp)
    expect(result2).toBe(smallWebp)

    // Case 3: Right format, but too large - should still process (re-compress)
    const largeWebp = new File(["x".repeat(2000)], "large.webp", { type: "image/webp" })
    const result3 = await applyPreprocessor(preprocessors, largeWebp)
    expect(result3).not.toBe(largeWebp)
  })
})
