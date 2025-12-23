<script setup lang="ts">
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { LiveStoreProvider } from 'vue-livestore'
import { FileSyncProvider } from '@livestore-filesync/vue'
import { makeAdapter as makeFileSystemAdapter } from '@livestore-filesync/adapter-web'

import { schema } from './livestore/schema.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'
import Gallery from './components/Gallery.vue'

// Allow storeId to be set via query param for testing isolation
const urlParams = new URLSearchParams(window.location.search)
const storeId = urlParams.get('storeId') || 'vue_filesync_store'

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
})

const fileSystem = makeFileSystemAdapter()

const authToken = import.meta.env.VITE_AUTH_TOKEN

const storeOptions = {
  schema,
  adapter,
  storeId,
  syncPayload: { authToken }
}

// Auth headers for file sync API
const getAuthHeaders = () => ({
  'Authorization': `Bearer ${authToken}`,
})
</script>

<template>
  <Suspense>
    <template #default>
      <LiveStoreProvider :options="storeOptions">
        <FileSyncProvider :auth-headers="getAuthHeaders" :file-system="fileSystem">
          <Gallery />
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
</style>
