# @livestore-filesync/image

Image processing for livestore-filesync with two backend options: a lightweight **Canvas** processor and a full-featured **[wasm-vips](https://github.com/kleisauke/wasm-vips)** processor.

## Features

### Image Preprocessing

- Resize images to a maximum dimension while maintaining aspect ratio
- Convert images to JPEG, WebP, or PNG format
- Configurable quality settings
- **Smart skip**: Already-processed images are returned unchanged to prevent quality degradation

### Thumbnail Generation

- Generate multiple thumbnail sizes in the background
- Web Worker-based processing (non-blocking)
- Persistent state tracking via LiveStore client document
- Automatic cleanup when files are deleted

## Processing Backends

This package provides two image processing backends. Choose based on your requirements:

| Feature | Canvas | Vips (wasm-vips) |
|---------|--------|------------------|
| Additional bundle size | 0 KB | ~5 MB WASM |
| ICC profile preservation | No (converts to sRGB) | Yes |
| Lossless WebP | No | Yes |
| Metadata preservation | No | Yes |
| COOP/COEP headers required | No | Yes |
| Initialization time | Instant | ~100-500ms (first use) |

### When to use Canvas

- You want zero additional bundle size
- You don't need color-accurate output (sRGB is fine)
- You can't configure COOP/COEP headers on your server
- You're building a simple app where image quality isn't critical

### When to use Vips

- You need professional-quality image processing
- You want to preserve ICC color profiles (important for photography)
- You need lossless WebP compression for smaller thumbnails
- You want to preserve image metadata (EXIF, etc.)

## Installation

```bash
# Canvas only (no WASM dependency)
pnpm add @livestore-filesync/image

# With Vips support (recommended for quality)
pnpm add @livestore-filesync/image wasm-vips
```

## Setup

### Vips Setup (skip if using Canvas only)

If using the Vips processor, copy the wasm-vips WASM file to your public directory:

```bash
# From your project root
cp node_modules/wasm-vips/lib/vips.wasm public/
```

For Vite projects, you may want to add this to your build script or use a plugin.

Your server must also send COOP/COEP headers for SharedArrayBuffer support:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

## Image Preprocessing

Preprocess images during file upload - resize and convert to optimize storage.

### Basic Usage

```typescript
import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

// Canvas processor (lightweight, no WASM)
const canvasPreprocessor = createImagePreprocessor({
  processor: 'canvas',
  maxDimension: 1500,
  quality: 90,
  format: 'jpeg'
})

// Vips processor (high quality, requires wasm-vips)
const vipsPreprocessor = createImagePreprocessor({
  processor: 'vips',  // default when wasm-vips is installed
  maxDimension: 1500,
  quality: 90,
  format: 'jpeg'
})

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    preprocessors: {
      'image/*': canvasPreprocessor  // or vipsPreprocessor
    }
  }
})
```

### Preprocessor API

#### `createImagePreprocessor(options?)`

Creates a file preprocessor that resizes and converts images.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `processor` | `'canvas' \| 'vips'` | `'vips'` | Processing backend to use. |
| `maxDimension` | `number` | `1500` | Maximum width/height in pixels. Images exceeding this are resized. Set to 0 to disable. |
| `quality` | `number` | `90` | Output quality (1-100). Only applies to JPEG and WebP. |
| `format` | `'jpeg' \| 'webp' \| 'png'` | `'jpeg'` | Output format for all processed images. |
| `minSizeThreshold` | `number` | `0` | Skip processing files below this size (in bytes). |
| `vipsOptions` | `VipsInitOptions` | - | Custom wasm-vips initialization options (Vips only). |

#### `createResizeOnlyPreprocessor(maxDimension, vipsOptions?)`

Creates a preprocessor that only resizes without format conversion. The output format matches the input format.

```typescript
import { createResizeOnlyPreprocessor } from '@livestore-filesync/image/preprocessor'

const resizer = createResizeOnlyPreprocessor(1200)
```

## Thumbnail Generation

Generate multiple thumbnail sizes in the background using a Web Worker.

### Setup

1. **Add the thumbnail schema to your LiveStore schema:**

```typescript
import { createFileSyncSchema } from '@livestore-filesync/core/schema'
import { createThumbnailSchema } from '@livestore-filesync/image/thumbnails/schema'

const fileSyncSchema = createFileSyncSchema()
const thumbnailSchema = createThumbnailSchema()

const tables = {
  ...fileSyncSchema.tables,
  ...thumbnailSchema.tables,
}
```

2. **Create a worker file:**

Choose based on your preferred processing backend:

```typescript
// thumbnail.worker.ts (Canvas - lightweight, no WASM)
import '@livestore-filesync/image/thumbnails/workers/canvas.worker'

// OR

// thumbnail.worker.ts (Vips - high quality, requires wasm-vips)
import '@livestore-filesync/image/thumbnails/workers/vips.worker'
```

3. **Initialize thumbnails:**

```typescript
import { initThumbnails, resolveThumbnailUrl } from '@livestore-filesync/image/thumbnails'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const dispose = initThumbnails(store, {
  sizes: { small: 128, medium: 256, large: 512 },
  fileSystem: opfsLayer(),
  workerUrl: new URL('./thumbnail.worker.ts', import.meta.url),
  schema: { tables }  // Pass your schema tables for file scanning
})

// Later, to clean up:
await dispose()
```

### Using Thumbnails

```typescript
import { resolveThumbnailUrl, getThumbnailState } from '@livestore-filesync/image/thumbnails'

// Get thumbnail URL (returns null if not ready)
const url = await resolveThumbnailUrl(fileId, 'small')
if (url) {
  img.src = url
}

// Or with fallback to original file
import { resolveThumbnailOrFileUrl } from '@livestore-filesync/image/thumbnails'
import { resolveFileUrl } from '@livestore-filesync/core'

const url = await resolveThumbnailOrFileUrl(
  fileId,
  'small',
  () => resolveFileUrl(fileId)
)

// Check thumbnail state
const state = getThumbnailState(fileId)
if (state?.sizes.small.status === 'done') {
  // Thumbnail is ready
}
```

### Thumbnail API

#### `initThumbnails(store, config)`

Initialize and optionally start thumbnail generation.

**Config:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sizes` | `Record<string, number>` | **required** | Map of size names to max dimension in pixels. |
| `fileSystem` | `Layer<FileSystem>` | **required** | File system layer (e.g., `@livestore-filesync/opfs`). |
| `workerUrl` | `URL \| string` | **required** | URL to your thumbnail worker file. |
| `schema` | `{ tables }` | - | Pass your schema tables for automatic file scanning. |
| `format` | `'webp' \| 'jpeg' \| 'png'` | `'webp'` | Output format for thumbnails. |
| `concurrency` | `number` | `2` | Maximum concurrent thumbnail generations. |
| `autoStart` | `boolean` | `true` | Whether to start generation automatically. |
| `onEvent` | `(event) => void` | - | Callback for thumbnail events. |

#### Other Functions

- `resolveThumbnailUrl(fileId, size)` - Get thumbnail URL (null if not ready)
- `resolveThumbnailOrFileUrl(fileId, size, getFileUrl)` - Get thumbnail with fallback
- `getThumbnailState(fileId)` - Get thumbnail generation state
- `regenerateThumbnail(fileId)` - Force regenerate thumbnails
- `startThumbnails()` / `stopThumbnails()` - Control generation
- `onThumbnailEvent(callback)` - Subscribe to events

### Thumbnail Events

```typescript
import { onThumbnailEvent } from '@livestore-filesync/image/thumbnails'

const unsub = onThumbnailEvent((event) => {
  switch (event.type) {
    case 'thumbnail:generation-started':
      console.log('Started generating', event.fileId)
      break
    case 'thumbnail:generation-completed':
      console.log('Completed', event.fileId, event.sizes)
      break
    case 'thumbnail:generation-error':
      console.error('Error', event.fileId, event.error)
      break
  }
})
```

## Advanced: WASM Path Configuration (Vips only)

If your WASM file is not in the root public directory:

```typescript
// Preprocessor
const preprocessor = createImagePreprocessor({
  processor: 'vips',
  vipsOptions: {
    locateFile: (path) => `/wasm/${path}`
  }
})

// Or pre-initialize before use
import { initVips } from '@livestore-filesync/image'

await initVips({
  locateFile: (path) => `/assets/wasm/${path}`
})
```

## Performance Notes

### Canvas Processor
- Zero additional download - uses built-in browser APIs
- Instant initialization
- Good performance for most use cases
- Thumbnails are generated in a Web Worker to avoid blocking the main thread

### Vips Processor
- The WASM module (~5 MB) is downloaded once and cached by the browser
- First image processing may have a slight delay (~100-500ms) while WASM initializes
- Subsequent processing is very fast (native speed via WebAssembly)
- Higher quality output, especially for downscaling
- Thumbnails are generated in a Web Worker to avoid blocking the main thread

## Browser Support

### Canvas Processor
Works in all modern browsers with Canvas API support.

### Vips Processor
Requires browsers with WebAssembly SIMD and SharedArrayBuffer support:
- Chrome 91+
- Firefox 89+
- Safari 16.4+
- Edge 91+

Note: SharedArrayBuffer requires COOP/COEP headers to be set on your server.

## License

MIT
