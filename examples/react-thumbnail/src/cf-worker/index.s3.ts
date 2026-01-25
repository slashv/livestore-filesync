/**
 * Cloudflare Worker entry point - S3 Signer mode
 *
 * This worker handles:
 * 1. LiveStore sync (Durable Object)
 * 2. S3 signer API (presigned URLs for direct-to-R2 uploads)
 *
 * Clients upload/download files directly to R2 via presigned URLs.
 * The Worker only signs URLs - it doesn't proxy file data.
 *
 * Benefits over R2 Gateway mode (index.r2.ts):
 * - Higher performance (no Worker in the data path)
 * - Better for large files and high traffic
 * - Lower Worker CPU/bandwidth usage
 *
 * Requirements:
 * - S3 API credentials in environment (S3_ENDPOINT, S3_ACCESS_KEY_ID, etc.)
 * - No R2 bucket binding needed
 *
 * To use this mode, update wrangler.toml:
 *   main = "src/cf-worker/index.s3.ts"
 *
 * See .dev.vars.example for required environment variables.
 */

import { createS3SignerHandler, type S3SignerEnv } from "@livestore-filesync/s3-signer"
import type { CfTypes } from "@livestore/sync-cf/cf-worker"
import * as SyncBackend from "@livestore/sync-cf/cf-worker"
import { SyncPayload } from "../livestore/schema.ts"

// =============================================================================
// Environment
// =============================================================================

interface Env extends SyncBackend.Env, S3SignerEnv {
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

// S3 signer handler (signs URLs for direct-to-R2 uploads)
const s3SignerHandler = createS3SignerHandler<Env>({
  basePath: "/api",
  validateAuth: async (request, env) => {
    const token = request.headers.get("Authorization")?.replace("Bearer ", "") ||
      request.headers.get("X-Worker-Auth")
    if (!token || token !== env.WORKER_AUTH_TOKEN) return null
    return [] // Allow all keys
  }
})

// =============================================================================
// Main fetch handler
// =============================================================================

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext) {
    // Try S3 signer routes first
    const s3Response = await s3SignerHandler(request as unknown as Request, env)
    if (s3Response) return s3Response

    // Then try LiveStore sync
    const searchParams = SyncBackend.matchSyncRequest(request)
    if (searchParams !== undefined) {
      return SyncBackend.handleSyncRequest({
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
    }

    return new Response("Not Found", { status: 404 })
  }
}
