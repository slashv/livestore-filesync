/**
 * LiveStore Schema for FileSync
 *
 * This module exports the schema components needed for file syncing.
 * Applications should merge these with their own schema.
 *
 * @example
 * ```typescript
 * import { fileSyncTables, fileSyncEvents, createFileSyncMaterializers } from 'livestore-filesync/schema'
 * import { Events, makeSchema, State } from '@livestore/livestore'
 *
 * // Your app's tables
 * const appTables = {
 *   ...fileSyncTables,
 *   images: State.SQLite.table({ ... }),
 * }
 *
 * // Your app's events
 * const appEvents = {
 *   ...fileSyncEvents,
 *   imageCreated: Events.synced({ ... }),
 * }
 *
 * // Create materializers
 * const materializers = State.SQLite.materializers(appEvents, {
 *   ...createFileSyncMaterializers(appTables),
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

// Re-export types that consumers will need
export type { TransferStatus } from "../services/sync-executor/index.js"

/**
 * File created event payload
 */
export interface FileCreatedPayload {
  id: string
  path: string
  contentHash: string
  createdAt: Date
  updatedAt: Date
}

/**
 * File updated event payload
 */
export interface FileUpdatedPayload {
  id: string
  path: string
  remoteKey: string
  contentHash: string
  updatedAt: Date
}

/**
 * File deleted event payload
 */
export interface FileDeletedPayload {
  id: string
  deletedAt: Date
}

/**
 * Helper to create file sync schema components
 *
 * @example
 * ```typescript
 * import { createFileSyncSchema } from 'livestore-filesync/schema'
 *
 * const { tables, events, createMaterializers } = createFileSyncSchema()
 * ```
 */
export function createFileSyncSchema() {
  // Schemas
  const transferStatus = Schema.Literal("pending", "queued", "inProgress", "done", "error")

  const localFileState = Schema.Struct({
    path: Schema.String,
    localHash: Schema.String,
    downloadStatus: transferStatus,
    uploadStatus: transferStatus,
    lastSyncError: Schema.String
  })

  const localFilesState = Schema.Record({
    key: Schema.String,
    value: localFileState
  })

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
        localFiles: localFilesState
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
      schema: Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        contentHash: Schema.String,
        createdAt: Schema.Date,
        updatedAt: Schema.Date
      })
    }),
    fileUpdated: Events.synced({
      name: "v1.FileUpdated",
      schema: Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        remoteKey: Schema.String,
        contentHash: Schema.String,
        updatedAt: Schema.Date
      })
    }),
    fileDeleted: Events.synced({
      name: "v1.FileDeleted",
      schema: Schema.Struct({
        id: Schema.String,
        deletedAt: Schema.Date
      })
    }),
    localFileStateSet: tables.localFileState.set
  }

  // Create materializers function
  const createMaterializers = <T extends typeof tables>(appTables: T) => ({
    "v1.FileCreated": ({
      id,
      path,
      contentHash,
      createdAt,
      updatedAt
    }: FileCreatedPayload) =>
      appTables.files.insert({ id, path, contentHash, createdAt, updatedAt }),
    "v1.FileUpdated": ({
      id,
      path,
      remoteKey,
      contentHash,
      updatedAt
    }: FileUpdatedPayload) =>
      appTables.files.update({ path, remoteKey, contentHash, updatedAt }).where({ id }),
    "v1.FileDeleted": ({ id, deletedAt }: FileDeletedPayload) =>
      appTables.files.update({ deletedAt }).where({ id })
  })

  return {
    tables,
    events,
    createMaterializers,
    schemas: {
      transferStatus,
      localFileState,
      localFilesState
    }
  }
}