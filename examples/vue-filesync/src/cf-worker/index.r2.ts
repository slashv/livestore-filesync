/**
 * Cloudflare Worker entry point - R2 Gateway mode
 *
 * This worker handles:
 * 1. LiveStore sync (Durable Object)
 * 2. File storage via R2 adapter (signer API + file serving)
 *
 * Files are proxied through this Worker using Cloudflare's R2 bucket binding.
 * This is the simplest setup and works great for:
 * - Local development with Wrangler (uses R2 emulation)
 * - Small to medium production deployments
 *
 * For an alternative setup using direct S3/R2 uploads with presigned URLs,
 * see index.s3.ts which only handles LiveStore sync (the S3 signer is deployed
 * separately or you use @livestore-filesync/s3-signer).
 */

import { composeFetchHandlers, createMatchedHandler, createR2Handler } from "@livestore-filesync/r2"
import type { CfTypes } from "@livestore/sync-cf/cf-worker"
import * as SyncBackend from "@livestore/sync-cf/cf-worker"
import { SyncPayload } from "../livestore/schema.ts"

// =============================================================================
// Environment
// =============================================================================

interface Env extends SyncBackend.Env {
  FILE_BUCKET: R2Bucket
  WORKER_AUTH_TOKEN: string
}

// =============================================================================
// LiveStore Sync Durable Object
// =============================================================================

export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log("onPush", message.batch, "storeId:", context.storeId, "payload:", context.payload)
  },
  onPull: async (message, context) => {
    console.log("onPull", message, "storeId:", context.storeId, "payload:", context.payload)
  }
}) {}

// =============================================================================
// Route handlers
// =============================================================================

type SyncSearchParams = Exclude<ReturnType<typeof SyncBackend.matchSyncRequest>, undefined>

const fileRoutes = createR2Handler<CfTypes.Request, Env, CfTypes.ExecutionContext>({
  bucket: (env) => env.FILE_BUCKET,
  basePath: "/api",
  filesBasePath: "/livestore-filesync-files",

  // Static secret for HMAC-signing presigned URLs
  getSigningSecret: (env) => env.WORKER_AUTH_TOKEN,

  // Async auth validation - validates the auth token from headers
  // Returns empty array to allow all keys (no prefix restrictions)
  validateAuth: async (request, env) => {
    const authHeader = request.headers.get("Authorization")
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null

    if (!token || token !== env.WORKER_AUTH_TOKEN) {
      return null // Deny access
    }

    return [] // Allow all keys (no prefix restrictions)
  }
})

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
    ctx: CfTypes.ExecutionContext
  ) =>
    SyncBackend.handleSyncRequest({
      request,
      searchParams,
      ctx,
      syncBackendBinding: "SYNC_BACKEND_DO",
      syncPayloadSchema: SyncPayload,
      validatePayload: (payload, context) => {
        console.log(`Validating connection for store: ${context.storeId}`)
        if (payload?.authToken !== env.WORKER_AUTH_TOKEN) {
          throw new Error("Invalid auth token")
        }
      }
    })
})

export default {
  fetch: composeFetchHandlers<CfTypes.Request, Env, CfTypes.ExecutionContext>(
    fileRoutes,
    liveStoreSyncRoutes
  )
}
