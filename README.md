# Livestore-Filesync

Local-first file sync for LiveStore apps. Files are stored locally first, content-addressed by SHA-256, and synced to remote storage in the background.

## How It Works

1. **Local-first storage**: Files are always written to local storage first (OPFS in browsers, filesystem in Node.js), ensuring immediate availability even offline.

2. **Content-Addressable Storage (CAS)**: Files are named by their SHA-256 hash. Duplicate content automatically collapses to a single file, saving storage and bandwidth.

3. **Background sync**: The sync engine handles bidirectional synchronization — uploading local files to remote storage and downloading files that exist remotely but not locally.

4. **LiveStore integration**: File metadata is tracked in LiveStore tables, giving you reactive queries over your files with the same local-first sync guarantees as your other app data.

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
import { initFileSync, startFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' }
})

startFileSync()
```

### 3. Use the API

```typescript
import { saveFile, getFileUrl } from '@livestore-filesync/core'

const result = await saveFile(file)
const url = await getFileUrl(result.fileId)
```

See `examples/` for complete implementations:
- `examples/react-filesync` — React with LiveStore
- `examples/vue-filesync` — Vue with LiveStore  
- `examples/node-filesync` — Node.js usage

## Filesystem Adapters

The core package has a pluggable filesystem architecture. It expects any layer that provides the `@effect/platform` `FileSystem` interface.

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

Custom adapters can be created by implementing the Effect Platform `FileSystem` interface.

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

## Service Worker (Optional)

For browsers, an optional service worker can intercept requests to `/livestore-filesync-files/*` and serve files from OPFS before falling back to remote. See `examples/react-filesync/file-sync-sw.ts` for implementation.

## Requirements

- Browser: OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+)
- Effect 3.x, @effect/platform 0.92+

## License

MIT
