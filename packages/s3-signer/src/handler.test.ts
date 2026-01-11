import { beforeEach, describe, expect, it, vi } from "vitest"
import { createS3SignerHandler } from "./handler.js"
import type { S3SignerEnv } from "./types.js"

// Mock fetch globally for S3 operations
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock AWS client signing
vi.mock("aws4fetch", () => ({
  AwsClient: vi.fn().mockImplementation(() => ({
    sign: vi.fn().mockImplementation(async (url: string, options?: { method?: string }) => ({
      url: `${url}?X-Amz-Signature=mock-signature`,
      method: options?.method ?? "GET"
    }))
  }))
}))

type MockEnv = S3SignerEnv & {
  WORKER_AUTH_TOKEN: string
}

describe("createS3SignerHandler", () => {
  let env: MockEnv

  beforeEach(() => {
    vi.clearAllMocks()
    env = {
      S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
      S3_REGION: "us-east-1",
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      WORKER_AUTH_TOKEN: "test-token"
    }

    // Default mock for health check
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  describe("health endpoint", () => {
    it("should return health status without auth", async () => {
      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/api/health", { method: "GET" })
      const response = await handler(request, env)

      expect(response).not.toBeNull()
      const data = (await response!.json()) as { status: string }
      expect(data.status).toBe("ok")
    })

    it("should return error status when S3 check fails", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }))

      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/api/health", { method: "GET" })
      const response = await handler(request, env)

      expect(response).not.toBeNull()
      expect(response!.status).toBe(500)
      const data = (await response!.json()) as { status: string }
      expect(data.status).toBe("error")
    })
  })

  describe("OPTIONS requests", () => {
    it("should handle CORS preflight", async () => {
      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/api/v1/sign/upload", { method: "OPTIONS" })
      const response = await handler(request, env)

      expect(response).not.toBeNull()
      expect(response!.status).toBe(204)
      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("*")
    })
  })

  describe("sign/upload endpoint", () => {
    it("should return signed URL without auth when validateAuth is not configured", async () => {
      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const data = (await response!.json()) as { method: string; url: string; expiresAt: string }
      expect(data.method).toBe("PUT")
      expect(data.url).toContain("X-Amz-Signature")
      expect(data.expiresAt).toBeDefined()
    })

    it("should reject unauthorized requests when validateAuth returns null", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => null
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(401)
    })

    it("should allow access when validateAuth returns empty array (no restrictions)", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "any-file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
    })

    it("should allow access when key matches allowed prefix", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user123/file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)
    })

    it("should return 403 when key does not match allowed prefix", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
    })

    it("should support multiple allowed prefixes", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => ["user123/", "shared/"]
      })

      // First prefix should work
      const request1 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user123/file.txt" })
      })
      const response1 = await handler(request1, env)
      expect(response1!.status).toBe(200)

      // Second prefix should work
      const request2 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "shared/document.pdf" })
      })
      const response2 = await handler(request2, env)
      expect(response2!.status).toBe(200)

      // Other prefix should fail
      const request3 = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "other/file.txt" })
      })
      const response3 = await handler(request3, env)
      expect(response3!.status).toBe(403)
    })

    it("should return 400 for invalid key", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "../etc/passwd" })
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(400)
    })
  })

  describe("sign/download endpoint", () => {
    it("should return signed download URL", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const data = (await response!.json()) as { url: string; expiresAt: string }
      expect(data.url).toContain("X-Amz-Signature")
      expect(data.expiresAt).toBeDefined()
    })

    it("should enforce key prefix restrictions for downloads", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/sign/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(403)
    })
  })

  describe("delete endpoint", () => {
    it("should delete file when authorized", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(204)
    })

    it("should return 401 when validateAuth returns null", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => null
      })

      const request = new Request("http://localhost/api/v1/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test-file.txt" })
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(401)
    })

    it("should enforce key prefix restrictions for deletes", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => ["user123/"]
      })

      const request = new Request("http://localhost/api/v1/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "user456/file.txt" })
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(403)
    })
  })

  describe("async validateAuth callback", () => {
    it("should receive request and env in validateAuth", async () => {
      const validateAuth = vi.fn(async (request: Request, e: MockEnv) => {
        expect(request.headers.get("Authorization")).toBe("Bearer user-token")
        expect(e.S3_BUCKET).toBe("test-bucket")
        return [] as ReadonlyArray<string>
      })

      const handler = createS3SignerHandler<MockEnv>({
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

      await handler(request, env)
      expect(validateAuth).toHaveBeenCalled()
    })

    it("should support async validation against external services", async () => {
      // Simulate async auth validation
      const handler = createS3SignerHandler<MockEnv>({
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
      const validResponse = await handler(validRequest, env)
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
      const invalidResponse = await handler(invalidRequest, env)
      expect(invalidResponse!.status).toBe(401)
    })

    it("should validate auth based on token matching env secret", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async (request, e) => {
          const token = request.headers.get("Authorization")?.replace("Bearer ", "")
          if (!token || token !== e.WORKER_AUTH_TOKEN) return null
          return []
        }
      })

      // Valid token
      const validRequest = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token"
        },
        body: JSON.stringify({ key: "file.txt" })
      })
      const validResponse = await handler(validRequest, env)
      expect(validResponse!.status).toBe(200)

      // Invalid token
      const invalidRequest = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token"
        },
        body: JSON.stringify({ key: "file.txt" })
      })
      const invalidResponse = await handler(invalidRequest, env)
      expect(invalidResponse!.status).toBe(401)
    })
  })

  describe("custom paths", () => {
    it("should use custom basePath", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        basePath: "/custom-api"
      })

      // Health endpoint at custom path
      const healthRequest = new Request("http://localhost/custom-api/health", { method: "GET" })
      const healthResponse = await handler(healthRequest, env)
      expect(healthResponse!.status).toBe(200)

      // Sign endpoint at custom path
      const signRequest = new Request("http://localhost/custom-api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test.txt" })
      })
      const signResponse = await handler(signRequest, env)
      expect(signResponse!.status).toBe(200)
    })

    it("should return null for non-matching paths", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        basePath: "/api"
      })

      const request = new Request("http://localhost/other-path", { method: "GET" })
      const response = await handler(request, env)

      expect(response).toBeNull()
    })
  })

  describe("request body validation", () => {
    it("should return 400 for missing key in sign/upload", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(400)
    })

    it("should return 400 for invalid JSON body", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        validateAuth: async () => []
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json"
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(400)
    })
  })

  describe("non-matching routes", () => {
    it("should return null for non-matching routes", async () => {
      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/other-path", { method: "GET" })
      const response = await handler(request, env)

      expect(response).toBeNull()
    })

    it("should return null for unknown endpoints under basePath", async () => {
      const handler = createS3SignerHandler<MockEnv>({})

      const request = new Request("http://localhost/api/v1/unknown", { method: "POST" })
      const response = await handler(request, env)

      expect(response).toBeNull()
    })
  })

  describe("maxExpirySeconds configuration", () => {
    it("should respect maxExpirySeconds setting", async () => {
      const handler = createS3SignerHandler<MockEnv>({
        maxExpirySeconds: 300
      })

      const request = new Request("http://localhost/api/v1/sign/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "test.txt" })
      })

      const response = await handler(request, env)
      expect(response!.status).toBe(200)

      const data = (await response!.json()) as { expiresAt: string }
      const expiresAt = new Date(data.expiresAt).getTime()
      const now = Date.now()
      // Should expire within 5 minutes (300 seconds) + some tolerance
      expect(expiresAt - now).toBeLessThanOrEqual(300 * 1000 + 1000)
      expect(expiresAt - now).toBeGreaterThan(0)
    })
  })
})
