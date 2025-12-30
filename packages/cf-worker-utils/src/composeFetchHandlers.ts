import type { FetchHandler } from './types.js'

export function composeFetchHandlers<
  RequestType = Request,
  Env = unknown,
  Ctx = unknown,
  ResponseType = unknown,
>(
  ...handlers: ReadonlyArray<FetchHandler<RequestType, Env, Ctx, ResponseType>>
) {
  return async function composedFetch(
    request: RequestType,
    env: Env,
    ctx: Ctx,
  ): Promise<ResponseType> {
    for (const handler of handlers) {
      const response = await handler(request, env, ctx)
      if (response) return response
    }
    return new Response('Not Found', { status: 404 }) as unknown as ResponseType
  }
}


