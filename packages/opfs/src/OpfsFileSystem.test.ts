import { SystemError } from "@effect/platform/Error"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeOpfsFileSystem } from "./OpfsFileSystem.js"

type Entry = FileEntry | DirectoryEntry

interface FileEntry {
  type: "file"
  data: Uint8Array
  mimeType: string
}

interface DirectoryEntry {
  type: "directory"
  entries: Map<string, Entry>
}

const createNotFound = () => new DOMException("NotFound", "NotFoundError")

class MockFileHandle {
  private directory: DirectoryEntry
  private name: string

  constructor(directory: DirectoryEntry, name: string) {
    this.directory = directory
    this.name = name
  }

  async getFile(): Promise<File> {
    const entry = this.directory.entries.get(this.name)
    if (!entry || entry.type !== "file") {
      throw createNotFound()
    }
    const buffer = entry.data.buffer.slice(
      entry.data.byteOffset,
      entry.data.byteOffset + entry.data.byteLength
    ) as ArrayBuffer
    return new File([buffer], this.name, { type: entry.mimeType })
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write: (data: Blob) => Promise<void>
    truncate: (length: number) => Promise<void>
    close: () => Promise<void>
  }> {
    const fileHandle = this
    return {
      write: async (data: Blob) => {
        const buffer = await data.arrayBuffer()
        fileHandle.directory.entries.set(fileHandle.name, {
          type: "file",
          data: new Uint8Array(buffer),
          mimeType: data.type || "application/octet-stream"
        })
      },
      truncate: async (length: number) => {
        const entry = fileHandle.directory.entries.get(fileHandle.name)
        if (entry && entry.type === "file") {
          entry.data = entry.data.slice(0, length)
        }
      },
      close: async () => {}
    }
  }
}

class MockDirectoryHandle {
  private entry: DirectoryEntry
  readonly kind = "directory"

