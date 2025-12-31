import type { FetchHandler } from './types.js'

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
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>
  readonly get: (key: string) => Promise<R2ObjectLike | null>
  readonly delete: (key: string) => Promise<unknown>
}

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
 */
export type R2HandlerConfig<Env> = {
  /** Function to get the R2 bucket binding from the Worker environment */
  readonly bucket: (env: Env) => R2BucketLike
  /** Function to get the auth token from the Worker environment */
  readonly getAuthToken: (env: Env) => string | undefined
  /** Base path for the signer API (default: '/api') */
  readonly basePath?: string
  /** Base path for serving files (default: '/livestore-filesync-files') */
  readonly filesBasePath?: string
  /** URL expiry time in seconds (default: 900 = 15 minutes) */
  readonly ttlSeconds?: number
}

const normalizeBasePath = (path: string): string => (path.endsWith('/') ? path.slice(0, -1) : path)

const addCors = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Worker-Auth')
  headers.set('Access-Control-Max-Age', '86400')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const json = (data: unknown, status = 200): Response =>
  addCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

const error = (message: string, status = 500): Response => json({ error: message }, status)

const base64UrlEncode = (bytes: ArrayBuffer): string => {
  const u8 = new Uint8Array(bytes)
  let binary = ''
  for (const b of u8) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const hmacSha256Base64Url = async (secret: string, message: string): Promise<string> => {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return base64UrlEncode(sig)
}

const getAuthTokenFromRequest = (request: Request): string | null => {
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    const trimmed = authHeader.trim()
    const prefix = 'Bearer '
    if (trimmed.startsWith(prefix)) {
      const token = trimmed.slice(prefix.length).trim()
      return token.length > 0 ? token : null
    }
  }
  const workerAuthHeader = request.headers.get('X-Worker-Auth')
  return workerAuthHeader && workerAuthHeader.trim().length > 0 ? workerAuthHeader.trim() : null
}

const isAuthorizedHeader = (request: Request, expectedToken: string): boolean =>
  getAuthTokenFromRequest(request) === expectedToken

const verifySignedQuery = async (
  request: Request,
  expectedToken: string,
  method: string,
  key: string,
): Promise<boolean> => {
  const url = new URL(request.url)
  const exp = url.searchParams.get('exp')
  const sig = url.searchParams.get('sig')
  if (!exp || !sig) return false

  const expNum = Number(exp)
  if (!Number.isFinite(expNum)) return false

  const now = Math.floor(Date.now() / 1000)
  if (expNum < now) return false

  const expectedSig = await hmacSha256Base64Url(expectedToken, `${method}\n${key}\n${expNum}`)
  return sig === expectedSig
}

const encodeKeyPath = (key: string): string =>
  key
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')

const decodeKeyPath = (encodedPath: string): string =>
  encodedPath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .join('/')

const getFileKeyFromPath = (pathname: string, filesBasePath: string): string | null => {
  const prefix = `${normalizeBasePath(filesBasePath)}/`
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (!raw) return null
  return decodeKeyPath(raw)
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
 *   WORKER_AUTH_TOKEN: string
 * }
 *
 * const fileRoutes = createR2Handler<Request, Env, ExecutionContext>({
 *   bucket: (env) => env.FILE_BUCKET,
 *   getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
 * })
 *
 * export default {
 *   fetch: composeFetchHandlers(fileRoutes, otherRoutes),
 * }
 * ```
 */
export function createR2Handler<RequestType = Request, Env = unknown, Ctx = unknown>(
  config: R2HandlerConfig<Env>,
): FetchHandler<RequestType, Env, Ctx, Response> {
  const basePath = normalizeBasePath(config.basePath ?? '/api')
  const filesBasePath = normalizeBasePath(config.filesBasePath ?? '/livestore-filesync-files')
  const ttlSeconds = config.ttlSeconds ?? 900

  return async (request: RequestType, env: Env, _ctx: Ctx) => {
    const req = request as unknown as Request
    const url = new URL(req.url)
    const pathname = url.pathname
    const method = req.method

    const isUnderControl = pathname.startsWith(basePath)
    const isUnderFiles = pathname.startsWith(filesBasePath)
    if (!isUnderControl && !isUnderFiles) return null

    if (method === 'OPTIONS') {
      return addCors(new Response(null, { status: 204 }))
    }

    const bucket = config.bucket(env)

    if (pathname === `${basePath}/health` && method === 'GET') {
      try {
        await bucket.list({ limit: 1 })
        return json({ status: 'ok', bucket: true, timestamp: new Date().toISOString() })
      } catch {
        return json({ status: 'error', bucket: false, timestamp: new Date().toISOString() }, 500)
      }
    }

    if (pathname === `${basePath}/v1/sign/upload` && method === 'POST') {
      const expectedToken = config.getAuthToken(env)
      if (expectedToken && !isAuthorizedHeader(req, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')

      const exp = Math.floor(Date.now() / 1000) + ttlSeconds
      const sig = expectedToken ? await hmacSha256Base64Url(expectedToken, `PUT\n${key}\n${exp}`) : null
      const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
      fileUrl.searchParams.set('exp', String(exp))
      if (sig) fileUrl.searchParams.set('sig', sig)

      return json({
        method: 'PUT',
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString(),
      })
    }

    if (pathname === `${basePath}/v1/sign/download` && method === 'POST') {
      const expectedToken = config.getAuthToken(env)
      if (expectedToken && !isAuthorizedHeader(req, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')

      const exp = Math.floor(Date.now() / 1000) + ttlSeconds
      const sig = expectedToken ? await hmacSha256Base64Url(expectedToken, `GET\n${key}\n${exp}`) : null
      const fileUrl = new URL(`${filesBasePath}/${encodeKeyPath(key)}`, url.origin)
      fileUrl.searchParams.set('exp', String(exp))
      if (sig) fileUrl.searchParams.set('sig', sig)

      return json({
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString(),
      })
    }

    if (pathname === `${basePath}/v1/delete` && method === 'POST') {
      const expectedToken = config.getAuthToken(env)
      if (expectedToken && !isAuthorizedHeader(req, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await req.json().catch(() => null)) as { key?: unknown } | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')

      await bucket.delete(key)
      return addCors(new Response(null, { status: 204 }))
    }

    const fileKey = getFileKeyFromPath(pathname, filesBasePath)
    if (!fileKey) return null

    if (method === 'PUT') {
      const expectedToken = config.getAuthToken(env)
      if (expectedToken) {
        const ok =
          isAuthorizedHeader(req, expectedToken) ||
          (await verifySignedQuery(req, expectedToken, 'PUT', fileKey))
        if (!ok) return error('Unauthorized', 401)
      }

      const contentType = req.headers.get('Content-Type') ?? 'application/octet-stream'
      const arrayBuffer = await req.arrayBuffer()
      await bucket.put(fileKey, arrayBuffer, { httpMetadata: { contentType } })
      return addCors(new Response(null, { status: 200 }))
    }

    if (method === 'GET') {
      const expectedToken = config.getAuthToken(env)
      if (expectedToken) {
        const ok =
          isAuthorizedHeader(req, expectedToken) ||
          (await verifySignedQuery(req, expectedToken, 'GET', fileKey))
        if (!ok) return error('Unauthorized', 401)
      }

      const object = await bucket.get(fileKey)
      if (!object) return error('File not found', 404)
      const headers = new Headers()
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
      headers.set('Content-Length', object.size.toString())
      headers.set('ETag', object.etag)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return addCors(new Response(object.body, { headers }))
    }

    return null
  }
}


