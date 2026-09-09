import { Effect, Semaphore } from "effect"
import type { FileRecord, LocalFilesState, LocalFileState } from "../../types/index.js"
import type { LocalFileStateManagerService } from "../local-file-state/LocalFileStateManager.js"
import type { SyncExecutorService, TransferKind } from "../sync-executor/SyncExecutor.js"

export interface FileRepair {
  readonly fileId: string
  readonly attempts: number
  readonly retryErrors?: boolean
}

const sameState = (a: LocalFileState | undefined, b: LocalFileState | undefined) =>
  a === b || (!!a && !!b && a.path === b.path && a.localHash === b.localHash &&
    a.uploadStatus === b.uploadStatus && a.downloadStatus === b.downloadStatus && a.lastSyncError === b.lastSyncError)

/** Queues are a cache of durable work. Routine recovery preserves terminal errors. */
export const makeReconciliation = (deps: {
  state: LocalFileStateManagerService
  executor: SyncExecutorService
  localOnly: boolean
  readFile: (id: string) => FileRecord | undefined
  inspect: (file: FileRecord) => Effect.Effect<LocalFileState | undefined, unknown>
  remove: (file: FileRecord) => Effect.Effect<void>
  readRepairs: () => ReadonlyArray<FileRepair>
  writeRepairs: (update: (repairs: ReadonlyArray<FileRepair>) => ReadonlyArray<FileRepair>) => Effect.Effect<void>
  onError: (fileId: string, error: unknown) => Effect.Effect<void>
  maxRepairAttempts: number
}) => {
  const mutex = Semaphore.makeUnsafe(1)
  const recover = (retryErrors = false): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function*() {
      const retried = new Set<string>()
      yield* deps.state.atomicUpdate((state) => {
        const next = { ...state }
        for (const [id, local] of Object.entries(state)) {
          const updated = { ...local }
          for (const kind of ["upload", "download"] as const) {
            const field = kind === "upload" ? "uploadStatus" : "downloadStatus"
            if (deps.localOnly) updated[field] = "done"
            else if (!deps.executor.hasTask(kind, id)) {
              if (local[field] === "inProgress" || (retryErrors && local[field] === "error")) {
                updated[field] = "queued"
                updated.lastSyncError = ""
                if (local[field] === "error") retried.add(id)
              }
            }
          }
          if (deps.localOnly) updated.lastSyncError = ""
          next[id] = updated
        }
        return next
      })
      if (!deps.localOnly) {
        const state = yield* deps.state.getState()
        for (const [id, local] of Object.entries(state)) {
          if (local.uploadStatus !== "queued" && local.downloadStatus !== "queued") continue
          const file = deps.readFile(id)
          if (!file || file.deletedAt) continue
          for (const kind of ["upload", "download"] as const) {
            const field = kind === "upload" ? "uploadStatus" : "downloadStatus"
            if (local[field] !== "queued" || deps.executor.hasTask(kind, id)) continue
            yield* enqueue(kind, id)
          }
        }
      }
      return Array.from(retried)
    })

  const enqueue = (kind: TransferKind, id: string) =>
    kind === "upload" ? deps.executor.enqueueUpload(id) : deps.executor.enqueueDownload(id)

  // Collect a patch, then compare both metadata and local state at synchronous commit time.
  // Storage reads can yield while save/update or a transfer publishes newer state.
  const reconcileUnlocked = (ids: ReadonlyArray<string>, retryErrors = false): Effect.Effect<void> =>
    Effect.gen(function*() {
      if (ids.length === 0) return
      const before = yield* deps.state.getState()
      const patch: Record<string, { file: FileRecord; state: LocalFileState | undefined }> = {}
      for (const id of ids) {
        const file = deps.readFile(id)
        if (!file) {
          yield* deps.writeRepairs((repairs) => repairs.filter((r) => r.fileId !== id))
          continue
        }
        yield* Effect.gen(function*() {
          const state = file.deletedAt ? undefined : yield* deps.inspect(file)
          if (file.deletedAt) yield* deps.remove(file)
          patch[id] = { file, state }
        }).pipe(Effect.catch((error) =>
          Effect.gen(function*() {
            yield* deps.writeRepairs((repairs) => [
              ...repairs.filter((r) => r.fileId !== id),
              {
                fileId: id,
                attempts: (repairs.find((r) => r.fileId === id)?.attempts ?? 0) + 1,
                retryErrors: retryErrors || repairs.find((r) => r.fileId === id)?.retryErrors === true
              }
            ])
            yield* deps.onError(id, error)
          })
        ))
      }
      const pending: Array<{ kind: TransferKind; id: string }> = []
      const applied = new Set<string>()
      yield* deps.state.atomicUpdate((current) => {
        const next: Record<string, LocalFileState> = { ...current }
        for (const [id, candidate] of Object.entries(patch)) {
          const file = deps.readFile(id)
          if (
            !file || file.path !== candidate.file.path || file.contentHash !== candidate.file.contentHash ||
            file.remoteKey !== candidate.file.remoteKey ||
            file.deletedAt?.getTime() !== candidate.file.deletedAt?.getTime() ||
            !sameState(current[id], before[id])
          ) continue
          applied.add(id)
          if (candidate.state) {
            next[id] = preserveAttempt(current, id, candidate.state, retryErrors)
            if (!deps.localOnly) {
              if (
                next[id].uploadStatus === "queued" || (retryErrors && candidate.state.uploadStatus === "queued")
              ) pending.push({ kind: "upload", id })
              if (
                next[id].downloadStatus === "queued" || (retryErrors && candidate.state.downloadStatus === "queued")
              ) pending.push({ kind: "download", id })
            }
          } else delete next[id]
        }
        return next
      })
      // Publish durable state before retiring repair work; interruption can only cause a harmless replay.
      yield* deps.writeRepairs((repairs) => {
        const next = repairs.filter((r) => !applied.has(r.fileId))
        for (const id of Object.keys(patch)) {
          if (applied.has(id)) continue
          const index = next.findIndex((r) => r.fileId === id)
          if (index < 0) next.push({ fileId: id, attempts: 0, retryErrors })
          else if (retryErrors) next[index] = { ...next[index], retryErrors: true }
        }
        return next
      })
      for (const { id, kind } of pending) yield* enqueue(kind, id)
    })

  const preserveAttempt = (
    current: LocalFilesState,
    id: string,
    next: LocalFileState,
    retryErrors: boolean
  ): LocalFileState => {
    const existing = current[id]
    if (!existing || existing.path !== next.path || existing.localHash !== next.localHash) return next
    const result = { ...next }
    for (const field of ["uploadStatus", "downloadStatus"] as const) {
      if (
        next[field] === "queued" && (existing[field] === "inProgress" || (!retryErrors && existing[field] === "error"))
      ) {
        result[field] = existing[field]
        result.lastSyncError = existing.lastSyncError
      }
    }
    return result
  }

  const reconcile = (ids: ReadonlyArray<string>, retryErrors = false) =>
    mutex.withPermit(reconcileUnlocked(ids, retryErrors))

  // Read repair intent inside the lock: a stale heartbeat snapshot must not retry
  // terminal work already repaired by an event or an explicit retry.
  const repair = (): Effect.Effect<void> =>
    mutex.withPermit(Effect.gen(function*() {
      for (const entry of deps.readRepairs()) {
        if (entry.attempts < deps.maxRepairAttempts) yield* reconcileUnlocked([entry.fileId], entry.retryErrors)
      }
    }))

  return { reconcile, recover, repair }
}
