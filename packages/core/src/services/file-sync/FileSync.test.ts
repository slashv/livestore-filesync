import { Effect, Exit, Layer, ManagedRuntime, Ref, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore, generateTestFiles, delay } from "../../../test/helpers/livestore.js"
import { makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { getSyncStatus } from "../../api/sync-status.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { LocalFileStateManagerLive } from "../local-file-state/index.js"
import {
  makeRemoteStorageMemoryWithRefs,
  RemoteStorage,
  type MemoryRemoteStorageOptions
} from "../remote-file-storage/index.js"
import { FileSync, FileSyncLive, type FileSyncConfig } from "./index.js"
import { FileStorage, FileStorageLive } from "../file-storage/index.js"
import type { SyncExecutorConfig } from "../sync-executor/index.js"

interface CreateRuntimeOptions {
  remoteOptions?: MemoryRemoteStorageOptions
  executorConfig?: Partial<SyncExecutorConfig>
  fileSyncConfig?: Partial<FileSyncConfig>
}

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
  const { service, optionsRef, storeRef } = await Effect.runPromise(makeRemoteStorageMemoryWithRefs)
  await Effect.runPromise(Ref.set(optionsRef, options.remoteOptions ?? {}))

  const remoteLayer = Layer.succeed(RemoteStorage, service)
  const localFileStateManagerLayer = LocalFileStateManagerLive(deps)
  const baseLayer = Layer.mergeAll(Layer.scope, LocalFileStorageMemory, localFileStateManagerLayer, remoteLayer)
  
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
      gcDelayMs: options.fileSyncConfig?.gcDelayMs ?? 10
    })
  )
  
  const fileStorageLayer = Layer.provide(Layer.mergeAll(baseLayer, fileSyncLayer))(
    FileStorageLive(deps)
  )

  const mainLayer = Layer.mergeAll(baseLayer, fileSyncLayer, fileStorageLayer)
  return { 
    runtime: ManagedRuntime.make(mainLayer),
    optionsRef,
    storeRef
  }
}

describe("FileSync", () => {
  it("marks remote-only files for download", async () => {
    const { deps, store, events, shutdown } = await createTestStore()
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
    const { deps, store, events, shutdown } = await createTestStore()
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
    const { deps, store, events, shutdown } = await createTestStore()
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

      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      expect(state[fileId]?.downloadStatus).toBe("queued")
    } finally {
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
    const events: string[] = []
    const unsubscribe = fileSync.onEvent((event) => {
      events.push(event.type)
    })

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
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

describe("FileSync - Transfer Progress Events", () => {
  it("emits upload:progress events during file upload", async () => {
    const { deps, shutdown } = await createTestStore()
    const { runtime } = await createRuntimeWithConfig(deps, {
      remoteOptions: { uploadDelayMs: 200 },
      executorConfig: { maxConcurrentUploads: 1 }
    })

    const fileSync = await runtime.runPromise(Effect.gen(function* () {
      return yield* FileSync
    }))
    const fileStorage = await runtime.runPromise(Effect.gen(function* () {
      return yield* FileStorage
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

      // Save a file
      const files = generateTestFiles(1)
      const result = await runtime.runPromise(fileStorage.saveFile(files[0]))

      // Wait for upload to complete
      await delay(400)

      // Should have received progress events
      const fileProgressEvents = progressEvents.filter(
        (e) => e.fileId === result.fileId && e.type === "upload:progress"
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
    const { deps, store, events, shutdown } = await createTestStore()
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

    const fileSync = await runtime.runPromise(Effect.gen(function* () {
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

    const fileSync = await runtime.runPromise(Effect.gen(function* () {
      return yield* FileSync
    }))
    const fileStorage = await runtime.runPromise(Effect.gen(function* () {
      return yield* FileStorage
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

      const files = generateTestFiles(1)
      const result = await runtime.runPromise(fileStorage.saveFile(files[0]))

      await delay(300)

      // Verify captured progress has correct structure
      expect(capturedProgress).not.toBeNull()
      expect(capturedProgress!.kind).toBe("upload")
      expect(capturedProgress!.fileId).toBe(result.fileId)
      expect(capturedProgress!.status).toBe("inProgress")
      expect(typeof capturedProgress!.loaded).toBe("number")
      expect(typeof capturedProgress!.total).toBe("number")
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
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      
      // Save 5 files concurrently (like Gallery.vue does with Promise.all)
      const files = generateTestFiles(5)
      const results = await Promise.all(
        files.map(f => runtime.runPromise(fileStorage.saveFile(f)))
      )
      
      // All 5 files should have been saved
      expect(results).toHaveLength(5)
      
      // Get sync status
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      const status = getSyncStatus(state)
      
      // All 5 should be in some upload state (queued since we're offline)
      const totalUploadPending = 
        status.uploadingCount + 
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
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      
      const fileCount = 5
      const files = generateTestFiles(fileCount)
      const results = await Promise.all(
        files.map(f => runtime.runPromise(fileStorage.saveFile(f)))
      )
      
      const fileIds = results.map(r => r.fileId)
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
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      
      // Save 3 files concurrently
      const files = generateTestFiles(3)
      const results = await Promise.all(
        files.map(f => runtime.runPromise(fileStorage.saveFile(f)))
      )
      
      // Wait for first upload to start processing
      // The executor worker polls every 50-100ms, so we need to wait long enough
      await delay(150)
      
      const state1 = await runtime.runPromise(fileSync.getLocalFilesState())
      const status1 = getSyncStatus(state1)
      
      // With maxConcurrentUploads: 1 and 200ms delay, expect:
      // All 3 files should be tracked in local state
      expect(Object.keys(state1)).toHaveLength(3)
      
      // Check all files are accounted for in some upload state
      const totalInAnyUploadState = 
        status1.uploadingCount + 
        status1.queuedUploadCount + 
        status1.pendingUploadCount +
        Object.values(state1).filter(s => s.uploadStatus === "done").length
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
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(fileSync.setOnline(false))
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      
      // Add 10 files as fast as possible
      const files = generateTestFiles(10)
      const results = await Promise.all(
        files.map(f => runtime.runPromise(fileStorage.saveFile(f)))
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
      const totalUploadPending = 
        status.uploadingCount + 
        status.queuedUploadCount + 
        status.pendingUploadCount
      
      expect(totalUploadPending).toBe(10)
      
      // Verify file IDs match
      const resultFileIds = new Set(results.map(r => r.fileId))
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
    const fileStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.start(), scope))
      
      // Save 5 files
      const files = generateTestFiles(5)
      const results = await Promise.all(
        files.map(f => runtime.runPromise(fileStorage.saveFile(f)))
      )
      
      // Wait for executor to pick up tasks
      await delay(100)
      
      const state = await runtime.runPromise(fileSync.getLocalFilesState())
      const status = getSyncStatus(state)
      
      // All 5 files should be tracked
      expect(Object.keys(state)).toHaveLength(5)
      
      // With 2 concurrent uploads and 5 files:
      // Should have at most 2 inProgress, rest could be queued, pending, or done
      expect(status.uploadingCount).toBeLessThanOrEqual(2)
      
      // Total in any state should be 5
      const doneCount = Object.values(state).filter(s => s.uploadStatus === "done").length
      const totalUploadState = 
        status.uploadingCount + 
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
