import { EventSequenceNumber, type LiveStoreEvent } from "@livestore/livestore"
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createTestStore, delay, waitFor } from "../../../test/helpers/livestore.js"
import { DownloadError, StorageError, UploadError } from "../../errors/index.js"
import { getClientSession } from "../../livestore/types.js"
import type { TransferStatus } from "../../types/index.js"
import { hashFile, makeStoredPath } from "../../utils/index.js"
import { stripFilesRoot } from "../../utils/path.js"
import { HashServiceLive } from "../hash/index.js"
import { LocalFileStateManagerLive } from "../local-file-state/index.js"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { RemoteStorage, type RemoteStorageService } from "../remote-file-storage/index.js"
import { FileSync, FileSyncLive } from "./index.js"

const setup = async (heartbeatIntervalMs = 20, injectEvents = true) => {
  const t = await createTestStore()
  const { deps, events, store, tables } = t
  // The in-memory adapter's upstream head stays e0. Inject only stream transport;
  // metadata, cursor, repair document and local state all use a real LiveStore.
  const incoming = Effect.runSync(Queue.unbounded<LiveStoreEvent.Client.Decoded>())
  if (injectEvents) {
    vi.spyOn(store, "eventsStream").mockImplementation(() =>
      Stream.fromQueue(incoming) as ReturnType<typeof store.eventsStream>
    )
  }
  let started = false
  const remoteFiles = new Map<string, File>()
  const uploads: Array<string> = []
  const downloads: Array<string> = []
  const reads: Array<string> = []
  let readGate: (() => Promise<void>) | undefined
  const faults = { reads: 0, uploads: false }
  const remote: RemoteStorageService = {
    upload: (file, options) =>
      Effect.gen(function*() {
        uploads.push(options.key)
        if (faults.uploads) return yield* Effect.fail(new UploadError({ message: "Permanent failure" }))
        remoteFiles.set(options.key, file)
        return { key: options.key }
      }),
    download: (key) =>
      Effect.gen(function*() {
        downloads.push(key)
        const file = remoteFiles.get(key)
        if (!file) return yield* Effect.fail(new DownloadError({ message: "Missing remote", url: key }))
        return file
      }),
    delete: () => Effect.void,
    getDownloadUrl: (key) => Effect.succeed(key),
    checkHealth: () => Effect.succeed(true),
    getConfig: () => ({ signerBaseUrl: "https://example.test" })
  }
  const storage = Layer.effect(
    LocalFileStorage,
    Effect.gen(function*() {
      const base = yield* LocalFileStorage
      return {
        ...base,
        readFile: (path: string) =>
          Effect.gen(function*() {
            reads.push(path)
            if (faults.reads > 0) {
              faults.reads--
              return yield* Effect.fail(new StorageError({ message: "Temporary read failure" }))
            }
            const file = yield* base.readFile(path)
            const gate = readGate
            readGate = undefined
            if (gate) yield* Effect.promise(gate)
            return file
          })
      }
    })
  ).pipe(Layer.provide(LocalFileStorageMemory))
  const base = Layer.mergeAll(
    storage,
    HashServiceLive,
    LocalFileStateManagerLive(deps),
    Layer.succeed(RemoteStorage, remote)
  )
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    base,
    FileSyncLive(deps, {
      heartbeatIntervalMs,
      executorConfig: {
        maxConcurrentUploads: 1,
        maxConcurrentDownloads: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterMs: 0
      }
    }).pipe(Layer.provide(base))
  ))
  const sync = await runtime.runPromise(FileSync)
  const local = await runtime.runPromise(LocalFileStorage)
  const scope = await runtime.runPromise(Scope.make())
  const seed = async (status: TransferStatus, kind: "upload" | "download" = "upload", id = crypto.randomUUID()) => {
    const file = new File([id], "file.txt")
    const contentHash = await runtime.runPromise(hashFile(file))
    const path = makeStoredPath(deps.storeId, contentHash)
    const remoteKey = stripFilesRoot(path)
    if (kind === "upload" || status === "done") await runtime.runPromise(local.writeFile(path, file))
    if (kind === "download" || status === "done") remoteFiles.set(remoteKey, file)
    store.commit(events.fileCreated({ id, path, contentHash, createdAt: new Date(), updatedAt: new Date() }))
    if (kind === "download" || status === "done") {
      store.commit(events.fileUpdated({ id, path, contentHash, remoteKey, updatedAt: new Date() }))
    }
    store.commit(events.localFileStateUpsert({
      fileId: id,
      path,
      localHash: kind === "upload" || status === "done" ? contentHash : "",
      uploadStatus: kind === "upload" ? status : "done",
      downloadStatus: kind === "download" ? status : "done",
      lastSyncError: ""
    }))
    if (started) {
      await runtime.runPromise(Queue.offer(incoming, {
        name: "v1.FileCreated",
        args: { id },
        seqNum: EventSequenceNumber.Client.fromString(store.syncStatus().localHead)
      } as LiveStoreEvent.Client.Decoded))
    }
    return { id, path, remoteKey, contentHash }
  }
  return {
    ...t,
    runtime,
    sync,
    local,
    uploads,
    downloads,
    reads,
    faults,
    remoteFiles,
    seed,
    deliver: (id: string) =>
      runtime.runPromise(Queue.offer(incoming, {
        name: "v1.FileUpdated",
        args: { id },
        seqNum: EventSequenceNumber.Client.fromString(store.syncStatus().localHead)
      } as LiveStoreEvent.Client.Decoded)),
    blockNextRead: () => {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      readGate = async () => {
        enter()
        await released
      }
      return { entered, release }
    },
    state: async (id: string) => (await runtime.runPromise(sync.getLocalFilesState()))[id],
    advance: () =>
      store.commit(
        events.fileSyncCursorSet({ lastEventSequence: store.syncStatus().localHead, updatedAt: new Date() })
      ),
    repairs: () => store.query(deps.schema.queryDb(tables.fileSyncCursor.get())).repairs ?? [],
    start: async () => {
      await runtime.runPromise(Scope.provide(sync.start(), scope))
      started = true
    },
    async close() {
      await runtime.runPromise(sync.stop())
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
      await t.shutdown()
    }
  }
}

