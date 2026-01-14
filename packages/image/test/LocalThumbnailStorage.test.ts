import { FileSystem, Size } from "@effect/platform/FileSystem"
import type * as FS from "@effect/platform/FileSystem"
import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { ThumbnailFileNotFoundError } from "../src/thumbnails/errors/index.js"
import { LocalThumbnailStorage, LocalThumbnailStorageLive } from "../src/thumbnails/services/LocalThumbnailStorage.js"

describe("LocalThumbnailStorage", () => {
  const makeFileInfo = (type: FS.File.Type, size = 0): FS.File.Info => ({
    type,
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0,
    ino: Option.none(),
    mode: 0,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: Size(size),
    blksize: Option.none(),
    blocks: Option.none()
  })

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

    const service: Pick<
      FS.FileSystem,
      "readFile" | "writeFile" | "readDirectory" | "makeDirectory" | "remove" | "exists" | "stat"
    > = {
      readFile: (path) =>
        Effect.sync(() => {
          const normalized = normalize(path)
          const data = files.get(normalized)
          if (!data) {
            throw new Error(`Missing file: ${normalized}`)
          }
          return data
        }),
      writeFile: (path, data) =>
        Effect.sync(() => {
          const normalized = normalize(path)
          const lastSlash = normalized.lastIndexOf("/")
          const directory = lastSlash === -1 ? "" : normalized.slice(0, lastSlash)
          ensureDirectory(directory, true)
          files.set(normalized, data)
        }),
      readDirectory: (path) =>
        Effect.sync(() => {
          const normalized = normalize(path)
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
        }),
      makeDirectory: (path, options) => Effect.sync(() => ensureDirectory(path, options?.recursive ?? true)),
      remove: (path, options) =>
        Effect.sync(() => {
          const normalized = normalize(path)
          if (files.has(normalized)) {
            files.delete(normalized)
            return
          }
          const prefix = normalized === "" ? "" : `${normalized}/`
          const hasChildren = Array.from(files.keys()).some((entry) => entry.startsWith(prefix)) ||
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
        }),
      exists: (path) =>
        Effect.sync(() => {
          const normalized = normalize(path)
          return files.has(normalized) || directories.has(normalized)
        }),
      stat: (path) =>
        Effect.sync(() => {
          const normalized = normalize(path)
          if (files.has(normalized)) {
            return makeFileInfo("File", files.get(normalized)?.length ?? 0)
          }
          if (directories.has(normalized)) {
            return makeFileInfo("Directory")
          }
          throw new Error(`Missing path: ${normalized}`)
        })
    }

    return { service: service as FS.FileSystem, files, directories }
  }

  const runWithStorage = <A, E>(
    effect: Effect.Effect<A, E, LocalThumbnailStorage>,
    service: FS.FileSystem
  ): Promise<A> =>
    Effect.runPromise(
      Effect.provide(
        effect,
        Layer.provide(Layer.succeed(FileSystem, service))(LocalThumbnailStorageLive)
      )
    )

  const runWithStorageExit = <A, E>(
    effect: Effect.Effect<A, E, LocalThumbnailStorage>,
    service: FS.FileSystem
  ): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(
      Effect.provide(
        effect,
        Layer.provide(Layer.succeed(FileSystem, service))(LocalThumbnailStorageLive)
      )
    )

  describe("writeThumbnail and readThumbnail", () => {
    it("should write and read a thumbnail", async () => {
      const { service } = createMemoryFileSystem()
      const thumbnailData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage

          const path = yield* storage.writeThumbnail("abc123", "small", "webp", thumbnailData)
          const readData = yield* storage.readThumbnail("abc123", "small", "webp")

          return { path, data: Array.from(readData) }
        }),
        service
      )

      expect(result.path).toBe("thumbnails/abc123/small.webp")
      expect(result.data).toEqual([0x89, 0x50, 0x4e, 0x47])
    })

    it("should fail when reading non-existent thumbnail", async () => {
      const { service } = createMemoryFileSystem()

      const exit = await runWithStorageExit(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          return yield* storage.readThumbnail("nonexistent", "small", "webp")
        }),
        service
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ThumbnailFileNotFoundError)
      }
    })

    it("should handle different formats", async () => {
      const { service } = createMemoryFileSystem()
      const thumbnailData = new Uint8Array([1, 2, 3, 4])

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage

          const webpPath = yield* storage.writeThumbnail("hash1", "medium", "webp", thumbnailData)
          const jpegPath = yield* storage.writeThumbnail("hash2", "medium", "jpeg", thumbnailData)
          const pngPath = yield* storage.writeThumbnail("hash3", "medium", "png", thumbnailData)

          return { webpPath, jpegPath, pngPath }
        }),
        service
      )

      expect(result.webpPath).toBe("thumbnails/hash1/medium.webp")
      expect(result.jpegPath).toBe("thumbnails/hash2/medium.jpeg")
      expect(result.pngPath).toBe("thumbnails/hash3/medium.png")
    })

    it("should handle multiple sizes for the same content hash", async () => {
      const { service } = createMemoryFileSystem()
      const smallData = new Uint8Array([1, 2, 3])
      const mediumData = new Uint8Array([4, 5, 6, 7])
      const largeData = new Uint8Array([8, 9, 10, 11, 12])

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          const contentHash = "same-hash"

          yield* storage.writeThumbnail(contentHash, "small", "webp", smallData)
          yield* storage.writeThumbnail(contentHash, "medium", "webp", mediumData)
          yield* storage.writeThumbnail(contentHash, "large", "webp", largeData)

          const readSmall = yield* storage.readThumbnail(contentHash, "small", "webp")
          const readMedium = yield* storage.readThumbnail(contentHash, "medium", "webp")
          const readLarge = yield* storage.readThumbnail(contentHash, "large", "webp")

          return {
            small: Array.from(readSmall),
            medium: Array.from(readMedium),
            large: Array.from(readLarge)
          }
        }),
        service
      )

      expect(result.small).toEqual([1, 2, 3])
      expect(result.medium).toEqual([4, 5, 6, 7])
      expect(result.large).toEqual([8, 9, 10, 11, 12])
    })
  })

  describe("thumbnailExists", () => {
    it("should return true for existing thumbnail", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          yield* storage.writeThumbnail("exists-hash", "small", "webp", new Uint8Array([1, 2, 3]))
          return yield* storage.thumbnailExists("exists-hash", "small", "webp")
        }),
        service
      )

      expect(result).toBe(true)
    })

    it("should return false for non-existent thumbnail", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          return yield* storage.thumbnailExists("does-not-exist", "small", "webp")
        }),
        service
      )

      expect(result).toBe(false)
    })
  })

  describe("deleteThumbnails", () => {
    it("should delete all thumbnails for a content hash", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          const contentHash = "to-delete"

          yield* storage.writeThumbnail(contentHash, "small", "webp", new Uint8Array([1]))
          yield* storage.writeThumbnail(contentHash, "medium", "webp", new Uint8Array([2]))
          yield* storage.writeThumbnail(contentHash, "large", "webp", new Uint8Array([3]))

          const beforeSmall = yield* storage.thumbnailExists(contentHash, "small", "webp")
          const beforeMedium = yield* storage.thumbnailExists(contentHash, "medium", "webp")
          const beforeLarge = yield* storage.thumbnailExists(contentHash, "large", "webp")

          yield* storage.deleteThumbnails(contentHash)

          const afterSmall = yield* storage.thumbnailExists(contentHash, "small", "webp")
          const afterMedium = yield* storage.thumbnailExists(contentHash, "medium", "webp")
          const afterLarge = yield* storage.thumbnailExists(contentHash, "large", "webp")

          return {
            before: { small: beforeSmall, medium: beforeMedium, large: beforeLarge },
            after: { small: afterSmall, medium: afterMedium, large: afterLarge }
          }
        }),
        service
      )

      expect(result.before.small).toBe(true)
      expect(result.before.medium).toBe(true)
      expect(result.before.large).toBe(true)
      expect(result.after.small).toBe(false)
      expect(result.after.medium).toBe(false)
      expect(result.after.large).toBe(false)
    })

    it("should not fail when deleting non-existent thumbnails", async () => {
      const { service } = createMemoryFileSystem()

      // Should not throw
      await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          yield* storage.deleteThumbnails("never-existed")
        }),
        service
      )
    })

    it("should not affect other content hashes", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage

          yield* storage.writeThumbnail("hash-a", "small", "webp", new Uint8Array([1]))
          yield* storage.writeThumbnail("hash-b", "small", "webp", new Uint8Array([2]))

          yield* storage.deleteThumbnails("hash-a")

          const hashAExists = yield* storage.thumbnailExists("hash-a", "small", "webp")
          const hashBExists = yield* storage.thumbnailExists("hash-b", "small", "webp")

          return { hashAExists, hashBExists }
        }),
        service
      )

      expect(result.hashAExists).toBe(false)
      expect(result.hashBExists).toBe(true)
    })
  })

  describe("getThumbnailPath", () => {
    it("should return correct path", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          return storage.getThumbnailPath("abc123", "small", "webp")
        }),
        service
      )

      expect(result).toBe("thumbnails/abc123/small.webp")
    })

    it("should handle different formats", async () => {
      const { service } = createMemoryFileSystem()

      const result = await runWithStorage(
        Effect.gen(function*() {
          const storage = yield* LocalThumbnailStorage
          return {
            webp: storage.getThumbnailPath("hash", "medium", "webp"),
            jpeg: storage.getThumbnailPath("hash", "medium", "jpeg"),
            png: storage.getThumbnailPath("hash", "medium", "png")
          }
        }),
        service
      )

      expect(result.webp).toBe("thumbnails/hash/medium.webp")
      expect(result.jpeg).toBe("thumbnails/hash/medium.jpeg")
      expect(result.png).toBe("thumbnails/hash/medium.png")
    })
  })
})
