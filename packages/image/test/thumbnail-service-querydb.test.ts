import { FileSystem } from "@effect/platform/FileSystem"
import type * as LiveStoreModule from "@livestore/livestore"
import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import { createThumbnailSchema } from "../src/thumbnails/schema/index.js"
import { LocalThumbnailStorage } from "../src/thumbnails/services/LocalThumbnailStorage.js"
import { makeThumbnailService } from "../src/thumbnails/services/ThumbnailService.js"
import { ThumbnailWorkerClient } from "../src/thumbnails/services/ThumbnailWorkerClient.js"

const { queryDbMock } = vi.hoisted(() => ({
  queryDbMock: vi.fn((query: unknown) => query)
}))

vi.mock("@livestore/livestore", async (importOriginal) => {
  const actual = await importOriginal<typeof LiveStoreModule>()
  return {
    ...actual,
    queryDb: queryDbMock
  }
})

const makeService = async ({
  filesTable,
  store
}: {
  filesTable: { select: () => unknown; where: (conditions: unknown) => unknown }
  store: { commit: (event: unknown) => void; query: (query: unknown) => unknown }
}) => {
  const thumbnailSchema = createThumbnailSchema()

  const workerClientLayer = Layer.succeed(ThumbnailWorkerClient, {
    generate: () => Effect.succeed({ thumbnails: [] }),
    isReady: () => Effect.succeed(true),
    terminate: () => Effect.succeed(undefined),
    waitForReady: () => Effect.succeed(undefined)
  } as any)

  const storageLayer = Layer.succeed(LocalThumbnailStorage, {
    deleteThumbnails: () => Effect.succeed(undefined),
    getThumbnailPath: () => "thumbnails/mock.webp",
    getThumbnailUrl: () => Effect.succeed("blob:mock"),
    readThumbnail: () => Effect.succeed(new Uint8Array()),
    thumbnailExists: () => Effect.succeed(false),
    writeThumbnail: () => Effect.succeed("thumbnails/mock.webp")
  } as any)

  const fileSystemLayer = Layer.succeed(FileSystem, {
    exists: () => Effect.succeed(false),
    readFile: () => Effect.succeed(new Uint8Array())
  } as any)

  return Effect.runPromise(
    makeThumbnailService(store as any, thumbnailSchema.tables, thumbnailSchema.events, {
      concurrency: 1,
      filesTable: filesTable as any,
      format: "webp",
      pollInterval: 0,
      sizes: { small: 128 },
      supportedMimeTypes: ["image/jpeg", "image/png", "image/webp"]
    }).pipe(Effect.provide(Layer.mergeAll(workerClientLayer, storageLayer, fileSystemLayer)))
  )
}

describe("ThumbnailService query behavior", () => {
  it("scans files on start when filesTable is present without external queryDb", async () => {
    queryDbMock.mockClear()

    const selectQuery = { kind: "files.select" }
    const filesTable = {
      select: vi.fn(() => selectQuery),
      where: vi.fn()
    }

    const store = {
      commit: vi.fn(),
      query: vi
        .fn<(query: unknown) => unknown>()
        // readConfig()
        .mockReturnValueOnce([])
        // scanExistingFiles() -> files table
        .mockReturnValueOnce([])
    }

    const service = await makeService({ filesTable, store })
    await Effect.runPromise(service.start())

    expect(filesTable.select).toHaveBeenCalledTimes(1)
    expect(queryDbMock).toHaveBeenCalledWith(selectQuery)
    expect(store.query).toHaveBeenCalledWith(selectQuery)

    await Effect.runPromise(service.stop())
  })

  it("regenerate queries files table and queues work without external queryDb", async () => {
    queryDbMock.mockClear()

    const whereQuery = { kind: "files.where" }
    const filesTable = {
      select: vi.fn(),
      where: vi.fn(() => whereQuery)
    }

    const store = {
      commit: vi.fn(),
      query: vi
        .fn<(query: unknown) => unknown>(() => [])
        // regenerate() -> files table lookup
        .mockReturnValueOnce([
          {
            contentHash: "content-hash",
            deletedAt: null,
            id: "file-1",
            path: "photo.jpg",
            remoteKey: "remote-key"
          }
        ])
        // regenerate() -> readFileThumbnailState(fileId)
        .mockReturnValueOnce([])
        // queueFile() -> readFileThumbnailState(file.id)
        .mockReturnValueOnce([])
    }

    const service = await makeService({ filesTable, store })
    await Effect.runPromise(service.regenerate("file-1"))

    expect(filesTable.where).toHaveBeenCalledWith({ id: "file-1" })
    expect(queryDbMock).toHaveBeenCalledWith(whereQuery)
    expect(store.query).toHaveBeenCalledWith(whereQuery)
    expect(store.commit).toHaveBeenCalled()
  })
})
