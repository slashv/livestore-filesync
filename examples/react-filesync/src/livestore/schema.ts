import { makeSchema, Schema, State } from '@livestore/livestore'
import { fileSyncSchema } from '@livestore-filesync/react/schema'

export const SyncPayload = Schema.Struct({ authToken: Schema.String })

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
