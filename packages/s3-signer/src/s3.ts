import { AwsClient } from "aws4fetch"
import type { S3SignerEnv } from "./types.js"

export function makeAwsClient(env: S3SignerEnv): AwsClient {
  return new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
    region: env.S3_REGION,
    service: "s3"
  })
}

export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

export function getForcePathStyle(env: S3SignerEnv): boolean {
  return String(env.S3_FORCE_PATH_STYLE || "").toLowerCase() === "true"
}

export function makeObjectUrl(env: S3SignerEnv, key: string): string {
  const endpoint = env.S3_ENDPOINT.replace(/\/+$/, "")
  const encodedKey = encodeS3Key(key)
  const forcePathStyle = getForcePathStyle(env)

  if (forcePathStyle) {
    return `${endpoint}/${env.S3_BUCKET}/${encodedKey}`
  }

  const url = new URL(endpoint)
  url.hostname = `${env.S3_BUCKET}.${url.hostname}`
  url.pathname = `/${encodedKey}`
  return url.toString()
}

export function makeBucketUrl(env: S3SignerEnv): string {
  const endpoint = env.S3_ENDPOINT.replace(/\/+$/, "")
  const forcePathStyle = getForcePathStyle(env)

  if (forcePathStyle) {
    return `${endpoint}/${env.S3_BUCKET}`
  }

  const url = new URL(endpoint)
  url.hostname = `${env.S3_BUCKET}.${url.hostname}`
  url.pathname = "/"
  return url.toString()
}


