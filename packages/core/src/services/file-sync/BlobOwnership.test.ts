import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { LocalFileStorage, LocalFileStorageMemory } from "../local-file-storage/index.js"
import { makeBlobOwnership } from "./BlobOwnership.js"

const setup = async () => {
  const storage = await Effect.runPromise(LocalFileStorage.pipe(Effect.provide(LocalFileStorageMemory)))
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const references = new Set<string>()
  const blobs = await Effect.runPromise(makeBlobOwnership({
    ...storage,
    deleteFile: (path) =>
      Effect.gen(function*() {
        yield* Effect.promise(async () => {
          enter()
          await released
        })
        yield* storage.deleteFile(path)
      })
  }, (path) => references.has(path)))
  await Effect.runPromise(storage.writeFile("shared", new File(["shared bytes"], "file.txt")))
  return { storage, blobs, references, entered, release }
}

describe("asynchronous local blob cleanup", () => {
  it("restores bytes when synced metadata adds an owner during adapter deletion", async () => {
    const t = await setup()
    const cleanup = Effect.runPromise(t.blobs.cleanup("shared"))
    try {
      await t.entered
      t.references.add("shared")
    } finally {
      t.release()
    }
    await cleanup
    expect(await (await Effect.runPromise(t.storage.readFile("shared"))).text()).toBe("shared bytes")
  })

  it("serializes new byte publication after an already pending deletion", async () => {
    const t = await setup()
    const cleanup = Effect.runPromise(t.blobs.cleanup("shared"))
    await t.entered
    const publication = Effect.runPromise(t.blobs.publish(Effect.gen(function*() {
      yield* t.storage.writeFile("shared", new File(["shared bytes"], "file.txt"))
      t.references.add("shared")
    })))
    t.release()
    await Promise.all([cleanup, publication])
    expect(t.references.has("shared")).toBe(true)
    expect(await (await Effect.runPromise(t.storage.readFile("shared"))).text()).toBe("shared bytes")
  })

  it("restores bytes for a transfer that starts while deletion is pending", async () => {
    const t = await setup()
    const cleanup = Effect.runPromise(t.blobs.cleanup("shared"))
    await t.entered
    let started!: () => void
    const transferStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const transfer = Effect.runPromise(t.blobs.duringTransfer(
      "shared",
      Effect.gen(function*() {
        started()
        return yield* t.blobs.publish(t.storage.readFile("shared"))
      })
    ))
    await transferStarted
    t.release()
    await cleanup
    expect(await (await transfer).text()).toBe("shared bytes")
    expect(await Effect.runPromise(t.storage.fileExists("shared"))).toBe(false)
  })
})
