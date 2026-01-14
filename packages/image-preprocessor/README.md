# @livestore-filesync/image-preprocessor

High-quality image preprocessing for livestore-filesync using [wasm-vips](https://github.com/nicolo-ribaudo/libvips-wasm).

## Features

- Resize images to a maximum dimension while maintaining aspect ratio
- Convert images to JPEG, WebP, or PNG format
- Configurable quality settings
- Lazy-loaded WASM module (only initialized when first image is processed)
- Browser-cached WASM for fast subsequent loads
- **Smart skip**: Already-processed images are returned unchanged to prevent quality degradation

## Installation

```bash
pnpm add @livestore-filesync/image-preprocessor wasm-vips
```

## Setup

### 1. Copy the WASM file

Copy the wasm-vips WASM file to your public directory so it can be loaded at runtime:

```bash
# From your project root
cp node_modules/wasm-vips/lib/vips.wasm public/
```

For Vite projects, you may want to add this to your build script or use a plugin.

### 2. Configure the preprocessor

```typescript
import { createImagePreprocessor } from '@livestore-filesync/image-preprocessor'
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

// Create a preprocessor with default settings
// (max 1500px, JPEG at 90% quality)
const imagePreprocessor = createImagePreprocessor()

// Or customize the settings
const customPreprocessor = createImagePreprocessor({
  maxDimension: 1200,  // Max width/height in pixels
  quality: 85,         // JPEG/WebP quality (1-100)
  format: 'webp'       // Output format: 'jpeg', 'webp', or 'png'
})

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    preprocessors: {
      'image/*': imagePreprocessor
    }
  }
})
```

## API

### `createImagePreprocessor(options?)`

Creates a file preprocessor that resizes and converts images.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxDimension` | `number` | `1500` | Maximum width/height in pixels. Images exceeding this are resized. Set to 0 to disable. |
| `quality` | `number` | `90` | Output quality (1-100). Only applies to JPEG and WebP. |
| `format` | `'jpeg' \| 'webp' \| 'png'` | `'jpeg'` | Output format for all processed images. |
| `minSizeThreshold` | `number` | `0` | Skip processing files below this size (in bytes). |
| `vipsOptions` | `VipsInitOptions` | - | Custom wasm-vips initialization options. |

**Example with custom WASM path:**

```typescript
const preprocessor = createImagePreprocessor({
  maxDimension: 1500,
  quality: 90,
  format: 'jpeg',
  vipsOptions: {
    locateFile: (path) => `/wasm/${path}`  // Custom path
  }
})
```

### `createResizeOnlyPreprocessor(maxDimension, vipsOptions?)`

Creates a preprocessor that only resizes without format conversion. The output format matches the input format.

```typescript
import { createResizeOnlyPreprocessor } from '@livestore-filesync/image-preprocessor'

const resizer = createResizeOnlyPreprocessor(1200)

initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' },
  options: {
    preprocessors: {
      'image/*': resizer
    }
  }
})
```

### `initVips(options?)`

Manually initialize wasm-vips. This is typically not needed as it's called automatically by the preprocessors.

```typescript
import { initVips, isVipsInitialized } from '@livestore-filesync/image-preprocessor'

// Pre-initialize during app startup
await initVips({
  locateFile: (path) => `/assets/wasm/${path}`
})

// Check if initialized
console.log(isVipsInitialized())  // true
```

## Skip Behavior

To prevent quality degradation from repeated re-compression, the preprocessor automatically skips processing when an image is already in the correct state:

- **`createImagePreprocessor`**: Skips if the image is already in the target format AND within the dimension bounds
- **`createResizeOnlyPreprocessor`**: Skips if the image is already within the dimension bounds

This is especially important when using `updateFile()` — if a user re-saves an already-processed image, it won't be re-compressed.

## Performance Notes

- The WASM module (~7MB) is downloaded once and cached by the browser
- First image processing may have a slight delay while WASM initializes
- Subsequent processing is fast (native speed via WebAssembly)
- Processing happens on the main thread; for heavy workloads, consider using a Web Worker

## Browser Support

Requires browsers with WebAssembly support:
- Chrome 57+
- Firefox 52+
- Safari 11+
- Edge 16+

## License

MIT
