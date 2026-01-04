/**
 * LiveStore integration types
 *
 * These types are derived from LiveStore and the file sync schema.
 *
 * @module
 */

import { queryDb, StoreInternalsSymbol } from "@livestore/livestore"
import type { Store, ClientSession } from "@livestore/livestore"
import type { createFileSyncSchema } from "../schema/index.js"

export type FileSyncSchema = ReturnType<typeof createFileSyncSchema>

/**
 * LiveStore schema configuration for file sync.
 */
export type SyncSchema = Pick<FileSyncSchema, "tables" | "events"> & {
  queryDb: typeof queryDb
}

/**
 * Internal store type used by file sync services.
 * Uses `any` schema since we only need the base Store methods.
 */
export type SyncStore = Store<any>

/**
 * LiveStore store + schema dependencies used internally by services.
 */
export interface LiveStoreDeps {
  store: SyncStore
  schema: SyncSchema
  storeId: string
  localPathRoot?: string
}

/**
 * Get the ClientSession from a Store instance.
 * This provides access to lockStatus for leader election.
 */
export const getClientSession = (store: SyncStore): ClientSession => {
  return (store as any)[StoreInternalsSymbol].clientSession
}
