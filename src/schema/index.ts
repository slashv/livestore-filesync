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

// Re-export types that consumers will need
export type { TransferStatus } from "../services/sync-executor/index.js"

/**
 * Schema definitions for LiveStore integration
 *
 * These are type definitions only. The actual schema creation requires
 * the @livestore/livestore package which is a peer dependency.
 */

/**
 * Transfer status literal type
 */
export const TRANSFER_STATUS = ["pending", "queued", "inProgress", "done", "error"] as const

/**
 * Local file state shape (for reference)
 */
export interface LocalFileStateShape {
  path: string
  localHash: string
  downloadStatus: typeof TRANSFER_STATUS[number]
  uploadStatus: typeof TRANSFER_STATUS[number]
  lastSyncError: string
}

/**
 * Local files state map shape
 */
export type LocalFilesStateShape = Record<string, LocalFileStateShape>

/**
 * Files table columns shape
 */
export interface FilesTableColumns {
  id: string
  path: string
  remoteUrl: string
  contentHash: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

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
  remoteUrl: string
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
 * This function must be called with the LiveStore Schema module
 * since it's a peer dependency.
 *
 * @example
 * ```typescript
 * import { Schema, State, Events, SessionIdSymbol } from '@livestore/livestore'
 * import { createFileSyncSchema } from 'livestore-filesync/schema'
 *
 * const { tables, events, createMaterializers } = createFileSyncSchema({
 *   Schema,
 *   State,
 *   Events,
 *   SessionIdSymbol
 * })
 * ```
 */
export function createFileSyncSchema<
  TSchema extends {
    Literal: (...args: readonly string[]) => unknown
    Struct: (shape: Record<string, unknown>) => unknown
    Record: (config: { key: unknown; value: unknown }) => unknown
    String: unknown
    Boolean: unknown
    Date: unknown
    DateFromNumber: unknown
  },
  TState extends {
    SQLite: {
      table: (config: unknown) => unknown
      text: (config?: unknown) => unknown
      integer: (config?: unknown) => unknown
      clientDocument: (config: unknown) => unknown
      materializers: (events: unknown, handlers: unknown) => unknown
    }
  },
  TEvents extends {
    synced: (config: { name: string; schema: unknown }) => unknown
  }
>(deps: {
  Schema: TSchema
  State: TState
  Events: TEvents
  SessionIdSymbol: symbol
}) {
  const { Schema, State, Events, SessionIdSymbol } = deps

  // Transfer status schema
  const transferStatus = Schema.Literal("pending", "queued", "inProgress", "done", "error")

  // Local file state schema
  const localFileState = Schema.Struct({
    path: Schema.String,
    localHash: Schema.String,
    downloadStatus: transferStatus,
    uploadStatus: transferStatus,
    lastSyncError: Schema.String
  })

  // Local files state map schema
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
        remoteUrl: State.SQLite.text({ default: "" }),
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
        remoteUrl: Schema.String,
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
    localFileStateSet: (tables.localFileState as any).set
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
      (appTables.files as any).insert({ id, path, contentHash, createdAt, updatedAt }),
    "v1.FileUpdated": ({
      id,
      path,
      remoteUrl,
      contentHash,
      updatedAt
    }: FileUpdatedPayload) =>
      (appTables.files as any).update({ path, remoteUrl, contentHash, updatedAt }).where({ id }),
    "v1.FileDeleted": ({ id, deletedAt }: FileDeletedPayload) =>
      (appTables.files as any).update({ deletedAt }).where({ id })
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

/**
 * Event names used by file sync
 */
export const FILE_SYNC_EVENT_NAMES = {
  FILE_CREATED: "v1.FileCreated",
  FILE_UPDATED: "v1.FileUpdated",
  FILE_DELETED: "v1.FileDeleted"
} as const
