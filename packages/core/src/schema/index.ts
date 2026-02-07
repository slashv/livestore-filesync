/**
 * LiveStore Schema for FileSync
 *
 * This module exports the schema components needed for file syncing.
 * Applications should merge these with their own schema.
 *
 * Types are derived from these schemas in types/index.ts to ensure
 * a single source of truth.
 *
 * ARCHITECTURE NOTE: localFileState uses a regular SQLite table with
 * clientOnly events instead of a clientDocument with Schema.Record.
 * This prevents rebase conflicts during concurrent tab operations by
 * storing each file's state as a separate row rather than a single JSON blob.
 * See: https://github.com/livestorejs/livestore/issues/998
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

import { Events, EventSequenceNumber, Schema, State } from "@livestore/livestore"

// ============================================
// Schema Definitions (Source of Truth)
// ============================================

/**
 * Transfer status schema - tracks the state of file uploads/downloads
 */
export const TransferStatusSchema = Schema.Literal("pending", "queued", "inProgress", "done", "error")

/**
 * Local file state schema - tracks sync status for a single file
 * This is used for both the row type and the event payload.
 */
export const LocalFileStateSchema = Schema.Struct({
  path: Schema.String,
  localHash: Schema.String,
  downloadStatus: TransferStatusSchema,
  uploadStatus: TransferStatusSchema,
  lastSyncError: Schema.String
})

/**
 * Local file state row schema - includes the fileId for the table
 */
export const LocalFileStateRowSchema = Schema.Struct({
  fileId: Schema.String,
  path: Schema.String,
  localHash: Schema.String,
  downloadStatus: TransferStatusSchema,
  uploadStatus: TransferStatusSchema,
  lastSyncError: Schema.String
})

/**
 * Map of file IDs to local file states schema
 * This type is kept for backwards compatibility with consumers.
 */
export const LocalFilesStateSchema = Schema.Record({
  key: Schema.String,
  value: LocalFileStateSchema
})

/**
 * File sync cursor schema - tracks last processed event sequence
 */
export const FileSyncCursorSchema = Schema.Struct({
  lastEventSequence: Schema.String,
  updatedAt: Schema.Date
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
type LocalFileStateRow = typeof LocalFileStateRowSchema.Type

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
    /**
     * Local file state table - stores sync status for each file as individual rows.
     *
     * This replaces the previous clientDocument approach which used Schema.Record
     * to store all file states in a single JSON blob. The row-based approach:
     * - Reduces rebase conflicts by isolating changes to individual rows
     * - Works better with SQLite's changeset extension
     * - Shares state across all tabs (no session isolation needed for OPFS)
     */
    localFileState: State.SQLite.table({
      name: "localFileState",
      columns: {
        fileId: State.SQLite.text({ primaryKey: true }),
        path: State.SQLite.text({ default: "" }),
        localHash: State.SQLite.text({ default: "" }),
        downloadStatus: State.SQLite.text({ default: "pending" }),
        uploadStatus: State.SQLite.text({ default: "pending" }),
        lastSyncError: State.SQLite.text({ default: "" })
      }
    }),
    fileSyncCursor: State.SQLite.clientDocument({
      name: "fileSyncCursor",
      schema: FileSyncCursorSchema,
      default: {
        id: "global",
        value: {
          lastEventSequence: EventSequenceNumber.Client.toString(EventSequenceNumber.Client.ROOT),
          updatedAt: new Date(0)
        }
      }
    })
  }

  // Events
  const events = {
    // Synced events for file CRUD (sync to remote)
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

    // Client-only events for local file state (sync between tabs, not to remote)
    // These use individual row operations to avoid Schema.Record rebase conflicts
    localFileStateUpsert: Events.clientOnly({
      name: "v1.LocalFileStateUpsert",
      schema: LocalFileStateRowSchema
    }),
    localFileStateRemove: Events.clientOnly({
      name: "v1.LocalFileStateRemove",
      schema: Schema.Struct({ fileId: Schema.String })
    }),
    localFileStateClear: Events.clientOnly({
      name: "v1.LocalFileStateClear",
      schema: Schema.Struct({})
    }),

    // Cursor for tracking sync progress (still uses clientDocument - single value, low conflict risk)
    fileSyncCursorSet: tables.fileSyncCursor.set
  }

  // Create materializers function
  const createMaterializers = <T extends typeof tables>(appTables: T) => ({
    // File CRUD materializers
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
    "v1.FileDeleted": ({ deletedAt, id }: FileDeletedPayload) => appTables.files.update({ deletedAt }).where({ id }),

    // Local file state materializers - row-level operations
    // Uses delete + insert pattern for upsert since LiveStore doesn't have native upsert
    "v1.LocalFileStateUpsert": ({
      downloadStatus,
      fileId,
      lastSyncError,
      localHash,
      path,
      uploadStatus
    }: LocalFileStateRow) => [
      appTables.localFileState.delete().where({ fileId }),
      appTables.localFileState.insert({ fileId, path, localHash, downloadStatus, uploadStatus, lastSyncError })
    ],
    "v1.LocalFileStateRemove": ({ fileId }: { fileId: string }) =>
      appTables.localFileState.delete().where({ fileId }),
    "v1.LocalFileStateClear": () => appTables.localFileState.delete()
  })

  return {
    tables,
    events,
    createMaterializers,
    schemas: {
      TransferStatusSchema,
      LocalFileStateSchema,
      LocalFileStateRowSchema,
      LocalFilesStateSchema,
      FileSyncCursorSchema,
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
