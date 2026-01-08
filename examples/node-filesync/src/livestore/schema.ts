import { createFileSyncSchema } from "@livestore-filesync/core/schema"
import { makeSchema, Schema, State } from "@livestore/livestore"

export const SyncPayload = Schema.Struct({ authToken: Schema.String })

const fileSyncSchema = createFileSyncSchema()

export const tables = {
  ...fileSyncSchema.tables
} as const

export const events = {
  ...fileSyncSchema.events
}

const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })
