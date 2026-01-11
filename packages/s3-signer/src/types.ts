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
}

/**
 * Result of async auth validation.
 *
 * - `null`: Access denied (returns 401 Unauthorized)
 * - `[]` (empty array): No restrictions, allow access to all keys
 * - `["prefix/"]`: Only allow access to keys starting with any of the specified prefixes
 */
export type ValidateAuthResult = ReadonlyArray<string> | null

export interface S3SignerHandlerConfig<Env extends S3SignerEnv = S3SignerEnv> {
  /**
   * Base path for signer routes (default: '/api')
   *
   * Example:
   * - basePath '/api' => routes at '/api/health', '/api/v1/sign/upload', ...
   */
  readonly basePath?: string

  /**
   * Maximum expiry in seconds for presigned URLs (default: 900).
   */
  readonly maxExpirySeconds?: number

  /**
   * Async auth validation callback.
   *
   * Called for every request that requires authentication (sign endpoints and delete).
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
