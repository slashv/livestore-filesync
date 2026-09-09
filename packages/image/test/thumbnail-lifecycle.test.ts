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
  const states = new Map<string, any>()
  let configRow: any
  const store = {
    [StoreInternalsSymbol]: { clientSession: { lockStatus } },
    query: (query: any) => {
      if (query === select) return [{ id: "file", contentHash: "hash", path: "photo.jpg", deletedAt: null }]
      if (query.tableDef?.name === "thumbnailConfig") return configRow ? [configRow] : []
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
  const fileSystem = Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(true),
    readFile: () => Effect.succeed(new Uint8Array(12)),
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
  return { config, store, lockStatus, writes }
}
afterEach(async () => {
  await disposeThumbnails()
  ControlledWorker.instances = []
})

describe("public thumbnail lifecycle", () => {
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
