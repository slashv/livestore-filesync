import { Effect, Exit, Ref } from "effect"
import { describe, expect, it } from "vitest"
import { DownloadError, UploadError } from "../src/errors/index.js"
import {
  makeMemoryRemoteStorage,
  type MemoryRemoteStorageOptions
} from "../src/services/remote-file-storage/index.js"
import { makeStoredPath } from "../src/utils/index.js"

describe("RemoteStorage", () => {
  const createTestStorage = () =>
    Effect.gen(function*() {
      const storeRef = yield* Ref.make(new Map<string, { data: Uint8Array; mimeType: string; name: string }>())
      const optionsRef = yield* Ref.make<MemoryRemoteStorageOptions>({})
      const service = makeMemoryRemoteStorage(storeRef, optionsRef)
      return { service, storeRef, optionsRef }
    })

  describe("upload and download", () => {
    it("should upload a file and return a URL", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          const file = new File(["hello world"], "test.txt", { type: "text/plain" })
          const key = makeStoredPath("store-1", "abc123def456")

          const url = yield* service.upload(file, { key })

          expect(url).toBe(`https://test-storage.local/${key}`)
          return url
        })
      )

      expect(result).toBeTruthy()
    })

    it("should download a previously uploaded file", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          const originalFile = new File(["hello world"], "test.txt", { type: "text/plain" })
          const key = makeStoredPath("store-1", "abc123def456")

          const url = yield* service.upload(originalFile, { key })
          const downloadedFile = yield* service.download(url)

          return {
            name: downloadedFile.name,
            type: downloadedFile.type,
            content: yield* Effect.promise(() => downloadedFile.text())
          }
        })
      )

      expect(result.name).toBe("test.txt")
      expect(result.type).toBe("text/plain")
      expect(result.content).toBe("hello world")
    })

    it("should fail to download non-existent file", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          const key = makeStoredPath("store-1", "nonexistent")
          return yield* service.download(`https://test-storage.local/${key}`)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DownloadError)
      }
    })
  })

  describe("delete", () => {
    it("should delete an uploaded file", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          const file = new File(["to delete"], "delete-me.txt")
          const key = makeStoredPath("store-1", "delete-me")

          const url = yield* service.upload(file, { key })
          yield* service.delete(url)

          // Attempting to download should fail
          const downloadResult = yield* Effect.either(service.download(url))
          expect(downloadResult._tag).toBe("Left")
        })
      )
    })
  })

  describe("checkHealth", () => {
    it("should return true when online", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          return yield* service.checkHealth()
        })
      )

      expect(result).toBe(true)
    })

    it("should return false when offline", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()
          yield* Ref.set(optionsRef, { offline: true })
          return yield* service.checkHealth()
        })
      )

      expect(result).toBe(false)
    })
  })

  describe("offline simulation", () => {
    it("should fail uploads when offline", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()
          yield* Ref.set(optionsRef, { offline: true })

          const file = new File(["test"], "test.txt")
          return yield* service.upload(file)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(UploadError)
      }
    })

    it("should fail downloads when offline", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()

          // First upload while online
          const file = new File(["test"], "test.txt")
          const key = makeStoredPath("store-1", "abc123def456")
          const url = yield* service.upload(file, { key })

          // Then go offline and try to download
          yield* Ref.set(optionsRef, { offline: true })
          return yield* service.download(url)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DownloadError)
      }
    })
  })

  describe("selective failure simulation", () => {
    it("should fail only uploads when failUploads is true", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()

          // First upload while working
          const file = new File(["test"], "test.txt")
          const key = makeStoredPath("store-1", "abc123def456")
          const url = yield* service.upload(file, { key })

          // Enable upload failures
          yield* Ref.set(optionsRef, { failUploads: true })

          // Downloads should still work
          const downloaded = yield* service.download(url)
          expect(downloaded.name).toBe("test.txt")

          // Uploads should fail
          const uploadResult = yield* Effect.either(
            service.upload(new File(["new"], "new.txt"), {
              key: makeStoredPath("store-1", "new-file")
            })
          )
          expect(uploadResult._tag).toBe("Left")
        })
      )
    })
  })
})
