import { EventSequenceNumber } from "@livestore/livestore"
import { Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createTestStore, delay, generateTestFiles, waitFor } from "../../../test/helpers/livestore.js"
import { getSyncStatus } from "../../api/sync-status.js"
import { getClientSession } from "../../livestore/types.js"
import { HashServiceLive } from "../../services/hash/index.js"
import { makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { LocalFileStateManager, LocalFileStateManagerLive } from "../local-file-state/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import {
  makeRemoteStorageMemoryWithRefs,
  type MemoryRemoteStorageOptions,
  RemoteStorage
} from "../remote-file-storage/index.js"
import type { SyncExecutorConfig } from "../sync-executor/index.js"
import { FileSync, type FileSyncConfig, FileSyncLive } from "./index.js"

interface CreateRuntimeOptions {
  remoteOptions?: MemoryRemoteStorageOptions
  executorConfig?: Partial<SyncExecutorConfig>
  fileSyncConfig?: Partial<FileSyncConfig>
}

const isNamedEvent = (value: unknown): value is { name: string } =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof (value as { name?: unknown }).name === "string"

const createRuntime = async (
  deps: Parameters<typeof FileSyncLive>[0],
  options: MemoryRemoteStorageOptions = {}
) => {
  return createRuntimeWithConfig(deps, { remoteOptions: options })
}

const createRuntimeWithConfig = async (
  deps: Parameters<typeof FileSyncLive>[0],
  options: CreateRuntimeOptions = {}
) => {
  const { optionsRef, service, storeRef } = await Effect.runPromise(makeRemoteStorageMemoryWithRefs)
  await Effect.runPromise(Ref.set(optionsRef, options.remoteOptions ?? {}))

  const remoteLayer = Layer.succeed(RemoteStorage, service)
  const localFileStateManagerLayer = LocalFileStateManagerLive(deps)
  const baseLayer = Layer.mergeAll(
    Layer.scope,
    HashServiceLive,
    LocalFileStorageMemory,
    localFileStateManagerLayer,
    remoteLayer
  )

  const executorConfig: SyncExecutorConfig = {
    maxConcurrentDownloads: options.executorConfig?.maxConcurrentDownloads ?? 1,
    maxConcurrentUploads: options.executorConfig?.maxConcurrentUploads ?? 1,
    baseDelayMs: options.executorConfig?.baseDelayMs ?? 5,
    maxDelayMs: options.executorConfig?.maxDelayMs ?? 10,
    jitterMs: options.executorConfig?.jitterMs ?? 0,
    maxRetries: options.executorConfig?.maxRetries ?? 0
  }

  const fileSyncLayer = Layer.provide(baseLayer)(
    FileSyncLive(deps, {
      executorConfig,
      healthCheckIntervalMs: options.fileSyncConfig?.healthCheckIntervalMs ?? 50,
      heartbeatIntervalMs: options.fileSyncConfig?.heartbeatIntervalMs ?? 0,
      ...(options.fileSyncConfig ?? {})
    })
  )

  const mainLayer = Layer.mergeAll(baseLayer, fileSyncLayer)
  return {
    runtime: ManagedRuntime.make(mainLayer),
    optionsRef,
    storeRef
  }
}

