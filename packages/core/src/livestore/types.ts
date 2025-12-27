/**
 * LiveStore integration types
 *
 * These types are derived from LiveStore and the file sync schema.
 *
 * @module
 */

import { queryDb } from "@livestore/livestore"
import type { Store } from "@livestore/livestore"
import type { createFileSyncSchema } from "../schema/index.js"

export type FileSyncSchema = ReturnType<typeof createFileSyncSchema>

/**
 * LiveStore schema configuration for file sync.
 */
export type SyncSchema = Pick<FileSyncSchema, "tables" | "events"> & {
  queryDb: typeof queryDb
}

/**
 * LiveStore store instance type.
 */
export type SyncStore = Store<any> & { storeId: string }

/**
 * LiveStore store + schema dependencies.
 */
export interface LiveStoreDeps {
  store: SyncStore
  schema: SyncSchema
  storeId: string
  localPathRoot?: string
}
