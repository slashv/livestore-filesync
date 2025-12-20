/**
 * File hashing utilities using Web Crypto API
 *
 * @module
 */

import { Effect } from "effect"
import { HashError } from "../errors/index.js"

/**
 * Hash a file using SHA-256 and return the hex string
 */
export const hashFile = (file: File): Effect.Effect<string, HashError> =>
  Effect.tryPromise({
    try: async () => {
      const buffer = await file.arrayBuffer()
      const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
    },
    catch: (error) =>
      new HashError({
        message: "Failed to hash file",
        cause: error
      })
  })

/**
 * Hash an ArrayBuffer using SHA-256 and return the hex string
 */
export const hashArrayBuffer = (buffer: ArrayBuffer): Effect.Effect<string, HashError> =>
  Effect.tryPromise({
    try: async () => {
      const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
    },
    catch: (error) =>
      new HashError({
        message: "Failed to hash buffer",
        cause: error
      })
  })

/**
 * Hash a Uint8Array using SHA-256 and return the hex string
 */
export const hashUint8Array = (data: Uint8Array): Effect.Effect<string, HashError> =>
  hashArrayBuffer(data.buffer as ArrayBuffer)