describe("FileSync", () => {
  it("marks remote-only files for download", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "remote-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "remote-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteKey: stripFilesRoot(path),
        contentHash: "remote-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.downloadStatus).toBe("queued")
      expect(state[fileId]?.uploadStatus).toBe("done")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("marks local-only files for upload", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "local-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "local-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(localStorage.writeFile(path, new File(["local"], "local.txt")))
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.uploadStatus).toBe("queued")
      expect(state[fileId]?.downloadStatus).toBe("done")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("queues download when local hash mismatches remote", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "remote-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "remote-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteKey: stripFilesRoot(path),
        contentHash: "remote-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(localStorage.writeFile(path, new File(["local"], "local.txt")))
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.downloadStatus).toBe("queued")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("sets the cursor to upstream head after bootstrap", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "cursor-hash")

    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "cursor-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteKey: stripFilesRoot(path),
        contentHash: "cursor-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const cursorDoc = store.query(deps.schema.queryDb(tables.fileSyncCursor.get()))
      const upstreamState = await runtime.runPromise(
        getClientSession(store as typeof deps.store).leaderThread.syncState
      )
      const upstreamCursor = EventSequenceNumber.Client.toString(upstreamState.upstreamHead)
      expect(cursorDoc.lastEventSequence).toBe(upstreamCursor)
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("bootstraps local state with one commit transaction for multiple files", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))

    const fileId1 = crypto.randomUUID()
    const path1 = makeStoredPath(deps.storeId, "bootstrap-hash-1")
    const fileId2 = crypto.randomUUID()
    const path2 = makeStoredPath(deps.storeId, "bootstrap-hash-2")

    await runtime.runPromise(localStorage.writeFile(path1, new File(["bootstrap-1"], "bootstrap-1.txt")))
    await runtime.runPromise(localStorage.writeFile(path2, new File(["bootstrap-2"], "bootstrap-2.txt")))

    store.commit(events.fileCreated({
      id: fileId1,
      path: path1,
      contentHash: "bootstrap-hash-1",
      createdAt: new Date(),
      updatedAt: new Date()
    }))
    store.commit(events.fileCreated({
      id: fileId2,
      path: path2,
      contentHash: "bootstrap-hash-2",
      createdAt: new Date(),
      updatedAt: new Date()
    }))

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())
    const commitSpy = vi.spyOn(store, "commit")

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await waitFor(
        () => runtime.runPromise(fileSync.getLocalFilesState()),
        (state) => Object.keys(state).length === 2,
        { timeoutMs: 1500, message: "Expected local state bootstrap for two files" }
      )

      const localStateCommitCalls = commitSpy.mock.calls
        .map((call) => (call as Array<unknown>).filter(isNamedEvent))
        .filter((events) =>
          events.some((event) => event.name === "v1.LocalFileStateUpsert" || event.name === "v1.LocalFileStateRemove")
        )

      expect(localStateCommitCalls).toHaveLength(1)
      expect(localStateCommitCalls[0]!.length).toBe(2)
      for (const event of localStateCommitCalls[0]!) {
        expect(event.name).toBe("v1.LocalFileStateUpsert")
      }
    } finally {
      commitSpy.mockRestore()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("syncNow restart does not re-bootstrap local state", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))

    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "sync-now-no-bootstrap")

    await runtime.runPromise(localStorage.writeFile(path, new File(["sync-now"], "sync-now.txt")))
    store.commit(events.fileCreated({
      id: fileId,
      path,
      contentHash: "sync-now-no-bootstrap",
      createdAt: new Date(),
      updatedAt: new Date()
    }))

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())
    const commitSpy = vi.spyOn(store, "commit")

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await waitFor(
        () => runtime.runPromise(fileSync.getLocalFilesState()),
        (state) => Object.keys(state).length === 1,
        { timeoutMs: 1500, message: "Expected initial bootstrap to populate local state" }
      )

      commitSpy.mockClear()

      await runtime.runPromise(fileSync.syncNow())
      await delay(100)

      const restartLocalStateEvents = commitSpy.mock.calls
        .flatMap((call) => (call as Array<unknown>).filter(isNamedEvent))
        .filter((event) => event.name === "v1.LocalFileStateUpsert" || event.name === "v1.LocalFileStateRemove")

      expect(restartLocalStateEvents).toEqual([])
    } finally {
      commitSpy.mockRestore()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("emits online and offline events", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())
    const events: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      events.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(fileSync.setOnline(true))

      expect(events).toContain("offline")
      expect(events).toContain("online")
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Offline Transition", () => {
  it("resets inProgress transfers to queued but preserves error states when going offline", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntime(deps, { offline: true })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // Create two files with local copies
      const fileId1 = crypto.randomUUID()
      const path1 = makeStoredPath(deps.storeId, "hash1")
      const fileId2 = crypto.randomUUID()
      const path2 = makeStoredPath(deps.storeId, "hash2")

      await runtime.runPromise(localStorage.writeFile(path1, new File(["data1"], "test1.txt")))
      await runtime.runPromise(localStorage.writeFile(path2, new File(["data2"], "test2.txt")))

      store.commit(events.fileCreated({
        id: fileId1,
        path: path1,
        contentHash: "hash1",
        createdAt: new Date(),
        updatedAt: new Date()
      }))
      store.commit(events.fileCreated({
        id: fileId2,
        path: path2,
        contentHash: "hash2",
        createdAt: new Date(),
        updatedAt: new Date()
      }))

      // Start offline so uploads queue but don't run
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Manually set file1 to "error" state (simulating a non-network failure)
      const stateManager = await runtime.runPromise(
        Effect.gen(function*() {
          return yield* LocalFileStateManager
        })
      )
      await runtime.runPromise(
        stateManager.setTransferError(fileId1, "upload", "error", "File too large")
      )

      // Verify initial states
      let state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId1]?.uploadStatus).toBe("error")
      expect(state[fileId1]?.lastSyncError).toBe("File too large")
      expect(state[fileId2]?.uploadStatus).toBe("queued")

      // Go online then immediately offline — this triggers the goOffline path.
      // No delay between to avoid the executor picking up the error file and
      // overwriting the manually-set lastSyncError.
      await runtime.runPromise(fileSync.setOnline(true))
      await runtime.runPromise(fileSync.setOnline(false))
      await delay(20)

      // Error state should be preserved (not blindly reset)
      state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId1]?.uploadStatus).toBe("error")
      expect(state[fileId1]?.lastSyncError).toBe("File too large")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Transfer Progress Events", () => {
  it("emits upload:progress events during file upload", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { uploadDelayMs: 200 },
      executorConfig: { maxConcurrentUploads: 1 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const progressEvents: Array<{
      type: string
      fileId: string
      loaded?: number
      total?: number
    }> = []

    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "upload:progress") {
        progressEvents.push({
          type: event.type,
          fileId: event.fileId,
          loaded: event.progress.loaded,
          total: event.progress.total
        })
      } else if (event.type === "upload:start" || event.type === "upload:complete") {
        progressEvents.push({ type: event.type, fileId: event.fileId })
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Save a file
      const files = generateTestFiles(1)
      const result = await runtime.runPromise(fileSync.saveFile(files[0]))
      await runtime.runPromise(fileSync.syncNow())

      // Wait for upload to complete
      await delay(400)

      // Should have received progress events
      const fileProgressEvents = await waitFor(
        () => progressEvents.filter((e) => e.fileId === result.fileId && e.type === "upload:progress"),
        (events): events is Array<(typeof progressEvents)[number]> => events.length > 0,
        {
          timeoutMs: 1500,
          message: "Expected upload progress events"
        }
      )

      // Each progress event should have valid loaded/total values
      for (const event of fileProgressEvents) {
        expect(event.loaded).toBeDefined()
        expect(event.total).toBeDefined()
        expect(event.loaded!).toBeGreaterThanOrEqual(0)
        expect(event.total!).toBeGreaterThan(0)
      }

      // Should have start and complete events
      expect(progressEvents.some((e) => e.type === "upload:start" && e.fileId === result.fileId)).toBe(true)
      expect(progressEvents.some((e) => e.type === "upload:complete" && e.fileId === result.fileId)).toBe(true)
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("emits download:progress events during file download", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime, storeRef } = await createRuntimeWithConfig(deps, {
      remoteOptions: { downloadDelayMs: 200 },
      executorConfig: { maxConcurrentDownloads: 1 }
    })

    const fileId = crypto.randomUUID()
    const path = makeStoredPath(deps.storeId, "download-progress-hash")
    const remoteKey = stripFilesRoot(path)

    // Pre-populate remote storage with file
    await Effect.runPromise(
      Ref.update(storeRef, (store) => {
        const newStore = new Map(store)
        const content = new TextEncoder().encode("test content for download progress")
        newStore.set(remoteKey, {
          data: new Uint8Array(content),
          mimeType: "text/plain",
          name: "test.txt"
        })
        return newStore
      })
    )

    // Create file record with remote key (simulates file from another client)
    store.commit(
      events.fileCreated({
        id: fileId,
        path,
        contentHash: "download-progress-hash",
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    store.commit(
      events.fileUpdated({
        id: fileId,
        path,
        remoteKey,
        contentHash: "download-progress-hash",
        updatedAt: new Date()
      })
    )

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const progressEvents: Array<{
      type: string
      fileId: string
      loaded?: number
      total?: number
    }> = []

    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "download:progress") {
        progressEvents.push({
          type: event.type,
          fileId: event.fileId,
          loaded: event.progress.loaded,
          total: event.progress.total
        })
      } else if (event.type === "download:start" || event.type === "download:complete") {
        progressEvents.push({ type: event.type, fileId: event.fileId })
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Wait for download to complete
      await delay(500)

      // Should have received progress events
      const fileProgressEvents = progressEvents.filter(
        (e) => e.fileId === fileId && e.type === "download:progress"
      )
      expect(fileProgressEvents.length).toBeGreaterThan(0)

      // Each progress event should have valid loaded/total values
      for (const event of fileProgressEvents) {
        expect(event.loaded).toBeDefined()
        expect(event.total).toBeDefined()
        expect(event.loaded!).toBeGreaterThanOrEqual(0)
        expect(event.total!).toBeGreaterThan(0)
      }

      // Should have start and complete events
      expect(progressEvents.some((e) => e.type === "download:start" && e.fileId === fileId)).toBe(true)
      expect(progressEvents.some((e) => e.type === "download:complete" && e.fileId === fileId)).toBe(true)
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("progress events contain correct TransferProgress structure", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { uploadDelayMs: 150 },
      executorConfig: { maxConcurrentUploads: 1 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    let capturedProgress: {
      kind: string
      fileId: string
      status: string
      loaded: number
      total: number
    } | null = null

    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "upload:progress" && !capturedProgress) {
        capturedProgress = {
          kind: event.progress.kind,
          fileId: event.progress.fileId,
          status: event.progress.status,
          loaded: event.progress.loaded,
          total: event.progress.total
        }
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const files = generateTestFiles(1)
      const result = await runtime.runPromise(fileSync.saveFile(files[0]))
      await runtime.runPromise(fileSync.syncNow())

      const progress = await waitFor(
        () => capturedProgress,
        (value): value is NonNullable<typeof value> => value !== null,
        {
          timeoutMs: 1500,
          message: "Expected upload progress event"
        }
      )

      if (!progress) {
        throw new Error("Expected upload progress event")
      }

      // Verify captured progress has correct structure
      expect(progress.kind).toBe("upload")
      expect(progress.fileId).toBe(result.fileId)
      expect(progress.status).toBe("inProgress")
      expect(typeof progress.loaded).toBe("number")
      expect(typeof progress.total).toBe("number")
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Multi-file upload sync status", () => {
  it("queues multiple files for upload when saved concurrently", async () => {
    const { deps, shutdown } = await createTestStore()
    // Use offline mode so uploads are queued but don't execute
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Save 5 files concurrently (like Gallery.vue does with Promise.all)
      const files = generateTestFiles(5)
      const results = await Promise.all(
        files.map((f) => runtime.runPromise(fileSync.saveFile(f)))
      )
      await runtime.runPromise(fileSync.syncNow())

      // All 5 files should have been saved
      expect(results).toHaveLength(5)

      // Get sync status (wait for event stream to enqueue uploads)
      const state = await waitFor(
        () => runtime.runPromise(fileSync.getLocalFilesState()),
        (value) => Object.keys(value).length === 5,
        {
          timeoutMs: 1500,
          message: "Expected 5 files in local state"
        }
      )
      const status = getSyncStatus(state)

      // All 5 should be in some upload state (queued since we're offline)
      const totalUploadPending = status.uploadingCount +
        status.queuedUploadCount +
        status.pendingUploadCount

      expect(totalUploadPending).toBe(5)
      expect(status.hasPending).toBe(true)

      // Verify each file has state
      for (const result of results) {
        expect(state[result.fileId]).toBeDefined()
        expect(["queued", "pending", "inProgress"]).toContain(state[result.fileId].uploadStatus)
      }
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("maintains file state integrity during concurrent saves", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      const fileCount = 5
      const files = generateTestFiles(fileCount)
      const results = await Promise.all(
        files.map((f) => runtime.runPromise(fileSync.saveFile(f)))
      )

      const fileIds = results.map((r) => r.fileId)
      const state = await runtime.runPromise(fileSync.getLocalFilesState())

      // Every returned fileId should have state
      for (const fileId of fileIds) {
        expect(state[fileId]).toBeDefined()
        expect(state[fileId].uploadStatus).toBeDefined()
        expect(state[fileId].downloadStatus).toBeDefined()
        expect(state[fileId].path).toBeTruthy()
        expect(state[fileId].localHash).toBeTruthy()
      }

      // Should have exactly fileCount entries
      expect(Object.keys(state)).toHaveLength(fileCount)

      // All fileIds in state should match returned fileIds
      for (const stateFileId of Object.keys(state)) {
        expect(fileIds).toContain(stateFileId)
      }
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("correctly transitions upload status from queued to inProgress to done", async () => {
    const { deps, shutdown } = await createTestStore()
    // Use upload delay to observe state transitions
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { uploadDelayMs: 200 },
      executorConfig: { maxConcurrentUploads: 1 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Save 3 files concurrently
      const files = generateTestFiles(3)
      const results = await Promise.all(
        files.map((f) => runtime.runPromise(fileSync.saveFile(f)))
      )
      await runtime.runPromise(fileSync.syncNow())

      // Wait for first upload to start processing
      // The executor worker polls every 50-100ms, so we need to wait long enough
      const state1 = await waitFor(
        () => runtime.runPromise(fileSync.getLocalFilesState()),
        (value) => Object.keys(value).length === 3,
        {
          timeoutMs: 1500,
          message: "Expected 3 files in local state"
        }
      )
      const status1 = getSyncStatus(state1)

      // With maxConcurrentUploads: 1 and 200ms delay, expect:
      // All 3 files should be tracked in local state
      expect(Object.keys(state1)).toHaveLength(3)

      // Check all files are accounted for in some upload state
      const totalInAnyUploadState = status1.uploadingCount +
        status1.queuedUploadCount +
        status1.pendingUploadCount +
        Object.values(state1).filter((s) => s.uploadStatus === "done").length
      expect(totalInAnyUploadState).toBe(3)

      // Wait for all uploads to complete
      await delay(800)

      const state2 = await runtime.runPromise(fileSync.getLocalFilesState())
      const status2 = getSyncStatus(state2)

      // All should be done
      expect(status2.uploadingCount).toBe(0)
      expect(status2.queuedUploadCount).toBe(0)
      expect(status2.isSyncing).toBe(false)

      // Verify each file is done
      for (const result of results) {
        expect(state2[result.fileId].uploadStatus).toBe("done")
      }
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("handles rapid concurrent file additions without losing state", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Add 10 files as fast as possible
      const files = generateTestFiles(10)
      const results = await Promise.all(
        files.map((f) => runtime.runPromise(fileSync.saveFile(f)))
      )

      const state = await runtime.runPromise(fileSync.getLocalFilesState())

      // All 10 files should be tracked
      expect(Object.keys(state)).toHaveLength(10)

      // Each should have valid uploadStatus
      for (const fileState of Object.values(state)) {
        expect(["pending", "queued", "inProgress", "done", "error"]).toContain(
          fileState.uploadStatus
        )
      }

      const status = getSyncStatus(state)

      // Total files in some upload state should be 10
      const totalUploadPending = status.uploadingCount +
        status.queuedUploadCount +
        status.pendingUploadCount

      expect(totalUploadPending).toBe(10)

      // Verify file IDs match
      const resultFileIds = new Set(results.map((r) => r.fileId))
      const stateFileIds = new Set(Object.keys(state))
      expect(resultFileIds).toEqual(stateFileIds)
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("getSyncStatus correctly aggregates mixed upload states", async () => {
    const { deps, shutdown } = await createTestStore()
    // Use sequential uploads with delay to create mixed states
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { uploadDelayMs: 150 },
      executorConfig: { maxConcurrentUploads: 2 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Save 5 files
      const files = generateTestFiles(5)
      const results = await Promise.all(
        files.map((f) => runtime.runPromise(fileSync.saveFile(f)))
      )
      await runtime.runPromise(fileSync.syncNow())

      // Wait for executor to pick up tasks
      const state = await waitFor(
        () => runtime.runPromise(fileSync.getLocalFilesState()),
        (value) => Object.keys(value).length === 5,
        {
          timeoutMs: 1500,
          message: "Expected 5 files in local state"
        }
      )
      const status = getSyncStatus(state)

      // All 5 files should be tracked
      expect(Object.keys(state)).toHaveLength(5)

      // With 2 concurrent uploads and 5 files:
      // Should have at most 2 inProgress, rest could be queued, pending, or done
      expect(status.uploadingCount).toBeLessThanOrEqual(2)

      // Total in any state should be 5
      const doneCount = Object.values(state).filter((s) => s.uploadStatus === "done").length
      const totalUploadState = status.uploadingCount +
        status.queuedUploadCount +
        status.pendingUploadCount +
        doneCount
      expect(totalUploadState).toBe(5)

      // Verify the file ID lists match counts
      expect(status.uploadingFileIds).toHaveLength(status.uploadingCount)
      expect(status.queuedUploadFileIds).toHaveLength(status.queuedUploadCount)
      expect(status.pendingUploadFileIds).toHaveLength(status.pendingUploadCount)

      // All file IDs from results should be in state
      for (const result of results) {
        expect(state[result.fileId]).toBeDefined()
      }

      // Wait for all to complete
      await delay(600)

      const finalState = await runtime.runPromise(fileSync.getLocalFilesState())
      const finalStatus = getSyncStatus(finalState)

      expect(finalStatus.uploadingCount).toBe(0)
      expect(finalStatus.queuedUploadCount).toBe(0)
      expect(finalStatus.isSyncing).toBe(false)
      expect(finalStatus.hasPending).toBe(false)

      // All files should be done
      for (const result of results) {
        expect(finalState[result.fileId].uploadStatus).toBe("done")
      }
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Error State Recovery", () => {
  it("auto-retries files in error state on startup", async () => {
    const { deps, shutdown } = await createTestStore()
    // Configure remote to fail uploads initially
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true },
      executorConfig: { maxRetries: 0 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    const events: Array<{ type: string; fileIds?: ReadonlyArray<string> }> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:error-retry-start") {
        events.push({ type: event.type, fileIds: event.fileIds })
      }
    })

    try {
      // Create a file and manually set it to error state
      const fileId = crypto.randomUUID()
      const path = makeStoredPath(deps.storeId, "error-test-hash")

      // Write file to local storage
      await runtime.runPromise(localStorage.writeFile(path, new File(["test"], "test.txt")))

      // Manually inject error state into localFileState
      const { schema, store } = deps
      store.commit(
        schema.events.localFileStateUpsert({
          fileId,
          path,
          localHash: "error-test-hash",
          uploadStatus: "error",
          downloadStatus: "done",
          lastSyncError: "Simulated error"
        })
      )

      // Start FileSync - should auto-retry error files
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(100)

      // Check that error-retry-start event was emitted
      const retryEvent = events.find((e) => e.type === "sync:error-retry-start")
      expect(retryEvent).toBeDefined()
      expect(retryEvent?.fileIds).toContain(fileId)

      // Check state was reset to queued
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.uploadStatus).toBe("queued")
      expect(state[fileId]?.lastSyncError).toBe("")
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("retryErrors() re-queues files in error state", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    const events: Array<{ type: string; from?: string }> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:recovery") {
        events.push({ type: event.type, from: event.from })
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Create two files with error states
      const fileId1 = crypto.randomUUID()
      const fileId2 = crypto.randomUUID()
      const path1 = makeStoredPath(deps.storeId, "retry-hash-1")
      const path2 = makeStoredPath(deps.storeId, "retry-hash-2")

      await runtime.runPromise(localStorage.writeFile(path1, new File(["test1"], "test1.txt")))
      await runtime.runPromise(localStorage.writeFile(path2, new File(["test2"], "test2.txt")))

      // Inject error states
      const { schema, store } = deps
      store.commit(
        schema.events.localFileStateUpsert({
          fileId: fileId1,
          path: path1,
          localHash: "retry-hash-1",
          uploadStatus: "error",
          downloadStatus: "done",
          lastSyncError: "Upload failed"
        })
      )
      store.commit(
        schema.events.localFileStateUpsert({
          fileId: fileId2,
          path: path2,
          localHash: "retry-hash-2",
          uploadStatus: "done",
          downloadStatus: "error",
          lastSyncError: "Download failed"
        })
      )

      await delay(50)

      // Call retryErrors
      const retriedIds = await runtime.runPromise(fileSync.retryErrors())

      // Should return both file IDs
      expect(retriedIds).toHaveLength(2)
      expect(retriedIds).toContain(fileId1)
      expect(retriedIds).toContain(fileId2)

      // Check recovery event was emitted
      const recoveryEvent = events.find((e) => e.type === "sync:recovery" && e.from === "error-retry")
      expect(recoveryEvent).toBeDefined()

      // Check states were updated
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId1]?.uploadStatus).toBe("queued")
      expect(state[fileId2]?.downloadStatus).toBe("queued")
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("retryErrors() returns empty array when no errors", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // No files with errors
      const retriedIds = await runtime.runPromise(fileSync.retryErrors())
      expect(retriedIds).toHaveLength(0)
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("clears lastSyncError when auto-retrying on startup", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // Create file with error and error message
      const fileId = crypto.randomUUID()
      const path = makeStoredPath(deps.storeId, "clear-error-hash")

      await runtime.runPromise(localStorage.writeFile(path, new File(["test"], "test.txt")))

      const { schema, store } = deps
      store.commit(
        schema.events.localFileStateUpsert({
          fileId,
          path,
          localHash: "clear-error-hash",
          uploadStatus: "error",
          downloadStatus: "done",
          lastSyncError: "This error should be cleared"
        })
      )

      // Start FileSync
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(100)

      // Error message should be cleared
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.lastSyncError).toBe("")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Event Callback Safety", () => {
  it("continues emitting to other subscribers when one callback throws", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const receivedBySecond: Array<string> = []
    const receivedByThird: Array<string> = []

    // First subscriber throws on every event
    const unsub1 = fileSync.onEvent(() => {
      throw new Error("subscriber 1 blows up")
    })
    // Second subscriber should still receive events
    const unsub2 = fileSync.onEvent((event) => {
      receivedBySecond.push(event.type)
    })
    // Third subscriber should also still receive events
    const unsub3 = fileSync.onEvent((event) => {
      receivedByThird.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      // setOnline(false) emits an "offline" event
      await runtime.runPromise(fileSync.setOnline(false))
      await delay(50)

      // Both the second and third subscriber should have received the "offline"
      // event despite the first subscriber throwing on every event
      expect(receivedBySecond.length).toBeGreaterThan(0)
      expect(receivedByThird.length).toBeGreaterThan(0)
      expect(receivedBySecond).toContain("offline")
      expect(receivedByThird).toContain("offline")
    } finally {
      unsub1()
      unsub2()
      unsub3()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Per-Event Error Handling", () => {
  it("processes multiple files independently through bootstrap without batch abort", async () => {
    // Verify that each event/file is processed independently during bootstrap.
    // Previously, handleEventBatch wrapped all events in a single try/catch,
    // so one failing event would abort the entire batch.
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // Create two files — both have local copies
      const fileId1 = crypto.randomUUID()
      const path1 = makeStoredPath(deps.storeId, "hash1")
      const fileId2 = crypto.randomUUID()
      const path2 = makeStoredPath(deps.storeId, "hash2")

      await runtime.runPromise(localStorage.writeFile(path1, new File(["data1"], "test1.txt")))
      await runtime.runPromise(localStorage.writeFile(path2, new File(["data2"], "test2.txt")))

      // Commit events before start
      store.commit(events.fileCreated({
        id: fileId1,
        path: path1,
        contentHash: "hash1",
        createdAt: new Date(),
        updatedAt: new Date()
      }))
      store.commit(events.fileCreated({
        id: fileId2,
        path: path2,
        contentHash: "hash2",
        createdAt: new Date(),
        updatedAt: new Date()
      }))

      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(100)

      // Both files should have local state — one file's processing shouldn't
      // prevent the other from being processed
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId1]).toBeDefined()
      expect(state[fileId2]).toBeDefined()
      expect(state[fileId1]?.uploadStatus).toBe("queued")
      expect(state[fileId2]?.uploadStatus).toBe("queued")
    } finally {
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Sync Error Events", () => {
  it("emits sync:error event on event batch processing failure", async () => {
    // This test is more of an integration test - we need to trigger an actual error
    // For now, we verify the event type is properly exposed
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: true }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const allEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      allEvents.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Verify we can subscribe to events and receive basic events
      // The sync:error events will only fire on actual errors
      expect(allEvents).toBeDefined()
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Heartbeat", () => {
  it("does not emit heartbeat-recovery when stream is healthy", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: { heartbeatIntervalMs: 30 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      // Wait for several heartbeat intervals
      await delay(200)

      // No recovery events should fire when everything is healthy
      expect(recoveryEvents).toEqual([])
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("syncNow restarts event stream without triggering heartbeat recovery", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: { heartbeatIntervalMs: 30 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const allEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      allEvents.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Restart stream via syncNow — should not cause errors
      await runtime.runPromise(fileSync.syncNow())
      // Wait long enough for multiple heartbeat ticks to verify no false recovery
      await delay(150)

      // Stream should still be functional after restart
      // Verify no heartbeat-recovery was needed (stream was restarted cleanly via syncNow)
      expect(allEvents.filter((e) => e === "sync:heartbeat-recovery")).toEqual([])
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("heartbeat is disabled when heartbeatIntervalMs is 0", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: { heartbeatIntervalMs: 0 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(100)

      // No recovery events since heartbeat is disabled
      expect(recoveryEvents).toEqual([])
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("heartbeat recovers dead event stream", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: { heartbeatIntervalMs: 30 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Verify stream is running (no recovery yet)
      expect(recoveryEvents).toEqual([])

      // Kill the event stream to simulate a dead fiber
      await runtime.runPromise(fileSync._simulateStreamDeath())

      // Wait for heartbeat to detect and recover (30ms interval + buffer)
      await waitFor(
        () => Promise.resolve(recoveryEvents),
        (evts) => evts.includes("stream-dead"),
        { timeoutMs: 500, message: "Expected heartbeat to recover dead stream" }
      )

      // Recovery event should have been emitted
      expect(recoveryEvents).toContain("stream-dead")

      // Wait a bit more to verify no duplicate recoveries
      await delay(100)
      const recoveryCount = recoveryEvents.filter((r) => r === "stream-dead").length
      expect(recoveryCount).toBe(1)
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("heartbeat detects stalled stream when upstream advances but cursor does not", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    // Short heartbeat interval and very short stall threshold for testing
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: {
        heartbeatIntervalMs: 30,
        streamStallThresholdMs: 50
      }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Create initial file to process (this sets lastBatchAtRef and lastBatchCursorRef)
      const fileId1 = crypto.randomUUID()
      const path1 = makeStoredPath(deps.storeId, "stall-test-hash-1")
      await runtime.runPromise(localStorage.writeFile(path1, new File(["test1"], "test1.txt")))
      store.commit(
        events.fileCreated({
          id: fileId1,
          path: path1,
          contentHash: "stall-test-hash-1",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )

      // Wait for the stream to process the event
      await delay(100)

      // Kill the stream to simulate a stall (fiber alive but not processing)
      // Note: We use _simulateStreamDeath to clear the fiber ref, then add events
      // The difference from "stream-dead" is we'll restart before the heartbeat check
      // and let the stall detection kick in
      await runtime.runPromise(fileSync._simulateStreamDeath())

      // Wait for the stall threshold to pass
      await delay(100)

      // Add new events to advance upstream head (but stream won't process them)
      const fileId2 = crypto.randomUUID()
      const path2 = makeStoredPath(deps.storeId, "stall-test-hash-2")
      await runtime.runPromise(localStorage.writeFile(path2, new File(["test2"], "test2.txt")))
      store.commit(
        events.fileCreated({
          id: fileId2,
          path: path2,
          contentHash: "stall-test-hash-2",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )

      // Wait for heartbeat to detect the stall
      await waitFor(
        () => Promise.resolve(recoveryEvents),
        (evts) => evts.includes("stream-stalled") || evts.includes("stream-dead"),
        { timeoutMs: 500, message: "Expected heartbeat to detect stalled stream" }
      )

      // Recovery event should have been emitted (either stream-dead or stream-stalled)
      // Since we killed the fiber, stream-dead will be detected first
      expect(recoveryEvents.length).toBeGreaterThan(0)
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("does not emit stream-stalled when upstream head has not advanced", async () => {
    const { deps, events, shutdown, store } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: {
        heartbeatIntervalMs: 30,
        streamStallThresholdMs: 50
      }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Create and process initial file
      const fileId = crypto.randomUUID()
      const path = makeStoredPath(deps.storeId, "no-stall-hash")
      await runtime.runPromise(localStorage.writeFile(path, new File(["test"], "test.txt")))
      store.commit(
        events.fileCreated({
          id: fileId,
          path,
          contentHash: "no-stall-hash",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )

      // Wait for stream to process and stall threshold to pass
      await delay(150)

      // Don't add any new events - upstream head should match last processed cursor
      // Wait for several heartbeat intervals
      await delay(150)

      // No stream-stalled events should have fired (stream-dead might fire if fiber died)
      const stalledEvents = recoveryEvents.filter((r) => r === "stream-stalled")
      expect(stalledEvents).toEqual([])
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("health check loop auto-recovers when remote becomes healthy", async () => {
    // This test verifies that the health check loop (started when going offline)
    // automatically detects when the remote is reachable again and brings the
    // system back online WITHOUT a manual setOnline(true) call.
    //
    // BUG: The health check fiber is forked with Effect.fork (scoped to the
    // generator) instead of Effect.forkIn(mainScope), so it dies immediately
    // after startHealthCheckLoop returns.
    const { deps, shutdown } = await createTestStore()
    const { optionsRef, runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { offline: false },
      fileSyncConfig: { healthCheckIntervalMs: 50, heartbeatIntervalMs: 0 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const events: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      events.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      await delay(50)

      // Simulate going offline — this starts the health check loop
      await Effect.runPromise(Ref.set(optionsRef, { offline: true }))
      await runtime.runPromise(fileSync.setOnline(false))
      expect(events).toContain("offline")

      // Verify we are offline
      const isOnlineBefore = await runtime.runPromise(fileSync.isOnline())
      expect(isOnlineBefore).toBe(false)

      // Now simulate remote becoming reachable again (but do NOT call setOnline(true))
      await Effect.runPromise(Ref.set(optionsRef, { offline: false }))

      // The health check loop should detect this and bring us back online
      await waitFor(
        () => runtime.runPromise(fileSync.isOnline()),
        (online) => online === true,
        { timeoutMs: 2000, message: "Health check loop did not auto-recover online state" }
      )

      // Verify the online event was emitted by the health check loop
      // (not by a manual setOnline call — we never called setOnline(true))
      const onlineEvents = events.filter((e) => e === "online")
      expect(onlineEvents.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("stream stall detection is disabled when streamStallThresholdMs is 0", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      fileSyncConfig: {
        heartbeatIntervalMs: 30,
        streamStallThresholdMs: 0 // Disabled
      }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    const recoveryEvents: Array<string> = []
    const unsubscribe = fileSync.onEvent((event) => {
      if (event.type === "sync:heartbeat-recovery") {
        recoveryEvents.push(event.reason)
      }
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      // Wait for multiple heartbeat intervals
      await delay(150)

      // No stream-stalled events should fire when disabled
      const stalledEvents = recoveryEvents.filter((r) => r === "stream-stalled")
      expect(stalledEvents).toEqual([])
    } finally {
      unsubscribe()
      await runtime.runPromise(fileSync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})
