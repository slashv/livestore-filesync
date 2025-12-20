import { Events, makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { createFileSyncSchema } from '@livestore-filesync/core/schema'

// Create file sync schema components from the base package
// Using 'as any' to bypass generic type constraints that return 'unknown'
const fileSyncSchema = createFileSyncSchema({
  Schema: Schema as any,
  State: State as any,
  Events: Events as any,
  SessionIdSymbol
})

// UI state for the gallery (app-specific)
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

// Combine file sync tables with app-specific tables
export const tables = {
  files: fileSyncSchema.tables.files,
  localFileState: fileSyncSchema.tables.localFileState,
  uiState: uiStateDoc
} as const

// Combine file sync events with app-specific events
export const events = {
  ...fileSyncSchema.events,
  uiStateSet: uiStateDoc.set
}

// Create materializers using the helper from file sync schema
const materializers = State.SQLite.materializers(events as any, {
  ...fileSyncSchema.createMaterializers(tables as any)
})

const state = State.SQLite.makeState({ tables: tables as any, materializers })

export const schema = makeSchema({ events: events as any, state })

// Export schema config for use in FileSyncProvider
export const fileSyncSchemaConfig = {
  tables: fileSyncSchema.tables,
  events: fileSyncSchema.events
}
