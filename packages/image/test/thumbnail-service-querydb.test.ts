import type * as LiveStoreModule from "@livestore/livestore"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
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
  concurrency = 1,
  fileSystem,
  filesTable,
  store
}: {
  concurrency?: number
  fileSystem?: {
    exists: (path: string) => Effect.Effect<boolean>
    readFile: (path: string) => Effect.Effect<Uint8Array | null>
  }
  filesTable: { select: () => unknown; where: (conditions: unknown) => unknown }
  store: { commit: (...events: Array<unknown>) => void; query: (query: unknown) => unknown }
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
    exists: fileSystem?.exists ?? (() => Effect.succeed(false)),
    readFile: fileSystem?.readFile ?? (() => Effect.succeed(new Uint8Array()))
  } as any)

  return Effect.runPromise(
    makeThumbnailService(store as any, thumbnailSchema.tables, thumbnailSchema.events, {
      concurrency,
      filesTable: filesTable as any,
      format: "webp",
      pollInterval: 0,
      sizes: { small: 128 },
      supportedMimeTypes: ["image/jpeg", "image/png", "image/webp"]
    }).pipe(Effect.provide(Layer.mergeAll(workerClientLayer, storageLayer, fileSystemLayer)))
  )
}

describe("ThumbnailService query behavior", () => {
  const getEventName = (event: unknown): string | undefined =>
    typeof event === "object" && event !== null && "name" in event
      ? ((event as { name: unknown }).name as string)
      : undefined

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

  it("regenerate does not publish work while stopped", async () => {
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

    expect(filesTable.where).not.toHaveBeenCalled()
    expect(store.commit).not.toHaveBeenCalled()
  })

  it("batches thumbnail state upserts into a single commit when scanning on start", async () => {
    queryDbMock.mockClear()

    const selectQuery = { kind: "files.select" }
    const filesTable = {
      select: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery)
    }

    const files = [
      {
        contentHash: "hash-1",
        deletedAt: null,
        id: "file-1",
        path: "image-1.jpg",
        remoteKey: "remote-1"
      },
      {
        contentHash: "hash-2",
        deletedAt: null,
        id: "file-2",
        path: "image-2.png",
        remoteKey: "remote-2"
      },
      {
        contentHash: "hash-3",
        deletedAt: null,
        id: "file-3",
        path: "image-3.webp",
        remoteKey: "remote-3"
      }
    ]

    const store = {
      commit: vi.fn(),
      query: vi.fn((query: unknown) => query === selectQuery ? files : [])
    }

    const service = await makeService({ concurrency: 0, filesTable, store })
    await Effect.runPromise(service.start())

    const thumbnailUpsertCommitCalls = store.commit.mock.calls.filter((commitArgs) =>
      commitArgs.length > 0 &&
      commitArgs.every((event) => getEventName(event) === "v1.ThumbnailStateUpsert")
    )
    expect(thumbnailUpsertCommitCalls).toHaveLength(1)
    expect(thumbnailUpsertCommitCalls[0]).toHaveLength(files.length)

    expect(queryDbMock).toHaveBeenCalledWith(selectQuery)
    expect(store.query).toHaveBeenCalledWith(selectQuery)

    await Effect.runPromise(service.stop())
  })

  it("does not re-emit thumbnail state upserts on repeated unchanged scans", async () => {
    queryDbMock.mockClear()

    const selectQuery = { kind: "files.select" }
    const filesTable = {
      select: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery)
    }

    const files = [
      {
        contentHash: "hash-1",
        deletedAt: null,
        id: "file-1",
        path: "image-1.jpg",
        remoteKey: "remote-1"
      },
      {
        contentHash: "hash-2",
        deletedAt: null,
        id: "file-2",
        path: "document.bin",
        remoteKey: "remote-2"
      }
    ]

    const states = new Map<string, unknown>()
    const store = {
      commit: vi.fn((...events: Array<any>) => {
        for (const event of events) {
          if (getEventName(event) === "v1.ThumbnailStateUpsert") states.set(event.args.fileId, event.args)
        }
      }),
      query: vi.fn((query: any) => {
        if (query === selectQuery) return files
        const sql = query.asSql()
        if (sql.usedTables.has("thumbnailConfig")) return []
        const id = sql.bindValues[0]
        return id ? [states.get(id)].filter(Boolean) : [...states.values()]
      })
    }

    const service = await makeService({
      concurrency: 0,
      fileSystem: {
        exists: () => Effect.succeed(true),
        readFile: () => Effect.succeed(new Uint8Array(12))
      },
      filesTable,
      store
    })

    await Effect.runPromise(service.start())
    await Effect.runPromise(service.stop())
    await Effect.runPromise(service.start())
    await Effect.runPromise(service.stop())

    const thumbnailUpsertCommitCalls = store.commit.mock.calls.filter((commitArgs) =>
      commitArgs.length > 0 &&
      commitArgs.every((event) => getEventName(event) === "v1.ThumbnailStateUpsert")
    )
    expect(thumbnailUpsertCommitCalls).toHaveLength(1)
    expect(thumbnailUpsertCommitCalls[0]).toHaveLength(files.length)

    const committedEvents = thumbnailUpsertCommitCalls[0] as Array<{ args: { fileId: string; sizesJson: string } }>
    expect(committedEvents.map((event) => event.args.fileId)).toEqual(["file-1", "file-2"])
    expect(JSON.parse(committedEvents[1]!.args.sizesJson)).toEqual({ small: { status: "skipped" } })
  })
})
