import { beforeEach, describe, expect, it, vi } from "vitest"
import { createR2Handler } from "./r2Handler.js"

// Mock R2 bucket implementation
const createMockBucket = () => {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>()
  return {
    store,
    list: vi.fn(async () => ({ objects: [] })),
    put: vi.fn(async (key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, {
        data: value,
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream"
      })
    }),
    get: vi.fn(async (key: string) => {
      const item = store.get(key)
      if (!item) return null
      return {
        size: item.data.byteLength,
        etag: `"${key}-etag"`,
        httpMetadata: { contentType: item.contentType },
        body: new Blob([item.data])
      }
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    })
  }
}

type MockEnv = {
  FILE_BUCKET: ReturnType<typeof createMockBucket>
  FILE_SIGNING_SECRET: string
}

describe("createR2Handler", () => {
  let mockBucket: ReturnType<typeof createMockBucket>
  let env: MockEnv

  beforeEach(() => {
    mockBucket = createMockBucket()
    env = {
      FILE_BUCKET: mockBucket,
      FILE_SIGNING_SECRET: "test-signing-secret"
    }
  })

  describe("health endpoint", () => {
    it("should return health status", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/api/health", { method: "GET" })
      const response = await handler(request, env, {})

      expect(response).not.toBeNull()
      const data = await response!.json()
      expect(data.status).toBe("ok")
      expect(data.bucket).toBe(true)
    })
  })

  describe("OPTIONS requests", () => {
    it("should handle CORS preflight", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/api/v1/sign/upload", { method: "OPTIONS" })
      const response = await handler(request, env, {})

      expect(response).not.toBeNull()
      expect(response!.status).toBe(204)
      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("*")
    })
  })

  describe("sign/upload endpoint", () => {
    it("should return signed URL without auth when validateAuth is not configured", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const data = await response!.json()
      expect(data.method).toBe("PUT")
      expect(data.url).toContain("/livestore-filesync-files/test-file.txt")
      expect(data.url).toContain("sig=")
      expect(data.expiresAt).toBeDefined()
    })

    it("should reject unauthorized requests when validateAuth returns null", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => null
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(401)
    })

    it("should allow access when validateAuth returns empty array (no restrictions)", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "any-file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
    })

    it("should allow access when key matches allowed prefix", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user123/file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
    })

    it("should return 403 when key does not match allowed prefix", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
    })

    it("should support multiple allowed prefixes", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => ["user123/", "shared/"]
      })

      // First prefix should work
      const request1 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user123/file.txt" })
      })
      const response1 = await handler(request1, env, {})
      expect(response1!.status).toBe(200)

      // Second prefix should work
      const request2 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "shared/document.pdf" })
      })
      const response2 = await handler(request2, env, {})
      expect(response2!.status).toBe(200)

      // Other prefix should fail
      const request3 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "other/file.txt" })
      })
      const response3 = await handler(request3, env, {})
      expect(response3!.status).toBe(403)
    })
  })

  describe("sign/download endpoint", () => {
    it("should return signed download URL", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const data = await response!.json()
      expect(data.url).toContain("/livestore-filesync-files/test-file.txt")
      expect(data.url).toContain("sig=")
    })

    it("should enforce key prefix restrictions for downloads", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(403)
    })
  })

  describe("delete endpoint", () => {
    it("should delete file when authorized", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response).not.toBeNull()
      expect(response!.status).toBe(204)
      expect(mockBucket.delete).toHaveBeenCalledWith("test-file.txt")
    })

    it("should enforce key prefix restrictions for deletes", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(403)
      expect(mockBucket.delete).not.toHaveBeenCalled()
    })
  })

  describe("file upload (PUT)", () => {
    it("should upload file with valid signed URL", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      // First get a signed URL
      const signRequest = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-upload.txt" })
      })
      const signResponse = await handler(signRequest, env, {})
      const { url } = await signResponse!.json()

      // Now upload to the signed URL
      const uploadRequest = new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "Hello, World!"
      })
      const uploadResponse = await handler(uploadRequest, env, {})

      expect(uploadResponse).not.toBeNull()
      expect(uploadResponse!.status).toBe(200)
      expect(mockBucket.put).toHaveBeenCalled()
    })

    it("should reject upload with invalid signature", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      const exp = Math.floor(Date.now() / 1000) + 900
      const uploadRequest = new Request(
        `http://localhost/livestore-filesync-files/test.txt?exp=${exp}&sig=invalid-signature`,
        {
          method: "PUT",
          body: "content"
        }
      )

      const response = await handler(uploadRequest, env, {})
      expect(response!.status).toBe(401)
    })

    it("should reject upload with expired signature", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      const exp = Math.floor(Date.now() / 1000) - 100 // Expired
      const uploadRequest = new Request(
        `http://localhost/livestore-filesync-files/test.txt?exp=${exp}&sig=any`,
        {
          method: "PUT",
          body: "content"
        }
      )

      const response = await handler(uploadRequest, env, {})
      expect(response!.status).toBe(401)
    })
  })

  describe("file download (GET)", () => {
    it("should download file with valid signed URL", async () => {
      // Pre-populate the bucket
      const content = new TextEncoder().encode("File content")
      mockBucket.store.set("test-download.txt", {
        data: content.buffer,
        contentType: "text/plain"
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      // Get a signed download URL
      const signRequest = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-download.txt" })
      })
      const signResponse = await handler(signRequest, env, {})
      const { url } = await signResponse!.json()

      // Download from the signed URL
      const downloadRequest = new Request(url, { method: "GET" })
      const downloadResponse = await handler(downloadRequest, env, {})

      expect(downloadResponse).not.toBeNull()
      expect(downloadResponse!.status).toBe(200)
      expect(downloadResponse!.headers.get("Content-Type")).toBe("text/plain")
    })

    it("should return 404 for non-existent file", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET
      })

      // Get a signed URL for a file that doesn't exist
      const signRequest = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "non-existent.txt" })
      })
      const signResponse = await handler(signRequest, env, {})
      const { url } = await signResponse!.json()

      const downloadRequest = new Request(url, { method: "GET" })
      const downloadResponse = await handler(downloadRequest, env, {})

      expect(downloadResponse!.status).toBe(404)
    })
  })

  describe("async validateAuth callback", () => {
    it("should receive request and env in validateAuth", async () => {
      const validateAuth = vi.fn(async (request: Request, e: MockEnv) => {
        expect(request.headers.get("Authorization")).toBe("Bearer user-token")
        expect(e.FILE_SIGNING_SECRET).toBe("test-signing-secret")
        return [] as ReadonlyArray<string>
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user-token"
        },
        body: JSON.stringify({ key: "file.txt" })
      })

      await handler(request, env, {})
      expect(validateAuth).toHaveBeenCalled()
    })

    it("should support async validation against external services", async () => {
      // Simulate async auth validation
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async (request) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (!token) return null

          // Simulate async validation
          await new Promise((resolve) => setTimeout(resolve, 10))

          // Return user-specific prefix based on "decoded" token
          if (token === "valid-user-token") {
            return ["user-123/"]
          }
          return null
        }
      })

      // Valid token
      const validRequest = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-user-token"
        },
        body: JSON.stringify({ key: "user-123/file.txt" })
      })
      const validResponse = await handler(validRequest, env, {})
      expect(validResponse!.status).toBe(200)

      // Invalid token
      const invalidRequest = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token"
        },
        body: JSON.stringify({ key: "user-123/file.txt" })
      })
      const invalidResponse = await handler(invalidRequest, env, {})
      expect(invalidResponse!.status).toBe(401)
    })
  })

  describe("URL signing without signing secret", () => {
    it("should not include signature when getSigningSecret is not provided", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test.txt" })
      })

      const response = await handler(request, env, {})
      const data = await response!.json()

      expect(data.url).toContain("exp=")
      expect(data.url).not.toContain("sig=")
    })

    it("should allow file access without signature when no signing secret", async () => {
      mockBucket.store.set("public-file.txt", {
        data: new TextEncoder().encode("public").buffer,
        contentType: "text/plain"
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
        // No getSigningSecret
      })

      const exp = Math.floor(Date.now() / 1000) + 900
      const request = new Request(
        `http://localhost/livestore-filesync-files/public-file.txt?exp=${exp}`,
        { method: "GET" }
      )

      const response = await handler(request, env, {})
      expect(response!.status).toBe(200)
    })
  })

  describe("custom paths", () => {
    it("should use custom basePath and filesBasePath", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        basePath: "/custom-api",
        filesBasePath: "/files"
      })

      // Health endpoint at custom path
      const healthRequest = new Request("http://localhost/custom-api/health", { method: "GET" })
      const healthResponse = await handler(healthRequest, env, {})
      expect(healthResponse!.status).toBe(200)

      // Sign endpoint at custom path
      const signRequest = new Request("http://localhost/custom-api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test.txt" })
      })
      const signResponse = await handler(signRequest, env, {})
      const data = await signResponse!.json()
      expect(data.url).toContain("/files/test.txt")
    })
  })

  describe("request body validation", () => {
    it("should return 400 for missing key in sign/upload", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(400)
    })

    it("should return 400 for invalid JSON body", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json"
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(400)
    })
  })

  describe("non-matching routes", () => {
    it("should return null for non-matching routes", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET
      })

      const request = new Request("http://localhost/other-path", { method: "GET" })
      const response = await handler(request, env, {})

      expect(response).toBeNull()
    })
  })

  describe("direct file access with auth headers (validateAuth fallback)", () => {
    it("should allow file download with valid auth headers when validateAuth allows", async () => {
      // Pre-populate the bucket
      const content = new TextEncoder().encode("File content")
      mockBucket.store.set("user123/file.txt", {
        data: content.buffer,
        contentType: "text/plain"
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async (request) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (token === "valid-token") return ["user123/"]
          return null
        }
      })

      // Access file directly with auth header (no signature)
      const request = new Request("http://localhost/livestore-filesync-files/user123/file.txt", {
        method: "GET",
        headers: { Authorization: "Bearer valid-token" }
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(200)
    })

    it("should reject file download with invalid auth headers", async () => {
      const content = new TextEncoder().encode("File content")
      mockBucket.store.set("user123/file.txt", {
        data: content.buffer,
        contentType: "text/plain"
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async (request) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (token === "valid-token") return ["user123/"]
          return null
        }
      })

      const request = new Request("http://localhost/livestore-filesync-files/user123/file.txt", {
        method: "GET",
        headers: { Authorization: "Bearer invalid-token" }
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(401)
    })

    it("should enforce key prefix restrictions for direct file access", async () => {
      const content = new TextEncoder().encode("File content")
      mockBucket.store.set("user456/file.txt", {
        data: content.buffer,
        contentType: "text/plain"
      })

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async (request) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (token === "valid-token") return ["user123/"] // Only allows user123/
          return null
        }
      })

      // Try to access user456's file with user123's token
      const request = new Request("http://localhost/livestore-filesync-files/user456/file.txt", {
        method: "GET",
        headers: { Authorization: "Bearer valid-token" }
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(401)
    })

    it("should allow file upload with valid auth headers when validateAuth allows", async () => {
      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: async (request) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (token === "valid-token") return ["user123/"]
          return null
        }
      })

      // Upload file directly with auth header (no signature)
      const request = new Request("http://localhost/livestore-filesync-files/user123/new-file.txt", {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid-token",
          "Content-Type": "text/plain"
        },
        body: "New file content"
      })

      const response = await handler(request, env, {})
      expect(response!.status).toBe(200)
      expect(mockBucket.store.has("user123/new-file.txt")).toBe(true)
    })

    it("should prefer signed URL over auth header when both are valid", async () => {
      const content = new TextEncoder().encode("File content")
      mockBucket.store.set("test.txt", {
        data: content.buffer,
        contentType: "text/plain"
      })

      const validateAuthMock = vi.fn(async () => [] as ReadonlyArray<string>)

      const handler = createR2Handler<Request, MockEnv, unknown>({
        bucket: (e) => e.FILE_BUCKET,
        getSigningSecret: (e) => e.FILE_SIGNING_SECRET,
        validateAuth: validateAuthMock
      })

      // Get a signed URL
      const signRequest = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-token"
        },
        body: JSON.stringify({ key: "test.txt" })
      })
      const signResponse = await handler(signRequest, env, {})
      const { url } = await signResponse!.json()

      // Reset mock after sign request
      validateAuthMock.mockClear()

      // Access with signed URL - validateAuth should NOT be called
      const downloadRequest = new Request(url, { method: "GET" })
      const downloadResponse = await handler(downloadRequest, env, {})

      expect(downloadResponse!.status).toBe(200)
      // validateAuth should not be called when signature is valid
      expect(validateAuthMock).not.toHaveBeenCalled()
    })
  })
})
