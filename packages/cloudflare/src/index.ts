/**
 * @livestore-filesync/cloudflare
 *
 * Cloudflare Workers helper for livestore-filesync file storage
 *
 * @example
 * ```typescript
 * import { createFileSyncHandler } from '@livestore-filesync/cloudflare'
 *
 * const fileSyncHandler = createFileSyncHandler()
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     // Handle file operations
 *     const fileResponse = await fileSyncHandler(request, env)
 *     if (fileResponse) return fileResponse
 *
 *     // Handle LiveStore sync or other routes...
 *     return new Response('Not Found', { status: 404 })
 *   }
 * }
 * ```
 *
 * @module
 */

// Main handler factory
export { createFileSyncHandler } from './handler.js'

// Types
export type {
  FileSyncEnv,
  FileSyncHandlerConfig,
  UploadResponse,
  HealthResponse,
} from './types.js'

// CORS utilities (for custom handlers)
export {
  handleCorsPreflightRequest,
  addCorsHeaders,
  jsonResponse,
  errorResponse,
} from './cors.js'
