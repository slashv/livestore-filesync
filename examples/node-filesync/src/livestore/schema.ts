import { makeSchema, Schema, SessionIdSymbol, State } from "@livestore/livestore"
import { createFileSyncSchema } from "@livestore-filesync/core/schema"

export const SyncPayload = Schema.Struct({ authToken: Schema.String })

const uiStateDoc = State.SQLite.clientDocument({
  name: "uiState",
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

const fileSyncSchema = createFileSyncSchema()

export const tables = {
  ...fileSyncSchema.tables,
  uiState: uiStateDoc
} as const

export const events = {
  ...fileSyncSchema.events,
  uiStateSet: uiStateDoc.set
}

const materializers = State.SQLite.materializers(events as any, {
  ...fileSyncSchema.createMaterializers(tables as any)
})

const state = State.SQLite.makeState({ tables: tables as any, materializers })

export const schema = makeSchema({ events: events as any, state })
