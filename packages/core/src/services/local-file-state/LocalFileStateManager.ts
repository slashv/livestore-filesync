/**
 * LocalFileStateManager Service
 *
 * Centralized manager for all LocalFilesState mutations. Uses a semaphore
 * to ensure atomic read-modify-write operations, preventing race conditions
 * when multiple concurrent operations try to update the state.
 *
 * All state changes must go through this service - it is the single owner
 * of LocalFilesState mutations.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import type { LiveStoreDeps } from "../../livestore/types.js"
import type {
  LocalFileState,
  LocalFilesState,
  TransferStatus
} from "../../types/index.js"

/**
 * LocalFileStateManager service interface
 *
 * Provides atomic operations for updating the LocalFilesState client document.
 * All methods are serialized internally to prevent race conditions.
 */
export interface LocalFileStateManagerService {
  /**
   * Set the complete state for a single file.
   * If the file doesn't exist, it will be created.
   */
  readonly setFileState: (
    fileId: string,
    state: LocalFileState
  ) => Effect.Effect<void>

  /**
   * Update the transfer status (upload or download) for a file.
   * No-op if the file doesn't exist in state.
   */
  readonly setTransferStatus: (
    fileId: string,
    action: "upload" | "download",
    status: TransferStatus
  ) => Effect.Effect<void>

  /**
   * Update the transfer status and set an error message.
   * No-op if the file doesn't exist in state.
   */
  readonly setTransferError: (
    fileId: string,
    action: "upload" | "download",
    status: TransferStatus,
    error: string
  ) => Effect.Effect<void>

  /**
   * Remove a file's state entry.
   * No-op if the file doesn't exist in state.
   */
  readonly removeFile: (fileId: string) => Effect.Effect<void>

  /**
   * Merge a patch of file states into the current state.
   * Existing files not in the patch are preserved.
   */
  readonly mergeFiles: (patch: LocalFilesState) => Effect.Effect<void>

  /**
   * Replace the entire state with a new state.
   * Use with caution - typically used for reconciliation.
   */
  readonly replaceState: (state: LocalFilesState) => Effect.Effect<void>

  /**
   * Get the current state (read-only, no locking needed).
   */
  readonly getState: () => Effect.Effect<LocalFilesState>

  /**
   * Apply a custom updater function atomically.
   * Use this for complex updates that don't fit the other methods.
   */
  readonly atomicUpdate: (
    updater: (state: LocalFilesState) => LocalFilesState
  ) => Effect.Effect<void>
}

/**
 * LocalFileStateManager service tag
 */
export class LocalFileStateManager extends Context.Tag("LocalFileStateManager")<
  LocalFileStateManager,
  LocalFileStateManagerService
>() {}

/**
 * Create the LocalFileStateManager service
 */
export const makeLocalFileStateManager = (
  deps: LiveStoreDeps
): Effect.Effect<LocalFileStateManagerService> =>
  Effect.gen(function* () {
    const { store, schema } = deps
    const { tables, events, queryDb } = schema

    // Create a semaphore with 1 permit to ensure only one update runs at a time
    const semaphore = yield* Effect.makeSemaphore(1)

    // Read current state from LiveStore
    const readState = (): LocalFilesState => {
      const doc = store.query<{ localFiles?: LocalFilesState }>(
        queryDb(tables.localFileState.get())
      )
      return doc.localFiles ?? {}
    }

    // Commit state to LiveStore
    const commitState = (state: LocalFilesState): void => {
      store.commit(events.localFileStateSet({ localFiles: state }))
    }

    // Core atomic update - all other methods use this
    // Uses semaphore.withPermits(1) to ensure only one update runs at a time
    const atomicUpdate = (
      updater: (state: LocalFilesState) => LocalFilesState
    ): Effect.Effect<void> =>
      semaphore.withPermits(1)(
        Effect.sync(() => {
          const currentState = readState()
          const nextState = updater(currentState)
          // Only commit if state actually changed (referential equality check)
          if (nextState !== currentState) {
            commitState(nextState)
          }
        })
      )

    // Set complete state for a single file
    const setFileState = (
      fileId: string,
      state: LocalFileState
    ): Effect.Effect<void> =>
      atomicUpdate((currentState) => ({
        ...currentState,
        [fileId]: state
      }))

    // Update transfer status for a file
    const setTransferStatus = (
      fileId: string,
      action: "upload" | "download",
      status: TransferStatus
    ): Effect.Effect<void> =>
      atomicUpdate((currentState) => {
        const existing = currentState[fileId]
        if (!existing) return currentState // No-op if file doesn't exist

        const field = action === "upload" ? "uploadStatus" : "downloadStatus"
        return {
          ...currentState,
          [fileId]: { ...existing, [field]: status }
        }
      })

    // Update transfer status and set error
    const setTransferError = (
      fileId: string,
      action: "upload" | "download",
      status: TransferStatus,
      error: string
    ): Effect.Effect<void> =>
      atomicUpdate((currentState) => {
        const existing = currentState[fileId]
        if (!existing) return currentState // No-op if file doesn't exist

        const field = action === "upload" ? "uploadStatus" : "downloadStatus"
        return {
          ...currentState,
          [fileId]: { ...existing, [field]: status, lastSyncError: error }
        }
      })

    // Remove a file's state
    const removeFile = (fileId: string): Effect.Effect<void> =>
      atomicUpdate((currentState) => {
        if (!(fileId in currentState)) return currentState // No-op
        const { [fileId]: _, ...rest } = currentState
        return rest
      })

    // Merge files into state
    const mergeFiles = (patch: LocalFilesState): Effect.Effect<void> =>
      atomicUpdate((currentState) => ({
        ...currentState,
        ...patch
      }))

    // Replace entire state
    const replaceState = (state: LocalFilesState): Effect.Effect<void> =>
      atomicUpdate(() => state)

    // Get current state (no lock needed for reads)
    const getState = (): Effect.Effect<LocalFilesState> =>
      Effect.sync(readState)

    return {
      setFileState,
      setTransferStatus,
      setTransferError,
      removeFile,
      mergeFiles,
      replaceState,
      getState,
      atomicUpdate
    }
  })

/**
 * Create a Layer for LocalFileStateManager
 */
export const LocalFileStateManagerLive = (
  deps: LiveStoreDeps
): Layer.Layer<LocalFileStateManager> =>
  Layer.effect(LocalFileStateManager, makeLocalFileStateManager(deps))
