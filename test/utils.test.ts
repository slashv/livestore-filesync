import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  extractHashFromPath,
  FILES_DIRECTORY,
  joinPath,
  makeStoredPath,
  parsePath
} from "../src/utils/index.js"

describe("path utilities", () => {
  describe("makeStoredPath", () => {
    it("should create a path with the files directory prefix", () => {
      const hash = "abc123def456"
      const path = makeStoredPath(hash)
      expect(path).toBe(`${FILES_DIRECTORY}/${hash}`)
    })
  })

  describe("extractHashFromPath", () => {
    it("should extract hash from a stored path", () => {
      const hash = "abc123def456"
      const path = `${FILES_DIRECTORY}/${hash}`
      expect(extractHashFromPath(path)).toBe(hash)
    })

    it("should return the path unchanged if it does not have the prefix", () => {
      const path = "other/path/to/file"
      expect(extractHashFromPath(path)).toBe(path)
    })
  })

  describe("parsePath", () => {
    it("should parse a simple filename", () => {
      const result = parsePath("file.txt")
      expect(result).toEqual({ directory: "", filename: "file.txt" })
    })

    it("should parse a path with one directory", () => {
      const result = parsePath("folder/file.txt")
      expect(result).toEqual({ directory: "folder", filename: "file.txt" })
    })

    it("should parse a nested path", () => {
      const result = parsePath("a/b/c/file.txt")
      expect(result).toEqual({ directory: "a/b/c", filename: "file.txt" })
    })
  })

  describe("joinPath", () => {
    it("should join path segments", () => {
      expect(joinPath("a", "b", "c")).toBe("a/b/c")
    })

    it("should filter out empty segments", () => {
      expect(joinPath("a", "", "b", "", "c")).toBe("a/b/c")
    })

    it("should handle single segment", () => {
      expect(joinPath("file.txt")).toBe("file.txt")
    })

    it("should handle empty input", () => {
      expect(joinPath()).toBe("")
    })
  })
})

describe("hash utilities", () => {
  // Note: hash utilities use Web Crypto API which requires browser/Node 20+
  // These tests verify the Effect structure works correctly

  it("should hash a file to a hex string", async () => {
    // Skip if crypto.subtle is not available (Node < 20)
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return
    }

    const { hashFile } = await import("../src/utils/index.js")

    const file = new File(["hello world"], "test.txt", { type: "text/plain" })
    const hash = await Effect.runPromise(hashFile(file))

    // SHA-256 produces 64 hex characters
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)

    // Same content should produce same hash
    const file2 = new File(["hello world"], "different-name.txt")
    const hash2 = await Effect.runPromise(hashFile(file2))
    expect(hash2).toBe(hash)
  })

  it("should produce different hashes for different content", async () => {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return
    }

    const { hashFile } = await import("../src/utils/index.js")

    const file1 = new File(["content 1"], "file1.txt")
    const file2 = new File(["content 2"], "file2.txt")

    const hash1 = await Effect.runPromise(hashFile(file1))
    const hash2 = await Effect.runPromise(hashFile(file2))

    expect(hash1).not.toBe(hash2)
  })
})
