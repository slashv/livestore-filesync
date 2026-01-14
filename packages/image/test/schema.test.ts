import { describe, expect, it } from "vitest"
import { createThumbnailSchema } from "../src/thumbnails/schema/index.js"

describe("Thumbnail Schema", () => {
  describe("createThumbnailSchema", () => {
    it("should create schema with tables", () => {
      const schema = createThumbnailSchema()

      expect(schema.tables).toBeDefined()
      expect(schema.tables.thumbnailState).toBeDefined()
    })

    it("should create schema with events", () => {
      const schema = createThumbnailSchema()

      expect(schema.events).toBeDefined()
      expect(schema.events.thumbnailStateSet).toBeDefined()
    })

    it("should create schema with schemas export", () => {
      const schema = createThumbnailSchema()

      expect(schema.schemas).toBeDefined()
      expect(schema.schemas.ThumbnailGenerationStatusSchema).toBeDefined()
      expect(schema.schemas.ThumbnailSizeStateSchema).toBeDefined()
      expect(schema.schemas.FileThumbnailStateSchema).toBeDefined()
      expect(schema.schemas.ThumbnailFilesStateSchema).toBeDefined()
      expect(schema.schemas.ThumbnailStateDocumentSchema).toBeDefined()
    })

    it("should create functional independent schema instances", () => {
      const schema1 = createThumbnailSchema()
      const schema2 = createThumbnailSchema()

      // Tables should both be defined
      expect(schema1.tables.thumbnailState).toBeDefined()
      expect(schema2.tables.thumbnailState).toBeDefined()
    })
  })
})
