/**
 * Cloudflare Worker entry point
 *
 * Handles both file storage operations and LiveStore sync
 */

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { SyncPayload } from '../livestore/schema.ts'

// Extend SyncBackend.Env with our additional bindings
interface Env extends SyncBackend.Env {
  WORKER_AUTH_TOKEN: string
  FILE_BUCKET: R2Bucket
}

// Create SyncBackendDO class
export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId, 'payload:', context.payload)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId, 'payload:', context.payload)
  },
}) { }

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

const isAuthorizedHeader = (request: Request, expectedToken: string): boolean => {
  const authHeader = request.headers.get('Authorization')
  const workerAuthHeader = request.headers.get('X-Worker-Auth')
  const providedToken = authHeader?.replace('Bearer ', '') || workerAuthHeader
  return providedToken === expectedToken
}

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

const getFileKeyFromPath = (pathname: string): string | null => {
  const prefix = '/livestore-filesync-files/'
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (!raw) return null
  return decodeURIComponent(raw)
}

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext) {
    const url = new URL(request.url)
    const pathname = url.pathname
    const method = request.method

    if (method === 'OPTIONS') {
      return addCors(new Response(null, { status: 204 }))
    }

    // Signer API used by @livestore-filesync/core (dev: backed by R2 binding)
    if (pathname === '/api/health' && method === 'GET') {
      try {
        await env.FILE_BUCKET.list({ limit: 1 })
        return json({ status: 'ok', bucket: true, timestamp: new Date().toISOString() })
      } catch {
        return json({ status: 'error', bucket: false, timestamp: new Date().toISOString() }, 500)
      }
    }

    if (pathname === '/api/v1/sign/upload' && method === 'POST') {
      const expectedToken = env.WORKER_AUTH_TOKEN
      if (expectedToken && !isAuthorizedHeader(request as unknown as Request, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await (request as unknown as Request).json().catch(() => null)) as
        | { key?: unknown }
        | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')
      const exp = Math.floor(Date.now() / 1000) + 900
      const sig = expectedToken
        ? await hmacSha256Base64Url(expectedToken, `PUT\n${key}\n${exp}`)
        : null
      const fileUrl = new URL(
        `/livestore-filesync-files/${encodeKeyPath(key)}`,
        url.origin,
      )
      fileUrl.searchParams.set('exp', String(exp))
      if (sig) fileUrl.searchParams.set('sig', sig)
      return json({
        method: 'PUT',
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString(),
      })
    }

    if (pathname === '/api/v1/sign/download' && method === 'POST') {
      const expectedToken = env.WORKER_AUTH_TOKEN
      if (expectedToken && !isAuthorizedHeader(request as unknown as Request, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await (request as unknown as Request).json().catch(() => null)) as
        | { key?: unknown }
        | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')
      const exp = Math.floor(Date.now() / 1000) + 900
      const sig = expectedToken
        ? await hmacSha256Base64Url(expectedToken, `GET\n${key}\n${exp}`)
        : null
      const fileUrl = new URL(
        `/livestore-filesync-files/${encodeKeyPath(key)}`,
        url.origin,
      )
      fileUrl.searchParams.set('exp', String(exp))
      if (sig) fileUrl.searchParams.set('sig', sig)
      return json({
        url: fileUrl.toString(),
        expiresAt: new Date(exp * 1000).toISOString(),
      })
    }

    if (pathname === '/api/v1/delete' && method === 'POST') {
      const expectedToken = env.WORKER_AUTH_TOKEN
      if (expectedToken && !isAuthorizedHeader(request as unknown as Request, expectedToken)) {
        return error('Unauthorized', 401)
      }

      const body = (await (request as unknown as Request).json().catch(() => null)) as
        | { key?: unknown }
        | null
      if (!body || typeof body.key !== 'string') return error('Invalid request', 400)
      const key = body.key.replace(/^\/+/, '')
      await env.FILE_BUCKET.delete(key)
      return addCors(new Response(null, { status: 204 }))
    }

    // Direct file data plane (PUT/GET) backed by R2 bucket binding
    const fileKey = getFileKeyFromPath(pathname)
    if (fileKey && method === 'PUT') {
      const expectedToken = env.WORKER_AUTH_TOKEN
      if (expectedToken) {
        const ok =
          isAuthorizedHeader(request as unknown as Request, expectedToken) ||
          (await verifySignedQuery(request as unknown as Request, expectedToken, 'PUT', fileKey))
        if (!ok) return error('Unauthorized', 401)
      }

      const contentType =
        (request as unknown as Request).headers.get('Content-Type') ?? 'application/octet-stream'
      const arrayBuffer = await (request as unknown as Request).arrayBuffer()
      await env.FILE_BUCKET.put(fileKey, arrayBuffer, {
        httpMetadata: { contentType },
      })
      return addCors(new Response(null, { status: 200 }))
    }

    if (fileKey && method === 'GET') {
      const expectedToken = env.WORKER_AUTH_TOKEN
      if (expectedToken) {
        const ok =
          isAuthorizedHeader(request as unknown as Request, expectedToken) ||
          (await verifySignedQuery(request as unknown as Request, expectedToken, 'GET', fileKey))
        if (!ok) return error('Unauthorized', 401)
      }

      const object = await env.FILE_BUCKET.get(fileKey)
      if (!object) return error('File not found', 404)
      const headers = new Headers()
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
      headers.set('Content-Length', object.size.toString())
      headers.set('ETag', object.etag)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return addCors(new Response(object.body, { headers }))
    }

    // Handle LiveStore sync
    const searchParams = SyncBackend.matchSyncRequest(request)
    if (searchParams !== undefined) {
      return SyncBackend.handleSyncRequest({
        request,
        searchParams,
        ctx,
        syncBackendBinding: 'SYNC_BACKEND_DO',
        syncPayloadSchema: SyncPayload,
        validatePayload: (payload, context) => {
          console.log(`Validating connection for store: ${context.storeId}`)
          if (payload?.authToken !== env.WORKER_AUTH_TOKEN) {
            throw new Error('Invalid auth token')
          }
        },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}
