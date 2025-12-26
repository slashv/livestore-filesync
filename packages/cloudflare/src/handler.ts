/**
 * Main handler factory for file sync routes
 */

import { handleCorsPreflightRequest, errorResponse } from './cors.js'
import { handleHealth, handleUpload, handleDownload, handleDelete } from './routes.js'
import type { FileSyncEnv, FileSyncHandlerConfig } from './types.js'

/**
 * Create a file sync handler for Cloudflare Workers
 *
 * @example
 * ```typescript
 * import { createFileSyncHandler } from '@livestore-filesync/cloudflare'
 *
 * const fileSyncHandler = createFileSyncHandler()
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const response = await fileSyncHandler(request, env)
 *     if (response) return response
 *
 *     // Handle other routes...
 *     return new Response('Not Found', { status: 404 })
 *   }
 * }
 * ```
 */
export function createFileSyncHandler(config: FileSyncHandlerConfig = {}) {
  const {
    bucketBinding = 'FILE_BUCKET',
    basePath = '/api',
    filesBasePath = '/livestore-filesync-files',
    getAuthToken,
  } = config

  /**
   * Handle file sync requests
   * Returns Response if route matches, null otherwise
   */
  return async function handleFileSyncRequest(
    request: Request,
    env: FileSyncEnv
  ): Promise<Response | null> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
    const normalizedFilesBasePath = filesBasePath.endsWith('/')
      ? filesBasePath.slice(0, -1)
      : filesBasePath
    const filesPrefix = `${normalizedFilesBasePath}/`

    // Handle CORS preflight for all control/data routes
    if (
      method === 'OPTIONS' &&
      (pathname.startsWith(normalizedBasePath) || pathname.startsWith(normalizedFilesBasePath))
    ) {
      return handleCorsPreflightRequest()
    }

    // Check if this is a file sync route
    if (
      !pathname.startsWith(normalizedBasePath) &&
      !pathname.startsWith(normalizedFilesBasePath)
    ) {
      return null
    }

    // Get bucket from env
    const bucket = (env as unknown as Record<string, unknown>)[bucketBinding] as R2Bucket | undefined
    if (!bucket) {
      console.error(`R2 bucket binding '${bucketBinding}' not found in env`)
      return errorResponse(`R2 bucket not configured`, 500)
    }

    // Check authentication if configured
    if (getAuthToken) {
      const expectedToken = getAuthToken(env)
      if (expectedToken) {
        const authHeader = request.headers.get('Authorization')
        const workerAuthHeader = request.headers.get('X-Worker-Auth')
        const providedToken = authHeader?.replace('Bearer ', '') || workerAuthHeader

        if (providedToken !== expectedToken) {
          return errorResponse('Unauthorized', 401)
        }
      }
    }

    // Route matching
    const relativePath = pathname.startsWith(normalizedBasePath)
      ? pathname.slice(normalizedBasePath.length)
      : ''

    // GET /api/health
    if (method === 'GET' && relativePath === '/health') {
      return handleHealth(bucket)
    }

    // POST /api/upload
    if (method === 'POST' && relativePath === '/upload') {
      return handleUpload(request, bucket, url.origin, normalizedFilesBasePath)
    }

    // GET /livestore-filesync-files/:key
    if (method === 'GET' && pathname.startsWith(filesPrefix)) {
      const key = decodeURIComponent(pathname.slice(filesPrefix.length))
      return handleDownload(bucket, key)
    }

    // DELETE /livestore-filesync-files/:key
    if (method === 'DELETE' && pathname.startsWith(filesPrefix)) {
      const key = decodeURIComponent(pathname.slice(filesPrefix.length))
      return handleDelete(bucket, key)
    }

    // No matching route under /api
    return null
  }
}
