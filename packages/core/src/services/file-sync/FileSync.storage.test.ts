import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { createTestStore } from "../../../test/helpers/livestore.js"
import type { FileSyncConfig } from "../../services/file-sync/FileSync.js"
import { HashServiceLive } from "../../services/hash/index.js"
import type { PreprocessorMap } from "../../types/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { LocalFileStateManagerLive } from "../local-file-state/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { RemoteStorageMemory } from "../remote-file-storage/index.js"
import { FileSync, FileSyncLive } from "./index.js"

const createRuntime = (
  deps: Parameters<typeof FileSyncLive>[0],
  config?: Partial<FileSyncConfig>
) => {
  const localFileStateManagerLayer = LocalFileStateManagerLive(deps)
  const baseLayer = Layer.mergeAll(
    Layer.scope,
    HashServiceLive,
    LocalFileStorageMemory,
    localFileStateManagerLayer,
    RemoteStorageMemory
  )
  const fileSyncLayer = Layer.provide(baseLayer)(
    FileSyncLive(deps, {
      executorConfig: {
        maxConcurrentDownloads: 1,
        maxConcurrentUploads: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterMs: 0,
        maxRetries: 0
      },
      ...config
    })
  )
  const mainLayer = Layer.mergeAll(baseLayer, fileSyncLayer)
  return ManagedRuntime.make(mainLayer)
}

// Helper to run hashFile with the HashService layer
const runHashFile = (file: File) => Effect.runPromise(Effect.provide(hashFile(file), HashServiceLive))

describe("FileSync - File operations", () => {
  it("saves files and records metadata", async () => {
    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      await runtime.runPromise(Scope.extend(fileSync.saveFile(new File(["data"], "data.txt")), scope))

      const files = store.query(
        deps.schema.queryDb(tables.files.select())
      )
      expect(files).toHaveLength(1)
      const saved = files[0]!
      expect(saved.path).toBe(makeStoredPath(deps.storeId, saved.contentHash))

      const exists = await runtime.runPromise(localStorage.fileExists(saved.path))
      expect(exists).toBe(true)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("updates files and cleans up old paths", async () => {
    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const initial = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "data.txt")), scope)
      )
      const updated = await runtime.runPromise(
        Scope.extend(fileSync.updateFile(initial.fileId, new File(["next"], "next.txt")), scope)
      )

      expect(updated.path).not.toBe(initial.path)
      const oldExists = await runtime.runPromise(localStorage.fileExists(initial.path))
      const newExists = await runtime.runPromise(localStorage.fileExists(updated.path))
      expect(oldExists).toBe(false)
      expect(newExists).toBe(true)

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: initial.fileId }))
      )
      expect(records[0]?.path).toBe(updated.path)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("deletes files and marks records deleted", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const saved = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "data.txt")), scope)
      )
      store.commit(
        events.fileUpdated({
          id: saved.fileId,
          path: saved.path,
          remoteKey: stripFilesRoot(saved.path),
          contentHash: saved.contentHash,
          updatedAt: new Date()
        })
      )

      await runtime.runPromise(Scope.extend(fileSync.deleteFile(saved.fileId), scope))

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: saved.fileId }))
      )
      expect(records[0]?.deletedAt).not.toBeNull()

      const exists = await runtime.runPromise(localStorage.fileExists(saved.path))
      expect(exists).toBe(false)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("prefers local file URLs and falls back to remote URLs", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const saved = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "data.txt")), scope)
      )
      const localUrl = await runtime.runPromise(
        Scope.extend(fileSync.resolveFileUrl(saved.fileId), scope)
      )

      expect(localUrl?.startsWith("file://")).toBe(true)
      expect(localUrl).toContain(saved.path)

      const remoteId = crypto.randomUUID()
      const remotePath = makeStoredPath(deps.storeId, "remote-hash")
      store.commit(
        events.fileCreated({
          id: remoteId,
          path: remotePath,
          contentHash: "remote-hash",
          createdAt: new Date(),
          updatedAt: new Date()
        })
      )
      store.commit(
        events.fileUpdated({
          id: remoteId,
          path: remotePath,
          remoteKey: stripFilesRoot(remotePath),
          contentHash: "remote-hash",
          updatedAt: new Date()
        })
      )

      const remoteUrl = await runtime.runPromise(
        Scope.extend(fileSync.resolveFileUrl(remoteId), scope)
      )
      expect(remoteUrl).toBe(`https://test-storage.local/${stripFilesRoot(remotePath)}`)

      const records = store.query(
        deps.schema.queryDb(tables.files.where({ id: remoteId }))
      )
      expect(records[0]?.path).toBe(remotePath)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})

