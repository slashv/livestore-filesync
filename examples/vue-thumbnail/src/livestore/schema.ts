import { createFileSyncSchema } from "@livestore-filesync/core/schema"
import { createThumbnailSchema } from "@livestore-filesync/image-thumbnails/schema"
import { makeSchema, Schema, State } from "@livestore/livestore"

export const SyncPayload = Schema.Struct({ authToken: Schema.String })

export const fileSyncSchema = createFileSyncSchema()
export const thumbnailSchema = createThumbnailSchema()

export const tables = {
  ...fileSyncSchema.tables,
  ...thumbnailSchema.tables
}

export const events = {
  ...fileSyncSchema.events,
  ...thumbnailSchema.events
}

const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})

const state = State.SQLite.makeState({ tables, materializers })

export const schema = makeSchema({ events, state })
