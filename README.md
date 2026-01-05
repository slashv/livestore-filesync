# Livestore-Filesync

Local-first file sync for LiveStore apps. Files are stored locally first, then synced between clients via remote storage in the background.

## How It Works

1. **Local-first storage**: Files are always written to local storage first (OPFS in browsers, filesystem in Node.js), ensuring immediate availability even offline.

2. **Content-Addressable Storage (CAS)**: Files are named by their hash which makes things so much easier by avoiding duplicated content and automatic change detection.

3. **Background sync**: The sync engine handles bidirectional synchronization — uploading local files to remote storage and downloading files that exist remotely but not locally.

4. **Built for LiveStore**: File metadata lives in LiveStore tables, so you get reactive queries over your files with the same local-first sync model as the rest of your app.

## Packages

| Package | Description |
|---------|-------------|
| `@livestore-filesync/core` | Framework-agnostic API, schema helpers, service worker utilities |
| `@livestore-filesync/opfs` | OPFS filesystem adapter for browsers |
| `@livestore-filesync/r2` | Cloudflare R2 storage handler (Worker-proxied) |
| `@livestore-filesync/s3-signer` | S3-compatible presigned URL signer (direct-to-storage) |

## Install

```bash
# Web app (React/Vue/etc)
pnpm add @livestore-filesync/core @livestore-filesync/opfs

# Node.js
pnpm add @livestore-filesync/core @effect/platform-node
```

## Quick Start

### 1. Extend your LiveStore schema

```typescript
import { createFileSyncSchema } from '@livestore-filesync/core/schema'

const fileSyncSchema = createFileSyncSchema()

export const tables = { ...fileSyncSchema.tables, /* your tables */ }
export const events = { ...fileSyncSchema.events, /* your events */ }

const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables)
})
```

### 2. Initialize FileSync

```typescript
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const dispose = initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' }
})

// Later, to clean up:
// await dispose()
```

### 3. Use the API

```typescript
import { saveFile, getFileUrl } from '@livestore-filesync/core'

const result = await saveFile(file)
const url = await getFileUrl(result.fileId)
```

See `examples/` for complete implementations:
- `examples/react-filesync` — React with service worker for file URL resolution
- `examples/vue-filesync` — Vue using `resolveFileUrl()` (no service worker)
- `examples/node-filesync` — Node.js usage

## Filesystem Adapters

The core package has a pluggable filesystem architecture. It expects any layer that provides a sub-section of the `@effect/platform` `FileSystem` interface. Use any existing effect Filesystem or write your own. OPFS provided as doesn't exist in Effect platform browser and was the most suitable for browsers.

**Browser (OPFS)**: Use the provided `@livestore-filesync/opfs` package:
```typescript
import { layer as opfsLayer } from '@livestore-filesync/opfs'
initFileSync(store, { fileSystem: opfsLayer(), ... })
```

**Node.js**: Use `@effect/platform-node` directly:
```typescript
import { NodeFileSystem } from '@effect/platform-node'
createFileSync({ fileSystem: NodeFileSystem.layer, ... })
```

## Backend Storage

The client expects a **signer service** that mints short-lived URLs for uploads/downloads and handles deletes. The API contract:

- `GET /health` — Health check
- `POST /v1/sign/upload` — Returns `{ url, method, headers?, expiresAt }`
- `POST /v1/sign/download` — Returns `{ url, headers?, expiresAt }`
- `POST /v1/delete` — Deletes an object (returns 204)

We provide two backend implementations:

### R2 Adapter (`@livestore-filesync/r2`)

Files are proxied through your Cloudflare Worker using R2 bucket bindings.

```typescript
import { createR2Handler, composeFetchHandlers } from '@livestore-filesync/r2'

export default {
  fetch: composeFetchHandlers(
    createR2Handler({
      bucket: (env) => env.FILE_BUCKET,
      getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
    })
  )
}
```

### S3 Signer (`@livestore-filesync/s3-signer`)

Generates presigned URLs — clients upload/download directly to S3-compatible storage.

```typescript
import { createS3SignerHandler } from '@livestore-filesync/s3-signer'

export default {
  fetch: createS3SignerHandler({
    basePath: '/api',
    getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
  })
}
```

Requires S3 credentials (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) and CORS configuration on the bucket for browser uploads.

### Comparison

| | R2 Adapter | S3 Signer |
|---|---|---|
| **How it works** | Worker proxies all file data | Worker signs URLs, clients transfer directly |
| **Setup** | Simple — just R2 binding | Requires S3 credentials + CORS |
| **Best for** | Local dev, small deployments | High traffic, large files |
| **Trade-offs** | Bandwidth through Worker (~128MB limit) | More complex initial setup |

## File URL Resolution

There are two ways to resolve file URLs in the browser:

### Option 1: Service Worker (simpler component code if targeting browser)

The service worker intercepts requests to `/livestore-filesync-files/*` and serves files from OPFS, falling back to remote storage. This lets you use `file.path` directly as an image src.

**Setup:**

1. Copy the bundled service worker to your public folder (add to `package.json`):
```json
{
  "scripts": {
    "postinstall": "cp node_modules/@livestore-filesync/core/dist/file-sync-sw.iife.js public/file-sync-sw.js"
  }
}
```

2. Initialize the service worker before rendering (must complete before file URLs work):
```typescript
import { initServiceWorker } from '@livestore-filesync/core/worker'

await initServiceWorker({ authToken })
```

3. Use the file path directly:
```tsx
<img src={`/${file.path}`} />
```

The bundled service worker works in all browsers including Firefox. See `examples/react-filesync` for a complete implementation.

### Option 2: resolveFileUrl() (no service worker needed)

If you prefer not to use a service worker, use `resolveFileUrl()` to get a URL for each file. This returns a signed remote URL.

```typescript
import { resolveFileUrl } from '@livestore-filesync/core'

const url = await resolveFileUrl(file.id)
// Use url in your component
```

See `examples/vue-filesync` for this approach.

## Handling Upload State

When files sync across clients, the file metadata may arrive before the file content is uploaded. Use `getFileDisplayState()` to determine if a file can be displayed:

```typescript
import { getFileDisplayState } from '@livestore-filesync/core'

// In your component
const [localFileState] = store.useClientDocument(tables.localFileState)
const { canDisplay, isUploading } = getFileDisplayState(file, localFileState?.localFiles ?? {})

// canDisplay is true when:
// - The file exists locally (originating client can display immediately)
// - OR the file has been uploaded (remoteKey is set, other clients can download)

return canDisplay
  ? <img src={`/${file.path}`} />
  : <div>{isUploading ? 'Uploading...' : 'Waiting for file...'}</div>
```

This ensures a good user experience:
- The originating client displays files immediately from local storage
- Other clients show a placeholder until the upload completes
- After edits, the correct version is displayed (based on content hash matching)

Pattern suitable both when using service worker (see React example) and without (see Vue example).

## Multi-Tab Support

FileSync is designed to work correctly when multiple browser tabs are open to the same app. It uses LiveStore's built-in leader election (via Web Locks API) to ensure only one tab runs the sync loop at a time. This prevents race conditions and duplicate operations.

- **Leader tab**: Runs the sync loop, handles uploads/downloads
- **Non-leader tabs**: Can still save/update/delete files — operations are synced to the leader via SharedWorker
- **Automatic failover**: If the leader tab closes, another tab automatically becomes leader

No configuration required — this works automatically.

## Requirements

- Browser: OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+)
- Effect 3.x, @effect/platform 0.92+

## License

MIT
