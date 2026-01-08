/**
 * LiveStore Schema for FileSync
 *
 * This module exports the schema components needed for file syncing.
 * Applications should merge these with their own schema.
 *
 * Types are derived from these schemas in types/index.ts to ensure
 * a single source of truth.
 *
 * @example
 * ```typescript
 * import { createFileSyncSchema } from 'livestore-filesync/schema'
 * import { makeSchema, State } from '@livestore/livestore'
 *
 * const { tables, events, createMaterializers } = createFileSyncSchema()
 *
 * // Your app's tables (extend with file sync tables)
 * const appTables = {
 *   ...tables,
 *   images: State.SQLite.table({ ... }),
 * }
 *
 * // Your app's events (extend with file sync events)
 * const appEvents = {
 *   ...events,
 *   imageCreated: Events.synced({ ... }),
 * }
 *
 * // Create materializers
 * const materializers = State.SQLite.materializers(appEvents, {
 *   ...createMaterializers(appTables),
 *   'v1.ImageCreated': ({ ... }) => appTables.images.insert({ ... }),
 * })
 *
 * const state = State.SQLite.makeState({ tables: appTables, materializers })
 * export const schema = makeSchema({ events: appEvents, state })
 * ```
 *
 * @module
 */

import { Events, Schema, SessionIdSymbol, State } from "@livestore/livestore"

// ============================================
// Schema Definitions (Source of Truth)
// ============================================

/**
 * Transfer status schema - tracks the state of file uploads/downloads
 */
export const TransferStatusSchema = Schema.Literal("pending", "queued", "inProgress", "done", "error")

/**
 * Local file state schema - tracks sync status for a single file
 */
export const LocalFileStateSchema = Schema.Struct({
  path: Schema.String,
  localHash: Schema.String,
  downloadStatus: TransferStatusSchema,
  uploadStatus: TransferStatusSchema,
  lastSyncError: Schema.String
})

/**
 * Map of file IDs to local file states schema
 */
export const LocalFilesStateSchema = Schema.Record({
  key: Schema.String,
  value: LocalFileStateSchema
})

// ============================================
// Event Payload Schemas
// ============================================

/**
 * File created event payload schema
 */
export const FileCreatedPayloadSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})

/**
 * File updated event payload schema
 */
export const FileUpdatedPayloadSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  remoteKey: Schema.String,
  contentHash: Schema.String,
  updatedAt: Schema.Date
})

/**
 * File deleted event payload schema
 */
export const FileDeletedPayloadSchema = Schema.Struct({
  id: Schema.String,
  deletedAt: Schema.Date
})

// ============================================
// Schema Factory
// ============================================

// Event payload types for internal use in materializers
type FileCreatedPayload = typeof FileCreatedPayloadSchema.Type
type FileUpdatedPayload = typeof FileUpdatedPayloadSchema.Type
type FileDeletedPayload = typeof FileDeletedPayloadSchema.Type

/**
 * Creates file sync schema components (tables, events, materializers)
 *
 * @example
 * ```typescript
 * import { createFileSyncSchema } from 'livestore-filesync/schema'
 *
 * const { tables, events, createMaterializers } = createFileSyncSchema()
 * ```
 */
export function createFileSyncSchema() {
  // Tables
  const tables = {
    files: State.SQLite.table({
      name: "files",
      columns: {
        id: State.SQLite.text({ primaryKey: true }),
        path: State.SQLite.text({ default: "" }),
        remoteKey: State.SQLite.text({ default: "" }),
        contentHash: State.SQLite.text({ default: "" }),
        createdAt: State.SQLite.integer({ schema: Schema.DateFromNumber }),
        updatedAt: State.SQLite.integer({ schema: Schema.DateFromNumber }),
        deletedAt: State.SQLite.integer({ nullable: true, schema: Schema.DateFromNumber })
      }
    }),
    localFileState: State.SQLite.clientDocument({
      name: "localFileState",
      schema: Schema.Struct({
        localFiles: LocalFilesStateSchema
      }),
      default: {
        id: SessionIdSymbol,
        value: {
          localFiles: {}
        }
      }
    })
  }

  // Events
  const events = {
    fileCreated: Events.synced({
      name: "v1.FileCreated",
      schema: FileCreatedPayloadSchema
    }),
    fileUpdated: Events.synced({
      name: "v1.FileUpdated",
      schema: FileUpdatedPayloadSchema
    }),
    fileDeleted: Events.synced({
      name: "v1.FileDeleted",
      schema: FileDeletedPayloadSchema
    }),
    localFileStateSet: tables.localFileState.set
  }

  // Create materializers function
  const createMaterializers = <T extends typeof tables>(appTables: T) => ({
    "v1.FileCreated": ({
      contentHash,
      createdAt,
      id,
      path,
      updatedAt
    }: FileCreatedPayload) => appTables.files.insert({ id, path, contentHash, createdAt, updatedAt }),
    "v1.FileUpdated": ({
      contentHash,
      id,
      path,
      remoteKey,
      updatedAt
    }: FileUpdatedPayload) => appTables.files.update({ path, remoteKey, contentHash, updatedAt }).where({ id }),
    "v1.FileDeleted": ({ deletedAt, id }: FileDeletedPayload) => appTables.files.update({ deletedAt }).where({ id })
  })

  return {
    tables,
    events,
    createMaterializers,
    schemas: {
      TransferStatusSchema,
      LocalFileStateSchema,
      LocalFilesStateSchema,
      FileCreatedPayloadSchema,
      FileUpdatedPayloadSchema,
      FileDeletedPayloadSchema
    }
  }
}

// ============================================
// Type Helpers for Consumers
// ============================================

/**
 * Return type of createFileSyncSchema for type inference
 */
export type FileSyncSchema = ReturnType<typeof createFileSyncSchema>

/**
 * File sync tables type
 */
export type FileSyncTables = FileSyncSchema["tables"]

/**
 * File sync events type
 */
export type FileSyncEvents = FileSyncSchema["events"]
