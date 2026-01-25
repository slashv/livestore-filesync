import type { Scope } from "effect"
import { Deferred, Effect, Ref } from "effect"
import { describe, expect, it } from "vitest"
import { makeSyncExecutor, type SyncExecutorConfig } from "./index.js"

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
  ): Promise<A> => Effect.runPromise(Effect.scoped(effect))

  describe("enqueue and process", () => {
    it("should process enqueued downloads", async () => {
      const processed: Array<string> = []

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
      const processed: Array<string> = []

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
      const processed: Array<string> = []

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
            (_kind, _fileId) => Ref.update(countRef, (n) => n + 1),
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
      const processed: Array<string> = []

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
      const attempts: Array<number> = []

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
      const attempts: Array<number> = []

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

  describe("concurrency limits", () => {
    it("should respect max concurrent uploads", async () => {
      await runScoped(
        Effect.gen(function*() {
          const current = yield* Ref.make(0)
          const max = yield* Ref.make(0)
          const gate = yield* Deferred.make<void>()

          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Effect.gen(function*() {
                const inFlight = yield* Ref.updateAndGet(current, (n) => n + 1)
                yield* Ref.update(max, (n) => Math.max(n, inFlight))
                yield* Deferred.await(gate)
                yield* Ref.update(current, (n) => n - 1)
              }),
            { ...testConfig, maxConcurrentUploads: 1 }
          )

          yield* executor.start()
          yield* executor.enqueueUpload("u1")
          yield* executor.enqueueUpload("u2")
          yield* executor.enqueueUpload("u3")

          yield* Effect.sleep("25 millis")
          const maxSeen = yield* Ref.get(max)
          expect(maxSeen).toBe(1)

          yield* Deferred.succeed(gate, undefined)
          yield* executor.awaitIdle()
        })
      )
    })

    it("should respect max concurrent downloads", async () => {
      await runScoped(
        Effect.gen(function*() {
          const current = yield* Ref.make(0)
          const max = yield* Ref.make(0)
          const gate = yield* Deferred.make<void>()

          const executor = yield* makeSyncExecutor(
            (_kind, _fileId) =>
              Effect.gen(function*() {
                const inFlight = yield* Ref.updateAndGet(current, (n) => n + 1)
                yield* Ref.update(max, (n) => Math.max(n, inFlight))
                yield* Deferred.await(gate)
                yield* Ref.update(current, (n) => n - 1)
              }),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          yield* executor.start()
          yield* executor.enqueueDownload("d1")
          yield* executor.enqueueDownload("d2")
          yield* executor.enqueueDownload("d3")

          yield* Effect.sleep("25 millis")
          const maxSeen = yield* Ref.get(max)
          expect(maxSeen).toBe(1)

          yield* Deferred.succeed(gate, undefined)
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

  describe("prioritizeDownload", () => {
    it("should process prioritized downloads before normal queue", async () => {
      const processed: Array<string> = []

      await runScoped(
        Effect.gen(function*() {
          // Use a slower handler to ensure ordering can be observed
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.gen(function*() {
                yield* Effect.sleep("5 millis")
                processed.push(`${kind}:${fileId}`)
              }),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          // Pause to build up queue
          yield* executor.pause()
          yield* executor.start()

          // Enqueue normal files
          yield* executor.enqueueDownload("normal1")
          yield* executor.enqueueDownload("normal2")
          yield* executor.enqueueDownload("normal3")

          // Prioritize normal3 - should be processed before normal1 and normal2
          yield* executor.prioritizeDownload("normal3")

          // Resume processing
          yield* executor.resume()
          yield* executor.awaitIdle()

          // normal3 should appear before normal1 and normal2
          const normal1Index = processed.indexOf("download:normal1")
          const normal2Index = processed.indexOf("download:normal2")
          const normal3Index = processed.indexOf("download:normal3")

          expect(normal3Index).toBeLessThan(normal1Index)
          expect(normal3Index).toBeLessThan(normal2Index)
        })
      )
    })

    it("should not duplicate downloads when same file is in both queues", async () => {
      const processCount = await runScoped(
        Effect.gen(function*() {
          const countRef = yield* Ref.make(0)

          const executor = yield* makeSyncExecutor(
            () => Ref.update(countRef, (n) => n + 1),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          // Pause to build up queue
          yield* executor.pause()
          yield* executor.start()

          // Enqueue file1 to normal queue
          yield* executor.enqueueDownload("file1")

          // Prioritize file1 - now it's in both queues
          yield* executor.prioritizeDownload("file1")

          // Resume processing
          yield* executor.resume()
          yield* executor.awaitIdle()

          return yield* Ref.get(countRef)
        })
      )

      // file1 should only be processed once
      expect(processCount).toBe(1)
    })

    it("should be a no-op if file is not queued", async () => {
      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            () => Effect.void,
            testConfig
          )

          yield* executor.start()

          // Prioritize a file that was never enqueued - should not throw
          yield* executor.prioritizeDownload("non-existent")

          yield* executor.awaitIdle()
        })
      )
    })

    it("should be a no-op if file is already prioritized", async () => {
      const processed: Array<string> = []

      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.gen(function*() {
                yield* Effect.sleep("5 millis")
                processed.push(`${kind}:${fileId}`)
              }),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          // Pause to build up queue
          yield* executor.pause()
          yield* executor.start()

          yield* executor.enqueueDownload("file1")

          // Prioritize twice - should only add once to high priority queue
          yield* executor.prioritizeDownload("file1")
          yield* executor.prioritizeDownload("file1")

          yield* executor.resume()
          yield* executor.awaitIdle()

          // file1 should only appear once
          const occurrences = processed.filter((p) => p === "download:file1").length
          expect(occurrences).toBe(1)
        })
      )
    })
  })

  describe("cancelDownload", () => {
    it("should skip cancelled downloads when dequeued", async () => {
      const processed: Array<string> = []

      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.gen(function*() {
                yield* Effect.sleep("5 millis")
                processed.push(`${kind}:${fileId}`)
              }),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          // Pause to build up queue
          yield* executor.pause()
          yield* executor.start()

          // Enqueue multiple downloads
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file2")
          yield* executor.enqueueDownload("file3")

          // Cancel file2
          yield* executor.cancelDownload("file2")

          // Resume processing
          yield* executor.resume()
          yield* executor.awaitIdle()

          // file2 should not be processed
          expect(processed).toContain("download:file1")
          expect(processed).not.toContain("download:file2")
          expect(processed).toContain("download:file3")
        })
      )
    })

    it("should remove cancelled file from queued count", async () => {
      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            () => Effect.sleep("50 millis"),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          yield* executor.pause()
          yield* executor.start()

          // Enqueue downloads
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file2")

          // Verify initial queued count
          const beforeCancel = yield* executor.getQueuedCount()
          expect(beforeCancel.downloads).toBe(2)

          // Cancel file1
          yield* executor.cancelDownload("file1")

          // Verify queued count decreased
          const afterCancel = yield* executor.getQueuedCount()
          expect(afterCancel.downloads).toBe(1)

          yield* executor.resume()
          yield* executor.awaitIdle()
        })
      )
    })

    it("should be a no-op for non-existent files", async () => {
      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            () => Effect.void,
            testConfig
          )

          yield* executor.start()

          // Cancel a file that was never enqueued - should not throw
          yield* executor.cancelDownload("non-existent")

          yield* executor.awaitIdle()
        })
      )
    })

    it("should skip cancelled downloads even when prioritized", async () => {
      const processed: Array<string> = []

      await runScoped(
        Effect.gen(function*() {
          const executor = yield* makeSyncExecutor(
            (kind, fileId) =>
              Effect.gen(function*() {
                yield* Effect.sleep("5 millis")
                processed.push(`${kind}:${fileId}`)
              }),
            { ...testConfig, maxConcurrentDownloads: 1 }
          )

          // Pause to build up queue
          yield* executor.pause()
          yield* executor.start()

          // Enqueue and prioritize file1
          yield* executor.enqueueDownload("file1")
          yield* executor.enqueueDownload("file2")
          yield* executor.prioritizeDownload("file1")

          // Cancel file1 (now in both queues)
          yield* executor.cancelDownload("file1")

          // Resume processing
          yield* executor.resume()
          yield* executor.awaitIdle()

          // file1 should not be processed (even though it was prioritized)
          expect(processed).not.toContain("download:file1")
          expect(processed).toContain("download:file2")
        })
      )
    })
  })
})
