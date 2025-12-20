import { Events, makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'

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

// Files table for synced file metadata
const filesTable = State.SQLite.table({
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
})

// Local file state (client-only, per-session)
const localFileStateDoc = State.SQLite.clientDocument({
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

// UI state for the gallery
const uiStateDoc = State.SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({
    selectedFileId: Schema.optional(Schema.String),
    isUploading: Schema.Boolean,
    online: Schema.Boolean
  }),
  default: {
    id: SessionIdSymbol,
    value: {
      selectedFileId: undefined,
      isUploading: false,
      online: true
    }
  }
})

// All tables
export const tables = {
  files: filesTable,
  localFileState: localFileStateDoc,
  uiState: uiStateDoc
}

// File sync events
const fileCreated = Events.synced({
  name: "v1.FileCreated",
  schema: Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    contentHash: Schema.String,
    createdAt: Schema.Date,
    updatedAt: Schema.Date
  })
})

const fileUpdated = Events.synced({
  name: "v1.FileUpdated",
  schema: Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    remoteUrl: Schema.String,
    contentHash: Schema.String,
    updatedAt: Schema.Date
  })
})

const fileDeleted = Events.synced({
  name: "v1.FileDeleted",
  schema: Schema.Struct({
    id: Schema.String,
    deletedAt: Schema.Date
  })
})

// All events
export const events = {
  fileCreated,
  fileUpdated,
  fileDeleted,
  localFileStateSet: localFileStateDoc.set,
  uiStateSet: uiStateDoc.set
}

// Materializers
const materializers = State.SQLite.materializers(events, {
  "v1.FileCreated": ({ id, path, contentHash, createdAt, updatedAt }) =>
    tables.files.insert({ id, path, contentHash, createdAt, updatedAt }),
  "v1.FileUpdated": ({ id, path, remoteUrl, contentHash, updatedAt }) =>
    tables.files.update({ path, remoteUrl, contentHash, updatedAt }).where({ id }),
  "v1.FileDeleted": ({ id, deletedAt }) =>
    tables.files.update({ deletedAt }).where({ id })
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })

// Export schema for use in FileSyncProvider
export const fileSyncSchemaConfig = {
  tables: {
    files: filesTable,
    localFileState: localFileStateDoc
  },
  events: {
    fileCreated,
    fileUpdated,
    fileDeleted,
    localFileStateSet: localFileStateDoc.set
  }
}