  constructor(entry: DirectoryEntry) {
    this.entry = entry
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectoryHandle> {
    const existing = this.entry.entries.get(name)
    if (existing) {
      if (existing.type !== "directory") {
        throw new DOMException("TypeMismatch", "TypeMismatchError")
      }
      return new MockDirectoryHandle(existing)
    }
    if (!options?.create) {
      throw createNotFound()
    }
    const next: DirectoryEntry = { type: "directory", entries: new Map() }
    this.entry.entries.set(name, next)
    return new MockDirectoryHandle(next)
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileHandle> {
    const existing = this.entry.entries.get(name)
    if (existing) {
      if (existing.type !== "file") {
        throw new DOMException("TypeMismatch", "TypeMismatchError")
      }
      return new MockFileHandle(this.entry, name)
    }
    if (!options?.create) {
      throw createNotFound()
    }
    this.entry.entries.set(name, {
      type: "file",
      data: new Uint8Array(),
      mimeType: "application/octet-stream"
    })
    return new MockFileHandle(this.entry, name)
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.entry.entries.get(name)
    if (!existing) {
      throw createNotFound()
    }
    if (existing.type === "directory" && existing.entries.size > 0 && !options?.recursive) {
      throw new DOMException("InvalidModification", "InvalidModificationError")
    }
    this.entry.entries.delete(name)
  }

  entries(): AsyncIterable<[string, MockFileHandle | MockDirectoryHandle]> {
    const parent = this.entry
    const iterator = parent.entries.entries()
    return {
      async *[Symbol.asyncIterator]() {
        for (const [name, entry] of iterator) {
          yield [
            name,
            entry.type === "directory"
              ? new MockDirectoryHandle(entry)
              : new MockFileHandle(parent, name)
          ] as [string, MockFileHandle | MockDirectoryHandle]
        }
      }
    }
  }
}

const createMockRoot = () => new MockDirectoryHandle({ type: "directory", entries: new Map() })

describe("OpfsFileSystem", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  let root: MockDirectoryHandle

  beforeEach(() => {
    root = createMockRoot()
    const navigatorValue = originalNavigator?.value ?? {}
    Object.assign(navigatorValue, { storage: { getDirectory: async () => root } })
    Object.defineProperty(globalThis, "navigator", {
      value: navigatorValue,
      configurable: true,
      writable: true
    })
  })

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator)
    } else {
      delete (globalThis as { navigator?: unknown }).navigator
    }
  })

  it("writes and reads files with a base directory", async () => {
    const fs = makeOpfsFileSystem({ baseDirectory: "base" })
    const bytes = new Uint8Array([1, 2, 3])

    await Effect.runPromise(fs.writeFile("dir/file.bin", bytes))

    const entries = await Effect.runPromise(fs.readDirectory(""))
    expect(entries).toContain("dir")

    const data = await Effect.runPromise(fs.readFile("dir/file.bin"))
    expect(Array.from(data)).toEqual([1, 2, 3])
  })

  it("lists directories and removes entries", async () => {
    const fs = makeOpfsFileSystem()
    await Effect.runPromise(fs.writeFile("root/a.txt", new Uint8Array([7])))
    await Effect.runPromise(fs.writeFile("root/sub/b.txt", new Uint8Array([8])))

    const rootEntries = await Effect.runPromise(fs.readDirectory("root"))
    expect(rootEntries).toEqual(expect.arrayContaining(["a.txt", "sub"]))

    await Effect.runPromise(fs.remove("root/sub", { recursive: true }))
    const exists = await Effect.runPromise(fs.exists("root/sub"))
    expect(exists).toBe(false)
  })

  it("returns stats for files and directories", async () => {
    const fs = makeOpfsFileSystem()
    await Effect.runPromise(fs.makeDirectory("docs", { recursive: true }))
    await Effect.runPromise(fs.writeFile("docs/readme.txt", new Uint8Array([9])))

    const dirStat = await Effect.runPromise(fs.stat("docs"))
    const fileStat = await Effect.runPromise(fs.stat("docs/readme.txt"))

    expect(dirStat.type).toBe("Directory")
    expect(fileStat.type).toBe("File")
  })

  it("fails with SystemError when reading missing files", async () => {
    const fs = makeOpfsFileSystem()

    const result = await Effect.runPromiseExit(fs.readFile("missing.txt"))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const error = result.cause
      expect(error._tag).toBe("Fail")
      if (error._tag === "Fail") {
        expect(error.error).toBeInstanceOf(SystemError)
        expect((error.error as SystemError).reason).toBe("NotFound")
      }
    }
  })

  it("checks file existence correctly", async () => {
    const fs = makeOpfsFileSystem()
    await Effect.runPromise(fs.writeFile("exists.txt", new Uint8Array([1])))

    expect(await Effect.runPromise(fs.exists("exists.txt"))).toBe(true)
    expect(await Effect.runPromise(fs.exists("missing.txt"))).toBe(false)
  })

  it("creates and removes temp directories", async () => {
    const fs = makeOpfsFileSystem()
    const tempDir = await Effect.runPromise(fs.makeTempDirectory({ prefix: "test" }))

    expect(tempDir).toContain("test")
    expect(await Effect.runPromise(fs.exists(tempDir))).toBe(true)

    await Effect.runPromise(fs.remove(tempDir, { recursive: true }))
    expect(await Effect.runPromise(fs.exists(tempDir))).toBe(false)
  })

  it("copies files correctly", async () => {
    const fs = makeOpfsFileSystem()
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await Effect.runPromise(fs.writeFile("source.bin", data))

    await Effect.runPromise(fs.copyFile("source.bin", "dest.bin"))

    const copied = await Effect.runPromise(fs.readFile("dest.bin"))
    expect(Array.from(copied)).toEqual([1, 2, 3, 4, 5])
  })

  it("renames files correctly", async () => {
    const fs = makeOpfsFileSystem()
    const data = new Uint8Array([1, 2, 3])
    await Effect.runPromise(fs.writeFile("old.txt", data))

    await Effect.runPromise(fs.rename("old.txt", "new.txt"))

    expect(await Effect.runPromise(fs.exists("old.txt"))).toBe(false)
    expect(await Effect.runPromise(fs.exists("new.txt"))).toBe(true)
    const renamed = await Effect.runPromise(fs.readFile("new.txt"))
    expect(Array.from(renamed)).toEqual([1, 2, 3])
  })
})
