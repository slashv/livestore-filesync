import { addCorsHeaders, errorResponse, jsonResponse } from "./cors.js"
import { makeAwsClient, makeBucketUrl, makeObjectUrl } from "./s3.js"
import type {
  S3SignerEnv,
  SignDownloadRequest,
  SignDownloadResponse,
  SignUploadRequest,
  SignUploadResponse
} from "./types.js"

const isKeySafe = (key: string): boolean => {
  if (key.length === 0) return false
  if (key.startsWith("/")) return false
  const parts = key.split("/").filter((s) => s.length > 0)
  if (parts.some((p) => p === "." || p === "..")) return false
  return true
}

const parseAllowedPrefixes = (env: S3SignerEnv): ReadonlyArray<string> => {
  const raw = env.ALLOWED_KEY_PREFIXES
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const isKeyAllowed = (key: string, prefixes: ReadonlyArray<string>): boolean => {
  if (prefixes.length === 0) return true
  for (const prefixRaw of prefixes) {
    const prefix = prefixRaw.replace(/^\/+/, "")
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`
    if (key === prefix || key.startsWith(normalizedPrefix)) return true
  }
  return false
}

const expirySecondsToIso = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString()

export async function handleHealth(env: S3SignerEnv): Promise<Response> {
  try {
    const aws = makeAwsClient(env)
    const signed = await aws.sign(makeBucketUrl(env), { method: "HEAD" })
    const response = await fetch(signed)
    if (!response.ok) {
      return jsonResponse({ status: "error" }, 500)
    }
    return jsonResponse({ status: "ok" })
  } catch {
    return jsonResponse({ status: "error" }, 500)
  }
}

export async function handleSignUpload(
  request: Request,
  env: S3SignerEnv,
  options: { maxExpirySeconds: number; allowedPrefixes: ReadonlyArray<string> }
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SignUploadRequest | null
  if (!body || typeof body.key !== "string") return errorResponse("Invalid request", 400)

  const key = body.key.replace(/^\/+/, "")
  if (!isKeySafe(key)) return errorResponse("Invalid key", 400)
  if (!isKeyAllowed(key, options.allowedPrefixes)) return errorResponse("Forbidden", 403)

  const expiresIn = Math.max(1, Math.min(options.maxExpirySeconds, 3600))

  const aws = makeAwsClient(env)
  const objectUrl = makeObjectUrl(env, key)
  const signed = await aws.sign(objectUrl, {
    method: "PUT",
    aws: {
      signQuery: true,
      expires: expiresIn
    }
  })

  const response: SignUploadResponse = {
    method: "PUT",
    url: signed.url,
    expiresAt: expirySecondsToIso(expiresIn)
  }

  return jsonResponse(response)
}

export async function handleSignDownload(
  request: Request,
  env: S3SignerEnv,
  options: { maxExpirySeconds: number; allowedPrefixes: ReadonlyArray<string> }
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SignDownloadRequest | null
  if (!body || typeof body.key !== "string") return errorResponse("Invalid request", 400)

  const key = body.key.replace(/^\/+/, "")
  if (!isKeySafe(key)) return errorResponse("Invalid key", 400)
  if (!isKeyAllowed(key, options.allowedPrefixes)) return errorResponse("Forbidden", 403)

  const expiresIn = Math.max(1, Math.min(options.maxExpirySeconds, 3600))

  const aws = makeAwsClient(env)
  const objectUrl = makeObjectUrl(env, key)
  const signed = await aws.sign(objectUrl, {
    method: "GET",
    aws: {
      signQuery: true,
      expires: expiresIn
    }
  })

  const response: SignDownloadResponse = {
    url: signed.url,
    expiresAt: expirySecondsToIso(expiresIn)
  }

  return jsonResponse(response)
}

export async function handleDelete(
  request: Request,
  env: S3SignerEnv,
  options: { allowedPrefixes: ReadonlyArray<string> }
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { key?: unknown } | null
  if (!body || typeof body.key !== "string") return errorResponse("Invalid request", 400)

  const key = body.key.replace(/^\/+/, "")
  if (!isKeySafe(key)) return errorResponse("Invalid key", 400)
  if (!isKeyAllowed(key, options.allowedPrefixes)) return errorResponse("Forbidden", 403)

  try {
    const aws = makeAwsClient(env)
    const signed = await aws.sign(makeObjectUrl(env, key), { method: "DELETE" })
    const response = await fetch(signed)
    if (!response.ok && response.status !== 404) {
      return errorResponse("Delete failed", 500)
    }
    return addCorsHeaders(new Response(null, { status: 204 }))
  } catch {
    return errorResponse("Delete failed", 500)
  }
}

export const resolveAllowedPrefixes = (
  env: S3SignerEnv,
  request: Request,
  getAllowedKeyPrefixes?: (env: S3SignerEnv, request: Request) => ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
  const custom = getAllowedKeyPrefixes?.(env, request)
  if (custom) return custom
  return parseAllowedPrefixes(env)
}
