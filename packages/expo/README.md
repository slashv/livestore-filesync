# @livestore-filesync/expo

Expo/React Native adapters for livestore-filesync. Provides filesystem and image processing implementations for mobile apps.

## Features

- **Effect Platform FileSystem** - Full `@effect/platform` FileSystem implementation using `expo-file-system`
- **Image Processor** - URI-based image processor using `expo-image-manipulator` for thumbnails and resizing
- **ExpoFile Wrapper** - File-like wrapper that bridges URI-based files with the Web File API

## Installation

```bash
pnpm add @livestore-filesync/expo @livestore-filesync/core
```

### Peer Dependencies

This package requires the following Expo packages to be installed in your app:

```bash
npx expo install expo-file-system expo-image-manipulator
```

## Usage

### FileSystem Adapter

The Expo FileSystem adapter implements the `@effect/platform` FileSystem interface, allowing livestore-filesync to work seamlessly on mobile:

```typescript
import { initFileSync } from '@livestore-filesync/core'
import { layer as expoFileSystemLayer } from '@livestore-filesync/expo'

// Initialize with Expo filesystem (uses Documents directory by default)
const dispose = initFileSync(store, {
  fileSystem: expoFileSystemLayer(),
  remote: { signerBaseUrl: 'https://api.example.com' }
})
```

#### Custom Base Directory

By default, files are stored in `Paths.document` (persistent storage). You can customize this:

```typescript
import { layer as expoFileSystemLayer } from '@livestore-filesync/expo'
import { Paths } from 'expo-file-system'

// Use cache directory instead (can be cleared by OS)
const dispose = initFileSync(store, {
  fileSystem: expoFileSystemLayer({ baseDirectory: Paths.cache }),
  remote: { signerBaseUrl: 'https://api.example.com' }
})
```

### Image Processor

The Expo image processor uses `expo-image-manipulator` for native image processing:

```typescript
import { createExpoImageProcessor } from '@livestore-filesync/expo'

const processor = createExpoImageProcessor()
await processor.init()

// Process a single image
const result = await processor.process('file:///path/to/image.jpg', {
  maxDimension: 1500,
  format: 'jpeg',
  quality: 85
})

console.log(result.uri)    // file:///path/to/processed.jpg
console.log(result.width)  // 1500
console.log(result.height) // 1000
console.log(result.mimeType) // image/jpeg

// Process multiple sizes at once
const thumbnails = await processor.processMultiple(
  'file:///path/to/image.jpg',
  { small: 200, medium: 800, large: 1500 },
  { format: 'jpeg', quality: 80 }
)
```

#### Format Support

| Format | iOS | Android |
|--------|-----|---------|
| JPEG   | Yes | Yes     |
| PNG    | Yes | Yes     |
| WebP   | No* | Yes     |

*WebP encoding is only supported on Android. On iOS, requesting WebP will automatically fall back to JPEG.

### ExpoFile Wrapper

The `ExpoFile` class provides a Web `File`-like interface for URI-based files, enabling compatibility with `FilePreprocessor` and other APIs that expect the standard File API:

```typescript
import { ExpoFile } from '@livestore-filesync/expo'

// Create from a file URI
const file = ExpoFile.fromUri('file:///path/to/image.jpg', {
  type: 'image/jpeg'  // Optional, inferred from extension if not provided
})

// Use with any API expecting a File
const buffer = await file.arrayBuffer()
const text = await file.text()
const bytes = await file.bytes()

// Create from bytes (writes to cache directory)
const newFile = await ExpoFile.fromBytes(
  uint8Array,
  'output.jpg',
  'image/jpeg'
)
console.log(newFile.uri) // file:///path/to/cache/output.jpg
```

#### File Properties

```typescript
file.uri          // The file:// URI
file.name         // Filename
file.type         // MIME type
file.size         // File size in bytes (0 if unknown, use getSize() for accurate size)
file.lastModified // Last modified timestamp
```

## API Reference

### FileSystem Layer

```typescript
// Default layer (uses Paths.document)
export const layerDefault: Layer.Layer<FileSystem>

// Configurable layer
export function layer(options?: ExpoFileSystemOptions): Layer.Layer<FileSystem>

interface ExpoFileSystemOptions {
  baseDirectory?: string  // Base directory for all operations
}
```

### Image Processor

```typescript
export function createExpoImageProcessor(
  options?: ExpoImageProcessorOptions
): UriImageProcessor

interface ExpoImageProcessorOptions {
  defaultQuality?: number  // Default quality 0-100 (default: 90)
}

interface UriImageProcessor {
  readonly type: 'uri'
  readonly capabilities: ImageProcessorCapabilities
  init(): Promise<void>
  isInitialized(): boolean
  process(inputUri: string, options: ProcessImageOptions): Promise<ProcessedImageUri>
  processMultiple(
    inputUri: string,
    sizes: Record<string, number>,
    options: Omit<ProcessImageOptions, 'maxDimension'>
  ): Promise<Record<string, ProcessedImageUri>>
}

interface ProcessImageOptions {
  maxDimension: number
  format: 'jpeg' | 'webp' | 'png'
  quality?: number  // 0-100
}

interface ProcessedImageUri {
  uri: string
  width: number
  height: number
  mimeType: string
}
```

### ExpoFile

```typescript
export class ExpoFile implements Blob {
  readonly uri: string
  readonly name: string
  readonly type: string
  readonly size: number
  readonly lastModified: number

  constructor(uri: string, name: string, type: string, options?: {
    lastModified?: number
    size?: number
  })

  // Async methods
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  getSize(): Promise<number>  // Accurate size (reads from filesystem if needed)
  stream(): ReadableStream<Uint8Array>

  // Static factories
  static fromUri(uri: string, options?: {
    name?: string
    type?: string
    lastModified?: number
    size?: number
  }): ExpoFile

  static fromBytes(
    bytes: Uint8Array,
    name: string,
    type: string,
    options?: { cacheDir?: string }
  ): Promise<ExpoFile>
}
```

## Supported FileSystem Operations

| Operation | Supported | Notes |
|-----------|-----------|-------|
| readFile / writeFile | Yes | |
| readFileString / writeFileString | Yes | |
| exists | Yes | |
| makeDirectory | Yes | Recursive by default |
| readDirectory | Yes | Supports recursive option |
| remove | Yes | Supports recursive and force options |
| copy / copyFile | Yes | |
| rename | Yes | Uses move internally |
| stat | Yes | Returns size, type, mtime, birthtime |
| makeTempFile / makeTempDirectory | Yes | Uses cache directory |
| chmod / chown | No-op | Not supported on mobile |
| link / symlink / readLink | Error | Not supported on mobile |
| watch | Error | Not supported by expo-file-system |
| open (file handles) | Error | Use readFile/writeFile instead |

## Limitations

1. **No file watching** - `expo-file-system` doesn't support filesystem watching
2. **No symlinks/hardlinks** - Not available on mobile platforms
3. **No permissions** - chmod/chown are no-ops
4. **WebP on iOS** - WebP encoding falls back to JPEG on iOS
5. **File handles** - The `open()` method is not implemented; use `readFile`/`writeFile` instead

## License

MIT
