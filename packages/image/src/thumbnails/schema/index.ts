/**
 * LiveStore Schema for Image Thumbnails
 *
 * This module exports the schema components needed for thumbnail generation.
 * Applications should merge these with their existing schema.
 *
 * @example
 * ```typescript
 * import { createFileSyncSchema } from '@livestore-filesync/core/schema'
 * import { createThumbnailSchema } from '@livestore-filesync/image/thumbnails/schema'
 * import { makeSchema, State } from '@livestore/livestore'
 *
 * const fileSyncSchema = createFileSyncSchema()
 * const thumbnailSchema = createThumbnailSchema()
 *
 * const tables = {
 *   ...fileSyncSchema.tables,
 *   ...thumbnailSchema.tables
 * }
 *
 * const materializers = State.SQLite.materializers(events, {
 *   ...fileSyncSchema.createMaterializers(tables)
 * })
 * ```
 *
 * @module
 */

import { Schema, SessionIdSymbol, State } from "@livestore/livestore"

// ============================================
// Schema Definitions (Source of Truth)
// ============================================

/**
 * Thumbnail generation status schema
 */
export const ThumbnailGenerationStatusSchema = Schema.Literal(
  "pending", // Not yet queued
  "queued", // In queue for worker
  "generating", // Worker is processing
  "done", // Thumbnail exists
  "error", // Generation failed
  "skipped" // Not an image or unsupported format
)

/**
 * State for a single thumbnail size
 */
export const ThumbnailSizeStateSchema = Schema.Struct({
  status: ThumbnailGenerationStatusSchema,
  path: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  generatedAt: Schema.optional(Schema.Number)
})

/**
 * State for all thumbnail sizes of a single file
 */
export const FileThumbnailStateSchema = Schema.Struct({
  fileId: Schema.String,
  contentHash: Schema.String, // To detect when source file changes
  mimeType: Schema.String, // Original file mime type
  sizes: Schema.Record({
    key: Schema.String, // Size name (e.g., "small")
    value: ThumbnailSizeStateSchema
  })
})

/**
 * Map of file IDs to thumbnail states
 */
export const ThumbnailFilesStateSchema = Schema.Record({
  key: Schema.String,
  value: FileThumbnailStateSchema
})

/**
 * Root thumbnail state document schema
 */
export const ThumbnailStateDocumentSchema = Schema.Struct({
  files: ThumbnailFilesStateSchema
})

// ============================================
// Schema Factory
// ============================================

/**
 * Creates thumbnail schema components (tables)
 *
 * The thumbnail state is stored in a client document because:
 * - Thumbnails are not synced between clients (each generates locally)
 * - State persists across page refreshes
 * - We can show generation progress in UI
 *
 * @example
 * ```typescript
 * import { createThumbnailSchema } from '@livestore-filesync/image/thumbnails/schema'
 *
 * const thumbnailSchema = createThumbnailSchema()
 * const tables = { ...fileSyncSchema.tables, ...thumbnailSchema.tables }
 * ```
 */
export function createThumbnailSchema() {
  const tables = {
    thumbnailState: State.SQLite.clientDocument({
      name: "thumbnailState",
      schema: ThumbnailStateDocumentSchema,
      default: {
        id: SessionIdSymbol,
        value: {
          files: {}
        }
      }
    })
  }

  const events = {
    thumbnailStateSet: tables.thumbnailState.set
  }

  return {
    tables,
    events,
    schemas: {
      ThumbnailGenerationStatusSchema,
      ThumbnailSizeStateSchema,
      FileThumbnailStateSchema,
      ThumbnailFilesStateSchema,
      ThumbnailStateDocumentSchema
    }
  }
}

// ============================================
// Type Helpers for Consumers
// ============================================

/**
 * Return type of createThumbnailSchema for type inference
 */
export type ThumbnailSchema = ReturnType<typeof createThumbnailSchema>

/**
 * Thumbnail tables type
 */
export type ThumbnailTables = ThumbnailSchema["tables"]
