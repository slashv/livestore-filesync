import { Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { FileNotFoundError } from "../../errors/index.js"
import { FileSystem, type FileSystemService } from "../file-system/index.js"
import { FileSystemError } from "../../errors/index.js"
import { LocalFileStorage, LocalFileStorageLive, LocalFileStorageMemory } from "./index.js"
import { joinPath, makeStoreRoot } from "../../utils/index.js"

describe("LocalFileStorage", () => {
  const runWithStorage = <A, E>(
    effect: Effect.Effect<A, E, LocalFileStorage>
  ): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, LocalFileStorageMemory))

  const runWithStorageExit = <A, E>(
    effect: Effect.Effect<A, E, LocalFileStorage>
  ): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(Effect.provide(effect, LocalFileStorageMemory))

  const createMemoryFileSystem = () => {
    const files = new Map<string, Uint8Array>()
    const directories = new Set<string>([""])

    const normalize = (path: string): string =>
      path
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/")

    const ensureDirectory = (path: string, recursive = true) => {
      const normalized = normalize(path)
      if (normalized === "") return
      const segments = normalized.split("/")
      let current = ""
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment
        if (!directories.has(current) && !recursive) {
          throw new Error(`Missing directory: ${current}`)
        }
        directories.add(current)
      }
    }

    const listDirectEntries = (directory: string): string[] => {
      const normalized = normalize(directory)
      const prefix = normalized === "" ? "" : `${normalized}/`
      const entries = new Set<string>()

      for (const dir of directories) {
        if (dir === "" || !dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        if (rest.length === 0) continue
        entries.add(rest.split("/")[0] ?? rest)
      }

      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        entries.add(rest.split("/")[0] ?? rest)
      }

      return Array.from(entries)
    }

    const toError = (operation: string, path: string, cause: unknown) =>
      new FileSystemError({
        message: `Mock FileSystem ${operation} failed: ${path}`,
        operation,
        path,
        cause
      })

    const service: FileSystemService = {
      readFile: (path) =>
        Effect.try({
          try: () => {
            const normalized = normalize(path)
            const data = files.get(normalized)
            if (!data) {
              throw new Error(`Missing file: ${normalized}`)
            }
            return data
          },
          catch: (cause) => toError("readFile", path, cause)
        }),
      writeFile: (path, data) =>
        Effect.try({
          try: () => {
            const normalized = normalize(path)
            const { directory } = normalized.includes("/")
              ? { directory: normalized.slice(0, normalized.lastIndexOf("/")) }
              : { directory: "" }
            ensureDirectory(directory, true)
            files.set(normalized, data)
          },
          catch: (cause) => toError("writeFile", path, cause)
        }),
      readDirectory: (path) =>
        Effect.try({
          try: () => listDirectEntries(path),
          catch: (cause) => toError("readDirectory", path, cause)
        }),
      makeDirectory: (path, options) =>
        Effect.try({
          try: () => ensureDirectory(path, options?.recursive ?? true),
          catch: (cause) => toError("makeDirectory", path, cause)
        }),
      remove: (path, options) =>
        Effect.try({
          try: () => {
            const normalized = normalize(path)
            if (files.has(normalized)) {
              files.delete(normalized)
              return
            }
            const prefix = normalized === "" ? "" : `${normalized}/`
            const hasChildren =
              Array.from(files.keys()).some((entry) => entry.startsWith(prefix)) ||
              Array.from(directories).some(
                (entry) => entry !== normalized && entry.startsWith(prefix)
              )
            if (hasChildren && !options?.recursive) {
              throw new Error(`Directory not empty: ${normalized}`)
            }
            for (const filePath of Array.from(files.keys())) {
              if (filePath === normalized || filePath.startsWith(prefix)) {
                files.delete(filePath)
              }
            }
            for (const dir of Array.from(directories)) {
              if (dir === normalized || dir.startsWith(prefix)) {
                directories.delete(dir)
              }
            }
          },
          catch: (cause) => toError("remove", path, cause)
        }),
      exists: (path) =>
        Effect.try({
          try: () => {
            const normalized = normalize(path)
            return files.has(normalized) || directories.has(normalized)
          },
          catch: (cause) => toError("exists", path, cause)
        }),
      stat: (path) =>
        Effect.try({
          try: () => {
            const normalized = normalize(path)
            if (files.has(normalized)) {
              return { type: "file" as const }
            }
            if (directories.has(normalized)) {
              return { type: "directory" as const }
            }
            throw new Error(`Missing path: ${normalized}`)
          },
          catch: (cause) => toError("stat", path, cause)
        })
    }

    return { service, files }
  }

  const runWithLiveStorage = <A, E>(
    effect: Effect.Effect<A, E, LocalFileStorage>,
    service: FileSystemService
  ): Promise<A> =>
    Effect.runPromise(
      Effect.provide(
        effect,
        Layer.provide(Layer.succeed(FileSystem, service))(LocalFileStorageLive)
      )
    )

  describe("writeFile and readFile", () => {
    it("should write and read a file", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const file = new File(["hello world"], "test.txt", { type: "text/plain" })

          yield* storage.writeFile("test.txt", file)
          const readFile = yield* storage.readFile("test.txt")
          const content = yield* Effect.promise(() => readFile.text())

          return {
            name: readFile.name,
            type: readFile.type,
            content
          }
        })
      )

      expect(result.name).toBe("test.txt")
      expect(result.type).toBe("text/plain")
      expect(result.content).toBe("hello world")
    })

    it("should write and read a file in a nested path", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const file = new File(["nested content"], "nested.txt", { type: "text/plain" })

          yield* storage.writeFile("folder/subfolder/nested.txt", file)
          const readFile = yield* storage.readFile("folder/subfolder/nested.txt")
          const content = yield* Effect.promise(() => readFile.text())

          return {
            name: readFile.name,
            content
          }
        })
      )

      expect(result.name).toBe("nested.txt")
      expect(result.content).toBe("nested content")
    })

    it("should fail when reading a non-existent file", async () => {
      const exit = await runWithStorageExit(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          return yield* storage.readFile("nonexistent.txt")
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error).toBeInstanceOf(FileNotFoundError)
          expect((error.error as FileNotFoundError).path).toBe("nonexistent.txt")
        }
      }
    })
  })

  describe("writeBytes and readBytes", () => {
    it("should write and read bytes", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const data = new Uint8Array([1, 2, 3, 4, 5])

          yield* storage.writeBytes("data.bin", data)
          const readData = yield* storage.readBytes("data.bin")

          return Array.from(readData)
        })
      )

      expect(result).toEqual([1, 2, 3, 4, 5])
    })

    it("should preserve mime type when writing bytes", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const data = new TextEncoder().encode('{"key": "value"}')

          yield* storage.writeBytes("data.json", data, "application/json")
          const file = yield* storage.readFile("data.json")

          return file.type
        })
      )

      expect(result).toBe("application/json")
    })
  })

  describe("fileExists", () => {
    it("should return true for existing file", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const file = new File(["content"], "exists.txt")

          yield* storage.writeFile("exists.txt", file)
          return yield* storage.fileExists("exists.txt")
        })
      )

      expect(result).toBe(true)
    })

    it("should return false for non-existent file", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          return yield* storage.fileExists("does-not-exist.txt")
        })
      )

      expect(result).toBe(false)
    })
  })

  describe("deleteFile", () => {
    it("should delete an existing file", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const file = new File(["to delete"], "delete-me.txt")

          yield* storage.writeFile("delete-me.txt", file)
          const existsBefore = yield* storage.fileExists("delete-me.txt")

          yield* storage.deleteFile("delete-me.txt")
          const existsAfter = yield* storage.fileExists("delete-me.txt")

          return { existsBefore, existsAfter }
        })
      )

      expect(result.existsBefore).toBe(true)
      expect(result.existsAfter).toBe(false)
    })

    it("should not fail when deleting non-existent file", async () => {
      // This should not throw
      await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          yield* storage.deleteFile("never-existed.txt")
        })
      )
    })
  })

  describe("listFiles", () => {
    it("should list files in a directory", async () => {
      const storeRoot = makeStoreRoot("store-1")
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage

          yield* storage.writeFile(joinPath(storeRoot, "a.txt"), new File(["a"], "a.txt"))
          yield* storage.writeFile(joinPath(storeRoot, "b.txt"), new File(["b"], "b.txt"))
          yield* storage.writeFile(joinPath(storeRoot, "c.txt"), new File(["c"], "c.txt"))

          return yield* storage.listFiles(storeRoot)
        })
      )

      expect(result).toHaveLength(3)
      expect(result).toContain(joinPath(storeRoot, "a.txt"))
      expect(result).toContain(joinPath(storeRoot, "b.txt"))
      expect(result).toContain(joinPath(storeRoot, "c.txt"))
    })

    it("should list files in nested directories", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage

          yield* storage.writeFile("root/a.txt", new File(["a"], "a.txt"))
          yield* storage.writeFile("root/sub/b.txt", new File(["b"], "b.txt"))
          yield* storage.writeFile("root/sub/deep/c.txt", new File(["c"], "c.txt"))

          return yield* storage.listFiles("root")
        })
      )

      expect(result).toHaveLength(3)
      expect(result).toContain("root/a.txt")
      expect(result).toContain("root/sub/b.txt")
      expect(result).toContain("root/sub/deep/c.txt")
    })

    it("should return empty array for empty directory", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          return yield* storage.listFiles("empty")
        })
      )

      expect(result).toEqual([])
    })
  })

  describe("overwriting files", () => {
    it("should overwrite existing file with same path", async () => {
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage

          yield* storage.writeFile("overwrite.txt", new File(["original"], "overwrite.txt"))
          yield* storage.writeFile("overwrite.txt", new File(["updated"], "overwrite.txt"))

          const file = yield* storage.readFile("overwrite.txt")
          return yield* Effect.promise(() => file.text())
        })
      )

      expect(result).toBe("updated")
    })
  })

  describe("metadata handling", () => {
    it("should preserve metadata from stored files", async () => {
      const { service } = createMemoryFileSystem()
      const result = await runWithLiveStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          const file = new File(["meta"], "meta.txt", { type: "text/plain", lastModified: 1234 })

          yield* storage.writeFile("meta.txt", file)
          const readFile = yield* storage.readFile("meta.txt")

          return { type: readFile.type, lastModified: readFile.lastModified }
        }),
        service
      )

      expect(result.type).toBe("text/plain")
      expect(result.lastModified).toBe(1234)
    })

    it("should filter metadata files from listFiles", async () => {
      const { service, files } = createMemoryFileSystem()
      const result = await runWithLiveStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          yield* storage.writeBytes("root/file.txt", new TextEncoder().encode("data"), "text/plain")
          return yield* storage.listFiles("root")
        }),
        service
      )

      expect(result).toEqual(["root/file.txt"])
      const hasMeta = Array.from(files.keys()).some((key) => key.endsWith(".meta.json"))
      expect(hasMeta).toBe(true)
    })

    it("should remove metadata when deleting a file", async () => {
      const { service, files } = createMemoryFileSystem()
      await runWithLiveStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage
          yield* storage.writeFile("remove.txt", new File(["data"], "remove.txt"))
          yield* storage.deleteFile("remove.txt")
        }),
        service
      )

      const remaining = Array.from(files.keys())
      expect(remaining).toHaveLength(0)
    })
  })
})
