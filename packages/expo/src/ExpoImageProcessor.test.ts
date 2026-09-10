import { describe, expect, it, vi } from "vitest"
import { createExpoImageProcessor } from "./ExpoImageProcessor.js"

const native = vi.hoisted(() => ({
  manipulate: vi.fn(),
  resize: vi.fn(),
  renderAsync: vi.fn(),
  saveAsync: vi.fn()
}))
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }))
// Expo exports the imperative API as ImageManipulator, not on the module itself.
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: { manipulate: native.manipulate } }))

describe("Expo image processor", () => {
  it("uses the native imperative API and returns the encoded image", async () => {
    const context = { resize: native.resize, renderAsync: native.renderAsync }
    native.manipulate.mockReturnValue(context)
    native.resize.mockReturnValue(context)
    native.renderAsync.mockResolvedValue({ saveAsync: native.saveAsync })
    native.saveAsync.mockResolvedValue({ uri: "file:///resized.jpg", width: 64, height: 64 })
    const processor = createExpoImageProcessor()
    const result = await processor.process("file:///input.png", { maxDimension: 64, format: "jpeg", quality: 80 })
    expect(native.manipulate).toHaveBeenCalledWith("file:///input.png")
    expect(native.saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8 })
    expect(result).toEqual({ uri: "file:///resized.jpg", width: 64, height: 64, mimeType: "image/jpeg" })
  })
})
