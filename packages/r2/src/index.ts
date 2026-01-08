export { createAuthTokenChecker, getAuthTokenFromHeaders, isRequestAuthorized } from "./auth.js"
export { composeFetchHandlers } from "./composeFetchHandlers.js"
export { createMatchedHandler } from "./createMatchedHandler.js"
export { createR2Handler } from "./r2Handler.js"
export type { FetchHandler, FetchHandlerWithMatch, MaybePromise } from "./types.js"

/**
 * @deprecated Use `createR2Handler` instead. This alias will be removed in a future version.
 */
export { createR2Handler as createFilesyncR2DevHandler } from "./r2Handler.js"
