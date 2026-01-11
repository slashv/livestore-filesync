import type { FetchHandler } from "./types.js"

type R2ObjectLike = {
  readonly size: number
  readonly etag: string
  readonly httpMetadata?: { readonly contentType?: string | undefined } | undefined
  readonly body: BodyInit | ReadableStream<Uint8Array> | null
}

type R2BucketLike = {
  readonly list: (options?: { limit?: number }) => Promise<unknown>
  readonly put: (
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } }
  ) => Promise<unknown>
  readonly get: (key: string) => Promise<R2ObjectLike | null>
  readonly delete: (key: string) => Promise<unknown>
}

/**
 * Result of async auth validation.
 *
 * - `null`: Access denied (returns 401 Unauthorized)
 * - `[]` (empty array): No restrictions, allow access to all keys
 * - `["prefix/"]`: Only allow access to keys starting with any of the specified prefixes
 */
export type ValidateAuthResult = ReadonlyArray<string> | null

/**
 * Configuration for the R2 storage handler.
 *
 * This handler implements the filesync signer API contract and serves files directly
 * from Cloudflare R2 via the Workers API. It uses HMAC-SHA256 signed URLs for authentication.
 *
 * Suitable for:
 * - Local development with Wrangler (uses R2 emulation)
 * - Small to medium production deployments
 * - Apps where Worker-proxied file access is acceptable
 *
 * For high-traffic production deployments, consider using `@livestore-filesync/s3-signer`
 * which generates AWS S3-compatible presigned URLs for direct-to-storage access.
 *
 * ## Authentication
 *
 * Use `validateAuth` + `getSigningSecret` for per-user authentication with key prefix restrictions:
 * - `validateAuth`: Async callback to authenticate requests and return allowed key prefixes
 * - `getSigningSecret`: Static secret for HMAC-signing presigned URLs
 *
 * @example
 * ```typescript
 * createR2Handler({
 *   bucket: (env) => env.FILE_BUCKET,
 *   getSigningSecret: (env) => env.FILE_SIGNING_SECRET,
 *   validateAuth: async (request, env) => {
 *     const token = request.headers.get("Authorization")?.replace("Bearer ", "")
 *     if (!token) return null // Deny
 *
 *     const user = await validateSessionToken(token, env)
 *     if (!user) return null // Deny
 *
 *     return [`${user.id}/`] // Allow only this user's files
 *   }
 * })
 * ```
 */
export type R2HandlerConfig<Env> = {
  /** Function to get the R2 bucket binding from the Worker environment */
  readonly bucket: (env: Env) => R2BucketLike

  /**
   * Secret used to HMAC-sign presigned URLs.
   *
   * Should be a stable secret known only to the server.
   * If not provided, URLs are not signed (not recommended for production).
   */
  readonly getSigningSecret?: (env: Env) => string | undefined

  /**
   * Async auth validation callback.
   *
   * Called for every request that requires authentication (sign endpoints and direct file access).
   * Return allowed key prefixes or null to deny access.
   *
   * @param request - The incoming request (check Authorization header, cookies, etc.)
   * @param env - Worker environment
   * @returns Allowed key prefixes, or null to deny access
   *   - `null`: Access denied (401 Unauthorized)
   *   - `[]` (empty array): No key restrictions (allow all keys)
   *   - `["user123/"]`: Only allow keys starting with "user123/"
   *
   * @example
   * ```typescript
   * validateAuth: async (request, env) => {
   *   const token = request.headers.get("Authorization")?.replace("Bearer ", "")
   *   if (!token) return null
   *
   *   const response = await fetch(env.AUTH_VALIDATE_URL, {
   *     method: "POST",
   *     headers: { "Content-Type": "application/json" },
   *     body: JSON.stringify({ sessionToken: token })
   *   })
   *
   *   if (!response.ok) return null
   *   const { userId } = await response.json()
   *   return userId ? [`${userId}/`] : null
   * }
   * ```
   */
  readonly validateAuth?: (request: Request, env: Env) => Promise<ValidateAuthResult>

  /** Base path for the signer API (default: '/api') */
  readonly basePath?: string
  /** Base path for serving files (default: '/livestore-filesync-files') */
  readonly filesBasePath?: string
  /** URL expiry time in seconds (default: 900 = 15 minutes) */
  readonly ttlSeconds?: number
}

