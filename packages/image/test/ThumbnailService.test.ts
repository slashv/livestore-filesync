import { describe, expect, it } from "vitest"

/**
 * Tests for ThumbnailService config change detection
 * 
 * The actual service requires a full LiveStore instance which is complex to mock.
 * These tests verify the config hashing logic in isolation.
 */

// Simple hash function matching the one in ThumbnailService
const generateConfigHash = (sizes: Record<string, number>, format: string): string => {
  const configStr = JSON.stringify({ sizes, format })
  let hash = 0
  for (let i = 0; i < configStr.length; i++) {
    const char = configStr.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(16)
}

describe("ThumbnailService Config Hashing", () => {
  describe("generateConfigHash", () => {
    it("should generate consistent hash for same config", () => {
      const sizes = { small: 128, medium: 256, large: 512 }
      const format = "webp"

      const hash1 = generateConfigHash(sizes, format)
      const hash2 = generateConfigHash(sizes, format)

      expect(hash1).toBe(hash2)
    })

    it("should generate different hash when sizes change", () => {
      const format = "webp"

      const hash1 = generateConfigHash({ small: 128, medium: 256 }, format)
      const hash2 = generateConfigHash({ small: 128, medium: 512 }, format)

      expect(hash1).not.toBe(hash2)
    })

    it("should generate different hash when size is added", () => {
      const format = "webp"

      const hash1 = generateConfigHash({ small: 128, medium: 256 }, format)
      const hash2 = generateConfigHash({ small: 128, medium: 256, large: 512 }, format)

      expect(hash1).not.toBe(hash2)
    })

    it("should generate different hash when size is removed", () => {
      const format = "webp"

      const hash1 = generateConfigHash({ small: 128, medium: 256, large: 512 }, format)
      const hash2 = generateConfigHash({ small: 128, medium: 256 }, format)

      expect(hash1).not.toBe(hash2)
    })

    it("should generate different hash when format changes", () => {
      const sizes = { small: 128, medium: 256 }

      const hash1 = generateConfigHash(sizes, "webp")
      const hash2 = generateConfigHash(sizes, "jpeg")

      expect(hash1).not.toBe(hash2)
    })

    it("should generate different hash when size name changes", () => {
      const format = "webp"

      const hash1 = generateConfigHash({ small: 128, medium: 256 }, format)
      const hash2 = generateConfigHash({ tiny: 128, medium: 256 }, format)

      expect(hash1).not.toBe(hash2)
    })

    it("should generate different hash when property order changes", () => {
      const format = "webp"

      // JavaScript objects preserve insertion order for string keys
      // JSON.stringify respects this order, so different order = different hash
      // This is actually the DESIRED behavior - if someone reorders their config,
      // we want a new hash (and full regeneration is cheap enough)
      const hash1 = generateConfigHash({ small: 128, medium: 256 }, format)
      const hash2 = generateConfigHash({ medium: 256, small: 128 }, format)

      // These are different due to insertion order - that's fine
      expect(hash1).not.toBe(hash2)
    })
  })
})
