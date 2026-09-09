import { Effect, Option, Result } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeExpoFileSystem } from "./ExpoFileSystem.js"

// Controlled module boundary, not an emulation of a mobile device. Native v19
// methods can return synchronously; older/wrapped modules can return promises.
const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  create: vi.fn<(uri: string) => void | Promise<void>>(),
  write: vi.fn<(uri: string, bytes: Uint8Array) => void | Promise<void>>()
}))
vi.mock("expo-file-system", () => ({
  Paths: { document: { uri: "file:///documents/" }, cache: "file:///cache/" },
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return native.files.has(this.uri)
    }
    get size() {
      return native.files.get(this.uri)?.length ?? null
    }
    readonly type = "application/octet-stream"
    readonly creationTime = 0
    readonly modificationTime = 1700000000000
    bytes() {
      return Promise.resolve(native.files.get(this.uri)!)
    }
    write(bytes: Uint8Array) {
      return native.write(this.uri, bytes)
    }
    delete() {
      native.files.delete(this.uri)
    }
    copy(destination: { uri: string }) {
      native.files.set(destination.uri, native.files.get(this.uri)!.slice())
    }
    move(destination: { uri: string }) {
      this.copy(destination)
      this.delete()
    }
  },
  Directory: class {
    constructor(readonly uri: string) {}
    get exists() {
      return native.directories.has(this.uri)
    }
    create() {
      return native.create(this.uri)
    }
  }
}))

beforeEach(() => {
  native.files.clear()
  native.directories.clear()
  native.create.mockReset().mockImplementation((uri) => {
    native.directories.add(uri)
  })
  native.write.mockReset().mockImplementation((uri, bytes) => {
    native.files.set(uri, bytes.slice())
  })
})

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("Expo filesystem module contract", () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid truncate length %s without modifying bytes",
    async (length) => {
      const fs = makeExpoFileSystem()
      await Effect.runPromise(fs.writeFile("file.bin", new Uint8Array([7, 9])))
      await expect(Effect.runPromise(fs.truncate("file.bin", length))).rejects.toThrow()
      expect(await Effect.runPromise(fs.readFile("file.bin"))).toEqual(new Uint8Array([7, 9]))
    }
  )

  it.each([
    [1, [7]],
    [0, []],
    [4, [7, 9, 0, 0]]
  ])("truncates two bytes to %i with zero-filled growth", async (length, expected) => {
    const fs = makeExpoFileSystem()
    await Effect.runPromise(fs.writeFile("file.bin", new Uint8Array([7, 9])))
    await Effect.runPromise(fs.truncate("file.bin", length))
    expect(await Effect.runPromise(fs.readFile("file.bin"))).toEqual(new Uint8Array(expected))
    expect((await Effect.runPromise(fs.stat("file.bin"))).size).toBe(BigInt(length))
  })

  it("round trips bytes through synchronous native writes and normalizes relative paths", async () => {
    const fs = makeExpoFileSystem()
    const bytes = new Uint8Array([0, 255, 128, 42])
    await Effect.runPromise(fs.writeFile("/files//hash", bytes))
    expect(native.files.get("file:///documents/files/hash")).toEqual(bytes)
    expect(await Effect.runPromise(fs.readFile("files/hash"))).toEqual(bytes)
    const info = await Effect.runPromise(fs.stat("files/hash"))
    expect(info).toMatchObject({ type: "File", size: 4n })
    expect(Option.getOrThrow(info.birthtime)).toEqual(new Date(0))
    expect(Option.getOrThrow(info.mtime)).toEqual(new Date(1700000000000))
    await Effect.runPromise(fs.copyFile("files/hash", "files/copied"))
    expect(await Effect.runPromise(fs.readFile("files/copied"))).toEqual(bytes)
    await Effect.runPromise(fs.rename("files/copied", "files/moved"))
    expect(await Effect.runPromise(fs.exists("files/copied"))).toBe(false)
    await Effect.runPromise(fs.truncate("files/moved", 2))
    expect(await Effect.runPromise(fs.readFile("files/moved"))).toEqual(bytes.slice(0, 2))
    await Effect.runPromise(fs.remove("files/hash"))
    expect(await Effect.runPromise(fs.exists("files/hash"))).toBe(false)
    await expect(Effect.runPromise(fs.readFile("files/hash"))).rejects.toThrow()
    await Effect.runPromise(fs.remove("files/hash", { force: true }))
  })

  it("waits for directory creation before writing and for write publication before succeeding", async () => {
    const directory = gate()
    const write = gate()
    native.create.mockImplementation(async (uri) => {
      await directory.promise
      native.directories.add(uri)
    })
    native.write.mockImplementation(async (uri, bytes) => {
      await write.promise
      native.files.set(uri, bytes)
    })
    const fs = makeExpoFileSystem({ baseDirectory: "file:///custom" })
    let finished = false
    const result = Effect.runPromise(fs.writeFile("nested/file", new Uint8Array([7]))).then(() => {
      finished = true
    })
    try {
      await vi.waitFor(() => expect(native.create).toHaveBeenCalledOnce())
      expect(native.write).not.toHaveBeenCalled()
      expect(finished).toBe(false)
      directory.release()
      await vi.waitFor(() => expect(native.write).toHaveBeenCalledOnce())
      expect(finished).toBe(false)
      expect(native.files.size).toBe(0)
      write.release()
      await result
      expect(await Effect.runPromise(fs.readFile("nested/file"))).toEqual(new Uint8Array([7]))
    } finally {
      directory.release()
      write.release()
      await result
    }
  })

  for (const operation of ["directory", "write"] as const) {
    for (const asyncFailure of [false, true]) {
      it(`propagates ${asyncFailure ? "asynchronous" : "synchronous"} ${operation} failures`, async () => {
        const failure = new Error("permission or quota denied")
        const fail = () => {
          if (asyncFailure) return Promise.reject(failure)
          throw failure
        }
        if (operation === "directory") native.create.mockImplementation(fail)
        else native.write.mockImplementation(fail)
        const fs = makeExpoFileSystem()
        const result = await Effect.runPromise(Effect.result(fs.writeFile("nested/file", new Uint8Array([1]))))
        expect(Result.isFailure(result)).toBe(true)
        expect(result).toMatchObject({ failure: { reason: { method: "writeFile", cause: failure } } })
        expect(native.files.size).toBe(0)
        if (operation === "directory") expect(native.write).not.toHaveBeenCalled()
      })
    }
  }

  it("awaits standalone asynchronous directory creation and reports its failure", async () => {
    native.create.mockRejectedValue(new Error("permission denied"))
    const result = await Effect.runPromise(Effect.result(makeExpoFileSystem().makeDirectory("nested")))
    expect(Result.isFailure(result)).toBe(true)
    expect(result).toMatchObject({ failure: { reason: { method: "makeDirectory" } } })
  })
})
