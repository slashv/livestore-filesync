/**
 * Type definitions for @livestore-filesync/cloudflare
 */

/**
 * Environment bindings required for file sync
 */
export interface FileSyncEnv {
  /** R2 bucket for file storage */
  FILE_BUCKET: R2Bucket
  /** Optional auth token for API access */
  WORKER_AUTH_TOKEN?: string
}

/**
 * Configuration options for createFileSyncHandler
 */
export interface FileSyncHandlerConfig {
  /**
   * Name of the R2 bucket binding in env
   * @default 'FILE_BUCKET'
   */
  bucketBinding?: string

  /**
   * Base path for file routes
   * @default '/api'
   */
  basePath?: string

  /**
   * Function to get auth token from env
   * If provided, all routes will require authentication
   */
  getAuthToken?: (env: FileSyncEnv) => string | undefined
}

/**
 * Upload response returned from POST /api/upload
 */
export interface UploadResponse {
  url: string
  key: string
  size: number
  contentType: string
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'ok' | 'error'
  bucket: boolean
  timestamp: string
}
