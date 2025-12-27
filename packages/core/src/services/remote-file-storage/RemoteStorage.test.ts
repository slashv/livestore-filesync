import { Effect, Exit, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"

type FormDataLike = { get: (name: string) => unknown }
import {
  makeHttpRemoteStorage,
  makeMemoryRemoteStorage,
  type MemoryRemoteStorageOptions
} from "./index.js"
import { makeStoredPath } from "../../utils/index.js"

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

    it("should fail deletes when offline", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()
          yield* Ref.set(optionsRef, { offline: true })
          return yield* service.delete("https://test-storage.local/file")
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DeleteError)
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

  describe("options handling", () => {
    it("should use the custom baseUrl when provided", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()
          yield* Ref.set(optionsRef, { baseUrl: "https://custom-storage.local" })
          const url = yield* service.upload(new File(["data"], "data.txt"), {
            key: "custom-key"
          })
          return url
        })
      )

      expect(result).toBe("https://custom-storage.local/custom-key")
    })

    it("should fail downloads when failDownloads is true", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function*() {
          const { service, optionsRef } = yield* createTestStorage()
          yield* Ref.set(optionsRef, { failDownloads: true })
          return yield* service.download("https://test-storage.local/file")
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DownloadError)
      }
    })
  })

  describe("HTTP adapter", () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      globalThis.fetch = undefined as unknown as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it("should send auth headers and key on upload", async () => {
      let capturedBody: FormDataLike | null = null
      let capturedHeaders: Record<string, string> | null = null
      globalThis.fetch = (async (_url, init) => {
        capturedBody = init?.body as FormDataLike
        capturedHeaders = init?.headers as Record<string, string>
        return {
          ok: true,
          json: async () => ({ url: "https://files.local/uploaded" })
        } as Response
      }) as typeof fetch

      const storage = makeHttpRemoteStorage({
        baseUrl: "https://files.local",
        authToken: "token-123",
        headers: { "X-Custom": "value" }
      })

      const file = new File(["data"], "data.txt", { type: "text/plain" })
      const url = await Effect.runPromise(storage.upload(file, { key: "custom-key" }))

      expect(url).toBe("https://files.local/uploaded")
      expect(capturedHeaders).toMatchObject({
        Authorization: "Bearer token-123",
        "X-Custom": "value"
      })
      const body = capturedBody as unknown as FormDataLike | null
      expect(body?.get("key")).toBe("custom-key")
      const bodyFile = body?.get("file")
      expect(bodyFile).toBeInstanceOf(File)
    })

    it("should download and preserve file name", async () => {
      globalThis.fetch = (async () => {
        return {
          ok: true,
          blob: async () => new Blob(["download"], { type: "text/plain" })
        } as Response
      }) as typeof fetch

      const storage = makeHttpRemoteStorage({ baseUrl: "https://files.local" })
      const file = await Effect.runPromise(
        storage.download("https://files.local/path/to/file.txt")
      )

      expect(file.name).toBe("file.txt")
      expect(await file.text()).toBe("download")
    })

    it("should surface delete failures", async () => {
      globalThis.fetch = (async () => {
        return { ok: false, status: 500 } as Response
      }) as typeof fetch

      const storage = makeHttpRemoteStorage({ baseUrl: "https://files.local" })
      const exit = await Effect.runPromiseExit(storage.delete("https://files.local/file"))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DeleteError)
      }
    })

    it("should return false on health check errors", async () => {
      globalThis.fetch = (async () => {
        throw new Error("network down")
      }) as typeof fetch

      const storage = makeHttpRemoteStorage({ baseUrl: "https://files.local" })
      const healthy = await Effect.runPromise(storage.checkHealth())

      expect(healthy).toBe(false)
    })
  })
})
