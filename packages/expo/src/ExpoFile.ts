/**
 * File-like wrapper for URI-based files in Expo/React Native
 *
 * Provides a Web File API compatible interface that works with file URIs,
 * allowing the same FilePreprocessor signature to work across web and mobile.
 *
 * @module
 */

// Expo file system types (minimal interface we need)
interface ExpoFsFile {
  readonly size: number | null
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  write(content: string | Uint8Array): Promise<void>
}

interface ExpoFsModule {
  File: new(uri: string) => ExpoFsFile
  Paths: {
    cache: string
    document: string
  }
}

let _fs: ExpoFsModule | null = null

const getFs = async (): Promise<ExpoFsModule> => {
  if (!_fs) {
    // Dynamic import to avoid bundling issues
    // @ts-expect-error - expo-file-system types are provided by the consuming app
    _fs = (await import("expo-file-system")) as ExpoFsModule
  }
  return _fs
}

/**
 * A File-like wrapper for URI-based files in Expo/React Native.
 *
 * This class implements the essential parts of the Web File API,
 * allowing it to be used with FilePreprocessor and other APIs
 * that expect File objects.
 *
 * @example
 * ```typescript
 * // Create from a file URI
 * const file = new ExpoFile('file:///path/to/image.jpg', 'image.jpg', 'image/jpeg')
 *
 * // Use with FilePreprocessor
 * const processed = await preprocessor(file)
 *
 * // Read contents
 * const buffer = await file.arrayBuffer()
 * const text = await file.text()
 * ```
 */
export class ExpoFile implements Blob {
  /** The file URI (file:// or content://) */
  readonly uri: string

  /** The file name */
  readonly name: string

  /** The MIME type */
  readonly type: string

  /** Last modified timestamp (defaults to now if not provided) */
  readonly lastModified: number

  private _size: number | null = null
  private _cachedBytes: Uint8Array | null = null

  constructor(
    uri: string,
    name: string,
    type: string,
    options?: { lastModified?: number; size?: number }
  ) {
    this.uri = uri
    this.name = name
    this.type = type
    this.lastModified = options?.lastModified ?? Date.now()
    this._size = options?.size ?? null
  }

  /**
   * Get the file size in bytes.
   * Note: This may require a filesystem call if size wasn't provided in constructor.
   */
  get size(): number {
    if (this._size !== null) {
      return this._size
    }
    // Return 0 if size unknown - caller should use getSize() for accurate size
    return 0
  }

  /**
   * Get the accurate file size (async).
   * Use this instead of the `size` property when you need the actual size.
   */
  async getSize(): Promise<number> {
    if (this._size !== null) {
      return this._size
    }

    const fs = await getFs()
    const file = new fs.File(this.uri)
    this._size = file.size ?? 0
    return this._size
  }

  /**
   * Read the file contents as an ArrayBuffer
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes()
    // Create a new ArrayBuffer to ensure we return ArrayBuffer, not SharedArrayBuffer
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    return buffer
  }

  /**
   * Read the file contents as a Uint8Array
   */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this._cachedBytes) {
      return this._cachedBytes as Uint8Array<ArrayBuffer>
    }

    const fs = await getFs()
    const file = new fs.File(this.uri)
    const bytes = await file.bytes()
    this._cachedBytes = bytes
    this._size = bytes.length
    return bytes as Uint8Array<ArrayBuffer>
  }

  /**
   * Read the file contents as text
   */
  async text(): Promise<string> {
    const fs = await getFs()
    const file = new fs.File(this.uri)
    return file.text()
  }

  /**
   * Return a portion of the file as a new Blob
   */
  slice(_start?: number, _end?: number, _contentType?: string): Blob {
    // For now, we don't support slicing - return a placeholder
    // This could be implemented by reading the file and slicing the bytes
    throw new Error("ExpoFile.slice() is not yet implemented")
  }

  /**
   * Return a ReadableStream of the file contents
   */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    // Create a simple ReadableStream from the bytes
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      async start(controller) {
        try {
          const bytes = await self.bytes()
          controller.enqueue(bytes)
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      }
    })
  }

  /**
   * Clear any cached data to free memory
   */
  clearCache(): void {
    this._cachedBytes = null
  }

  /**
   * Create an ExpoFile from file metadata
   */
  static fromUri(
    uri: string,
    options: { name?: string; type?: string; lastModified?: number; size?: number } = {}
  ): ExpoFile {
    // Extract name from URI if not provided
    const name = options.name ?? uri.split("/").pop() ?? "file"

    // Try to infer type from extension if not provided
    let type = options.type
    if (!type) {
      const ext = name.split(".").pop()?.toLowerCase()
      type = ext ? getMimeTypeFromExtension(ext) : "application/octet-stream"
    }

    return new ExpoFile(uri, name, type, {
      ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
      ...(options.size !== undefined ? { size: options.size } : {})
    })
  }

  /**
   * Create an ExpoFile from bytes (writes to cache directory)
   */
  static async fromBytes(
    bytes: Uint8Array,
    name: string,
    type: string,
    options?: { cacheDir?: string }
  ): Promise<ExpoFile> {
    const fs = await getFs()

    // Generate a unique filename in the cache directory
    const cacheDir = options?.cacheDir ?? fs.Paths.cache
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`
    const uri = `${cacheDir}/${uniqueName}`

    // Write the bytes to the file
    const file = new fs.File(uri)
    await file.write(bytes)

    return new ExpoFile(uri, name, type, {
      lastModified: Date.now(),
      size: bytes.length
    })
  }
}

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromExtension(ext: string): string {
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",

    // Documents
    pdf: "application/pdf",
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    xml: "application/xml",

    // Media
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",

    // Archives
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar"
  }

  return mimeTypes[ext] ?? "application/octet-stream"
}
