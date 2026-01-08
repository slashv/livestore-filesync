import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore } from "../../../test/helpers/livestore.js"
import { makeLocalFileStateManager } from "./LocalFileStateManager.js"

describe("LocalFileStateManager", () => {
  it("should set and get file state", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file",
          localHash: "abc123",
          uploadStatus: "queued",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      const state = await Effect.runPromise(manager.getState())
      expect(state["file-1"]).toEqual({
        path: "/path/to/file",
        localHash: "abc123",
        uploadStatus: "queued",
        downloadStatus: "done",
        lastSyncError: ""
      })
    } finally {
      await shutdown()
    }
  })

  it("should update transfer status", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // First set the file state
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file",
          localHash: "abc123",
          uploadStatus: "queued",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      // Update upload status
      await Effect.runPromise(manager.setTransferStatus("file-1", "upload", "inProgress"))

      const state = await Effect.runPromise(manager.getState())
      expect(state["file-1"]?.uploadStatus).toBe("inProgress")
      expect(state["file-1"]?.downloadStatus).toBe("done") // Should be preserved
    } finally {
      await shutdown()
    }
  })

  it("should remove file state", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file",
          localHash: "abc123",
          uploadStatus: "done",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      await Effect.runPromise(manager.removeFile("file-1"))

      const state = await Effect.runPromise(manager.getState())
      expect(state["file-1"]).toBeUndefined()
    } finally {
      await shutdown()
    }
  })

  it("should merge files atomically", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // Set initial files
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file1",
          localHash: "hash1",
          uploadStatus: "done",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      // Merge in new files
      await Effect.runPromise(
        manager.mergeFiles({
          "file-2": {
            path: "/path/to/file2",
            localHash: "hash2",
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          },
          "file-3": {
            path: "/path/to/file3",
            localHash: "hash3",
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          }
        })
      )

      const state = await Effect.runPromise(manager.getState())
      expect(Object.keys(state)).toHaveLength(3)
      expect(state["file-1"]).toBeDefined()
      expect(state["file-2"]).toBeDefined()
      expect(state["file-3"]).toBeDefined()
    } finally {
      await shutdown()
    }
  })

  it("should handle concurrent updates without losing state", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // Simulate the race condition scenario: multiple concurrent setFileState calls
      const fileCount = 10
      const updates = Array.from({ length: fileCount }, (_, i) =>
        Effect.runPromise(
          manager.setFileState(`file-${i}`, {
            path: `/path/to/file-${i}`,
            localHash: `hash-${i}`,
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          })
        ))

      // Run all updates concurrently (this is what caused the race condition)
      await Promise.all(updates)

      const state = await Effect.runPromise(manager.getState())

      // All files should be present (not overwritten by race condition)
      expect(Object.keys(state)).toHaveLength(fileCount)

      for (let i = 0; i < fileCount; i++) {
        expect(state[`file-${i}`]).toBeDefined()
        expect(state[`file-${i}`].path).toBe(`/path/to/file-${i}`)
        expect(state[`file-${i}`].localHash).toBe(`hash-${i}`)
        expect(state[`file-${i}`].uploadStatus).toBe("queued")
      }
    } finally {
      await shutdown()
    }
  })

  it("should handle concurrent mixed operations", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // First add some files
      await Effect.runPromise(
        manager.mergeFiles({
          "file-1": {
            path: "/p/1",
            localHash: "h1",
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          },
          "file-2": {
            path: "/p/2",
            localHash: "h2",
            uploadStatus: "queued",
            downloadStatus: "done",
            lastSyncError: ""
          },
          "file-3": { path: "/p/3", localHash: "h3", uploadStatus: "queued", downloadStatus: "done", lastSyncError: "" }
        })
      )

      // Now do concurrent mixed operations
      await Promise.all([
        Effect.runPromise(manager.setTransferStatus("file-1", "upload", "inProgress")),
        Effect.runPromise(manager.setTransferStatus("file-2", "upload", "inProgress")),
        Effect.runPromise(manager.setFileState("file-4", {
          path: "/p/4",
          localHash: "h4",
          uploadStatus: "queued",
          downloadStatus: "done",
          lastSyncError: ""
        })),
        Effect.runPromise(manager.setTransferStatus("file-3", "upload", "done"))
      ])

      const state = await Effect.runPromise(manager.getState())

      expect(Object.keys(state)).toHaveLength(4)
      expect(state["file-1"]?.uploadStatus).toBe("inProgress")
      expect(state["file-2"]?.uploadStatus).toBe("inProgress")
      expect(state["file-3"]?.uploadStatus).toBe("done")
      expect(state["file-4"]?.uploadStatus).toBe("queued")
    } finally {
      await shutdown()
    }
  })

  it("should set transfer error with message", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file",
          localHash: "abc123",
          uploadStatus: "inProgress",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      await Effect.runPromise(
        manager.setTransferError("file-1", "upload", "pending", "Network error")
      )

      const state = await Effect.runPromise(manager.getState())
      expect(state["file-1"]?.uploadStatus).toBe("pending")
      expect(state["file-1"]?.lastSyncError).toBe("Network error")
    } finally {
      await shutdown()
    }
  })

  it("should replace entire state", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // Set initial state
      await Effect.runPromise(
        manager.mergeFiles({
          "file-1": { path: "/p/1", localHash: "h1", uploadStatus: "done", downloadStatus: "done", lastSyncError: "" },
          "file-2": { path: "/p/2", localHash: "h2", uploadStatus: "done", downloadStatus: "done", lastSyncError: "" }
        })
      )

      // Replace with completely new state
      await Effect.runPromise(
        manager.replaceState({
          "file-3": { path: "/p/3", localHash: "h3", uploadStatus: "queued", downloadStatus: "done", lastSyncError: "" }
        })
      )

      const state = await Effect.runPromise(manager.getState())
      expect(Object.keys(state)).toHaveLength(1)
      expect(state["file-1"]).toBeUndefined()
      expect(state["file-2"]).toBeUndefined()
      expect(state["file-3"]).toBeDefined()
    } finally {
      await shutdown()
    }
  })

  it("should no-op when updating non-existent file", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      // Try to update a file that doesn't exist
      await Effect.runPromise(manager.setTransferStatus("nonexistent", "upload", "inProgress"))

      const state = await Effect.runPromise(manager.getState())
      expect(state["nonexistent"]).toBeUndefined()
      expect(Object.keys(state)).toHaveLength(0)
    } finally {
      await shutdown()
    }
  })

  it("should handle atomicUpdate for custom operations", async () => {
    const { deps, shutdown } = await createTestStore()
    const manager = await Effect.runPromise(makeLocalFileStateManager(deps))

    try {
      await Effect.runPromise(
        manager.setFileState("file-1", {
          path: "/path/to/file",
          localHash: "abc123",
          uploadStatus: "queued",
          downloadStatus: "done",
          lastSyncError: ""
        })
      )

      // Custom atomic update that modifies multiple fields
      await Effect.runPromise(
        manager.atomicUpdate((state) => ({
          ...state,
          "file-1": {
            ...state["file-1"]!,
            uploadStatus: "done",
            localHash: "updated-hash"
          }
        }))
      )

      const state = await Effect.runPromise(manager.getState())
      expect(state["file-1"]?.uploadStatus).toBe("done")
      expect(state["file-1"]?.localHash).toBe("updated-hash")
    } finally {
      await shutdown()
    }
  })
})
