<script setup lang="ts">
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { LiveStoreProvider } from 'vue-livestore'
import { FileSyncProvider } from '@livestore-filesync/vue'

import { schema } from './livestore/schema.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'
import Gallery from './components/Gallery.vue'

const resetPersistence = import.meta.env.DEV && new URLSearchParams(window.location.search).get('reset') !== null

if (resetPersistence) {
  const searchParams = new URLSearchParams(window.location.search)
  searchParams.delete('reset')
  window.history.replaceState(null, '', `${window.location.pathname}?${searchParams.toString()}`)
}

const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
  resetPersistence,
})

const storeOptions = {
  schema,
  adapter,
  storeId: 'vue_filesync_store',
}
</script>

<template>
  <Suspense>
    <template #default>
      <LiveStoreProvider :options="storeOptions">
        <FileSyncProvider>
          <Gallery />
        </FileSyncProvider>
      </LiveStoreProvider>
    </template>
    <template #fallback>
      <div>Loading LiveStore...</div>
    </template>
  </Suspense>
</template>
