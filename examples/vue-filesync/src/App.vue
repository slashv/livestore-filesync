<script setup lang="ts">
import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { LiveStoreProvider } from 'vue-livestore'
import { Effect, Data } from 'effect'

import { type RemoteStorageAdapter } from '@livestore-filesync/vue'

import { schema, fileSyncSchemaConfig } from './livestore/schema.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'
import Gallery from './components/Gallery.vue'
import FileSyncWrapper from './components/FileSyncWrapper.vue'

// Define error types for the mock adapter
class UploadError extends Data.TaggedError("UploadError")<{
  message: string
  cause?: unknown
}> {}

class DownloadError extends Data.TaggedError("DownloadError")<{
  message: string
  url: string
  cause?: unknown
}> {}

class DeleteError extends Data.TaggedError("DeleteError")<{
  message: string
  path: string
  cause?: unknown
}> {}

// Mock remote storage adapter for demo
// In production, this would connect to your actual backend
const mockRemoteAdapter: RemoteStorageAdapter = {
  upload: (file: File) =>
    Effect.tryPromise({
      try: async () => {
        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 1000))
        // Return a mock URL
        return `https://mock-cdn.example.com/files/${file.name}`
      },
      catch: (error) => new UploadError({ message: 'Upload failed', cause: error })
    }),

  download: (url: string) =>
    Effect.tryPromise({
      try: async () => {
        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 500))
        // Return a mock file
        const filename = url.split('/').pop() || 'file'
        return new File(['mock content'], filename)
      },
      catch: (error) => new DownloadError({ message: 'Download failed', url, cause: error })
    }),

  delete: (url: string) =>
    Effect.tryPromise({
      try: async () => {
        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 200))
        console.log('Deleted:', url)
      },
      catch: (error) => new DeleteError({ message: 'Delete failed', path: url, cause: error })
    }),

  checkHealth: () => Effect.succeed(true)
}

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

const handleFileSyncEvent = (event: { type: string }) => {
  console.log('FileSync event:', event)
}
</script>

<template>
  <LiveStoreProvider :options="storeOptions">
    <template #loading>
      <div :style="loadingStyle">Loading LiveStore...</div>
    </template>
    <FileSyncWrapper
      :remote-adapter="mockRemoteAdapter"
      :schema="fileSyncSchemaConfig as any"
      :on-event="handleFileSyncEvent"
    >
      <div :style="appStyle">
        <header :style="headerStyle">
          <h1 :style="titleStyle">LiveStore FileSync Demo (Vue)</h1>
          <p :style="subtitleStyle">Upload images and watch them sync across tabs</p>
        </header>
        <main :style="mainStyle">
          <Gallery />
        </main>
      </div>
    </FileSyncWrapper>
  </LiveStoreProvider>
</template>

<style scoped>
</style>

<script lang="ts">
const loadingStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  fontSize: '18px',
  color: '#666'
}

const appStyle = {
  maxWidth: '1200px',
  margin: '0 auto',
  padding: '20px'
}

const headerStyle = {
  textAlign: 'center' as const,
  marginBottom: '40px'
}

const titleStyle = {
  fontSize: '32px',
  fontWeight: 'bold',
  color: '#333',
  marginBottom: '8px'
}

const subtitleStyle = {
  fontSize: '16px',
  color: '#666'
}

const mainStyle = {
  width: '100%'
}
</script>
