# livestore-filesync

Framework-agnostic file syncing for [LiveStore](https://livestore.dev) applications with OPFS (Origin Private File System) support.

## Features

- **Content-addressable storage** - Files are stored by SHA-256 hash, enabling deduplication
- **OPFS-backed local storage** - Fast local file access via the browser's Origin Private File System
- **Pluggable remote storage** - Works with any backend (S3, Cloudflare R2, Supabase Storage, custom APIs)
- **Effect-based architecture** - Built on [Effect](https://effect.website) for type-safe error handling and concurrency
- **Promise-based API** - Simple Promise-based client for users who prefer not to use Effect directly
- **Service Worker support** - Intercept file requests and serve from local cache
- **LiveStore integration** - Schema helpers for seamless LiveStore integration

## Installation

```bash
npm install livestore-filesync effect
# or
pnpm add livestore-filesync effect
```

## Quick Start

### Promise-based API (Simple)

```typescript
import { FileSyncClient, makeHttpRemoteStorage } from 'livestore-filesync'

// Create a client
const client = await FileSyncClient.create({
  remoteAdapter: makeHttpRemoteStorage({
    baseUrl: 'https://api.example.com/files',
    authToken: 'your-auth-token'
  }),
  onError: (error) => console.error('Sync error:', error)
})

// Save a file locally (content-addressable by hash)
const file = new File(['Hello, World!'], 'hello.txt', { type: 'text/plain' })
const result = await client.saveFile(file)
console.log('Saved:', result.contentHash)

// Upload to remote storage
const remoteUrl = await client.uploadFile(file)
console.log('Uploaded to:', remoteUrl)

// Get a local URL for display
const localUrl = await client.getFileUrl(result.path)

// Clean up when done
await client.dispose()
```

### Effect-based API (Advanced)

```typescript
import { Effect, Layer } from 'effect'
import {
  LocalFileStorage,
  LocalFileStorageLive,
  RemoteStorage,
  makeRemoteStorageLive,
  hashFile,
  makeStoredPath
} from 'livestore-filesync'

const program = Effect.gen(function* () {
  const localStorage = yield* LocalFileStorage
  const remoteStorage = yield* RemoteStorage

  // Hash and save a file
  const file = new File(['Hello'], 'hello.txt')
  const hash = yield* hashFile(file)
  const path = makeStoredPath(hash)

  yield* localStorage.writeFile(path, file)

  // Upload to remote
  const url = yield* remoteStorage.upload(file)

  return { hash, path, url }
})

// Provide dependencies
const RemoteStorageLive = makeRemoteStorageLive({
  baseUrl: 'https://api.example.com/files'
})

const MainLayer = Layer.merge(LocalFileStorageLive, RemoteStorageLive)

// Run the program
const result = await Effect.runPromise(program.pipe(Effect.provide(MainLayer)))
```

## LiveStore Integration

### Schema Setup

```typescript
import { Schema, State, Events, SessionIdSymbol, makeSchema } from '@livestore/livestore'
import { createFileSyncSchema } from 'livestore-filesync'

// Create file sync schema components
const { tables, events, createMaterializers, schemas } = createFileSyncSchema({
  Schema,
  State,
  Events,
  SessionIdSymbol
})

// Merge with your app's tables
const appTables = {
  ...tables,
  // Your other tables...
  images: State.SQLite.table({
    name: 'images',
    columns: {
      id: State.SQLite.text({ primaryKey: true }),
      fileId: State.SQLite.text(), // Reference to files table
      caption: State.SQLite.text({ default: '' })
    }
  })
}

// Merge with your app's events
const appEvents = {
  ...events,
  // Your other events...
  imageCreated: Events.synced({
    name: 'v1.ImageCreated',
    schema: Schema.Struct({
      id: Schema.String,
      fileId: Schema.String,
      caption: Schema.String
    })
  })
}

// Create materializers
const materializers = State.SQLite.materializers(appEvents, {
  ...createMaterializers(appTables),
  'v1.ImageCreated': ({ id, fileId, caption }) =>
    appTables.images.insert({ id, fileId, caption })
})

const state = State.SQLite.makeState({ tables: appTables, materializers })
export const schema = makeSchema({ events: appEvents, state })
```

## Service Worker

### Setup

Create a service worker file in your project:

```typescript
// sw.ts
import { initFileSyncServiceWorker, createMessageHandler } from 'livestore-filesync/worker'

initFileSyncServiceWorker({
  pathPrefix: '/files/',
  cacheRemoteResponses: true,
  getRemoteUrl: async (path) => {
    // Look up remote URL from your app's state
    // This could query IndexedDB or make an API call
    return `https://cdn.example.com/files/${path}`
  }
})

