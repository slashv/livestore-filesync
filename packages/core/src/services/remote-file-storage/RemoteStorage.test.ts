import { Effect, Exit, Ref } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DeleteError, DownloadError, UploadError } from "../../errors/index.js"

type FormDataLike = { get: (name: string) => unknown }
import {
  makeS3SignerRemoteStorage,
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
    it("should upload a file and return the key", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const { service } = yield* createTestStorage()
          const file = new File(["hello world"], "test.txt", { type: "text/plain" })
          const key = makeStoredPath("store-1", "abc123def456")

          const upload = yield* service.upload(file, { key })

          expect(upload.key).toBe(key)
          return upload.key
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

          yield* service.upload(originalFile, { key })
          const downloadedFile = yield* service.download(key)

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
          return yield* service.download(key)
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

          yield* service.upload(file, { key })
          yield* service.delete(key)

          // Attempting to download should fail
          const downloadResult = yield* Effect.either(service.download(key))
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
          return yield* service.upload(file, { key: "file" })
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
          yield* service.upload(file, { key })

          // Then go offline and try to download
          yield* Ref.set(optionsRef, { offline: true })
          return yield* service.download(key)
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
          return yield* service.delete("file")
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
          yield* service.upload(file, { key })

          // Enable upload failures
          yield* Ref.set(optionsRef, { failUploads: true })

          // Downloads should still work
          const downloaded = yield* service.download(key)
          expect(downloaded.name).toBe("test.txt")

          // Uploads should fail
          const uploadResult = yield* Effect.either(
            service.upload(new File(["new"], "new.txt"), { key: makeStoredPath("store-1", "new-file") })
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
          const key = "custom-key"
          yield* service.upload(new File(["data"], "data.txt"), { key })
          return yield* service.getDownloadUrl(key)
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

    it("should send auth headers and key to signer on upload", async () => {
      let capturedBody: unknown = null
      let capturedHeaders: Record<string, string> | null = null
      globalThis.fetch = (async (url, init) => {
        if (String(url) === "https://signer.local/v1/sign/upload") {
          capturedBody = init?.body
          capturedHeaders = init?.headers as Record<string, string>
          return {
            ok: true,
            json: async () => ({
              method: "PUT",
              url: "https://s3.local/put-url",
              headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
              expiresAt: new Date().toISOString()
            })
          } as Response
        }
        if (String(url) === "https://s3.local/put-url") {
          return { ok: true, headers: new Headers({ ETag: '"etag-1"' }) } as Response
        }
        return { ok: false, status: 404 } as Response
      }) as typeof fetch

      const storage = makeS3SignerRemoteStorage({
        signerBaseUrl: "https://signer.local",
        authToken: "token-123",
        headers: { "X-Custom": "value" }
      })

      const file = new File(["data"], "data.txt", { type: "text/plain" })
      const upload = await Effect.runPromise(storage.upload(file, { key: "custom-key" }))

      expect(upload.key).toBe("custom-key")
      expect(upload.etag).toBe('"etag-1"')
      expect(capturedHeaders).toMatchObject({
        Authorization: "Bearer token-123",
        "X-Custom": "value",
        "Content-Type": "application/json"
      })
      expect(JSON.parse(String(capturedBody))).toMatchObject({ key: "custom-key" })
    })

    it("should mint a download URL and download a file", async () => {
      globalThis.fetch = (async (url) => {
        if (String(url) === "https://signer.local/v1/sign/download") {
          return {
            ok: true,
            json: async () => ({
              url: "https://s3.local/get-url",
              expiresAt: new Date().toISOString()
            })
          } as Response
        }
        if (String(url) === "https://s3.local/get-url") {
          return {
            ok: true,
            blob: async () => new Blob(["download"], { type: "text/plain" })
          } as Response
        }
        return { ok: false, status: 404 } as Response
      }) as typeof fetch

      const storage = makeS3SignerRemoteStorage({ signerBaseUrl: "https://signer.local" })
      const file = await Effect.runPromise(
        storage.download("path/to/file.txt")
      )

      expect(file.name).toBe("file.txt")
      expect(await file.text()).toBe("download")
    })

    it("should surface delete failures", async () => {
      globalThis.fetch = (async () => {
        return { ok: false, status: 500 } as Response
      }) as typeof fetch

      const storage = makeS3SignerRemoteStorage({ signerBaseUrl: "https://signer.local" })
      const exit = await Effect.runPromiseExit(storage.delete("file"))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(DeleteError)
      }
    })

    it("should return false on health check errors", async () => {
      globalThis.fetch = (async () => {
        throw new Error("network down")
      }) as typeof fetch

      const storage = makeS3SignerRemoteStorage({ signerBaseUrl: "https://signer.local" })
      const healthy = await Effect.runPromise(storage.checkHealth())

      expect(healthy).toBe(false)
    })
  })
})
