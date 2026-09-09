import { Effect, Semaphore } from "effect"
import type { LocalFileStorageService } from "../local-file-storage/LocalFileStorage.js"

/** Local byte lifetime. Remote objects are retained: this device cannot know offline owners. */
export const makeBlobOwnership = (
  storage: LocalFileStorageService,
  isReferenced: (path: string) => boolean
) =>
  Effect.gen(function*() {
    const mutex = yield* Semaphore.make(1)
    const transfers = new Map<string, number>()
    const owned = (path: string) => isReferenced(path) || (transfers.get(path) ?? 0) > 0

    // Keep a copy until deletion settles: synced metadata can change outside our mutex.
    // If reading fails, retain the blob rather than risk an irreversible deletion.
    const cleanup = (path: string): Effect.Effect<void> =>
      mutex.withPermit(
        Effect.gen(function*() {
          if (owned(path)) return
          if (!(yield* storage.fileExists(path))) return
          const backup = yield* storage.readFile(path)
          if (owned(path)) return
          yield* storage.deleteFile(path)
          if (owned(path)) yield* storage.writeFile(path, backup)
        }).pipe(Effect.catch(() => Effect.void), Effect.uninterruptible)
      )

    const duringTransfer = <A, E, R>(path: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => transfers.set(path, (transfers.get(path) ?? 0) + 1)),
        () => effect,
        () =>
          Effect.gen(function*() {
            const remaining = (transfers.get(path) ?? 1) - 1
            if (remaining > 0) transfers.set(path, remaining)
            else transfers.delete(path)
            yield* cleanup(path)
          })
      )

    // The write and its metadata publication must finish together, including on cancellation.
    const publish = <A, E, R>(effect: Effect.Effect<A, E, R>) => mutex.withPermit(effect.pipe(Effect.uninterruptible))

    return { cleanup, duringTransfer, publish }
  })
