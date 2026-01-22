/**
 * HashService implementation using expo-crypto
 *
 * This implementation is required for React Native environments
 * where the Web Crypto API (crypto.subtle) is not available.
 *
 * @module
 */

import { Hash, type HashService } from "@livestore-filesync/core"
import { HashError } from "@livestore-filesync/core"
import { Effect, Layer } from "effect"
import { CryptoDigestAlgorithm, digest } from "expo-crypto"

/**
 * Convert an ArrayBuffer to a hex string
 */
const bytesToHex = (hashBuffer: ArrayBuffer): string => {
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Create a HashService implementation using expo-crypto
 */
const makeExpoCryptoHashService = (): HashService => ({
  hashArrayBuffer: (buffer) =>
    Effect.tryPromise({
      try: async () => {
        const hashBuffer = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(buffer))
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
        const hashBuffer = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(buffer))
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
 * HashService layer using expo-crypto.
 *
 * Required for React Native environments where Web Crypto API is not available.
 *
 * @example
 * ```typescript
 * import { initFileSync } from '@livestore-filesync/core'
 * import { layer as expoFsLayer, HashServiceLive } from '@livestore-filesync/expo'
 *
 * initFileSync(store, {
 *   fileSystem: expoFsLayer(),
 *   hashService: HashServiceLive,
 *   remote: { signerBaseUrl: 'https://api.example.com' }
 * })
 * ```
 */
export const HashServiceLive: Layer.Layer<Hash> = Layer.succeed(Hash, makeExpoCryptoHashService())
