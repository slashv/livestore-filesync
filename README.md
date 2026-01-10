# Livestore-Filesync

Local-first file sync for LiveStore apps. Files are stored locally first, then synced between clients via remote storage in the background.

- **Local-first**: Files are written to local storage first ensuring best UX and offline support.

- **Content-Addressable Storage (CAS)**: Files are named by their hash which avoids duplicated content and allows for automatic change detection.

- **Event-stream sync**: File transfers react to LiveStore file events with a shared cursor stored in `fileSyncCursor`.

- **Effect Platform Filesystem**: Use any Effect Platform Filesystem or the bundled OPFS adapter for local filesystem.

- **R2 and S3 remote storage**: Built in support for Cloudflare R2 and any S3 compatible remote storage service.

## Packages

| Package | Description |
|---------|-------------|
| `@livestore-filesync/core` | Framework-agnostic API and schema helpers |
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
import { saveFile, resolveFileUrl } from '@livestore-filesync/core'

const result = await saveFile(file)
const url = await resolveFileUrl(result.fileId)
```

See `examples/` for complete implementations:
- `examples/react-filesync` — React example using `resolveFileUrl()`
- `examples/vue-filesync` — Vue example using `resolveFileUrl()`
- `examples/node-filesync` — Node.js usage

## Filesystem Adapters

The core package has a pluggable filesystem architecture. It expects any layer that provides a sub-section of the `@effect/platform` `FileSystem` interface. An OPFS adapter is provided and recommended for browsers since Effects Platform Browser does not support it yet.

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

The client expects a **signer service** running in a server-side process that mints short-lived URLs for uploads/downloads and handles deletes. In the examples, we leverage the existing LiveStore Cloudflare Worker to host this signer service alongside LiveStore sync — see the `src/cf-worker/` folder in each example for the implementation.

The API contract:

- `GET /health` — Health check
- `POST /v1/sign/upload` — Returns `{ url, method, headers?, expiresAt }`
- `POST /v1/sign/download` — Returns `{ url, headers?, expiresAt }`
- `POST /v1/delete` — Deletes an object (returns 204)

We provide two backend implementations. **To switch between them, update the `main` entry point in your `wrangler.toml`** to point to either `index.r2.ts` or `index.s3.ts` — both files are provided in each example's `cf-worker/` folder:

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

Use `resolveFileUrl()` to get a displayable URL for each file. This approach integrates with the download queue and automatically prioritizes files that are being displayed.

```typescript
import { resolveFileUrl } from '@livestore-filesync/core'

const url = await resolveFileUrl(file.id)
// Use url in your component
```

**Automatic prioritization:** When `resolveFileUrl()` is called for a file that's queued for download, that file is automatically moved to the front of the queue. This ensures visible files are downloaded before background files.

See `examples/react-filesync` or `examples/vue-filesync` for complete implementations.

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

const url = await resolveFileUrl(file.id)

return canDisplay && url
  ? <img src={url} />
  : <div>{isUploading ? 'Uploading...' : 'Waiting for file...'}</div>
```

This ensures a good user experience:
- The originating client displays files immediately from local storage
- Other clients show a placeholder until the upload completes
- After edits, the correct version is displayed (based on content hash matching)

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
