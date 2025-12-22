/**
 * CORS utilities for Cloudflare Workers
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Worker-Auth',
  'Access-Control-Max-Age': '86400',
}

/**
 * Handle CORS preflight request
 */
export function handleCorsPreflightRequest(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  })
}

/**
 * Add CORS headers to a response
 */
export function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

/**
 * Create a JSON response with CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

/**
 * Create an error response with CORS headers
 */
export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status)
}
