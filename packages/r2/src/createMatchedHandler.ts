import type { FetchHandler, FetchHandlerWithMatch } from './types.js'

export function createMatchedHandler<
  RequestType = Request,
  Env = unknown,
  Ctx = unknown,
  Match = unknown,
  ResponseType = unknown,
>(options: {
  readonly match: (request: RequestType) => Match | undefined
  readonly handle: FetchHandlerWithMatch<RequestType, Env, Ctx, Match, ResponseType>
}): FetchHandler<RequestType, Env, Ctx, ResponseType> {
  const { match, handle } = options
  return async (request, env, ctx) => {
    const matchResult = match(request)
    if (matchResult === undefined) return null
    return handle(request, matchResult, env, ctx)
  }
}


