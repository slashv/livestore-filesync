/**
 * LiveStore adapter helpers
 *
 * Bridges LiveStore store + schema into Effect services.
 *
 * @module
 */

import { Effect } from "effect"
import type { FileRecord, LocalFilesState } from "../types/index.js"
import type { FileSyncStore } from "../services/file-sync/index.js"
import type { FileStorageStore } from "../services/file-storage/index.js"

/**
 * Framework-agnostic store interface
 *
 * This matches the essential methods from LiveStore
 */
export interface SyncStore {
  query: <T>(q: unknown) => T
  commit: (event: unknown) => void
  subscribe: (q: unknown, opts: { onUpdate: (result: unknown) => void }) => () => void
}

/**
 * Chainable query interface
 */
interface ChainableQuery {
  where: (condition: Record<string, unknown>) => unknown
}

/**
 * Schema configuration for file sync
 *
 * Must provide the tables and events from createFileSyncSchema
 */
export interface SyncSchema {
  tables: {
    files: {
      where: (condition: Record<string, unknown>) => unknown
      select: () => ChainableQuery
    }
    localFileState: {
      get: () => unknown
    }
  }
  events: {
    fileCreated: (data: {
      id: string
      path: string
      contentHash: string
      createdAt: Date
      updatedAt: Date
    }) => unknown
    fileUpdated: (data: {
      id: string
      path: string
      remoteUrl: string
      contentHash: string
      updatedAt: Date
    }) => unknown
    fileDeleted: (data: { id: string; deletedAt: Date }) => unknown
    localFileStateSet: (data: { localFiles: LocalFilesState }) => unknown
  }
  /** Query builder - typically `queryDb` from livestore */
  queryDb: <T>(query: unknown) => T
}

export const makeLiveStoreFileSyncStore = (store: SyncStore, schema: SyncSchema): FileSyncStore => {
  const { tables, events, queryDb } = schema

  return {
    getActiveFiles: () =>
      Effect.sync(() => store.query<FileRecord[]>(queryDb(tables.files.where({ deletedAt: null })))),

    getDeletedFiles: () =>
      Effect.sync(() =>
        store.query<FileRecord[]>(queryDb(tables.files.where({ deletedAt: { $ne: null } })))
      ),

    getFile: (fileId: string) =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id: fileId })))
        return files[0]
      }),

    getLocalFilesState: () =>
      Effect.sync(() => {
        const state = store.query<{ localFiles: LocalFilesState }>(queryDb(tables.localFileState.get()))
        return state.localFiles ?? {}
      }),

    updateLocalFilesState: (updater) =>
      Effect.sync(() => {
        const state = store.query<{ localFiles: LocalFilesState }>(queryDb(tables.localFileState.get()))
        const next = updater(state.localFiles ?? {})
        store.commit(events.localFileStateSet({ localFiles: next }))
      }),

    updateFileRemoteUrl: (fileId: string, remoteUrl: string) =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id: fileId })))
        const file = files[0]
        if (!file) return
        store.commit(
          events.fileUpdated({
            id: fileId,
            path: file.path,
            remoteUrl,
            contentHash: file.contentHash,
            updatedAt: new Date()
          })
        )
      }),

    onFilesChanged: (callback) =>
      Effect.sync(() => {
        const fileQuery = queryDb(tables.files.select().where({ deletedAt: null }))
        return store.subscribe(fileQuery, { onUpdate: () => callback() })
      })
  }
}

export const makeLiveStoreFileStorageStore = (
  store: SyncStore,
  schema: SyncSchema
): FileStorageStore => {
  const { tables, events, queryDb } = schema

  return {
    createFile: ({ id, path, contentHash }) =>
      Effect.sync(() => {
        store.commit(
          events.fileCreated({
            id,
            path,
            contentHash,
            createdAt: new Date(),
            updatedAt: new Date()
          })
        )
      }),

    updateFile: ({ id, path, contentHash }) =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id })))
        const file = files[0]
        if (!file) return
        store.commit(
          events.fileUpdated({
            id,
            path,
            remoteUrl: file.remoteUrl,
            contentHash,
            updatedAt: new Date()
          })
        )
      }),

    deleteFile: (id: string) =>
      Effect.sync(() => {
        store.commit(events.fileDeleted({ id, deletedAt: new Date() }))
      }),

    getFile: (id: string) =>
      Effect.sync(() => {
        const files = store.query<FileRecord[]>(queryDb(tables.files.where({ id })))
        return files[0]
      }),

    generateId: () => crypto.randomUUID()
  }
}
