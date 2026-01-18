# Image Processing

The `@livestore-filesync/image` package provides image processing capabilities with multiple backend options to suit different deployment scenarios.

## Processor Backends

### Overview

| Processor | Type   | ICC Profile | Lossless | Metadata | Bundle Size |
|-----------|--------|-------------|----------|----------|-------------|
| vips      | buffer | Preserved   | Yes      | Optional | ~3MB WASM   |
| canvas    | buffer | sRGB only   | No       | Stripped | 0 (native)  |
| expo      | uri    | sRGB only   | No       | Stripped | 0 (uses OS) |

### Vips Processor (Default)

Uses wasm-vips for high-quality image processing. Best for applications that need:
- ICC color profile preservation (wide-gamut images)
- Lossless WebP compression for small thumbnails
- Maximum image quality

```typescript
import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'

const preprocessor = createImagePreprocessor({
  processor: 'vips',  // default
  maxDimension: 1500,
  quality: 90,
  format: 'jpeg'
})
```

**Requirements:**
- Copy `node_modules/wasm-vips/lib/vips.wasm` to your public directory
- ~3MB WASM download on first use (cached by browser)

### Canvas Processor

Uses the native Canvas API for lightweight image processing. Best for:
- Electron apps (simpler than WASM loading)
- Applications where bundle size is critical
- Cases where ICC profile preservation isn't needed

```typescript
import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'

const preprocessor = createImagePreprocessor({
  processor: 'canvas',
  maxDimension: 1500,
  quality: 90,
  format: 'webp'
})
```

**Limitations:**
- Converts all images to sRGB (loses wide-gamut colors)
- No lossless WebP support
- Strips all metadata (EXIF, etc.)

## Thumbnail Workers

For thumbnail generation, choose the appropriate worker based on your needs:

### Vips Worker (Default)

```typescript
// thumbnail.worker.ts
import '@livestore-filesync/image/thumbnails/worker'
```

Or explicitly:

```typescript
// thumbnail.worker.ts  
import '@livestore-filesync/image/thumbnails/workers/vips.worker'
```

### Canvas Worker

```typescript
// thumbnail.worker.ts
import '@livestore-filesync/image/thumbnails/workers/canvas.worker'
```

## Using the Processor API Directly

For advanced use cases, you can use the processor API directly:

```typescript
import { 
  createVipsProcessor, 
  createCanvasProcessor,
  createImageProcessor 
} from '@livestore-filesync/image/processor'

// Create specific processor
const vipsProcessor = createVipsProcessor({
  locateFile: (path) => `/wasm/${path}`
})

const canvasProcessor = createCanvasProcessor()

// Or use factory function
const processor = createImageProcessor('canvas')

// Initialize and process
await processor.init()

const result = await processor.process(imageBuffer, {
  maxDimension: 1500,
  format: 'jpeg',
  quality: 90
})

// Process multiple sizes at once (more efficient)
const thumbnails = await processor.processMultiple(imageBuffer, {
  small: 128,
  medium: 256,
  large: 512
}, {
  format: 'webp',
  quality: 85
})
```

## Processor Capabilities

Each processor reports its capabilities:

```typescript
const processor = createCanvasProcessor()

console.log(processor.capabilities)
// {
//   preservesIccProfile: false,
//   supportsLossless: false,
//   preservesMetadata: false,
//   supportedFormats: ['jpeg', 'webp', 'png'],
//   runsOffMainThread: true
// }
```

Use this to make runtime decisions:

```typescript
if (processor.capabilities.preservesIccProfile) {
  // Use for professional photography
} else {
  // Warn about color profile conversion
}
```

## Migration Guide

### From Previous Versions

The default behavior remains unchanged. Existing code using the vips processor continues to work:

```typescript
// This still works exactly as before
import { createImagePreprocessor } from '@livestore-filesync/image/preprocessor'

const preprocessor = createImagePreprocessor({
  maxDimension: 1500,
  format: 'jpeg'
})
```

To switch to canvas processor, add the `processor` option:

```typescript
const preprocessor = createImagePreprocessor({
  processor: 'canvas',  // New option
  maxDimension: 1500,
  format: 'jpeg'
})
```

### Worker Migration

The default worker import path is unchanged:

```typescript
// thumbnail.worker.ts - still works
import '@livestore-filesync/image/thumbnails/worker'
```

For canvas-based workers, use the new path:

```typescript
// thumbnail.worker.ts - canvas version
import '@livestore-filesync/image/thumbnails/workers/canvas.worker'
```

## Future: Expo/React Native Support

The architecture is designed to support React Native via expo-image-manipulator in the future. The `UriImageProcessor` interface handles URI-based processing for platforms where ArrayBuffer-based processing isn't practical.

```typescript
// Future API (not yet implemented)
import { createExpoProcessor } from '@livestore-filesync/image/processor'

const processor = createExpoProcessor()
const result = await processor.process('file:///path/to/image.jpg', {
  maxDimension: 1500,
  format: 'jpeg'
})
// Returns { uri: 'file:///path/to/processed.jpg', width, height, mimeType }
```
