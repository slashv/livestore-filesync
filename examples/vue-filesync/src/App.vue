<script setup lang="ts">
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { LiveStoreProvider } from 'vue-livestore'

import { schema } from './livestore/schema.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'
import Gallery from './components/Gallery.vue'
import FileSyncProvider from './components/FileSyncProvider.vue'
import SyncStatus from './components/SyncStatus.vue'

// Allow storeId to be set via query param for testing isolation
const urlParams = new URLSearchParams(window.location.search)
// Bump default storeId when schema changes to avoid loading an incompatible persisted db in dev.
const storeId = urlParams.get('storeId') || 'vue_filesync_store_v9'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
})

const authToken = import.meta.env.VITE_AUTH_TOKEN

const storeOptions = {
  schema,
  adapter,
  storeId,
  syncPayload: { authToken }
}
</script>

<template>
  <Suspense>
    <template #default>
      <LiveStoreProvider :options="storeOptions">
        <FileSyncProvider :auth-token="authToken">
          <div class="layout">
            <div class="main">
              <Gallery />
            </div>
            <SyncStatus />
          </div>
        </FileSyncProvider>
      </LiveStoreProvider>
    </template>
    <template #fallback>
      <div class="loading">Loading...</div>
    </template>
  </Suspense>
</template>

<style scoped>
.loading {
  padding: 2rem;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  height: 100vh;
}

.main {
  overflow-y: auto;
}
</style>
