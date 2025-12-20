import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { LiveStoreProvider } from '@livestore/react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { Effect, Data } from 'effect'

import { FileSyncProvider, type RemoteStorageAdapter } from '@livestore-filesync/react'

import { schema, fileSyncSchemaConfig } from './livestore/schema.ts'
import LiveStoreWorker from './livestore.worker.ts?worker'
import { Gallery } from './components/Gallery.tsx'

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

export function App() {
  return (
    <LiveStoreProvider
      schema={schema}
      adapter={adapter}
      renderLoading={(_) => <div style={styles.loading}>Loading LiveStore ({_.stage})...</div>}
      batchUpdates={batchUpdates}
    >
      <FileSyncProvider
        remoteAdapter={mockRemoteAdapter}
        schema={fileSyncSchemaConfig}
        onEvent={(event) => {
          console.log('FileSync event:', event)
        }}
      >
        <div style={styles.app}>
          <header style={styles.header}>
            <h1 style={styles.title}>LiveStore FileSync Demo</h1>
            <p style={styles.subtitle}>Upload images and watch them sync across tabs</p>
          </header>
          <main style={styles.main}>
            <Gallery />
          </main>
        </div>
      </FileSyncProvider>
    </LiveStoreProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    fontSize: '18px',
    color: '#666'
  },
  app: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '20px'
  },
  header: {
    textAlign: 'center',
    marginBottom: '40px'
  },
  title: {
    fontSize: '32px',
    fontWeight: 'bold',
    color: '#333',
    marginBottom: '8px'
  },
  subtitle: {
    fontSize: '16px',
    color: '#666'
  },
  main: {
    width: '100%'
  }
}