describe("FileSync - Preprocessor integration", () => {
  it("applies preprocessor to file on saveFile", async () => {
    let preprocessorCalled = false
    let receivedFileName = ""
    const preprocessors: PreprocessorMap = {
      "text/*": async (file) => {
        preprocessorCalled = true
        receivedFileName = file.name
        // Transform the file - add a prefix to content
        const content = await file.text()
        return new File([`PROCESSED: ${content}`], `processed-${file.name}`, { type: file.type })
      }
    }

    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const originalFile = new File(["hello world"], "test.txt", { type: "text/plain" })
      const result = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(originalFile), scope)
      )

      // Verify preprocessor was called
      expect(preprocessorCalled).toBe(true)
      expect(receivedFileName).toBe("test.txt")

      // Verify the stored file has the processed content
      const storedFile = await runtime.runPromise(localStorage.readFile(result.path))
      const storedContent = await storedFile.text()
      expect(storedContent).toBe("PROCESSED: hello world")

      // Verify hash is calculated from processed content
      const expectedHash = await runHashFile(new File(["PROCESSED: hello world"], "test.txt"))
      expect(result.contentHash).toBe(expectedHash)

      // Verify database record
      const files = store.query(deps.schema.queryDb(tables.files.select()))
      expect(files).toHaveLength(1)
      expect(files[0]?.contentHash).toBe(expectedHash)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("applies preprocessor to file on updateFile", async () => {
    let preprocessorCallCount = 0
    const preprocessors: PreprocessorMap = {
      "text/*": async (file) => {
        preprocessorCallCount++
        const content = await file.text()
        return new File([`v${preprocessorCallCount}: ${content}`], file.name, { type: file.type })
      }
    }

    const { deps, shutdown } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // Save initial file
      const initial = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["first"], "data.txt", { type: "text/plain" })), scope)
      )
      expect(preprocessorCallCount).toBe(1)

      // Update the file
      const updated = await runtime.runPromise(
        Scope.extend(
          fileSync.updateFile(initial.fileId, new File(["second"], "data.txt", { type: "text/plain" })),
          scope
        )
      )
      expect(preprocessorCallCount).toBe(2)

      // Verify updated content
      const storedFile = await runtime.runPromise(localStorage.readFile(updated.path))
      const storedContent = await storedFile.text()
      expect(storedContent).toBe("v2: second")

      // Verify paths are different (content changed)
      expect(updated.path).not.toBe(initial.path)

      // Verify hash reflects processed content
      const expectedHash = await runHashFile(new File(["v2: second"], "data.txt"))
      expect(updated.contentHash).toBe(expectedHash)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("does not call preprocessor when no matching pattern", async () => {
    let preprocessorCalled = false
    const preprocessors: PreprocessorMap = {
      "image/*": async (file) => {
        preprocessorCalled = true
        return file
      }
    }

    const { deps, shutdown, store: _store, tables: _tables } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // Save a text file (should not match image/* pattern)
      await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "test.txt", { type: "text/plain" })), scope)
      )

      expect(preprocessorCalled).toBe(false)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("preprocessor can skip processing by returning original file", async () => {
    let processCount = 0
    const preprocessors: PreprocessorMap = {
      "text/*": async (file) => {
        // Skip if already processed (simulating format check)
        if (file.name.startsWith("processed-")) {
          return file
        }
        processCount++
        const content = await file.text()
        return new File([`DONE: ${content}`], `processed-${file.name}`, { type: file.type })
      }
    }

    const { deps, shutdown } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // First save - should process
      const first = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "file.txt", { type: "text/plain" })), scope)
      )
      expect(processCount).toBe(1)

      const firstContent = await (await runtime.runPromise(localStorage.readFile(first.path))).text()
      expect(firstContent).toBe("DONE: data")

      // Second save with "already processed" file - should skip
      const alreadyProcessed = new File(["DONE: data"], "processed-file.txt", { type: "text/plain" })
      const second = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(alreadyProcessed), scope)
      )
      expect(processCount).toBe(1) // Still 1 - skipped

      const secondContent = await (await runtime.runPromise(localStorage.readFile(second.path))).text()
      expect(secondContent).toBe("DONE: data") // Unchanged
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("catches preprocessor errors as StorageError instead of crashing the fiber", async () => {
    const preprocessors: PreprocessorMap = {
      "text/*": async () => {
        throw new Error("Preprocessor exploded")
      }
    }

    const { deps, shutdown } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const result = runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "test.txt", { type: "text/plain" })), scope)
      )

      // Should fail with a typed StorageError, not crash the runtime with a defect
      await expect(result).rejects.toThrow("Preprocessor failed for test.txt: Preprocessor exploded")
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("catches preprocessor errors on updateFile as StorageError", async () => {
    let callCount = 0
    const preprocessors: PreprocessorMap = {
      "text/*": async (file) => {
        callCount++
        if (callCount > 1) throw new Error("Preprocessor exploded on update")
        return file
      }
    }

    const { deps, shutdown } = await createTestStore()
    const runtime = createRuntime(deps, { preprocessors })
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      // First save succeeds
      const saved = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "test.txt", { type: "text/plain" })), scope)
      )

      // Second call (update) fails in preprocessor
      const result = runtime.runPromise(
        Scope.extend(
          fileSync.updateFile(saved.fileId, new File(["updated"], "test.txt", { type: "text/plain" })),
          scope
        )
      )

      await expect(result).rejects.toThrow("Preprocessor failed for test.txt: Preprocessor exploded on update")
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })

  it("works correctly without preprocessors configured", async () => {
    // No preprocessors - should work like before
    const { deps, shutdown, store, tables } = await createTestStore()
    const runtime = createRuntime(deps)
    const fileSync = await runtime.runPromise(Effect.gen(function*() {
      return yield* FileSync
    }))
    const localStorage = await runtime.runPromise(Effect.gen(function*() {
      return yield* LocalFileStorage
    }))
    const scope = await runtime.runPromise(Scope.make())

    try {
      const result = await runtime.runPromise(
        Scope.extend(fileSync.saveFile(new File(["data"], "test.txt")), scope)
      )

      const storedFile = await runtime.runPromise(localStorage.readFile(result.path))
      const storedContent = await storedFile.text()
      expect(storedContent).toBe("data")

      const files = store.query(deps.schema.queryDb(tables.files.select()))
      expect(files).toHaveLength(1)
    } finally {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await shutdown()
    }
  })
})
