import type * as LiveStoreModule from "@livestore/livestore"
import { StoreInternalsSymbol } from "@livestore/livestore"
import { Effect, Layer, SubscriptionRef } from "effect"
import { FileSystem } from "effect/FileSystem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createThumbnails } from "../src/thumbnails/api/createThumbnails.js"
import {
  disposeThumbnails,
  getThumbnailState,
  initThumbnails,
  onThumbnailEvent
} from "../src/thumbnails/api/singleton.js"
import { createThumbnailSchema } from "../src/thumbnails/schema/index.js"

vi.mock("@livestore/livestore", async (importOriginal) => ({
  ...await importOriginal<typeof LiveStoreModule>(),
  queryDb: (query: unknown) => query
}))

class ControlledWorker {
  static instances: Array<ControlledWorker> = []
  listeners = new Map<string, Set<(event: any) => void>>()
  requests: Array<any> = []
  terminated = false
  constructor() {
    ControlledWorker.instances.push(this)
  }
  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(request: any) {
    this.requests.push(request)
  }
  terminate() {
    this.terminated = true
  }
  emit(data: any) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data })
  }
}
const setup = (leader = true) => {
  const lockStatus = Effect.runSync(SubscriptionRef.make(leader ? "has-lock" : "no-lock"))
  const schema = createThumbnailSchema()
  const select = {}
  const filesTable = { select: () => select, where: () => select }
  const source = { id: "file", contentHash: "hash", path: "photo.jpg", deletedAt: null as Date | null }
  const states = new Map<string, any>()
  let configRow: any
  const store = {
    [StoreInternalsSymbol]: { clientSession: { lockStatus } },
    query: (query: any) => {
      if (query === select) return [{ ...source }]
      if (query.asSql().usedTables.has("thumbnailConfig")) return configRow ? [configRow] : []
      return [...states.values()]
    },
    commit: vi.fn((...events: Array<any>) => {
      for (const event of events) {
        if (event.name === "v1.ThumbnailStateUpsert") states.set(event.args.fileId, event.args)
        if (event.name === "v1.ThumbnailConfigSet") configRow = event.args
      }
    })
  }
  const writes = vi.fn(() => Effect.void)
  const reads = vi.fn(() => Effect.succeed(new Uint8Array(12)))
  const fileSystem = Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(true),
    readFile: reads,
    makeDirectory: () => Effect.void,
    writeFile: writes,
    remove: () => Effect.void
  } as any)
  const config = {
    store: store as any,
    tables: schema.tables,
    events: schema.events,
    filesTable: filesTable as any,
    sizes: { small: 128 },
    fileSystem,
    worker: ControlledWorker as unknown as new() => Worker
  }
  return { config, store, lockStatus, writes, reads, source, states }
}
afterEach(async () => {
  await disposeThumbnails()
  ControlledWorker.instances = []
})

