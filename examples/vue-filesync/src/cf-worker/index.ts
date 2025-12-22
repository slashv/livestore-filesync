/**
 * Cloudflare Worker entry point
 *
 * Handles both file storage operations and LiveStore sync
 */

import type { CfTypes } from '@livestore/sync-cf/cf-worker'
import * as SyncBackend from '@livestore/sync-cf/cf-worker'
import { createFileSyncHandler } from '@livestore-filesync/cloudflare'
import type { Env } from './shared.js'

// Create SyncBackendDO class
export class SyncBackendDO extends SyncBackend.makeDurableObject({
  onPush: async (message, context) => {
    console.log('onPush', message.batch, 'storeId:', context.storeId)
  },
  onPull: async (message, context) => {
    console.log('onPull', message, 'storeId:', context.storeId)
  },
}) {}

// Create file sync handler
const fileSyncHandler = createFileSyncHandler({
  getAuthToken: (env) => (env as unknown as Env).WORKER_AUTH_TOKEN,
})

export default {
  async fetch(request: CfTypes.Request, env: Env, ctx: CfTypes.ExecutionContext): Promise<Response> {
    // Handle file operations first
    const fileResponse = await fileSyncHandler(request, env)
    if (fileResponse) return fileResponse

    // Handle LiveStore sync
    const syncMatch = SyncBackend.matchSyncRequest(request)
    if (syncMatch !== undefined) {
      return SyncBackend.handleSyncRequest({
        request,
        ctx,
        searchParams: syncMatch,
        syncBackendBinding: 'SYNC_BACKEND_DO',
        validatePayload: (payload, context) => {
          console.log(`Validating connection for store: ${context.storeId}`)
          if (payload?.authToken !== env.WORKER_AUTH_TOKEN) {
            throw new Error('Invalid auth token')
          }
        },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}
