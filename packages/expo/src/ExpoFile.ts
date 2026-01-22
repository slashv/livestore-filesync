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
  readonly uri: string
  bytes(): Promise<Uint8Array>
  bytesSync(): Uint8Array
  text(): Promise<string>
  textSync(): string
  write(content: string | Uint8Array): void
}

interface ExpoFsDirectory {
  readonly uri: string
}

// The File class constructor in expo-file-system v19+
interface ExpoFsFileConstructor {
  new(...args: Array<unknown>): ExpoFsFile
}

interface ExpoFsModule {
  File?: ExpoFsFileConstructor
  Paths?: {
    cache: ExpoFsDirectory | string
    document: ExpoFsDirectory | string
  }
}

interface LegacyFsModule {
  readAsStringAsync: (uri: string, options?: { encoding?: string }) => Promise<string>
  writeAsStringAsync: (uri: string, contents: string, options?: { encoding?: string }) => Promise<void>
  getInfoAsync: (uri: string) => Promise<{ size?: number | null }>
  cacheDirectory: string | null
  documentDirectory: string | null
}

type ExpoFsModuleCandidate = ExpoFsModule | { default?: ExpoFsModule }
type LegacyFsModuleCandidate = LegacyFsModule | { default?: LegacyFsModule }

let _fs: ExpoFsModule | null = null
let _legacyFs: LegacyFsModule | null = null

const normalizeExpoFsModule = (module: ExpoFsModuleCandidate): ExpoFsModule | null => {
  if ("File" in module && module.File) {
    return module as ExpoFsModule
  }

  if ("default" in module && module.default?.File) {
    return module.default
  }

  return null
}

const normalizeLegacyFsModule = (module: LegacyFsModuleCandidate): LegacyFsModule => {
  if ("readAsStringAsync" in module) {
    return module as LegacyFsModule
  }

  if ("default" in module && module.default && "readAsStringAsync" in module.default) {
    return module.default
  }

  throw new Error("expo-file-system legacy module missing readAsStringAsync")
}

const getFs = async (): Promise<ExpoFsModule | null> => {
  if (!_fs) {
    // Dynamic import to avoid bundling issues
    const module = (await import("expo-file-system")) as ExpoFsModuleCandidate
    _fs = normalizeExpoFsModule(module)
  }
  return _fs
}

const getLegacyFs = async (): Promise<LegacyFsModule> => {
  if (!_legacyFs) {
    // @ts-expect-error - legacy entrypoint has no bundled types
    const module = (await import("expo-file-system/legacy")) as LegacyFsModuleCandidate
    _legacyFs = normalizeLegacyFsModule(module)
  }
  return _legacyFs
}

const normalizeFileUri = (uri: string): string => {
  if (!uri) return uri
  if (uri.startsWith("file://")) return uri
  if (uri.startsWith("file:/")) {
    return `file://${uri.replace(/^file:\/*/, "")}`
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return uri
  if (uri.startsWith("/")) return `file://${uri}`
  return uri
}

const decodeBase64 = (input: string): Uint8Array => {
  const binString = atob(input)
  const size = binString.length
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    bytes[i] = binString.charCodeAt(i)
  }
  return bytes
}

/**
 * Create an expo-file-system File instance from a URI
 */
const createFsFile = async (uri: string): Promise<ExpoFsFile> => {
  const fs = await getFs()
  if (!fs?.File) {
    throw new Error("expo-file-system module missing File export")
  }
  const normalizedUri = normalizeFileUri(uri)
  return new fs.File(normalizedUri)
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

    try {
      const file = await createFsFile(this.uri)
      this._size = file.size ?? 0
      return this._size
    } catch (error) {
      try {
        const legacy = await getLegacyFs()
        const normalizedUri = normalizeFileUri(this.uri)
        const info = await legacy.getInfoAsync(normalizedUri)
        this._size = info.size ?? 0
        return this._size
      } catch (legacyError) {
        console.error("[ExpoFile] getSize() failed", {
          uri: this.uri,
          name: this.name,
          error,
          legacyError
        })
        return 0
      }
    }
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

    try {
      const file = await createFsFile(this.uri)
      const bytes = await file.bytes()
      this._cachedBytes = bytes
      this._size = bytes.length
      return bytes as Uint8Array<ArrayBuffer>
    } catch (error) {
      // Try legacy API as fallback
      const fallback = await this.readBytesWithLegacy()
      if (fallback) {
        return fallback
      }
      throw error
    }
  }

  /**
   * Read the file contents as text
   */
  async text(): Promise<string> {
    try {
      const file = await createFsFile(this.uri)
      return file.text()
    } catch (error) {
      // Try legacy API as fallback
      const fallback = await this.readTextWithLegacy()
      if (fallback !== null) {
        return fallback
      }
      throw error
    }
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

  private async readBytesWithLegacy(): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const legacy = await getLegacyFs()
      const normalizedUri = normalizeFileUri(this.uri)
      const base64 = await legacy.readAsStringAsync(normalizedUri, { encoding: "base64" })
      const bytes = decodeBase64(base64)
      this._cachedBytes = bytes as Uint8Array<ArrayBuffer>
      this._size = bytes.length
      return bytes as Uint8Array<ArrayBuffer>
    } catch {
      return null
    }
  }

  private async readTextWithLegacy(): Promise<string | null> {
    try {
      const legacy = await getLegacyFs()
      const normalizedUri = normalizeFileUri(this.uri)
      return await legacy.readAsStringAsync(normalizedUri)
    } catch {
      return null
    }
  }

  /**
   * Create an ExpoFile from file metadata
   */
  static fromUri(
    uri: string,
    options: { name?: string; type?: string; lastModified?: number; size?: number } = {}
  ): ExpoFile {
    const normalizedUri = normalizeFileUri(uri)

    // Extract name from URI if not provided
    const name = options.name ?? normalizedUri.split("/").pop() ?? "file"

    // Try to infer type from extension if not provided
    let type = options.type
    if (!type) {
      const ext = name.split(".").pop()?.toLowerCase()
      type = ext ? getMimeTypeFromExtension(ext) : "application/octet-stream"
    }

    return new ExpoFile(normalizedUri, name, type, {
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
    if (!fs?.Paths) {
      throw new Error("expo-file-system module missing Paths export")
    }

    // Generate a unique filename in the cache directory
    const cacheDirUri = options?.cacheDir ?? (typeof fs.Paths.cache === "string" ? fs.Paths.cache : fs.Paths.cache.uri)
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`
    const uri = `${cacheDirUri}/${uniqueName}`

    // Write the bytes to the file
    const file = await createFsFile(uri)
    file.write(bytes)

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
