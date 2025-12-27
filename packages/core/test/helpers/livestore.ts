import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise, makeSchema, queryDb, State } from "@livestore/livestore"
import { createFileSyncSchema } from "../../src/schema/index.js"
import { sanitizeStoreId } from "../../src/utils/index.js"
import type { LiveStoreDeps } from "../../src/livestore/types.js"

interface TestStoreOptions {
  storeId?: string
  localPathRoot?: string
}

export const createTestStore = async (options: TestStoreOptions = {}) => {
  const adapter = makeAdapter({ storage: { type: "in-memory" } })
  const fileSyncSchema = createFileSyncSchema()
  const { tables, events, createMaterializers } = fileSyncSchema
  const materializers = State.SQLite.materializers(events, createMaterializers(tables))
  const state = State.SQLite.makeState({ tables, materializers })
  const schema = makeSchema({ events, state })
  const storeId = options.storeId ?? `test-store-${Date.now()}`
  const store = await createStorePromise({ adapter, schema, storeId })

  const deps: LiveStoreDeps = {
    store: store as LiveStoreDeps["store"],
    schema: { tables, events, queryDb },
    storeId: sanitizeStoreId(store.storeId)
  }
  if (options.localPathRoot !== undefined) {
    deps.localPathRoot = options.localPathRoot
  }

  return {
    store,
    deps,
    schema,
    tables,
    events,
    async shutdown() {
      await store.shutdownPromise()
    }
  }
}
