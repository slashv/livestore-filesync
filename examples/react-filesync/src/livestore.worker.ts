import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'

import { schema } from './livestore/schema.ts'

const syncUrl = import.meta.env.VITE_LIVESTORE_SYNC_URL || 'http://localhost:60004/sync'

makeWorker({
  schema,
  sync: {
    // Use /sync path to avoid Assets binding intercepting root path requests (alternative: wrangler.toml `run_worker_first = true` but less efficient)
    backend: makeWsSync({ url: syncUrl }),
    initialSyncOptions: { _tag: 'Blocking', timeout: 5000 },
  },
})
