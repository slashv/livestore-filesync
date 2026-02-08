import { FileSystem } from "@effect/platform/FileSystem"
import { Layer } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { disposeThumbnails, initThumbnails } from "../src/thumbnails/api/singleton.js"

const {
  createThumbnailsMock,
  disposeMock,
  startMock,
  stopMock
} = vi.hoisted(() => ({
  createThumbnailsMock: vi.fn(),
  disposeMock: vi.fn(async () => undefined),
  startMock: vi.fn(),
  stopMock: vi.fn()
}))

vi.mock("../src/thumbnails/api/createThumbnails.js", () => ({
  createThumbnails: createThumbnailsMock
}))

describe("thumbnail singleton API", () => {
  beforeEach(async () => {
    createThumbnailsMock.mockReset()
    disposeMock.mockClear()
    startMock.mockClear()
    stopMock.mockClear()

    createThumbnailsMock.mockReturnValue({
      dispose: disposeMock,
      getThumbnailState: vi.fn(() => null),
      regenerate: vi.fn(async () => undefined),
      resolveThumbnailOrFileUrl: vi.fn(async () => null),
      resolveThumbnailUrl: vi.fn(async () => null),
      start: startMock,
      stop: stopMock
    })

    await disposeThumbnails()
  })

  it("initializes with schema tables and no external queryDb", async () => {
    const filesTable = {
      select: vi.fn(() => ({ type: "select" })),
      where: vi.fn(() => ({ type: "where" }))
    }
    const fileSystem = Layer.succeed(FileSystem, {} as any)

    const dispose = initThumbnails(
      { schema: { state: { sqlite: { tables: new Map() } } } } as any,
      {
        fileSystem,
        schema: { tables: { files: filesTable } },
        sizes: { small: 128 },
        workerUrl: "/thumbnail.worker.js"
      }
    )

    const call = createThumbnailsMock.mock.calls[0]?.[0]

    expect(call).toBeDefined()
    expect(call.filesTable).toBe(filesTable)
    expect(call).not.toHaveProperty("queryDb")
    expect(startMock).toHaveBeenCalledTimes(1)

    await dispose()
  })
})
