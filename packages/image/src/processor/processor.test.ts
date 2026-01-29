import { describe, expect, it } from "vitest"

import { createCanvasProcessor } from "./canvas.js"
import { createImageProcessor, createVipsProcessor, isBufferProcessor, isUriProcessor } from "./index.js"
import type { BufferImageProcessor, ImageProcessor } from "./types.js"

/**
 * Tests for image processor abstraction.
 *
 * Note: Full integration tests require browser environment for canvas
 * and WASM for vips. These tests focus on:
 * 1. Factory functions and type correctness
 * 2. Capability reporting
 * 3. Type guards
 */

describe("createCanvasProcessor", () => {
  it("returns a BufferImageProcessor", () => {
    const processor = createCanvasProcessor()
    expect(processor.type).toBe("buffer")
  })

  it("has correct capabilities", () => {
    const processor = createCanvasProcessor()
    expect(processor.capabilities).toEqual({
      preservesIccProfile: false,
      supportsLossless: false,
      preservesMetadata: false,
      supportedFormats: ["jpeg", "webp", "png"],
      runsOffMainThread: true
    })
  })

  it("starts uninitialized", () => {
    const processor = createCanvasProcessor()
    expect(processor.isInitialized()).toBe(false)
  })

  it("becomes initialized after init()", async () => {
    const processor = createCanvasProcessor()
    await processor.init()
    expect(processor.isInitialized()).toBe(true)
  })

  it("init() is idempotent", async () => {
    const processor = createCanvasProcessor()
    await processor.init()
    await processor.init()
    expect(processor.isInitialized()).toBe(true)
  })
})

describe("createVipsProcessor", () => {
  it("returns a BufferImageProcessor", () => {
    const processor = createVipsProcessor()
    expect(processor.type).toBe("buffer")
  })

  it("has correct capabilities", () => {
    const processor = createVipsProcessor()
    expect(processor.capabilities).toEqual({
      preservesIccProfile: true,
      supportsLossless: true,
      preservesMetadata: true,
      supportedFormats: ["jpeg", "webp", "png"],
      runsOffMainThread: true
    })
  })

  it("starts uninitialized", () => {
    const processor = createVipsProcessor()
    expect(processor.isInitialized()).toBe(false)
  })

  it("accepts custom locateFile option", () => {
    const processor = createVipsProcessor({
      locateFile: (path: string) => `/custom/${path}`
    })
    expect(processor.type).toBe("buffer")
  })
})

describe("createImageProcessor", () => {
  it("creates vips processor when type is vips", async () => {
    const processor = await createImageProcessor("vips")
    expect(processor.type).toBe("buffer")
    expect(processor.capabilities.preservesIccProfile).toBe(true)
  })

  it("creates canvas processor when type is canvas", async () => {
    const processor = await createImageProcessor("canvas")
    expect(processor.type).toBe("buffer")
    expect(processor.capabilities.preservesIccProfile).toBe(false)
  })

  it("throws for expo processor (not yet implemented)", async () => {
    await expect(createImageProcessor("expo")).rejects.toThrow("not yet implemented")
  })

  it("passes vipsOptions to vips processor", async () => {
    const processor = await createImageProcessor("vips", {
      vipsOptions: {
        locateFile: (path: string) => `/wasm/${path}`
      }
    })
    expect(processor.type).toBe("buffer")
  })
})

describe("type guards", () => {
  it("isBufferProcessor returns true for canvas processor", () => {
    const processor: ImageProcessor = createCanvasProcessor()
    expect(isBufferProcessor(processor)).toBe(true)
    expect(isUriProcessor(processor)).toBe(false)
  })

  it("isBufferProcessor returns true for vips processor", () => {
    const processor: ImageProcessor = createVipsProcessor()
    expect(isBufferProcessor(processor)).toBe(true)
    expect(isUriProcessor(processor)).toBe(false)
  })

  it("type narrowing works with isBufferProcessor", () => {
    const processor: ImageProcessor = createCanvasProcessor()

    if (isBufferProcessor(processor)) {
      // TypeScript should allow calling buffer-specific methods
      const _method: BufferImageProcessor["process"] = processor.process
      expect(typeof _method).toBe("function")
    }
  })
})

describe("capability comparison", () => {
  it("vips has more capabilities than canvas", () => {
    const vips = createVipsProcessor()
    const canvas = createCanvasProcessor()

    expect(vips.capabilities.preservesIccProfile).toBe(true)
    expect(canvas.capabilities.preservesIccProfile).toBe(false)

    expect(vips.capabilities.supportsLossless).toBe(true)
    expect(canvas.capabilities.supportsLossless).toBe(false)

    expect(vips.capabilities.preservesMetadata).toBe(true)
    expect(canvas.capabilities.preservesMetadata).toBe(false)
  })

  it("both support same formats", () => {
    const vips = createVipsProcessor()
    const canvas = createCanvasProcessor()

    expect(vips.capabilities.supportedFormats).toEqual(canvas.capabilities.supportedFormats)
  })

  it("both run off main thread", () => {
    const vips = createVipsProcessor()
    const canvas = createCanvasProcessor()

    expect(vips.capabilities.runsOffMainThread).toBe(true)
    expect(canvas.capabilities.runsOffMainThread).toBe(true)
  })
})