createMessageHandler({
  onClearCache: async () => {
    // Handle cache clear request
  },
  onPrefetch: async (paths) => {
    // Handle prefetch request
  }
})
```

### Registration

```typescript
import {
  registerFileSyncServiceWorker,
  clearServiceWorkerCache,
  prefetchFiles
} from 'livestore-filesync/worker'

// Register the service worker
await registerFileSyncServiceWorker({
  scriptUrl: '/sw.js',
  onSuccess: (registration) => console.log('SW registered:', registration),
  onUpdate: (registration) => console.log('SW update available'),
  onError: (error) => console.error('SW registration failed:', error)
})

// Clear the cache
await clearServiceWorkerCache()

// Prefetch files
await prefetchFiles(['/files/abc123', '/files/def456'])
```

## Custom Remote Storage Adapter

```typescript
import { Effect } from 'effect'
import type { RemoteStorageAdapter } from 'livestore-filesync'
import { UploadError, DownloadError, DeleteError } from 'livestore-filesync'

const myCustomAdapter: RemoteStorageAdapter = {
  upload: (file: File) =>
    Effect.tryPromise({
      try: async () => {
        // Your upload logic
        const response = await fetch('/upload', {
          method: 'POST',
          body: file
        })
        const data = await response.json()
        return data.url
      },
      catch: (error) => new UploadError({ message: 'Upload failed', cause: error })
    }),

  download: (url: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url)
        const blob = await response.blob()
        return new File([blob], 'download')
      },
      catch: (error) => new DownloadError({ message: 'Download failed', url, cause: error })
    }),

  delete: (url: string) =>
    Effect.tryPromise({
      try: async () => {
        await fetch(url, { method: 'DELETE' })
      },
      catch: (error) => new DeleteError({ message: 'Delete failed', path: url, cause: error })
    }),

  checkHealth: () =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch('/health')
        return response.ok
      },
      catch: () => false
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))
}
```

## API Reference

### FileSyncClient

Promise-based client for simple file operations.

| Method | Description |
|--------|-------------|
| `create(config)` | Create a new client |
| `saveFile(file)` | Save a file to local storage |
| `updateFile(oldPath, file)` | Update a file's content |
| `deleteFile(path)` | Delete a file from local storage |
| `getFileUrl(path)` | Get a blob URL for a file |
| `fileExists(path)` | Check if a file exists locally |
| `readFile(path)` | Read a file from local storage |
| `listFiles(directory)` | List files in a directory |
| `uploadFile(file)` | Upload a file to remote storage |
| `downloadFile(url)` | Download a file from remote |
| `downloadAndSave(url, path)` | Download and save locally |
| `uploadFromLocal(path)` | Upload a local file to remote |
| `checkRemoteHealth()` | Check remote storage availability |
| `hashFile(file)` | Get SHA-256 hash of file content |
| `dispose()` | Release resources |

### Effect Services

| Service | Description |
|---------|-------------|
| `LocalFileStorage` | OPFS-backed local file storage |
| `RemoteStorage` | Remote storage adapter |
| `FileSync` | Sync orchestration service |
| `FileStorage` | High-level file operations |
| `SyncExecutor` | Concurrent transfer queue |

### Error Types

| Error | Description |
|-------|-------------|
| `StorageError` | General storage operation error |
| `FileNotFoundError` | File not found at path |
| `DirectoryNotFoundError` | Directory not found |
| `UploadError` | Failed to upload file |
| `DownloadError` | Failed to download file |
| `DeleteError` | Failed to delete file |
| `HashError` | Failed to hash file content |
| `OPFSNotAvailableError` | OPFS not supported |

## Requirements

- Browser with OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+)
- Effect 3.x

## License

MIT
