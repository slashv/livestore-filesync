/**
 * File hashing utilities
 *
 * These utilities use the HashService from context to perform hashing.
 * The HashService is platform-specific:
 * - Web/Node/Electron: Use HashServiceLive (Web Crypto API)
 * - React Native: Use HashServiceLive from @livestore-filesync/expo (expo-crypto)
 *
 * @module
 */

import { Effect } from "effect"
import { HashError } from "../errors/index.js"
import { Hash } from "../services/hash/index.js"

/**
 * Hash a file using SHA-256 and return the hex string.
 * Requires HashService in context.
 */
export const hashFile = (file: File): Effect.Effect<string, HashError, Hash> =>
  Effect.flatMap(Hash, (service) => service.hashFile(file))

/**
 * Hash an ArrayBuffer using SHA-256 and return the hex string.
 * Requires HashService in context.
 */
export const hashArrayBuffer = (buffer: ArrayBuffer): Effect.Effect<string, HashError, Hash> =>
  Effect.flatMap(Hash, (service) => service.hashArrayBuffer(buffer))

/**
 * Hash a Uint8Array using SHA-256 and return the hex string.
 * Requires HashService in context.
 */
export const hashUint8Array = (data: Uint8Array): Effect.Effect<string, HashError, Hash> =>
  hashArrayBuffer(data.buffer as ArrayBuffer)
