import { errorResponse, handleCorsPreflightRequest } from "./cors.js"
import { handleDelete, handleHealth, handleSignDownload, handleSignUpload } from "./routes.js"
import type { S3SignerEnv, S3SignerHandlerConfig } from "./types.js"

/**
 * Creates a Cloudflare Worker handler that implements the filesync signer API
 * for S3-compatible storage backends.
 *
 * This handler:
 * - Exposes signer endpoints at `{basePath}/v1/sign/upload`, `{basePath}/v1/sign/download`, `{basePath}/v1/delete`
 * - Generates presigned URLs for direct-to-S3 uploads/downloads
 * - Uses async `validateAuth` callback for authentication and key prefix authorization
 *
 * @example
 * ```typescript
 * import { createS3SignerHandler } from '@livestore-filesync/s3-signer'
 *
 * export default {
 *   fetch: createS3SignerHandler({
 *     basePath: '/api',
 *     validateAuth: async (request, env) => {
 *       const token = request.headers.get("Authorization")?.replace("Bearer ", "")
 *       if (!token || token !== env.WORKER_AUTH_TOKEN) return null
 *       return [] // Allow all keys
 *     }
 *   })
 * }
 * ```
 */
export function createS3SignerHandler<Env extends S3SignerEnv = S3SignerEnv>(
  config: S3SignerHandlerConfig<Env> = {}
) {
  const { basePath = "/api", maxExpirySeconds = 900, validateAuth } = config

  return async function handleS3SignerRequest(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    const normalizedBasePath = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath

    if (!pathname.startsWith(normalizedBasePath)) return null

    if (method === "OPTIONS") return handleCorsPreflightRequest()

    const relativePath = pathname.slice(normalizedBasePath.length) || "/"

    // Health check - no auth required
    if (method === "GET" && relativePath === "/health") {
      return handleHealth(env)
    }

    // All other endpoints require auth validation
    let allowedPrefixes: ReadonlyArray<string> = []

    if (validateAuth) {
      const authResult = await validateAuth(request, env)
      if (authResult === null) {
        return errorResponse("Unauthorized", 401)
      }
      allowedPrefixes = authResult
    }

    if (method === "POST" && relativePath === "/v1/sign/upload") {
      return handleSignUpload(request, env, { maxExpirySeconds, allowedPrefixes })
    }

    if (method === "POST" && relativePath === "/v1/sign/download") {
      return handleSignDownload(request, env, { maxExpirySeconds, allowedPrefixes })
    }

    if (method === "POST" && relativePath === "/v1/delete") {
      return handleDelete(request, env, { allowedPrefixes })
    }

    return null
  }
}