describe("public thumbnail lifecycle", () => {
  it("preserves legacy stored-state lookup without filesTable", async () => {
    const { config, states } = setup()
    states.set("file", {
      fileId: "file",
      contentHash: "hash",
      mimeType: "image/jpeg",
      sizesJson: JSON.stringify({ small: { status: "done", path: "thumbnails/hash/small.webp" } })
    })
    const instance = createThumbnails({ ...config, filesTable: undefined })
    try {
      expect(await instance.resolveThumbnailUrl("file", "small")).not.toBeNull()
      expect(instance.getThumbnailState("file")?.contentHash).toBe("hash")
    } finally {
      await instance.dispose()
    }
  })

  it("polls the current source version after rejecting an obsolete worker response", async () => {
    const { config, source, writes } = setup()
    const instance = createThumbnails(config)
    try {
      const starting = instance.start()
      await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
      const worker = ControlledWorker.instances[0]!
      worker.emit({ type: "ready" })
      await starting
      await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
      Object.assign(source, { contentHash: "new-hash", path: "new.jpg" })
      worker.emit({
        type: "complete",
        id: worker.requests[0].id,
        thumbnails: [{ sizeName: "small", data: new ArrayBuffer(2) }]
      })
      await vi.waitFor(() => expect(worker.requests).toHaveLength(2), { timeout: 5000 })
      expect(writes).not.toHaveBeenCalled()
      worker.emit({
        type: "complete",
        id: worker.requests[1].id,
        thumbnails: [{ sizeName: "small", data: new ArrayBuffer(3) }]
      })
      await vi.waitFor(() =>
        expect(instance.getThumbnailState("file")).toMatchObject({
          contentHash: "new-hash",
          sizes: { small: { status: "done" } }
        })
      )
      expect(await instance.resolveThumbnailUrl("file", "small")).not.toBeNull()
    } finally {
      await instance.dispose()
    }
  })

  it.each(["edit", "delete"] as const)(
    "revalidates after a generation-error listener performs an %s",
    async (change) => {
      const { config, source, store } = setup()
      const onEvent = vi.fn((event: { type: string }) => {
        if (event.type !== "thumbnail:generation-error") return
        if (change === "delete") source.deletedAt = new Date()
        else Object.assign(source, { contentHash: "new-hash", path: "new.jpg" })
      })
      const instance = createThumbnails({ ...config, onEvent })
      try {
        const starting = instance.start()
        await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
        const worker = ControlledWorker.instances[0]!
        worker.emit({ type: "ready" })
        await starting
        await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
        worker.emit({ type: "error", id: worker.requests[0].id, error: "worker failed" })
        await vi.waitFor(() =>
          expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: "thumbnail:generation-error"
          }))
        )
        expect(instance.getThumbnailState("file")).toBeNull()
        if (change === "edit") {
          await instance.regenerate("file")
          await vi.waitFor(() => expect(worker.requests).toHaveLength(2))
          worker.emit({
            type: "complete",
            id: worker.requests[1].id,
            thumbnails: [{ sizeName: "small", data: new ArrayBuffer(3) }]
          })
          await vi.waitFor(() =>
            expect(instance.getThumbnailState("file")).toMatchObject({
              contentHash: "new-hash",
              sizes: { small: { status: "done" } }
            })
          )
        }
      } finally {
        await instance.dispose()
      }
      expect(store.commit.mock.calls.flat().some((event) => event.args.sizesJson?.includes("\"error\""))).toBe(false)
    }
  )

  it.each(["edit", "delete"] as const)(
    "rejects %s during worker generation and preserves newer queued ownership",
    async (change) => {
      const { config, source, store, writes } = setup()
      const instance = createThumbnails(config)
      try {
        const starting = instance.start()
        await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
        const worker = ControlledWorker.instances[0]!
        worker.emit({ type: "ready" })
        await starting
        await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
        if (change === "delete") source.deletedAt = new Date()
        else Object.assign(source, { contentHash: "new-hash", path: "new.jpg" })
        await instance.regenerate("file")
        worker.emit({
          type: "complete",
          id: worker.requests[0].id,
          thumbnails: [{ sizeName: "small", data: new ArrayBuffer(2) }]
        })
        if (change === "edit") {
          await vi.waitFor(() => expect(worker.requests).toHaveLength(2))
          // An old completion must not retire ownership of this current attempt.
          await instance.regenerate("file")
          expect(instance.getThumbnailState("file")?.sizes.small?.status).toBe("generating")
          worker.emit({
            type: "complete",
            id: worker.requests[1].id,
            thumbnails: [{ sizeName: "small", data: new ArrayBuffer(3) }]
          })
          await vi.waitFor(() =>
            expect(instance.getThumbnailState("file")).toMatchObject({
              contentHash: "new-hash",
              sizes: { small: { status: "done" } }
            })
          )
          expect(await instance.resolveThumbnailUrl("file", "small")).not.toBeNull()
          expect(writes).toHaveBeenCalledTimes(1)
          await instance.regenerate("file")
          expect(worker.requests).toHaveLength(2)
        } else {
          await instance.dispose()
          expect(writes).not.toHaveBeenCalled()
        }
        expect(
          store.commit.mock.calls.flat().some((event) =>
            event.args.contentHash === "hash" && event.args.sizesJson?.includes("\"done\"")
          )
        ).toBe(false)
      } finally {
        await instance.dispose()
      }
    }
  )

  it.each(["edit", "delete"] as const)("rejects %s while thumbnail storage is writing", async (change) => {
    const { config, source, store, writes } = setup()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    writes.mockImplementation(() => Effect.promise(() => barrier))
    const instance = createThumbnails(config)
    try {
      const starting = instance.start()
      await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
      const worker = ControlledWorker.instances[0]!
      worker.emit({ type: "ready" })
      await starting
      await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
      worker.emit({
        type: "complete",
        id: worker.requests[0].id,
        thumbnails: [{ sizeName: "small", data: new ArrayBuffer(2) }]
      })
      await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
      if (change === "delete") source.deletedAt = new Date()
      else Object.assign(source, { contentHash: "new-hash", path: "new.jpg" })
      release()
      if (change === "edit") {
        await instance.regenerate("file")
        await vi.waitFor(() => expect(worker.requests).toHaveLength(2))
        worker.emit({
          type: "complete",
          id: worker.requests[1].id,
          thumbnails: [{ sizeName: "small", data: new ArrayBuffer(3) }]
        })
        await vi.waitFor(() => expect(instance.getThumbnailState("file")?.sizes.small?.status).toBe("done"))
        expect(instance.getThumbnailState("file")?.contentHash).toBe("new-hash")
      } else {
        expect(await instance.resolveThumbnailUrl("file", "small")).toBeNull()
      }
    } finally {
      release()
      await instance.dispose()
    }
    expect(
      store.commit.mock.calls.flat().some((event) =>
        event.args.contentHash === "hash" && event.args.sizesJson?.includes("\"done\"")
      )
    ).toBe(false)
  })

  it.each(["edit", "delete", "path"] as const)("rejects %s during thumbnail URL reads", async (change) => {
    const { config, reads, source, states } = setup()
    states.set("file", {
      fileId: "file",
      contentHash: "hash",
      mimeType: "image/jpeg",
      sizesJson: JSON.stringify({ small: { status: "done", path: "thumbnails/hash/small.webp" } })
    })
    const instance = createThumbnails(config)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    reads.mockImplementation(() =>
      Effect.promise(async () => {
        await barrier
        return new Uint8Array(12)
      })
    )
    try {
      const resolving = instance.resolveThumbnailUrl("file", "small")
      await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce())
      if (change === "delete") source.deletedAt = new Date()
      else if (change === "path") source.path = "moved.jpg"
      else source.contentHash = "new-hash"
      release()
      expect(await resolving).toBeNull()
      if (change !== "path") {
        expect(await instance.resolveThumbnailUrl("file", "small")).toBeNull()
        expect(instance.getThumbnailState("file")).toBeNull()
      }
    } finally {
      release()
      await instance.dispose()
    }
  })

  it("stops startup blocked on worker readiness and can restart", async () => {
    const { config, store } = setup()
    const instance = createThumbnails(config)
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
    instance.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    ControlledWorker.instances[0]!.emit({ type: "ready" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.commit).not.toHaveBeenCalled()
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances[0]!.requests).toHaveLength(1))
    await instance.dispose()
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
  })

  it("retries failed layer acquisition on a later start", async () => {
    const { config } = setup()
    let attempts = 0
    const fileSystem = Layer.effect(
      FileSystem,
      Effect.suspend(() => {
        if (++attempts === 1) return Effect.die(new Error("filesystem unavailable"))
        return Effect.succeed({ exists: () => Effect.succeed(false) } as any)
      })
    )
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const instance = createThumbnails({ ...config, fileSystem, filesTable: undefined })
    await instance.start()
    const restarting = instance.start()
    await vi.waitFor(() => expect(attempts).toBe(2))
    ControlledWorker.instances.at(-1)!.emit({ type: "ready" })
    await restarting
    await instance.dispose()
    error.mockRestore()
  })

  it("retries worker initialization after startup failure", async () => {
    const { config } = setup()
    const instance = createThumbnails(config)
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
    ControlledWorker.instances[0]!.emit({ type: "error", id: "init", error: "initialization failed" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2))
    ControlledWorker.instances[1]!.emit({ type: "ready" })
    await vi.waitFor(() => expect(ControlledWorker.instances[1]!.requests).toHaveLength(1))
    await instance.dispose()
  })

  it("does not publish a write that finishes after stop", async () => {
    const { config, store, writes } = setup()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    writes.mockImplementation(() => Effect.promise(() => barrier))
    const instance = createThumbnails(config)
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
    const worker = ControlledWorker.instances[0]!
    worker.emit({ type: "ready" })
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
    worker.emit({
      type: "complete",
      id: worker.requests[0].id,
      thumbnails: [{ sizeName: "small", data: new ArrayBuffer(2) }]
    })
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    let disposed = false
    const disposal = instance.dispose().then(() => {
      disposed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(disposed).toBe(false)
    const commits = store.commit.mock.calls.length
    release()
    await disposal
    expect(store.commit).toHaveBeenCalledTimes(commits)
    expect(store.commit.mock.calls.flat().some((event) => event.args.sizesJson?.includes("\"done\""))).toBe(false)
  })

  it("gates generation by leadership and ignores old responses after handoff", async () => {
    const { config, lockStatus, writes } = setup(false)
    const instance = createThumbnails(config)
    instance.start()
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
    const worker = ControlledWorker.instances[0]!
    worker.emit({ type: "ready" })
    expect(worker.requests).toHaveLength(0)
    Effect.runSync(SubscriptionRef.set(lockStatus, "has-lock"))
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1))
    Effect.runSync(SubscriptionRef.set(lockStatus, "no-lock"))
    worker.emit({
      type: "complete",
      id: worker.requests[0].id,
      thumbnails: [{ sizeName: "small", data: new ArrayBuffer(2) }]
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).not.toHaveBeenCalled()
    Effect.runSync(SubscriptionRef.set(lockStatus, "has-lock"))
    await vi.waitFor(() => expect(worker.requests).toHaveLength(2))
    await instance.dispose()
  })

  it("keeps replacement and overlapping singleton mounts alive after stale disposal", async () => {
    const a = setup()
    const b = setup()
    const config = (value: ReturnType<typeof setup>) => ({ ...value.config, autoStart: false })
    const releaseA = initThumbnails(a.config.store, config(a))
    const releaseB1 = initThumbnails(b.config.store, config(b))
    const releaseB2 = initThumbnails(b.config.store, config(b))
    await releaseA()
    await releaseB1()
    await releaseB1()
    // Resolve the actual runtime before using its synchronous state accessor.
    const { resolveThumbnailUrl } = await import("../src/thumbnails/api/singleton.js")
    expect(await resolveThumbnailUrl("missing", "small")).toBeNull()
    expect(getThumbnailState("missing")).toBeNull()
    await releaseB2()
    expect(() => getThumbnailState("missing")).toThrow("not initialized")
  })

  it("broadcasts real generation events even when another listener throws", async () => {
    const { config } = setup()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const offBad = onThumbnailEvent(() => {
      throw new Error("listener")
    })
    const events: Array<string> = []
    const offGood = onThumbnailEvent((event) => events.push(event.type))
    const release = initThumbnails(config.store, config)
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1))
    ControlledWorker.instances[0]!.emit({ type: "ready" })
    await vi.waitFor(() => expect(events).toContain("thumbnail:generation-started"))
    await release()
    offBad()
    offGood()
    error.mockRestore()
  })
})
