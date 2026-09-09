import { Effect, Layer } from "effect"
import * as FS from "effect/FileSystem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestStore } from "../../test/helpers/livestore.js"
import { createFileSync } from "./createFileSync.js"
import {
  disposeFileSync,
  initFileSync,
  isOnline,
  onFileSyncEvent,
  readFile,
  saveFile,
  startFileSync,
  stopFileSync
} from "./singleton.js"

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const memoryFs = () => {
  const bytes = new Map<string, Uint8Array>()
  return FS.makeNoop({
    exists: (path) => Effect.succeed(bytes.has(path)),
    makeDirectory: () => Effect.void,
    writeFile: (path, data) =>
      Effect.sync(() => {
        bytes.set(path, data)
      }),
    readFile: (path) => Effect.sync(() => bytes.get(path)!),
    remove: (path) =>
      Effect.sync(() => {
        bytes.delete(path)
      }),
    readDirectory: () => Effect.succeed([])
  })
}

const file = () => new File(["lifecycle bytes"], "lifecycle.txt", { type: "text/plain" })

afterEach(async () => {
  await disposeFileSync()
  vi.restoreAllMocks()
})

describe("public FileSync lifecycle", () => {
  it("binds overlapping mounts and stale user disposers to their originating generation", async () => {
    const test = await createTestStore()
    const config = { fileSystem: Layer.succeed(FS.FileSystem, memoryFs()), remote: false as const, autoStart: false }
    try {
      const old = initFileSync(test.store, { ...config, userId: "A" })
      const current = initFileSync(test.store, { ...config, userId: "B" })
      const overlap = initFileSync(test.store, { ...config, userId: "B" })
      await old()
      await old()
      const saved = await saveFile(file())
      expect(await (await readFile(saved.path)).text()).toBe("lifecycle bytes")
      await current()
      expect(isOnline()).toBe(true)
      await overlap()
      expect(() => isOnline()).toThrow("not initialized")
    } finally {
      await disposeFileSync()
      await test.shutdown()
    }
  })

  it("recognizes a new store object even when the store ID is unchanged", async () => {
    const first = await createTestStore({ storeId: "same-id" })
    const second = await createTestStore({ storeId: "same-id" })
    const config = { fileSystem: Layer.succeed(FS.FileSystem, memoryFs()), remote: false as const, autoStart: false }
    try {
      const old = initFileSync(first.store, config)
      initFileSync(second.store, config)
      await old()
      const saved = await saveFile(file())
      expect(first.store.query(first.tables.files)).toHaveLength(0)
      expect(second.store.query(second.tables.files)[0]?.id).toBe(saved.fileId)
    } finally {
      await disposeFileSync()
      await first.shutdown()
      await second.shutdown()
    }
  })

  it("global disposal cannot clear a replacement while old resources are closing", async () => {
    const test = await createTestStore()
    const closing = barrier()
    const finish = barrier()
    const fs = memoryFs()
    const slowLayer = Layer.effect(
      FS.FileSystem,
      Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            closing.release()
            await finish.promise
          })
        )
        return fs
      })
    )
    try {
      initFileSync(test.store, { fileSystem: slowLayer, remote: false, autoStart: false })
      await saveFile(file())
      const disposing = disposeFileSync()
      await closing.promise
      initFileSync(test.store, {
        fileSystem: Layer.succeed(FS.FileSystem, memoryFs()),
        remote: false,
        autoStart: false
      })
      finish.release()
      await disposing
      const saved = await saveFile(file())
      expect(await (await readFile(saved.path)).text()).toBe("lifecycle bytes")
    } finally {
      finish.release()
      await disposeFileSync()
      await test.shutdown()
    }
  })

  it("gates explicit replacement startup on retirement and lets stop cancel deferred startup", async () => {
    const test = await createTestStore()
    const closing = barrier()
    const finish = barrier()
    let replacementAcquired = false
    const oldLayer = Layer.effect(
      FS.FileSystem,
      Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            closing.release()
            await finish.promise
          })
        )
        return memoryFs()
      })
    )
    try {
      initFileSync(test.store, { fileSystem: oldLayer, remote: false, autoStart: false })
      await saveFile(file())
      const disposing = disposeFileSync()
      await closing.promise
      let secondFinished = false
      const secondDisposal = disposeFileSync().then(() => {
        secondFinished = true
      })
      initFileSync(test.store, {
        remote: false,
        fileSystem: Layer.effect(
          FS.FileSystem,
          Effect.sync(() => {
            replacementAcquired = true
            return memoryFs()
          })
        )
      })
      const starting = startFileSync()
      await stopFileSync()
      expect(replacementAcquired).toBe(false)
      expect(secondFinished).toBe(false)
      finish.release()
      await Promise.all([disposing, secondDisposal, starting])
      expect(replacementAcquired).toBe(false)
      await startFileSync()
      expect(replacementAcquired).toBe(true)
    } finally {
      finish.release()
      await disposeFileSync()
      await test.shutdown()
    }
  })

  it("serializes start/stop/start across asynchronous acquisition and releases resources once", async () => {
    const test = await createTestStore()
    const entered = barrier()
    const release = barrier()
    let acquired = 0
    let closed = 0
    const instance = createFileSync({
      store: test.store,
      schema: test.deps.schema,
      remote: false,
      fileSystem: Layer.effect(
        FS.FileSystem,
        Effect.gen(function*() {
          acquired++
          entered.release()
          yield* Effect.promise(() => release.promise)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed++
            })
          )
          return memoryFs()
        })
      )
    })
    try {
      const starting = instance.start()
      await entered.promise
      const stopping = instance.stop()
      const restarting = instance.start()
      release.release()
      await Promise.all([starting, stopping, restarting])
      const saved = await instance.saveFile(file())
      expect(await (await instance.readFile(saved.path)).text()).toBe("lifecycle bytes")
      const disposal = instance.dispose()
      expect(instance.dispose()).toBe(disposal)
      await disposal
      expect(acquired).toBe(1)
      expect(closed).toBe(1)
      await expect(instance.saveFile(file())).rejects.toThrow("disposed")
    } finally {
      release.release()
      await instance.dispose()
      await test.shutdown()
    }
  })

  it("can retry failed layer startup and isolates event listeners", async () => {
    const test = await createTestStore()
    let attempts = 0
    const received: Array<string> = []
    const instance = createFileSync({
      store: test.store,
      schema: test.deps.schema,
      remote: false,
      fileSystem: Layer.effect(
        FS.FileSystem,
        Effect.suspend(() => {
          attempts++
          return attempts === 1 ? Effect.die("startup failed") : Effect.succeed(memoryFs())
        })
      ),
      options: {
        onEvent: (event) => {
          received.push(event.type)
        }
      }
    })
    try {
      await instance.start()
      expect(received).toContain("sync:error")
      await instance.start()
      const saved = await instance.saveFile(file())
      expect(await (await instance.readFile(saved.path)).text()).toBe("lifecycle bytes")
      expect(attempts).toBe(2)
    } finally {
      await instance.dispose()
      await test.shutdown()
    }
  })

  it("broadcasts startup failures past throwing configured and global listeners", async () => {
    const test = await createTestStore()
    const received: Array<string> = []
    const offBad = onFileSyncEvent(() => {
      throw new Error("bad listener")
    })
    const offGood = onFileSyncEvent((event) => {
      received.push(event.type)
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      initFileSync(test.store, {
        fileSystem: Layer.effect(FS.FileSystem, Effect.die("startup failure")),
        remote: false,
        autoStart: false,
        options: {
          onEvent: () => {
            throw new Error("bad configured listener")
          }
        }
      })
      // Await explicit start so the test does not race automatic startup.
      await startFileSync()
      expect(received).toContain("sync:error")
    } finally {
      offBad()
      offGood()
      await disposeFileSync()
      await test.shutdown()
    }
  })
})
