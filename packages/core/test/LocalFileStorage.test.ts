import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { FileNotFoundError } from "../src/errors/index.js"
import {
  LocalFileStorage,
  LocalFileStorageMemory
} from "../src/services/local-file-storage/index.js"

describe("LocalFileStorage", () => {
  const runWithStorage = <A, E>(
    effect: Effect.Effect<A, E, LocalFileStorage>
  ): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, LocalFileStorageMemory))

  const runWithStorageExit = <A, E>(
    effect: Effect.Effect<A, E, LocalFileStorage>
  ): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(Effect.provide(effect, LocalFileStorageMemory))

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
      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalFileStorage

          yield* storage.writeFile("files/a.txt", new File(["a"], "a.txt"))
          yield* storage.writeFile("files/b.txt", new File(["b"], "b.txt"))
          yield* storage.writeFile("files/c.txt", new File(["c"], "c.txt"))

          return yield* storage.listFiles("files")
        })
      )

      expect(result).toHaveLength(3)
      expect(result).toContain("files/a.txt")
      expect(result).toContain("files/b.txt")
      expect(result).toContain("files/c.txt")
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
})
