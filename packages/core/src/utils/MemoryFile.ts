/**
 * MemoryFile - A File-like object backed by Uint8Array
 *
 * This class implements the Blob interface and provides File-like properties,
 * allowing it to work seamlessly across web and React Native environments.
 *
 * On web, the native File constructor works with ArrayBuffer/Uint8Array.
 * On React Native, the native Blob/File constructors don't support ArrayBuffer,
 * so this class provides a compatible alternative.
 *
 * @module
 */

/**
 * A File-like object backed by in-memory Uint8Array data.
 *
 * Implements the Blob interface and adds File properties (name, lastModified).
 * Can be used with fetch(), XMLHttpRequest, and other APIs that accept Blob/File.
 *
 * @example
 * ```typescript
 * const data = new Uint8Array([72, 101, 108, 108, 111])
 * const file = new MemoryFile(data, 'hello.txt', 'text/plain')
 *
 * // Use with fetch
 * await fetch(url, { method: 'PUT', body: file })
 *
 * // Read contents
 * const buffer = await file.arrayBuffer()
 * const text = await file.text()
 * ```
 */
export class MemoryFile implements Blob {
  private readonly _data: Uint8Array

  /** The file name */
  readonly name: string

  /** The MIME type */
  readonly type: string

  /** Last modified timestamp */
  readonly lastModified: number

  /** Size in bytes */
  readonly size: number

  constructor(
    data: Uint8Array,
    name: string,
    type: string,
    options?: { lastModified?: number }
  ) {
    this._data = data
    this.name = name
    this.type = type
    this.lastModified = options?.lastModified ?? Date.now()
    this.size = data.byteLength
  }

  /**
   * Read the file contents as an ArrayBuffer
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    // Create a new ArrayBuffer copy to match File.arrayBuffer() behavior
    const buffer = new ArrayBuffer(this._data.byteLength)
    new Uint8Array(buffer).set(this._data)
    return buffer
  }

  /**
   * Read the file contents as a Uint8Array
   */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    // Return a copy to match Blob.bytes() behavior
    const buffer = new ArrayBuffer(this._data.byteLength)
    const bytes = new Uint8Array(buffer)
    bytes.set(this._data)
    return bytes as Uint8Array<ArrayBuffer>
  }

  /**
   * Read the file contents as text
   */
  async text(): Promise<string> {
    return new TextDecoder().decode(this._data)
  }

  /**
   * Return a ReadableStream of the file contents
   */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(this._data.byteLength)
    bytes.set(this._data)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes as Uint8Array<ArrayBuffer>)
        controller.close()
      }
    })
  }

  /**
   * Return a portion of the file as a new Blob
   */
  slice(start?: number, end?: number, contentType?: string): Blob {
    const slicedData = this._data.slice(start, end)
    return new MemoryFile(
      slicedData,
      this.name,
      contentType ?? this.type,
      { lastModified: this.lastModified }
    )
  }

  /**
   * Get the raw Uint8Array data (for internal use)
   */
  get data(): Uint8Array {
    return this._data
  }
}
