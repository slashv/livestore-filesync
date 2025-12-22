/**
 * File operation route handlers
 */

import { addCorsHeaders, errorResponse, jsonResponse } from './cors.js'
import type { HealthResponse, UploadResponse } from './types.js'

/**
 * Health check - validates R2 bucket access
 */
export async function handleHealth(bucket: R2Bucket): Promise<Response> {
  try {
    // Try to list objects to verify bucket access
    await bucket.list({ limit: 1 })

    const response: HealthResponse = {
      status: 'ok',
      bucket: true,
      timestamp: new Date().toISOString(),
    }
    return jsonResponse(response)
  } catch (error) {
    const response: HealthResponse = {
      status: 'error',
      bucket: false,
      timestamp: new Date().toISOString(),
    }
    return jsonResponse(response, 500)
  }
}

/**
 * Upload file to R2
 * Expects multipart form data with 'file' field
 */
export async function handleUpload(
  request: Request,
  bucket: R2Bucket,
  origin: string
): Promise<Response> {
  try {
    const formData = await request.formData()
    const file = formData.get('file')

    if (!file || !(file instanceof File)) {
      return errorResponse('No file provided', 400)
    }

    const key = file.name
    const contentType = file.type || 'application/octet-stream'
    const arrayBuffer = await file.arrayBuffer()

    await bucket.put(key, arrayBuffer, {
      httpMetadata: {
        contentType,
      },
    })

    const response: UploadResponse = {
      url: `${origin}/api/files/${encodeURIComponent(key)}`,
      key,
      size: arrayBuffer.byteLength,
      contentType,
    }

    return jsonResponse(response, 201)
  } catch (error) {
    console.error('Upload error:', error)
    return errorResponse('Upload failed', 500)
  }
}

/**
 * Download file from R2
 */
export async function handleDownload(
  bucket: R2Bucket,
  key: string
): Promise<Response> {
  try {
    const object = await bucket.get(key)

    if (!object) {
      return errorResponse('File not found', 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Content-Length', object.size.toString())
    headers.set('ETag', object.etag)

    // Add cache headers
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    return addCorsHeaders(new Response(object.body, { headers }))
  } catch (error) {
    console.error('Download error:', error)
    return errorResponse('Download failed', 500)
  }
}

/**
 * Delete file from R2
 */
export async function handleDelete(
  bucket: R2Bucket,
  key: string
): Promise<Response> {
  try {
    await bucket.delete(key)
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error) {
    console.error('Delete error:', error)
    return errorResponse('Delete failed', 500)
  }
}
