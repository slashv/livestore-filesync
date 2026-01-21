/**
 * HashService - Platform-agnostic hashing service
 *
 * Provides SHA-256 hashing capabilities that can be implemented
 * differently per platform (Web Crypto API for browsers/Node,
 * expo-crypto for React Native).
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { HashError } from "../../errors/index.js"

/**
 * HashService interface for platform-agnostic hashing
 */
export interface HashService {
  /**
   * Hash an ArrayBuffer using SHA-256 and return the hex string
   */
  readonly hashArrayBuffer: (buffer: ArrayBuffer) => Effect.Effect<string, HashError>

  /**
   * Hash a File using SHA-256 and return the hex string
   */
  readonly hashFile: (file: File) => Effect.Effect<string, HashError>
}

/**
 * HashService context tag
 */
export class Hash extends Context.Tag("HashService")<Hash, HashService>() {}

/**
 * Convert an ArrayBuffer to a hex string
 */
const bytesToHex = (hashBuffer: ArrayBuffer): string => {
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Create a HashService implementation using Web Crypto API
 */
const makeWebCryptoHashService = (): HashService => ({
  hashArrayBuffer: (buffer) =>
    Effect.tryPromise({
      try: async () => {
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
        return bytesToHex(hashBuffer)
      },
      catch: (error) =>
        new HashError({
          message: "Failed to hash buffer",
          cause: error
        })
    }),

  hashFile: (file) =>
    Effect.tryPromise({
      try: async () => {
        const buffer = await file.arrayBuffer()
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
        return bytesToHex(hashBuffer)
      },
      catch: (error) =>
        new HashError({
          message: "Failed to hash file",
          cause: error
        })
    })
})

/**
 * Default HashService layer using Web Crypto API.
 *
 * Works in:
 * - Browsers (all modern browsers)
 * - Node.js 20+ (globalThis.crypto.subtle)
 * - Electron (renderer and main process)
 *
 * For React Native, use HashServiceLive from @livestore-filesync/expo instead.
 */
export const HashServiceLive: Layer.Layer<Hash> = Layer.succeed(Hash, makeWebCryptoHashService())
