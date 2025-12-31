/**
 * Cloudflare Worker entry point
 *
 * Handles both file storage operations and LiveStore sync.
 *
 * This example uses `@livestore-filesync/r2` which proxies files through the Worker
 * using Cloudflare's R2 binding. This is the simplest setup and works great for:
 * - Local development with Wrangler
 * - Small to medium production deployments
 *
 * For high-traffic production deployments, consider using `@livestore-filesync/s3-signer`
 * which generates presigned URLs for direct-to-S3/R2 uploads. See the commented
 * alternative below and the S3 environment variables in .dev.vars.example.
 */

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { SyncPayload } from '../livestore/schema.ts'
import { composeFetchHandlers, createMatchedHandler, createR2Handler } from '@livestore-filesync/r2'

// =============================================================================
// Environment configuration
// =============================================================================

// Using R2 adapter (simpler setup, Worker-proxied files)
interface Env extends SyncBackend.Env {
  FILE_BUCKET: R2Bucket
  WORKER_AUTH_TOKEN: string
}

// Alternative: Using S3 signer (direct-to-storage, higher performance)
// Uncomment and use this instead if you need direct S3/R2 uploads.
// See .dev.vars.example for required environment variables.
//
// interface Env extends SyncBackend.Env {
//   WORKER_AUTH_TOKEN: string
//   S3_ENDPOINT: string      // e.g., https://<account-id>.r2.cloudflarestorage.com
//   S3_REGION: string        // e.g., "auto" for R2
//   S3_BUCKET: string
//   S3_ACCESS_KEY_ID: string
//   S3_SECRET_ACCESS_KEY: string
// }

// =============================================================================
// LiveStore Sync Durable Object
// =============================================================================

export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId, 'payload:', context.payload)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId, 'payload:', context.payload)
  },
}) {}

type SyncSearchParams = Exclude<ReturnType<typeof SyncBackend.matchSyncRequest>, undefined>

// =============================================================================
// File storage routes
// =============================================================================

// Option 1: R2 adapter (current - simpler, Worker-proxied)
// Files are stored in R2 via the Workers API binding.
// Signed URLs point back to this Worker which proxies the file data.
const fileRoutes = createR2Handler<CfTypes.Request, Env, CfTypes.ExecutionContext>({
  bucket: (env) => env.FILE_BUCKET,
  getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
  basePath: '/api',
  filesBasePath: '/livestore-filesync-files',
})

// Option 2: S3 signer (alternative - higher performance, direct-to-storage)
// Uncomment this and comment out the R2 handler above to use direct S3/R2 uploads.
// Requires S3 API credentials in environment variables.
//
// import { createS3SignerHandler } from '@livestore-filesync/s3-signer'
//
// const fileRoutes = createS3SignerHandler({
//   basePath: '/api',
//   getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
// })

const liveStoreSyncRoutes = createMatchedHandler<
  CfTypes.Request,
  Env,
  CfTypes.ExecutionContext,
  SyncSearchParams
>({
  match: (request: CfTypes.Request) => SyncBackend.matchSyncRequest(request),
  handle: (
    request: CfTypes.Request,
    searchParams: SyncSearchParams,
    env: Env,
    ctx: CfTypes.ExecutionContext,
  ) =>
    SyncBackend.handleSyncRequest({
      request,
      searchParams,
      ctx,
      syncBackendBinding: 'SYNC_BACKEND_DO',
      syncPayloadSchema: SyncPayload,
      validatePayload: (payload, context) => {
        console.log(`Validating connection for store: ${context.storeId}`)
        if (payload?.authToken !== env.WORKER_AUTH_TOKEN) {
          throw new Error('Invalid auth token')
        }
      },
    }),
})

export default {
  fetch: composeFetchHandlers<CfTypes.Request, Env, CfTypes.ExecutionContext>(
    fileRoutes,
    liveStoreSyncRoutes,
  ),
}