const normalizeBasePath = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path)

const addCors = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", "*")
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Worker-Auth")
  headers.set("Access-Control-Max-Age", "86400")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

const json = (data: unknown, status = 200): Response =>
  addCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" }
    })
  )

const error = (message: string, status = 500): Response => json({ error: message }, status)

const base64UrlEncode = (bytes: ArrayBuffer): string => {
  const u8 = new Uint8Array(bytes)
  let binary = ""
  for (const b of u8) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

const hmacSha256Base64Url = async (secret: string, message: string): Promise<string> => {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return base64UrlEncode(sig)
}

const verifySignedQuery = async (
  request: Request,
  signingSecret: string,
  method: string,
  key: string
): Promise<boolean> => {
  const url = new URL(request.url)
  const exp = url.searchParams.get("exp")
  const sig = url.searchParams.get("sig")
  if (!exp || !sig) return false

  const expNum = Number(exp)
  if (!Number.isFinite(expNum)) return false

  const now = Math.floor(Date.now() / 1000)
  if (expNum < now) return false

  const expectedSig = await hmacSha256Base64Url(signingSecret, `${method}\n${key}\n${expNum}`)
  return sig === expectedSig
}

const encodeKeyPath = (key: string): string =>
  key
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/")

const decodeKeyPath = (encodedPath: string): string =>
  encodedPath
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .join("/")

const getFileKeyFromPath = (pathname: string, filesBasePath: string): string | null => {
  const prefix = `${normalizeBasePath(filesBasePath)}/`
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (!raw) return null
  return decodeKeyPath(raw)
}

/**
 * Check if a key is allowed by the given prefixes.
 *
 * @param key - The key to check
 * @param allowedPrefixes - Array of allowed prefixes. Empty array means all keys are allowed.
 * @returns true if the key is allowed
 */
const isKeyAllowed = (key: string, allowedPrefixes: ReadonlyArray<string>): boolean => {
  // Empty array means no restrictions
  if (allowedPrefixes.length === 0) return true
  // Check if key starts with any allowed prefix
  return allowedPrefixes.some((prefix) => key.startsWith(prefix))
}

/**
 * Creates a Cloudflare Worker handler that implements the filesync signer API
 * and serves files directly from R2.
 *
 * This handler:
 * - Exposes signer endpoints at `{basePath}/v1/sign/upload`, `{basePath}/v1/sign/download`, `{basePath}/v1/delete`
 * - Serves files at `{filesBasePath}/{key}` with HMAC-SHA256 signed URLs
 * - Proxies all file data through the Worker (unlike s3-signer which does direct-to-S3)
 *
 * @example
 * ```typescript
 * import { createR2Handler, composeFetchHandlers } from '@livestore-filesync/r2'
 *
 * interface Env {
 *   FILE_BUCKET: R2Bucket
 *   FILE_SIGNING_SECRET: string
 * }
 *
 * const fileRoutes = createR2Handler<Request, Env, ExecutionContext>({
 *   bucket: (env) => env.FILE_BUCKET,
 *   getSigningSecret: (env) => env.FILE_SIGNING_SECRET,
 *   validateAuth: async (request, env) => {
 *     // Validate session and return allowed key prefixes
 *     const userId = await validateSession(request)
 *     return userId ? [`${userId}/`] : null
 *   }
 * })
 *
 * export default {
 *   fetch: composeFetchHandlers(fileRoutes, otherRoutes),
 * }
 * ```
 */
export function createR2Handler<RequestType = Request, Env = unknown, Ctx = unknown>(
  config: R2HandlerConfig<Env>
): FetchHandler<RequestType, Env, Ctx, Response> {
  const basePath = normalizeBasePath(config.basePath ?? "/api")
  const filesBasePath = normalizeBasePath(config.filesBasePath ?? "/livestore-filesync-files")
  const ttlSeconds = config.ttlSeconds ?? 900

  return async (request: RequestType, env: Env, _ctx: Ctx) => {
    const req = request as unknown as Request
    const url = new URL(req.url)
    const pathname = url.pathname
    const method = req.method

    const isUnderControl = pathname.startsWith(basePath)
    const isUnderFiles = pathname.startsWith(filesBasePath)
    if (!isUnderControl && !isUnderFiles) return null

    if (method === "OPTIONS") {
      return addCors(new Response(null, { status: 204 }))
    }

    const bucket = config.bucket(env)
    const signingSecret = config.getSigningSecret?.(env)

    // Health check - no auth required
    if (pathname === `${basePath}/health` && method === "GET") {
      try {
        await bucket.list({ limit: 1 })
        return json({ status: "ok", bucket: true, timestamp: new Date().toISOString() })
      } catch {
        return json({ status: "error", bucket: false, timestamp: new Date().toISOString() }, 500)
      }
    }

    // Sign upload endpoint
    if (pathname === `${basePath}/v1/sign/upload` && method === "POST") {
      // Validate auth if configured
      if (config.validateAuth) {
        const allowedPrefixes = await config.validateAuth(req, env)
        if (allowedPrefixes === null) {
          return error("Unauthorized", 401)
        }

        const body = (await req.json().catch(() => null)) as { key?: unknown } | null
        if (!body || typeof body.key !== "string") return error("Invalid request", 400)
        const key = body.key.replace(/^\/+/, "")

        // Check key prefix restriction
        if (!isKeyAllowed(key, allowedPrefixes)) {
          return error("Forbidden", 403)
        }

        const exp = Math.floor(Date.now() / 1000) + ttlSeconds
        const sig = signingSecret ? await hmacSha256Base64Url(signingSecret, `PUT\n${key}\n${exp}`) : null
        const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
        fileUrl.searchParams.set("exp", String(exp))
        if (sig) fileUrl.searchParams.set("sig", sig)

        return json({
          method: "PUT",
          url: fileUrl.toString(),
          expiresAt: new Date(exp * 1000).toISOString()
        })
      }

      // No auth configured - allow all
      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== "string") return error("Invalid request", 400)
      const key = body.key.replace(/^\/+/, "")

      const exp = Math.floor(Date.now() / 1000) + ttlSeconds
      const sig = signingSecret ? await hmacSha256Base64Url(signingSecret, `PUT\n${key}\n${exp}`) : null
      const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
      fileUrl.searchParams.set("exp", String(exp))
      if (sig) fileUrl.searchParams.set("sig", sig)

      return json({
        method: "PUT",
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString()
      })
    }

    // Sign download endpoint
    if (pathname === `${basePath}/v1/sign/download` && method === "POST") {
      // Validate auth if configured
      if (config.validateAuth) {
        const allowedPrefixes = await config.validateAuth(req, env)
        if (allowedPrefixes === null) {
          return error("Unauthorized", 401)
        }

        const body = (await req.json().catch(() => null)) as { key?: unknown } | null
        if (!body || typeof body.key !== "string") return error("Invalid request", 400)
        const key = body.key.replace(/^\/+/, "")

        // Check key prefix restriction
        if (!isKeyAllowed(key, allowedPrefixes)) {
          return error("Forbidden", 403)
        }

        const exp = Math.floor(Date.now() / 1000) + ttlSeconds
        const sig = signingSecret ? await hmacSha256Base64Url(signingSecret, `GET\n${key}\n${exp}`) : null
        const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
        fileUrl.searchParams.set("exp", String(exp))
        if (sig) fileUrl.searchParams.set("sig", sig)

        return json({
          url: fileUrl.toString(),
          expiresAt: new Date(exp * 1000).toISOString()
        })
      }

      // No auth configured - allow all
      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== "string") return error("Invalid request", 400)
      const key = body.key.replace(/^\/+/, "")

      const exp = Math.floor(Date.now() / 1000) + ttlSeconds
      const sig = signingSecret ? await hmacSha256Base64Url(signingSecret, `GET\n${key}\n${exp}`) : null
      const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
      fileUrl.searchParams.set("exp", String(exp))
      if (sig) fileUrl.searchParams.set("sig", sig)

      return json({
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString()
      })
    }

    // Delete endpoint
    if (pathname === `${basePath}/v1/delete` && method === "POST") {
      // Validate auth if configured
      if (config.validateAuth) {
        const allowedPrefixes = await config.validateAuth(req, env)
        if (allowedPrefixes === null) {
          return error("Unauthorized", 401)
        }

        const body = (await req.json().catch(() => null)) as { key?: unknown } | null
        if (!body || typeof body.key !== "string") return error("Invalid request", 400)
        const key = body.key.replace(/^\/+/, "")

        // Check key prefix restriction
        if (!isKeyAllowed(key, allowedPrefixes)) {
          return error("Forbidden", 403)
        }

        await bucket.delete(key)
        return addCors(new Response(null, { status: 204 }))
      }

      // No auth configured - allow all
      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== "string") return error("Invalid request", 400)
      const key = body.key.replace(/^\/+/, "")

      await bucket.delete(key)
      return addCors(new Response(null, { status: 204 }))
    }

    // File access (PUT/GET)
    const fileKey = getFileKeyFromPath(pathname, filesBasePath)
    if (!fileKey) return null

    if (method === "PUT") {
      // For file uploads, first try signed URL verification
      if (signingSecret) {
        const sigOk = await verifySignedQuery(req, signingSecret, "PUT", fileKey)
        if (sigOk) {
          // Valid signature - allow upload
          const contentType = req.headers.get("Content-Type") ?? "application/octet-stream"
          const arrayBuffer = await req.arrayBuffer()
          await bucket.put(fileKey, arrayBuffer, { httpMetadata: { contentType } })
          return addCors(new Response(null, { status: 200 }))
        }
      }

      // Fall back to validateAuth for direct auth header access
      if (config.validateAuth) {
        const allowedPrefixes = await config.validateAuth(req, env)
        if (allowedPrefixes !== null && isKeyAllowed(fileKey, allowedPrefixes)) {
          const contentType = req.headers.get("Content-Type") ?? "application/octet-stream"
          const arrayBuffer = await req.arrayBuffer()
          await bucket.put(fileKey, arrayBuffer, { httpMetadata: { contentType } })
          return addCors(new Response(null, { status: 200 }))
        }
      }

      // No signing secret and no validateAuth - allow all (not recommended)
      if (!signingSecret && !config.validateAuth) {
        const contentType = req.headers.get("Content-Type") ?? "application/octet-stream"
        const arrayBuffer = await req.arrayBuffer()
        await bucket.put(fileKey, arrayBuffer, { httpMetadata: { contentType } })
        return addCors(new Response(null, { status: 200 }))
      }

      return error("Unauthorized", 401)
    }

    if (method === "GET") {
      // For file downloads, first try signed URL verification
      if (signingSecret) {
        const sigOk = await verifySignedQuery(req, signingSecret, "GET", fileKey)
        if (sigOk) {
          // Valid signature - allow download
          const object = await bucket.get(fileKey)
          if (!object) return error("File not found", 404)
          const headers = new Headers()
          headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream")
          headers.set("Content-Length", object.size.toString())
          headers.set("ETag", object.etag)
          headers.set("Cache-Control", "public, max-age=31536000, immutable")
          return addCors(new Response(object.body, { headers }))
        }
      }

      // Fall back to validateAuth for direct auth header access
      if (config.validateAuth) {
        const allowedPrefixes = await config.validateAuth(req, env)
        if (allowedPrefixes !== null && isKeyAllowed(fileKey, allowedPrefixes)) {
          const object = await bucket.get(fileKey)
          if (!object) return error("File not found", 404)
          const headers = new Headers()
          headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream")
          headers.set("Content-Length", object.size.toString())
          headers.set("ETag", object.etag)
          headers.set("Cache-Control", "public, max-age=31536000, immutable")
          return addCors(new Response(object.body, { headers }))
        }
      }

      // No signing secret and no validateAuth - allow all (not recommended)
      if (!signingSecret && !config.validateAuth) {
        const object = await bucket.get(fileKey)
        if (!object) return error("File not found", 404)
        const headers = new Headers()
        headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream")
        headers.set("Content-Length", object.size.toString())
        headers.set("ETag", object.etag)
        headers.set("Cache-Control", "public, max-age=31536000, immutable")
        return addCors(new Response(object.body, { headers }))
      }

      return error("Unauthorized", 401)
    }

    return null
  }
}
