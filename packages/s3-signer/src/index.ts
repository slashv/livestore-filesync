/**
 * @livestore-filesync/s3-signer
 *
 * Cloudflare Worker handler factory for minting presigned URLs against any S3-compatible backend.
 *
 * @module
 */

export { createS3SignerHandler } from "./handler.js"

export type {
  S3SignerEnv,
  S3SignerHandlerConfig,
  SignDownloadRequest,
  SignDownloadResponse,
  SignUploadRequest,
  SignUploadResponse
} from "./types.js"

export { addCorsHeaders, errorResponse, handleCorsPreflightRequest, jsonResponse } from "./cors.js"
