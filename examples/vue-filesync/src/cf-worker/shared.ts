/**
 * Cloudflare Worker environment bindings
 */

export interface Env {
  /** R2 bucket for file storage */
  FILE_BUCKET: R2Bucket
  /** Durable Object for LiveStore sync */
  SYNC_BACKEND_DO: DurableObjectNamespace
  /** Auth token for API access */
  WORKER_AUTH_TOKEN: string
}
