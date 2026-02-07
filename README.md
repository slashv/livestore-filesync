# Livestore-Filesync

File sync for LiveStore apps. This missing piece for local-first apps that need to sync files.

**[!]** This is still under active development and not yet fully tested or ready. Generally the sync functionality on web and desktop (electron) is in a functional state while the expo (mobile) and image packages are less mature.

**[!]** This project targets LiveStore 0.4 which is in active development. The LiveStore source is included as a git submodule (on the `dev` branch) so that we develop against the latest version rather than a pre-release from npm. See [Getting Started](#getting-started) for clone instructions.

- **Local-first**: Files are written to local storage first ensuring best UX and offline support.

- **Background sync**: Files as synced in background by reacting to LiveStore events.

- **Cross platform support**: Web, desktop and mobile support through file system adapters based on the Effect Platform Filesystem interface.

- **R2 and S3 remote storage**: Built in support for Cloudflare R2 and any S3 compatible remote storage service.

- **Media type support**: An optional image package is available for pre-processing helpers and local thumbnail generation. Artchitecture supports extending to other media types.

## Packages

| Package | Description |
|---------|-------------|
| `@livestore-filesync/core` | Framework-agnostic API and schema helpers |
| `@livestore-filesync/opfs` | OPFS filesystem adapter for browsers |
| `@livestore-filesync/expo` | Expo/React Native filesystem and image processing adapters |
| `@livestore-filesync/r2` | Cloudflare R2 storage handler (Worker-proxied) |
| `@livestore-filesync/s3-signer` | S3-compatible presigned URL signer (direct-to-storage) |
| `@livestore-filesync/image` | Image preprocessing and thumbnail generation |

## Getting Started

This repo uses a git submodule for LiveStore. You must clone with `--recursive` to pull it in:

```bash
git clone --recursive https://github.com/<org>/livestore-filesync.git
cd livestore-filesync
```

If you already cloned without `--recursive`, or are using this repo as a submodule in another project, initialize it with:

```bash
git submodule update --init --recursive
```

Then install dependencies:

```bash
pnpm install
```

### Updating LiveStore

To pull the latest LiveStore `dev` branch:

```bash
cd libs/livestore
git pull origin dev
cd ../..
pnpm install
```

## Install

```bash
# Web app (React/Vue/etc)
pnpm add @livestore-filesync/core @livestore-filesync/opfs

# Expo/React Native
pnpm add @livestore-filesync/core @livestore-filesync/expo
npx expo install expo-file-system expo-image-manipulator

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
- `examples/react-filesync` — React example
- `examples/vue-filesync` — Vue example
- `examples/vue-thumbnail` — Vue example with image thumbnail generation (wasm-vips)
- `examples/react-thumbnail` — React example with image thumbnails using the canvas processor (no WASM)
- `examples/node-filesync` — Node.js usage

**Note on examples**: I've been using examples to test out the implementation on different platforms and frameworks. The examples are also used to run the e2e tests against which makes them more complicated than they need to be for testing and debugging purposes. As the project matures the examples will probably migrate towards a few simpler examples and the e2e testing targets into seperate apps.

## Filesystem Adapters

The core package has a pluggable filesystem architecture. It expects any layer that provides a sub-section of the `@effect/platform` `FileSystem` interface.

**Browser (OPFS)**: Use the provided `@livestore-filesync/opfs` package:
```typescript
import { layer as opfsLayer } from '@livestore-filesync/opfs'
initFileSync(store, { fileSystem: opfsLayer(), ... })
```

**Expo/React Native**: Use the provided `@livestore-filesync/expo` package:
```typescript
import { layer as expoLayer } from '@livestore-filesync/expo'
initFileSync(store, { fileSystem: expoLayer(), ... })
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
      // Secret for HMAC-signing presigned URLs
      getSigningSecret: (env) => env.FILE_SIGNING_SECRET,
      // Async auth validation with optional key prefix restrictions
      validateAuth: async (request, env) => {
        const token = request.headers.get("Authorization")?.replace("Bearer ", "")
        if (!token || token !== env.WORKER_AUTH_TOKEN) return null // Deny
        return [] // Allow all keys (or return ["user123/"] to restrict)
      }
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
    // Async auth validation with optional key prefix restrictions
    validateAuth: async (request, env) => {
      const token = request.headers.get("Authorization")?.replace("Bearer ", "")
      if (!token || token !== env.WORKER_AUTH_TOKEN) return null // Deny
      return [] // Allow all keys (or return ["user123/"] to restrict)
    }
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

## File Preprocessors

FileSync supports preprocessing files before they are saved. This is useful for:
- Resizing images to reduce storage and bandwidth
- Converting images to more efficient formats (WebP, JPEG)
- Applying transformations based on file type

### Basic Usage

```typescript
import { initFileSync, type PreprocessorMap } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const preprocessors: PreprocessorMap = {
  // Transform all images
  'image/*': async (file) => {
    // Your transformation logic
    return transformedFile
  },
  // Or specific types
  'image/png': async (file) => convertPngToJpeg(file)
}

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: { preprocessors }
})
```

### Pattern Matching

Preprocessor patterns support:
- **Exact match**: `'image/png'` matches only PNG files
- **Wildcard subtype**: `'image/*'` matches all image types
- **Universal wildcard**: `'*'` or `'*/*'` matches any file

Priority order: exact match > wildcard subtype > universal wildcard.

### Image Preprocessing Package

For image preprocessing, use the optional `@livestore-filesync/image` package:

```bash
pnpm add @livestore-filesync/image wasm-vips
```

```typescript
import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    preprocessors: {
      'image/*': createImagePreprocessor({
        maxDimension: 1500,  // Max width/height in pixels
        quality: 90,         // JPEG/WebP quality (1-100)
        format: 'jpeg'       // Output format: 'jpeg', 'webp', or 'png'
      })
    }
  }
})
```

**Lightweight Canvas Alternative:** If you don't need the full power of wasm-vips (ICC profile preservation, lossless compression), you can use the canvas-based processor:

```typescript
createImagePreprocessor({
  processor: 'canvas',  // No WASM required
  maxDimension: 1500,
  format: 'webp'
})
```

See the [image package README](packages/image/README.md) and [image processing docs](docs/image-processing.md) for setup instructions and full documentation.

## Image Thumbnails (Optional)

The `@livestore-filesync/image` package provides client-side thumbnail generation in a dedicated web worker. Two processing backends are available:

- **Canvas**: Lightweight, zero additional bundle size, works everywhere
- **Vips (wasm-vips)**: Higher quality, ICC profile preservation, ~5 MB WASM download

### Features

- **Client-side generation**: Thumbnails are generated in the browser
- **Multiple sizes**: Configure named sizes (e.g., small: 128, medium: 256, large: 512)
- **Local storage**: Thumbnails stored in OPFS (not synced between clients)
- **Automatic generation**: Watches for new image files and generates thumbnails automatically
- **Leader-only**: Only the leader tab generates thumbnails to avoid duplicated work

### Quick Start

```typescript
import { createFileSyncSchema } from '@livestore-filesync/core/schema'
import { createThumbnailSchema } from '@livestore-filesync/image/thumbnails/schema'
import { initThumbnails, resolveThumbnailUrl } from '@livestore-filesync/image/thumbnails'
import { State } from '@livestore/livestore'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

// 1. Merge schemas
const fileSyncSchema = createFileSyncSchema()
const thumbnailSchema = createThumbnailSchema()

const tables = { ...fileSyncSchema.tables, ...thumbnailSchema.tables }
const events = { ...fileSyncSchema.events, ...thumbnailSchema.events }

const materializers = State.SQLite.materializers(events, {
  ...fileSyncSchema.createMaterializers(tables),
  ...thumbnailSchema.createMaterializers(tables)
})

// 2. Initialize (after FileSync is initialized)
const dispose = initThumbnails(store, {
  sizes: { small: 128, medium: 256, large: 512 },
  format: 'webp',
  fileSystem: opfsLayer(),
  workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
  schema: { tables }
})

// 3. Create your worker file (thumbnail.worker.ts)
// import '@livestore-filesync/image/thumbnails/worker'

// 4. Get thumbnail URLs
const url = await resolveThumbnailUrl(fileId, 'small')
```

See `examples/vue-thumbnail` (wasm-vips) and `examples/react-thumbnail` (canvas processor) for complete implementations.

## Requirements

- Browser: OPFS support (Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+)
- Effect 3.x, @effect/platform 0.92+
- For image processing with Vips: wasm-vips ^0.0.16 (~5 MB WASM), SharedArrayBuffer support (requires COOP/COEP headers). Alternatively, use the Canvas processor which has no additional requirements.

## License

MIT
