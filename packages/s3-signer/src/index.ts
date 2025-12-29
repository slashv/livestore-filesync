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
  SignUploadRequest,
  SignUploadResponse,
  SignDownloadRequest,
  SignDownloadResponse
} from "./types.js"

export {
  handleCorsPreflightRequest,
  addCorsHeaders,
  jsonResponse,
  errorResponse
} from "./cors.js"


