import { makeSchema, Schema, SessionIdSymbol, State } from '@livestore/livestore'
import { fileSyncSchema } from '@livestore-filesync/vue'

// Shared sync payload schema for authentication
export const SyncPayload = Schema.Struct({ authToken: Schema.String })

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
  ...fileSyncSchema.tables,
  uiState: uiStateDoc
}

// Combine file sync events with app-specific events
export const events = {
  ...fileSyncSchema.events,
  uiStateSet: uiStateDoc.set
}

// Create materializers using the helper from file sync schema
const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})

const state = State.SQLite.makeState({ tables: tables, materializers })

export const schema = makeSchema({ events: events, state })
