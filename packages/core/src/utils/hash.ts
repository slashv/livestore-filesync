/**
 * File hashing utilities using Web Crypto API
 *
 * @module
 */

import { Effect } from "effect"
import { HashError } from "../errors/index.js"

const ensureCryptoSubtle = (): SubtleCrypto | null => {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle
  }
  return null
}

const bytesToHex = (hashBuffer: ArrayBuffer): string => {
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

const digestWithExpoCrypto = async (buffer: ArrayBuffer): Promise<string> => {
  try {
    // @ts-expect-error - expo-crypto types are provided by the consuming app
    const { CryptoDigestAlgorithm, digest } = await import("expo-crypto")
    const hashBuffer = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(buffer))
    return bytesToHex(hashBuffer)
  } catch (error) {
    throw new Error("Expo Crypto digest failed", { cause: error })
  }
}

/**
 * Hash a file using SHA-256 and return the hex string
 */
export const hashFile = (file: File): Effect.Effect<string, HashError> =>
  Effect.tryPromise({
    try: async () => {
      const buffer = await file.arrayBuffer()
      const subtle = ensureCryptoSubtle()
      if (subtle) {
        const hashBuffer = await subtle.digest("SHA-256", buffer)
        return bytesToHex(hashBuffer)
      }
      return await digestWithExpoCrypto(buffer)
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
      const subtle = ensureCryptoSubtle()
      if (subtle) {
        const hashBuffer = await subtle.digest("SHA-256", buffer)
        return bytesToHex(hashBuffer)
      }
      return await digestWithExpoCrypto(buffer)
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
