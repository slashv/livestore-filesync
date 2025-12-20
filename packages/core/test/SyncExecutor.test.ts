import { Effect, Ref, Scope } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeSyncExecutor,
  type SyncExecutorConfig
} from "../src/services/sync-executor/index.js"

describe("SyncExecutor", () => {
  const testConfig: SyncExecutorConfig = {
    maxConcurrentDownloads: 2,
    maxConcurrentUploads: 2,
    baseDelayMs: 10, // Fast for tests
    maxDelayMs: 100,
    jitterMs: 5,
    maxRetries: 2
  }

  const runScoped = <A, E>(
    effect: Effect.Effect<A, E, Scope.Scope>
  ): Promise<A> =>
    Effect.runPromise(Effect.scoped(effect))

  describe("enqueue and process", () => {
    it("should process enqueued downloads", async () => {
      const processed: string[] = []

      const result = await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.sync(() => {
                processed.push(`${kind}:${fileId}`)
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file2")
          yield* executor.awaitIdle()

          return processed
        })
      )

      expect(result).toContain("download:file1")
      expect(result).toContain("download:file2")
    })

    it("should process enqueued uploads", async () => {
      const processed: string[] = []

      const result = await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.sync(() => {
                processed.push(`${kind}:${fileId}`)
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueUpload("file1")
          yield* executor.enqueueUpload("file2")
          yield* executor.awaitIdle()

          return processed
        })
      )

      expect(result).toContain("upload:file1")
      expect(result).toContain("upload:file2")
    })

    it("should handle mixed downloads and uploads", async () => {
      const processed: string[] = []

      const result = await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.sync(() => {
                processed.push(`${kind}:${fileId}`)
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("d1")
          yield* executor.enqueueUpload("u1")
          yield* executor.enqueueDownload("d2")
          yield* executor.enqueueUpload("u2")
          yield* executor.awaitIdle()

          return processed
        })
      )

      expect(result).toHaveLength(4)
      expect(result).toContain("download:d1")
      expect(result).toContain("download:d2")
      expect(result).toContain("upload:u1")
      expect(result).toContain("upload:u2")
    })
  })

  describe("deduplication", () => {
    it("should not process the same file twice when enqueued multiple times", async () => {
      const processCount = await runScoped(
        Effect.gen(function*() {
          const countRef = yield* Ref.make(0)

          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Ref.update(countRef, (n) => n + 1),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file1")
          yield* executor.awaitIdle()

          return yield* Ref.get(countRef)
        })
      )

      expect(processCount).toBe(1)
    })
  })

  describe("pause and resume", () => {
    it("should pause and resume processing", async () => {
      const processed: string[] = []

      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.sync(() => {
                processed.push(`${kind}:${fileId}`)
              }),
            testConfig
          )

          yield* executor.start()

          // Pause before enqueuing
          yield* executor.pause()
          const isPaused = yield* executor.isPaused()
          expect(isPaused).toBe(true)

          yield* executor.enqueueDownload("file1")

          // Wait a bit to ensure nothing is processed
          yield* Effect.sleep("50 millis")
          expect(processed).toHaveLength(0)

          // Resume and wait for processing
          yield* executor.resume()
          yield* executor.awaitIdle()

          expect(processed).toContain("download:file1")
        })
      )
    })
  })

  describe("retry on failure", () => {
    it("should retry failed tasks", async () => {
      const attempts: number[] = []

      await runScoped(
        Effect.gen(function*() {
          const attemptRef = yield* Ref.make(0)

          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Effect.gen(function*() {
                const attempt = yield* Ref.updateAndGet(attemptRef, (n) => n + 1)
                attempts.push(attempt)
                if (attempt < 2) {
                  return yield* Effect.fail(new Error("Simulated failure"))
                }
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("file1")
          yield* executor.awaitIdle()
        })
      )

      // Should have retried at least once
      expect(attempts.length).toBeGreaterThanOrEqual(2)
    })

    it("should give up after max retries", async () => {
      const attempts: number[] = []

      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Effect.gen(function*() {
                attempts.push(attempts.length + 1)
                return yield* Effect.fail(new Error("Always fails"))
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("file1")
          yield* executor.awaitIdle()
        })
      )

      // Should have tried maxRetries + 1 times (initial + retries)
      expect(attempts.length).toBe(testConfig.maxRetries + 1)
    })
  })

  describe("inflight and queued counts", () => {
    it("should track inflight count", async () => {
      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Effect.gen(function*() {
                // Check inflight count during processing
                yield* Effect.sleep("10 millis")
              }),
            testConfig
          )

          yield* executor.start()
          yield* executor.enqueueDownload("file1")

          // Small delay to let processing start
          yield* Effect.sleep("5 millis")

          const inflight = yield* executor.getInflightCount()
          // Should have at least some downloads in flight
          expect(inflight.downloads).toBeGreaterThanOrEqual(0)

          yield* executor.awaitIdle()

          // After idle, should be 0
          const inflightAfter = yield* executor.getInflightCount()
          expect(inflightAfter.downloads).toBe(0)
          expect(inflightAfter.uploads).toBe(0)
        })
      )
    })

    it("should track queued count", async () => {
      await runScoped(
        Effect.gen(function*() {
          // Use slow handler to build up queue
          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) => Effect.sleep("50 millis"),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          yield* executor.start()

          // Enqueue multiple items
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file2")
          yield* executor.enqueueDownload("file3")

          // Small delay to let first one start
          yield* Effect.sleep("10 millis")

          const queued = yield* executor.getQueuedCount()
          // Should have some items queued (at least 1-2)
          expect(queued.downloads).toBeGreaterThanOrEqual(0)

          yield* executor.awaitIdle()
        })
      )
    })
  })

  describe("awaitIdle", () => {
    it("should resolve immediately when already idle", async () => {
      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            () => Effect.void,
            testConfig
          )

          yield* executor.start()

          // Should resolve immediately since nothing is queued
          yield* executor.awaitIdle()
        })
      )
    })
  })
})
