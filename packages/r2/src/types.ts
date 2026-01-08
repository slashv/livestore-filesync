export type MaybePromise<T> = T | Promise<T>

export type FetchHandler<RequestType, Env, Ctx, ResponseType = unknown> = (
  request: RequestType,
  env: Env,
  ctx: Ctx
) => MaybePromise<ResponseType | null>

export type FetchHandlerWithMatch<RequestType, Env, Ctx, Match, ResponseType = unknown> = (
  request: RequestType,
  match: Match,
  env: Env,
  ctx: Ctx
) => MaybePromise<ResponseType>