describe("durable reconciliation", () => {
  for (const kind of ["upload", "download"] as const) {
    for (const status of ["queued", "error", "inProgress"] as const) {
      it(`recovers persisted ${status} ${kind} behind an advanced cursor without scanning done files`, async () => {
        const t = await setup(20, false)
        try {
          const done = await t.seed("done")
          const pending = await t.seed(status, kind)
          t.advance()
          await t.start()
          await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done" && s?.downloadStatus === "done")
          expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
          expect(await (await t.runtime.runPromise(t.local.readFile(pending.path))).text()).toBe(pending.id)
          expect(t.uploads).toEqual(kind === "upload" ? [pending.remoteKey] : [])
          expect(t.downloads).toEqual(kind === "download" ? [pending.remoteKey] : [])
          expect(t.reads).not.toContain(done.path)
        } finally {
          await t.close()
        }
      })
    }
  }

  it("rebuilds persisted work when a follower acquires leadership without a file event", async () => {
    const t = await setup(0, false)
    try {
      const pending = await t.seed("queued")
      t.advance()
      const lock = getClientSession(t.store).lockStatus
      await t.runtime.runPromise(SubscriptionRef.set(lock, "no-lock"))
      await t.start()
      expect(t.uploads).toEqual([])
      await t.runtime.runPromise(SubscriptionRef.set(lock, "has-lock"))
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
      expect(t.uploads).toEqual([pending.remoteKey])
    } finally {
      await t.close()
    }
  })

  it("heartbeat reconstructs missing work without a new file event or manual trigger", async () => {
    const t = await setup(20, false)
    try {
      const pending = await t.seed("pending")
      t.advance()
      await t.start()
      const state = await t.state(pending.id)
      t.store.commit(t.events.localFileStateUpsert({ ...state, fileId: pending.id, uploadStatus: "queued" }))
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(t.uploads).toEqual([pending.remoteKey])
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
    } finally {
      await t.close()
    }
  })

  it("persists a failed event inspection across stop/start and repairs only that file", async () => {
    const t = await setup(0)
    try {
      const done = await t.seed("done")
      t.advance()
      await t.start()
      t.faults.reads = 1
      const pending = await t.seed("pending")
      await waitFor(t.repairs, (r) => r.some((entry) => entry.fileId === pending.id))
      // Cursor has advanced, but the failure is durable independently of stream replay.
      await t.runtime.runPromise(t.sync.stop())
      const cursor = t.store.query(t.deps.schema.queryDb(t.tables.fileSyncCursor.get()))
      expect(cursor.lastEventSequence).not.toBe("e0")
      await t.start()
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(t.repairs()).toEqual([])
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
      expect(t.reads).not.toContain(done.path)
    } finally {
      await t.close()
    }
  })

  it("automatically repairs transient event failures on heartbeat", async () => {
    const t = await setup()
    try {
      await t.seed("done")
      t.advance()
      await t.start()
      t.faults.reads = 1
      const pending = await t.seed("pending")
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
      expect(t.repairs()).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("bounds permanent inspection and transfer failures until explicit retry", async () => {
    const t = await setup()
    try {
      await t.seed("done")
      t.advance()
      await t.start()
      t.faults.reads = 100
      const pending = await t.seed("pending")
      await waitFor(t.repairs, (r) => r.some((entry) => entry.attempts === 2))
      const readCount = t.reads.length
      await delay(100)
      expect(t.reads).toHaveLength(readCount)
      t.faults.reads = 0
      t.faults.uploads = true
      const gate = t.blockNextRead()
      const retry = t.runtime.runPromise(t.sync.retryErrors())
      await gate.entered
      // Let heartbeat request repair while the explicit retry is inspecting bytes.
      await delay(60)
      gate.release()
      await retry
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "error")
      await delay(100)
      expect(t.uploads).toHaveLength(1)
      t.faults.uploads = false
      await t.runtime.runPromise(t.sync.retryErrors())
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
    } finally {
      await t.close()
    }
  })
  it("keeps repair work when a concurrent local-state change rejects an inspection", async () => {
    const t = await setup()
    const gate = t.blockNextRead()
    try {
      await t.seed("done")
      t.advance()
      await t.start()
      const pending = await t.seed("pending")
      await gate.entered
      const current = await t.state(pending.id)
      t.store.commit(t.events.localFileStateUpsert({ ...current, fileId: pending.id, lastSyncError: "newer state" }))
      gate.release()
      await waitFor(() => t.state(pending.id), (s) => s?.uploadStatus === "done")
      expect(await t.remoteFiles.get(pending.remoteKey)?.text()).toBe(pending.id)
      expect(t.repairs()).toEqual([])
    } finally {
      gate.release()
      await t.close()
    }
  })

  it("repairs a corrected remote-key event after a read failure and a terminal download error", async () => {
    const t = await setup()
    try {
      const pending = await t.seed("queued", "download")
      const file = t.remoteFiles.get(pending.remoteKey)!
      t.remoteFiles.delete(pending.remoteKey)
      t.advance()
      await t.start()
      await waitFor(() => t.state(pending.id), (s) => s?.downloadStatus === "error")
      const stale = new File(["stale bytes"], "file.txt")
      await t.runtime.runPromise(t.local.writeFile(pending.path, stale))
      t.store.commit(t.events.localFileStateUpsert({
        ...await t.state(pending.id),
        fileId: pending.id,
        localHash: await t.runtime.runPromise(hashFile(stale))
      }))
      t.faults.reads = 1
      const remoteKey = "repaired-key"
      t.remoteFiles.set(remoteKey, file)
      t.store.commit(
        t.events.fileUpdated({
          id: pending.id,
          path: pending.path,
          contentHash: pending.contentHash,
          remoteKey,
          updatedAt: new Date()
        })
      )
      await t.deliver(pending.id)
      await waitFor(() => t.state(pending.id), (s) => s?.downloadStatus === "done")
      expect(await (await t.runtime.runPromise(t.local.readFile(pending.path))).text()).toBe(pending.id)
      expect(t.downloads).toEqual([pending.remoteKey, remoteKey])
    } finally {
      await t.close()
    }
  })

  it("cleans the previous local path after an unreconciled replacement is deleted", async () => {
    const t = await setup(0)
    try {
      const previous = await t.seed("done")
      const replacement = await t.seed("done")
      t.advance()
      await t.start()
      t.faults.reads = 1
      t.store.commit(
        t.events.fileUpdated({
          id: previous.id,
          path: replacement.path,
          contentHash: replacement.contentHash,
          remoteKey: replacement.remoteKey,
          updatedAt: new Date()
        })
      )
      await t.deliver(previous.id)
      await waitFor(t.repairs, (r) => r.some((entry) => entry.fileId === previous.id))
      t.store.commit(t.events.fileDeleted({ id: previous.id, deletedAt: new Date() }))
      await t.deliver(previous.id)
      await waitFor(() => t.state(previous.id), (s) => s === undefined)
      expect(await t.runtime.runPromise(t.local.fileExists(previous.path))).toBe(false)
      expect(await (await t.runtime.runPromise(t.local.readFile(replacement.path))).text()).toBe(replacement.id)
    } finally {
      await t.close()
    }
  })
})
