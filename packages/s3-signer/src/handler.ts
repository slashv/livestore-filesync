import { errorResponse, handleCorsPreflightRequest } from "./cors.js"
import {
  handleDelete,
  handleHealth,
  handleSignDownload,
  handleSignUpload,
  resolveAllowedPrefixes
} from "./routes.js"
import type { S3SignerEnv, S3SignerHandlerConfig } from "./types.js"

const getProvidedToken = (request: Request): string | null => {
  const authHeader = request.headers.get("Authorization")
  const workerAuthHeader = request.headers.get("X-Worker-Auth")
  return authHeader?.replace("Bearer ", "") || workerAuthHeader
}

export function createS3SignerHandler(config: S3SignerHandlerConfig = {}) {
  const {
    basePath = "/api",
    getAuthToken,
    getAllowedKeyPrefixes,
    maxExpirySeconds = 900
  } = config

  return async function handleS3SignerRequest(
    request: Request,
    env: S3SignerEnv
  ): Promise<Response | null> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    const normalizedBasePath = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath

    if (!pathname.startsWith(normalizedBasePath)) return null

    if (method === "OPTIONS") return handleCorsPreflightRequest()

    const relativePath = pathname.slice(normalizedBasePath.length) || "/"

    // Auth (optional)
    const expectedToken = getAuthToken ? getAuthToken(env) : env.WORKER_AUTH_TOKEN
    if (expectedToken) {
      const provided = getProvidedToken(request)
      if (provided !== expectedToken) return errorResponse("Unauthorized", 401)
    }

    const allowedPrefixes = resolveAllowedPrefixes(env, request, getAllowedKeyPrefixes)

    if (method === "GET" && relativePath === "/health") {
      return handleHealth(env)
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


