export function getAuthTokenFromHeaders(headers: Headers): string | null {
  const authorization = headers.get("Authorization")
  if (authorization) {
    const trimmed = authorization.trim()
    const prefix = "Bearer "
    if (trimmed.startsWith(prefix)) {
      const token = trimmed.slice(prefix.length).trim()
      return token.length > 0 ? token : null
    }
  }

  const workerAuth = headers.get("X-Worker-Auth")
  return workerAuth && workerAuth.trim().length > 0 ? workerAuth.trim() : null
}

export function isRequestAuthorized(request: Request, expectedToken: string): boolean {
  const provided = getAuthTokenFromHeaders(request.headers)
  return provided === expectedToken
}

export function createAuthTokenChecker(): (request: Request, expectedToken: string) => boolean {
  return (request, expectedToken) => isRequestAuthorized(request, expectedToken)
}
