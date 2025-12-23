/**
 * Cloudflare Worker environment bindings
 *
 * Re-exported for use elsewhere if needed
 */

import type * as SyncBackend from '@livestore/sync-cf/cf-worker'

export interface Env extends SyncBackend.Env {
  /** R2 bucket for file storage */
  FILE_BUCKET: R2Bucket
  /** Auth token for API access */
  WORKER_AUTH_TOKEN: string
}
