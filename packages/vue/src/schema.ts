/**
 * File sync schema for Vue adapter
 *
 * This creates the standard file sync schema using LiveStore primitives.
 * Apps should include these tables and events in their own schema.
 *
 * @module
 */

import { Events, Schema, SessionIdSymbol, State } from "@livestore/livestore"
import { createFileSyncSchema } from "@livestore-filesync/core/schema"

/**
 * Pre-configured file sync schema
 *
 * Include `fileSyncSchema.tables` in your app's tables and use
 * `fileSyncSchema.createMaterializers()` when creating materializers.
 *
 * @example
 * ```typescript
 * import { fileSyncSchema } from '@livestore-filesync/vue'
 *
 * const tables = {
 *   ...fileSyncSchema.tables,
 *   // your app tables...
 * }
 *
 * const events = {
 *   ...fileSyncSchema.events,
 *   // your app events...
 * }
 *
 * const materializers = State.SQLite.materializers(events, {
 *   ...fileSyncSchema.createMaterializers(tables),
 *   // your app materializers...
 * })
 * ```
 */
export const fileSyncSchema = createFileSyncSchema({
  Schema: Schema as any,
  State: State as any,
  Events: Events as any,
  SessionIdSymbol
})
