import { createFileSyncSchema } from "@livestore-filesync/core/schema"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, makeSchema, queryDb, State } from "@livestore/livestore"
import { Effect, Layer } from "effect"
import * as FS from "effect/FileSystem"
import { describe, expect, it, vi } from "vitest"
import { createThumbnailSchema } from "../src/thumbnails/schema/index.js"
import { LocalThumbnailStorageLive } from "../src/thumbnails/services/LocalThumbnailStorage.js"
import { makeThumbnailService, type ThumbnailServiceService } from "../src/thumbnails/services/ThumbnailService.js"
import { ThumbnailWorkerClient } from "../src/thumbnails/services/ThumbnailWorkerClient.js"
import type { ThumbnailFormat, ThumbnailSizes } from "../src/thumbnails/types/index.js"

const setup = async () => {
  const files = createFileSyncSchema()
  const thumbnails = createThumbnailSchema()
  const tables = { ...files.tables, ...thumbnails.tables }
  const events = { ...files.events, ...thumbnails.events }
  const schema = makeSchema({
    events,
    state: State.SQLite.makeState({
      tables,
      materializers: State.SQLite.materializers(events, {
        ...files.createMaterializers(tables),
        ...thumbnails.createMaterializers(tables)
      })
    })
  })
  const store = await createStorePromise({ schema, adapter: makeInMemoryAdapter(), storeId: crypto.randomUUID() })
  const bytes = new Map<string, Uint8Array>([["photo.jpg", new Uint8Array(12)]])
  const removals: Array<string> = []
  const fileSystem = Layer.succeed(
    FS.FileSystem,
    FS.makeNoop({
      exists: (path) => Effect.succeed(bytes.has(path) || [...bytes.keys()].some((key) => key.startsWith(`${path}/`))),
      readFile: (path) => Effect.sync(() => bytes.get(path)!),
      makeDirectory: () => Effect.void,
      writeFile: (path, data) =>
        Effect.sync(() => {
          bytes.set(path, data.slice())
        }),
      remove: (path) =>
        Effect.sync(() => {
          removals.push(path)
          for (const key of bytes.keys()) if (key === path || key.startsWith(`${path}/`)) bytes.delete(key)
        })
    })
  )
  const generate = vi.fn((
    _data: ArrayBuffer,
    _path: string,
    _hash: string,
    sizes: ThumbnailSizes,
    _format: ThumbnailFormat
  ) =>
    Effect.succeed({
      thumbnails: Object.entries(sizes).map(([sizeName, dimension]) => ({
        sizeName,
        width: dimension,
        height: dimension,
        mimeType: `image/${_format}`,
        data: new Uint8Array([dimension % 256, 42]).buffer
      }))
    })
  )
  const dependencies = Layer.mergeAll(
    fileSystem,
    LocalThumbnailStorageLive.pipe(Layer.provide(fileSystem)),
    Layer.succeed(ThumbnailWorkerClient, {
      generate,
      waitForReady: () => Effect.void,
      isReady: () => Effect.succeed(true),
      terminate: () => Effect.void
    })
  )
  store.commit(
    events.fileCreated({
      id: "file",
      path: "photo.jpg",
      contentHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date()
    })
  )
  let service: ThumbnailServiceService | undefined
  return {
    bytes,
    removals,
    generate,
    config: () => store.query(queryDb(tables.thumbnailConfig.select())),
    state: () => service!.getThumbnailState("file").pipe(Effect.runPromise),
    async start(sizes: ThumbnailSizes, format: ThumbnailFormat = "webp") {
      if (service) await Effect.runPromise(service.stop())
      service = await Effect.runPromise(
        makeThumbnailService(store, thumbnails.tables, thumbnails.events, {
          sizes,
          format,
          concurrency: 1,
          supportedMimeTypes: ["image/jpeg"],
          pollInterval: 0,
          filesTable: tables.files
        }).pipe(Effect.provide(dependencies))
      )
      await Effect.runPromise(service.start())
    },
    async done(sizes: Array<string>) {
      await vi.waitFor(async () => {
        const state = await this.state()
        expect(Object.keys(state?.sizes ?? {}).sort()).toEqual([...sizes].sort())
        for (const size of sizes) expect(state?.sizes[size]?.status).toBe("done")
      })
    },
    async close() {
      if (service) await Effect.runPromise(service.stop())
      await store.shutdownPromise()
    }
  }
}

describe("ThumbnailService persisted configuration", () => {
  it("preserves completed bytes and state when restarted with unchanged config", async () => {
    const t = await setup()
    try {
      await t.start({ small: 128 })
      await t.done(["small"])
      const state = await t.state()
      const config = t.config()
      const bytes = new Map(t.bytes)
      await t.start({ small: 128 })
      expect(await t.state()).toEqual(state)
      expect(t.config()).toEqual(config)
      expect(t.bytes).toEqual(bytes)
      expect(t.removals).toEqual([])
      expect(t.generate).toHaveBeenCalledOnce()
    } finally {
      await t.close()
    }
  })

  for (
    const change of [
      { sizes: { small: 64 }, format: "webp" },
      { sizes: { small: 128, large: 200 }, format: "webp" },
      { sizes: { renamed: 128 }, format: "webp" },
      { before: { small: 128, large: 200 }, sizes: { small: 128 }, format: "webp" },
      { sizes: { small: 128 }, format: "jpeg" }
    ] as Array<{ before?: ThumbnailSizes; sizes: ThumbnailSizes; format: ThumbnailFormat }>
  ) {
    it(`invalidates old storage and regenerates for ${JSON.stringify(change)}`, async () => {
      const t = await setup()
      try {
        const before = change.before ?? { small: 128 }
        await t.start(before)
        await t.done(Object.keys(before))
        const previousConfig = t.config()
        await t.start(change.sizes, change.format)
        await t.done(Object.keys(change.sizes))
        expect(t.config()).not.toEqual(previousConfig)
        expect(t.removals).toContain("thumbnails/hash")
        for (const name of Object.keys(before)) {
          if (!(name in change.sizes) || change.format !== "webp") {
            expect(t.bytes.has(`thumbnails/hash/${name}.webp`)).toBe(false)
          }
        }
        expect(t.generate).toHaveBeenCalledTimes(2)
        expect(t.generate.mock.calls[1]?.slice(3)).toEqual([change.sizes, change.format, undefined])
        for (const [name, dimension] of Object.entries(change.sizes)) {
          expect(t.bytes.get(`thumbnails/hash/${name}.${change.format}`)).toEqual(new Uint8Array([dimension % 256, 42]))
        }
      } finally {
        await t.close()
      }
    })
  }
})
