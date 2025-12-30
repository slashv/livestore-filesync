/**
 * Cloudflare Worker entry point
 *
 * Handles both file storage operations and LiveStore sync
 */

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { SyncPayload } from '../livestore/schema.ts'
import {
  composeFetchHandlers,
  createMatchedHandler,
  createFilesyncR2DevHandler,
} from '@livestore-filesync/cf-worker-utils'

// Extend SyncBackend.Env with our additional bindings
interface Env extends SyncBackend.Env {
  WORKER_AUTH_TOKEN: string
  FILE_BUCKET: R2Bucket
}

// Create SyncBackendDO class
export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId, 'payload:', context.payload)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId, 'payload:', context.payload)
  },
}) { }

type SyncSearchParams = Exclude<ReturnType<typeof SyncBackend.matchSyncRequest>, undefined>

const fileRoutes = createFilesyncR2DevHandler<CfTypes.Request, Env, CfTypes.ExecutionContext>({
  bucket: (env) => env.FILE_BUCKET,
  getAuthToken: (env) => env.WORKER_AUTH_TOKEN,
  basePath: '/api',
  filesBasePath: '/livestore-filesync-files',
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
