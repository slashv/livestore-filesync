/**
 * LocalFileStateManager Service
 *
 * Centralized manager for all LocalFilesState mutations. Uses SQLite row-level
 * operations to avoid the rebase conflicts that occur with Schema.Record in
 * clientDocument.
 *
 * Each file's state is stored as a separate row in the localFileState table,
 * with changes committed via clientOnly events that sync between tabs but not
 * to the remote backend.
 *
 * ARCHITECTURE NOTE: This service uses individual row operations instead of
 * atomic JSON updates. This prevents the "function signature mismatch" errors
 * during rebase rollback that occur when multiple tabs update a Schema.Record
 * clientDocument simultaneously.
 * See: https://github.com/livestorejs/livestore/issues/998
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import type { LiveStoreDeps } from "../../livestore/types.js"
import type { LocalFilesState, LocalFileState, TransferStatus } from "../../types/index.js"

/**
 * Row type for the localFileState table
 */
interface LocalFileStateTableRow {
  fileId: string
  path: string
  localHash: string
  downloadStatus: string
  uploadStatus: string
  lastSyncError: string
}

/**
 * LocalFileStateManager service interface
 *
 * Provides operations for updating the LocalFilesState stored in SQLite rows.
 * Each file's state is stored as a separate row to avoid rebase conflicts.
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
   * Get the current state (read-only).
   * Returns a map of fileId -> LocalFileState reconstructed from table rows.
   */
  readonly getState: () => Effect.Effect<LocalFilesState>

  /**
   * Apply a custom updater function.
   * The updater receives the current state and returns the new state.
   * Changes are computed as a diff and committed as individual row operations.
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
  Effect.sync(() => {
    const { schema, store } = deps
    const { events, queryDb, tables } = schema
    type LocalFileStateEvent =
      | ReturnType<typeof events.localFileStateUpsert>
      | ReturnType<typeof events.localFileStateRemove>

    /**
     * Convert a table row to LocalFileState (without fileId)
     */
    const rowToState = (row: LocalFileStateTableRow): LocalFileState => ({
      path: row.path,
      localHash: row.localHash,
      downloadStatus: row.downloadStatus as TransferStatus,
      uploadStatus: row.uploadStatus as TransferStatus,
      lastSyncError: row.lastSyncError
    })

    /**
     * Read current state from SQLite table as a map
     */
    const readState = (): LocalFilesState => {
      const rows = store.query<Array<LocalFileStateTableRow>>(
        queryDb(tables.localFileState.select())
      )
      const state: Record<string, LocalFileState> = {}
      for (const row of rows) {
        state[row.fileId] = rowToState(row)
      }
      return state
    }

    /**
     * Read a single file's state from the table
     */
    const readFileState = (fileId: string): LocalFileState | undefined => {
      const rows = store.query<Array<LocalFileStateTableRow>>(
        queryDb(tables.localFileState.where({ fileId }))
      )
      if (rows.length === 0) return undefined
      return rowToState(rows[0]!)
    }

    /**
     * Commit an upsert for a single file
     */
    const commitUpsert = (fileId: string, state: LocalFileState): void => {
      store.commit(
        events.localFileStateUpsert({
          fileId,
          path: state.path,
          localHash: state.localHash,
          downloadStatus: state.downloadStatus,
          uploadStatus: state.uploadStatus,
          lastSyncError: state.lastSyncError
        })
      )
    }

    /**
     * Commit a remove for a single file
     */
    const commitRemove = (fileId: string): void => {
      store.commit(events.localFileStateRemove({ fileId }))
    }

    /**
     * Commit a batch of local file state events in one transaction.
     */
    const commitEvents = (eventsBatch: ReadonlyArray<LocalFileStateEvent>): void => {
      if (eventsBatch.length === 0) return
      store.commit(...eventsBatch)
    }

    const hasStateChanged = (existing: LocalFileState | undefined, next: LocalFileState): boolean =>
      !existing ||
      existing.path !== next.path ||
      existing.localHash !== next.localHash ||
      existing.downloadStatus !== next.downloadStatus ||
      existing.uploadStatus !== next.uploadStatus ||
      existing.lastSyncError !== next.lastSyncError

    // Set complete state for a single file
    const setFileState = (
      fileId: string,
      state: LocalFileState
    ): Effect.Effect<void> => Effect.sync(() => commitUpsert(fileId, state))

    // Update transfer status for a file
    const setTransferStatus = (
      fileId: string,
      action: "upload" | "download",
      status: TransferStatus
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const existing = readFileState(fileId)
        if (!existing) return // No-op if file doesn't exist

        const updatedState: LocalFileState = action === "upload"
          ? { ...existing, uploadStatus: status }
          : { ...existing, downloadStatus: status }

        commitUpsert(fileId, updatedState)
      })

    // Update transfer status and set error
    const setTransferError = (
      fileId: string,
      action: "upload" | "download",
      status: TransferStatus,
      error: string
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const existing = readFileState(fileId)
        if (!existing) return // No-op if file doesn't exist

        const updatedState: LocalFileState = action === "upload"
          ? { ...existing, uploadStatus: status, lastSyncError: error }
          : { ...existing, downloadStatus: status, lastSyncError: error }

        commitUpsert(fileId, updatedState)
      })

    // Remove a file's state
    const removeFile = (fileId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        if (!readFileState(fileId)) return
        commitRemove(fileId)
      })

    // Merge files into state
    const mergeFiles = (patch: LocalFilesState): Effect.Effect<void> =>
      Effect.sync(() => {
        const currentState = readState()
        const eventsBatch: Array<LocalFileStateEvent> = []

        for (const [fileId, state] of Object.entries(patch)) {
          if (!hasStateChanged(currentState[fileId], state)) continue
          eventsBatch.push(events.localFileStateUpsert({
            fileId,
            path: state.path,
            localHash: state.localHash,
            downloadStatus: state.downloadStatus,
            uploadStatus: state.uploadStatus,
            lastSyncError: state.lastSyncError
          }))
        }

        commitEvents(eventsBatch)
      })

    // Replace entire state
    const replaceState = (newState: LocalFilesState): Effect.Effect<void> =>
      Effect.sync(() => {
        // Get current file IDs
        const currentState = readState()
        const currentIds = new Set(Object.keys(currentState))
        const newIds = new Set(Object.keys(newState))
        const eventsBatch: Array<LocalFileStateEvent> = []

        // Remove files that are not in the new state
        for (const fileId of currentIds) {
          if (!newIds.has(fileId)) {
            eventsBatch.push(events.localFileStateRemove({ fileId }))
          }
        }

        // Upsert all files in the new state
        for (const [fileId, state] of Object.entries(newState)) {
          if (!hasStateChanged(currentState[fileId], state)) continue
          eventsBatch.push(events.localFileStateUpsert({
            fileId,
            path: state.path,
            localHash: state.localHash,
            downloadStatus: state.downloadStatus,
            uploadStatus: state.uploadStatus,
            lastSyncError: state.lastSyncError
          }))
        }

        commitEvents(eventsBatch)
      })

    // Get current state (read-only)
    const getState = (): Effect.Effect<LocalFilesState> => Effect.sync(readState)

    // Apply a custom updater function
    const atomicUpdate = (
      updater: (state: LocalFilesState) => LocalFilesState
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const currentState = readState()
        const nextState = updater(currentState)

        // If state didn't change (same reference), skip
        if (nextState === currentState) return

        // Compute the diff and apply changes
        const currentIds = new Set(Object.keys(currentState))
        const nextIds = new Set(Object.keys(nextState))
        const eventsBatch: Array<LocalFileStateEvent> = []

        // Remove files that are no longer in state
        for (const fileId of currentIds) {
          if (!nextIds.has(fileId)) {
            eventsBatch.push(events.localFileStateRemove({ fileId }))
          }
        }

        // Upsert files that are new or changed
        for (const [fileId, state] of Object.entries(nextState)) {
          const existing = currentState[fileId]
          if (!hasStateChanged(existing, state)) continue
          eventsBatch.push(events.localFileStateUpsert({
            fileId,
            path: state.path,
            localHash: state.localHash,
            downloadStatus: state.downloadStatus,
            uploadStatus: state.uploadStatus,
            lastSyncError: state.lastSyncError
          }))
        }

        commitEvents(eventsBatch)
      })

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
): Layer.Layer<LocalFileStateManager> => Layer.effect(LocalFileStateManager, makeLocalFileStateManager(deps))
