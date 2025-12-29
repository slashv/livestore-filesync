/**
 * Type definitions for @livestore-filesync/s3-signer
 */

export interface S3SignerEnv {
  S3_ENDPOINT: string
  S3_REGION: string
  S3_BUCKET: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  S3_SESSION_TOKEN?: string

  /**
   * "true" to force path-style S3 URLs:
   *   {endpoint}/{bucket}/{key}
   *
   * Otherwise virtual host style is used:
   *   {protocol}//{bucket}.{host}/{key}
   */
  S3_FORCE_PATH_STYLE?: string

  /**
   * Optional auth token used to protect signer endpoints.
   */
  WORKER_AUTH_TOKEN?: string

  /**
   * Optional comma-separated list of key prefixes allowed for this deployment.
   * Example: "store-1/,store-2/"
   */
  ALLOWED_KEY_PREFIXES?: string
}

export interface S3SignerHandlerConfig {
  /**
   * Base path for signer routes (default: '/api')
   *
   * Example:
   * - basePath '/api' => routes at '/api/health', '/api/v1/sign/upload', ...
   */
  basePath?: string

  /**
   * Custom token lookup.
   * If not provided, defaults to env.WORKER_AUTH_TOKEN.
   */
  getAuthToken?: (env: S3SignerEnv) => string | undefined

  /**
   * Allowed key prefixes for authorization.
   * If not provided, defaults to parsing env.ALLOWED_KEY_PREFIXES.
   * Return empty/undefined to allow all keys.
   */
  getAllowedKeyPrefixes?: (env: S3SignerEnv, request: Request) => readonly string[] | undefined

  /**
   * Maximum expiry in seconds for presigned URLs (default: 900).
   */
  maxExpirySeconds?: number
}

export type SignUploadRequest = {
  key: string
  contentType?: string
  contentLength?: number
}

export type SignUploadResponse = {
  method: "PUT"
  url: string
  headers?: Record<string, string>
  expiresAt: string
}

export type SignDownloadRequest = {
  key: string
}

export type SignDownloadResponse = {
  url: string
  headers?: Record<string, string>
  expiresAt: string
}


