import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise } from "@livestore/livestore"

import { schema } from "./livestore/schema.js"

const store = await createStorePromise({
  adapter: makeAdapter({ storage: { type: "in-memory" } }),
  schema,
  storeId: "node-adapter-smoke"
})

await store.shutdownPromise()
