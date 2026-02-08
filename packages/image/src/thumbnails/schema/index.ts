/**
 * LiveStore Schema for Image Thumbnails
 *
 * This module exports the schema components needed for thumbnail generation.
 * Applications should merge these with their existing schema.
 *
 * ARCHITECTURE NOTE: thumbnailState uses a regular SQLite table with
 * clientOnly events instead of a clientDocument with Schema.Record.
 * This prevents rebase conflicts during concurrent tab operations by
 * storing each file's thumbnail state as a separate row rather than a
 * single JSON blob containing all files.
 * See: https://github.com/livestorejs/livestore/issues/998
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
 *   ...fileSyncSchema.createMaterializers(tables),
 *   ...thumbnailSchema.createMaterializers(thumbnailSchema.tables)
 * })
 * ```
 *
 * @module
 */

import { Events, Schema, State } from "@livestore/livestore"

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
 * Note: sizes is stored as JSON in the database row
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
 * Kept for backwards compatibility with consumers.
 */
export const ThumbnailFilesStateSchema = Schema.Record({
  key: Schema.String,
  value: FileThumbnailStateSchema
})

/**
 * Stored config - used to detect config changes and provide sizes to components
 */
export const StoredConfigSchema = Schema.Struct({
  /** Hash of the sizes config (JSON stringified and hashed) */
  configHash: Schema.String,
  /** The configured thumbnail sizes (name → pixels) */
  sizes: Schema.Record({
    key: Schema.String,
    value: Schema.Number
  })
})

/**
 * Row schema for thumbnail state table - stored as JSON for the sizes field
 */
export const ThumbnailStateRowSchema = Schema.Struct({
  fileId: Schema.String,
  contentHash: Schema.String,
  mimeType: Schema.String,
  sizesJson: Schema.String // JSON-encoded sizes object
})

/**
 * Config row schema for thumbnail config table
 */
export const ThumbnailConfigRowSchema = Schema.Struct({
  id: Schema.String,
  configHash: Schema.String,
  sizesJson: Schema.String // JSON-encoded sizes definition
})

// Type helpers
type ThumbnailStateRow = typeof ThumbnailStateRowSchema.Type
type ThumbnailConfigRow = typeof ThumbnailConfigRowSchema.Type

// ============================================
// Schema Factory
// ============================================

/**
 * Creates thumbnail schema components (tables, events, materializers)
 *
 * The thumbnail state is stored in SQLite tables because:
 * - Each file's state is a separate row (avoids Schema.Record rebase conflicts)
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
    /**
     * Thumbnail state table - stores generation status for each file as individual rows.
     * The 'sizes' field is stored as JSON since its structure is dynamic based on config.
     */
    thumbnailState: State.SQLite.table({
      name: "thumbnailState",
      columns: {
        fileId: State.SQLite.text({ primaryKey: true }),
        contentHash: State.SQLite.text({ default: "" }),
        mimeType: State.SQLite.text({ default: "" }),
        sizesJson: State.SQLite.text({ default: "{}" }) // JSON-encoded sizes object
      }
    }),
    /**
     * Thumbnail config table - stores the current config hash and size definitions.
     * Single row, rarely changes.
     */
    thumbnailConfig: State.SQLite.table({
      name: "thumbnailConfig",
      columns: {
        id: State.SQLite.text({ primaryKey: true }),
        configHash: State.SQLite.text({ default: "" }),
        sizesJson: State.SQLite.text({ default: "{}" }) // JSON-encoded sizes definition
      }
    })
  }

  const events = {
    // Thumbnail file state events
    thumbnailStateUpsert: Events.clientOnly({
      name: "v1.ThumbnailStateUpsert",
      schema: ThumbnailStateRowSchema
    }),
    thumbnailStateRemove: Events.clientOnly({
      name: "v1.ThumbnailStateRemove",
      schema: Schema.Struct({ fileId: Schema.String })
    }),
    thumbnailStateClear: Events.clientOnly({
      name: "v1.ThumbnailStateClear",
      schema: Schema.Struct({})
    }),

    // Thumbnail config events
    thumbnailConfigSet: Events.clientOnly({
      name: "v1.ThumbnailConfigSet",
      schema: ThumbnailConfigRowSchema
    })
  }

  // Create materializers function
  const createMaterializers = <T extends typeof tables>(appTables: T) => ({
    "v1.ThumbnailStateUpsert": ({
      contentHash,
      fileId,
      mimeType,
      sizesJson
    }: ThumbnailStateRow) => [
      appTables.thumbnailState.delete().where({ fileId }),
      appTables.thumbnailState.insert({ fileId, contentHash, mimeType, sizesJson })
    ],
    "v1.ThumbnailStateRemove": ({ fileId }: { fileId: string }) => appTables.thumbnailState.delete().where({ fileId }),
    "v1.ThumbnailStateClear": () => appTables.thumbnailState.delete(),
    "v1.ThumbnailConfigSet": ({
      configHash,
      id,
      sizesJson
    }: ThumbnailConfigRow) => [
      appTables.thumbnailConfig.delete().where({ id }),
      appTables.thumbnailConfig.insert({ id, configHash, sizesJson })
    ]
  })

  return {
    tables,
    events,
    createMaterializers,
    schemas: {
      ThumbnailGenerationStatusSchema,
      ThumbnailSizeStateSchema,
      FileThumbnailStateSchema,
      ThumbnailFilesStateSchema,
      StoredConfigSchema,
      ThumbnailStateRowSchema,
      ThumbnailConfigRowSchema
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

/**
 * Thumbnail events type
 */
export type ThumbnailEvents = ThumbnailSchema["events"]
