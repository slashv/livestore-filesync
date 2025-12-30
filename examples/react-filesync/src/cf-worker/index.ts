/**
 * Cloudflare Worker entry point
 *
 * Handles both file storage operations and LiveStore sync
 */

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { createFileSyncHandler } from '@livestore-filesync/cloudflare'
import { composeFetchHandlers, createMatchedHandler } from '@livestore-filesync/cf-worker-utils'
import { SyncPayload } from '../livestore/schema.ts'

// Extend SyncBackend.Env with our additional bindings
interface Env extends SyncBackend.Env {
  FILE_BUCKET: R2Bucket
  WORKER_AUTH_TOKEN: string
}

// Create SyncBackendDO class
export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId, 'payload:', context.payload)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId, 'payload:', context.payload)
  },
}) {}

// Create file sync handler
const fileSyncHandler = createFileSyncHandler({
  getAuthToken: (env) => (env as Env).WORKER_AUTH_TOKEN,
})

type SyncSearchParams = Exclude<ReturnType<typeof SyncBackend.matchSyncRequest>, undefined>

const fileRoutes = (request: CfTypes.Request, env: Env, _ctx: CfTypes.ExecutionContext) =>
  fileSyncHandler(request as unknown as Request, env)

const liveStoreSyncRoutes = createMatchedHandler<
  CfTypes.Request,
  Env,
  CfTypes.ExecutionContext,
  SyncSearchParams
>({
  match: (request) => SyncBackend.matchSyncRequest(request),
  handle: (request, searchParams, env, ctx) =>
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
