/**
 * FileSyncProvider
 *
 * Vue provider that manages file synchronization with LiveStore.
 * This provider should be placed inside the LiveStoreProvider.
 *
 * @module
 */

import { defineComponent, provide, ref, onMounted, onUnmounted, type PropType } from "vue"
import { Effect, ManagedRuntime, Layer, Context } from "effect"
import { queryDb } from "@livestore/livestore"

import { FileSyncKey } from "./FileSyncContext.js"
import type {
  FileSyncService,
  LocalFileState,
  LocalFilesState,
  LocalStorageService,
  FileSaveResult,
  RemoteStorageAdapter
} from "./types.js"

// Effect services (simplified inline definitions to avoid import issues)
interface LocalFileStorageService {
  writeFile: (path: string, file: File) => Effect.Effect<void>
  writeBytes: (path: string, data: Uint8Array, mimeType?: string) => Effect.Effect<void>
  readFile: (path: string) => Effect.Effect<File>
  readBytes: (path: string) => Effect.Effect<Uint8Array>
  fileExists: (path: string) => Effect.Effect<boolean>
  deleteFile: (path: string) => Effect.Effect<void>
  getFileUrl: (path: string) => Effect.Effect<string>
  listFiles: (directory: string) => Effect.Effect<string[]>
  getRoot: () => Effect.Effect<FileSystemDirectoryHandle>
  ensureDirectory: (path: string) => Effect.Effect<void>
}

interface RemoteStorageService {
  upload: (file: File) => Effect.Effect<string, unknown>
  download: (url: string) => Effect.Effect<File, unknown>
  delete: (url: string) => Effect.Effect<void, unknown>
  checkHealth: () => Effect.Effect<boolean, unknown>
  getConfig: () => { baseUrl: string }
}

class LocalFileStorage extends Context.Tag("LocalFileStorage")<LocalFileStorage, LocalFileStorageService>() {}
class RemoteStorage extends Context.Tag("RemoteStorage")<RemoteStorage, RemoteStorageService>() {}

// Hash file function
const hashFile = (file: File): Effect.Effect<string, never, never> =>
  Effect.promise(async () => {
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  })

// Make stored path from hash
const makeStoredPath = (hash: string): string => {
  const prefix = hash.slice(0, 2)
  const suffix = hash.slice(2, 4)
  return `files/${prefix}/${suffix}/${hash}`
}

// Create LocalFileStorageLive layer
const LocalFileStorageLive = Layer.succeed(LocalFileStorage, {
  writeFile: (path: string, file: File) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!, { create: true })
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1]!, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(file)
      await writable.close()
    }),
  writeBytes: (path: string, data: Uint8Array, mimeType?: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!, { create: true })
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1]!, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(new Blob([data.buffer as ArrayBuffer], mimeType ? { type: mimeType } : undefined))
      await writable.close()
    }),
  readFile: (path: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!)
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1]!)
      return fileHandle.getFile()
    }),
  readBytes: (path: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!)
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1]!)
      const file = await fileHandle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    }),
  fileExists: (path: string) =>
    Effect.promise(async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const parts = path.split("/")
        let current = root
        for (let i = 0; i < parts.length - 1; i++) {
          current = await current.getDirectoryHandle(parts[i]!)
        }
        await current.getFileHandle(parts[parts.length - 1]!)
        return true
      } catch {
        return false
      }
    }),
  deleteFile: (path: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!)
      }
      await current.removeEntry(parts[parts.length - 1]!)
    }),
  getFileUrl: (path: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/")
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]!)
      }
      const fileHandle = await current.getFileHandle(parts[parts.length - 1]!)
      const file = await fileHandle.getFile()
      return URL.createObjectURL(file)
    }),
  listFiles: (directory: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = directory.split("/").filter(Boolean)
      let current = root
      for (const part of parts) {
        current = await current.getDirectoryHandle(part)
      }
      const files: string[] = []
      for await (const entry of (current as any).values()) {
        if (entry.kind === "file") {
          files.push(entry.name)
        }
      }
      return files
    }),
  getRoot: () =>
    Effect.promise(async () => {
      return navigator.storage.getDirectory()
    }),
  ensureDirectory: (path: string) =>
    Effect.promise(async () => {
      const root = await navigator.storage.getDirectory()
      const parts = path.split("/").filter(Boolean)
      let current = root
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: true })
      }
    })
})

// File record type
interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

// Schema types passed as props
interface FileSyncSchema {
  tables: {
    files: {
      where: (condition: { deletedAt?: null; id?: string }) => unknown
    }
    localFileState: {
      get: () => unknown
    }
  }
  events: {
    fileCreated: (data: {
      id: string
      path: string
      contentHash: string
      createdAt: Date
      updatedAt: Date
    }) => unknown
    fileUpdated: (data: {
      id: string
      path: string
      remoteUrl: string
      contentHash: string
      updatedAt: Date
    }) => unknown
    fileDeleted: (data: {
      id: string
      deletedAt: Date
    }) => unknown
    localFileStateSet: (data: { localFiles: LocalFilesState }) => unknown
  }
}

// Store interface type
interface StoreInterface {
  query: (q: unknown) => unknown
  commit: (e: unknown) => void
  subscribe: (q: unknown, opts: { onUpdate: (r: unknown) => void }) => () => void
}

export const FileSyncProvider = defineComponent({
  name: "FileSyncProvider",
  props: {
    remoteAdapter: {
      type: Object as PropType<RemoteStorageAdapter>,
      required: true
    },
    schema: {
      type: Object as PropType<FileSyncSchema>,
      required: true
    },
    store: {
      type: Object as PropType<StoreInterface>,
      required: true
    },
    maxConcurrentDownloads: {
      type: Number,
      default: 2
    },
    maxConcurrentUploads: {
      type: Number,
      default: 2
    },
    onEvent: {
      type: Function as PropType<(event: { type: string; fileId?: string; error?: unknown }) => void>,
      default: undefined
    }
  },
  setup(props, { slots }) {
    const store = props.store

    const { tables, events } = props.schema
    const isOnline = ref(true)
    const isInitialized = ref(false)
    let runtime: ManagedRuntime.ManagedRuntime<LocalFileStorage | RemoteStorage, unknown> | null = null
    const uploadQueue = new Set<string>()
    const downloadQueue = new Set<string>()
    let activeUploads = 0
    let activeDownloads = 0
    let healthCheckInterval: ReturnType<typeof setInterval> | null = null
    let unsubscribeFiles: (() => void) | null = null

    // Helper to run effects
    const runEffect = <A>(effect: Effect.Effect<A, unknown, LocalFileStorage | RemoteStorage>): Promise<A> => {
      if (!runtime) {
        return Promise.reject(new Error("Runtime not initialized"))
      }
      return runtime.runPromise(effect as Effect.Effect<A, never, LocalFileStorage | RemoteStorage>)
    }

    // Get local files state from store
    const getLocalFilesState = (): LocalFilesState => {
      try {
        const state = store.query(queryDb(tables.localFileState.get() as unknown as Parameters<typeof queryDb>[0]))
        return ((state as { localFiles?: LocalFilesState }).localFiles) || {}
      } catch {
        return {}
      }
    }

    // Merge local files state
    const mergeLocalFiles = (patch: Record<string, LocalFileState>) => {
      const current = getLocalFilesState()
      const event = events.localFileStateSet({ localFiles: { ...current, ...patch } })
      store.commit(event as Parameters<typeof store.commit>[0])
    }

    // Set transfer status
    const setTransferStatus = (
      fileId: string,
      action: "upload" | "download",
      status: "pending" | "queued" | "inProgress" | "done" | "error"
    ) => {
      const localFiles = getLocalFilesState()
      const localFile = localFiles[fileId]
      if (!localFile) return

      const field = action === "upload" ? "uploadStatus" : "downloadStatus"
      const event = events.localFileStateSet({
        localFiles: {
          ...localFiles,
          [fileId]: { ...localFile, [field]: status }
        }
      })
      store.commit(event as Parameters<typeof store.commit>[0])
    }

    // Start health checks when offline
    const startHealthChecks = () => {
      if (healthCheckInterval) return

      healthCheckInterval = setInterval(async () => {
        try {
          const ok = await runEffect(
            Effect.gen(function* () {
              const remote = yield* RemoteStorage
              return yield* remote.checkHealth()
            })
          )
          if (ok) {
            isOnline.value = true
            props.onEvent?.({ type: "online" })
            if (healthCheckInterval) {
              clearInterval(healthCheckInterval)
              healthCheckInterval = null
            }
          }
        } catch {
          // Remain offline
        }
      }, 10000)
    }

    // Download a file from remote
    const downloadRemoteFile = async (fileId: string): Promise<LocalFileState | null> => {
      try {
        const filesQuery = queryDb(tables.files.where({ id: fileId }) as unknown as Parameters<typeof queryDb>[0])
        const files = store.query(filesQuery) as FileRecord[]
        const file = files[0]
        if (!file || !file.remoteUrl) {
          throw new Error(`File ${fileId} not found or has no remote URL`)
        }

        props.onEvent?.({ type: "download:start", fileId })

        const downloadedFile = await runEffect(
          Effect.gen(function* () {
            const remote = yield* RemoteStorage
            return yield* remote.download(file.remoteUrl!)
          })
        )

        await runEffect(
          Effect.gen(function* () {
            const local = yield* LocalFileStorage
            yield* local.writeFile(file.path, downloadedFile)
          })
        )

        const hash = await runEffect(hashFile(downloadedFile))

        props.onEvent?.({ type: "download:complete", fileId })

        return {
          path: file.path,
          localHash: hash,
          downloadStatus: "done",
          uploadStatus: "done",
          lastSyncError: ""
        }
      } catch (error) {
        props.onEvent?.({ type: "download:error", fileId, error })
        startHealthChecks()
        return null
      }
    }

    // Upload a file to remote
    const uploadLocalFile = async (fileId: string): Promise<LocalFileState | null> => {
      try {
        const localFiles = getLocalFilesState()
        const localFile = localFiles[fileId]
        if (!localFile) {
          throw new Error(`Local file ${fileId} not found`)
        }

        props.onEvent?.({ type: "upload:start", fileId })

        const file = await runEffect(
          Effect.gen(function* () {
            const local = yield* LocalFileStorage
            return yield* local.readFile(localFile.path)
          })
        )

        const remoteUrl = await runEffect(
          Effect.gen(function* () {
            const remote = yield* RemoteStorage
            return yield* remote.upload(file)
          })
        )

        // Update the file record with the remote URL
        const event = events.fileUpdated({
          id: fileId,
          path: localFile.path,
          remoteUrl,
          contentHash: localFile.localHash,
          updatedAt: new Date()
        })
        store.commit(event as Parameters<typeof store.commit>[0])

        props.onEvent?.({ type: "upload:complete", fileId })

        return {
          ...localFile,
          uploadStatus: "done",
          lastSyncError: ""
        }
      } catch (error) {
        props.onEvent?.({ type: "upload:error", fileId, error })
        startHealthChecks()
        return null
      }
    }

    // Process queues
    const processQueues = async () => {
      if (!isOnline.value) return

      // Process downloads
      while (activeDownloads < props.maxConcurrentDownloads && downloadQueue.size > 0) {
        const fileId = downloadQueue.values().next().value
        if (!fileId) break

        downloadQueue.delete(fileId)
        activeDownloads++

        setTransferStatus(fileId, "download", "inProgress")

        downloadRemoteFile(fileId).then((result) => {
          if (result) {
            mergeLocalFiles({ [fileId]: result })
          }
          activeDownloads--
          processQueues()
        })
      }

      // Process uploads
      while (activeUploads < props.maxConcurrentUploads && uploadQueue.size > 0) {
        const fileId = uploadQueue.values().next().value
        if (!fileId) break

        uploadQueue.delete(fileId)
        activeUploads++

        setTransferStatus(fileId, "upload", "inProgress")

        uploadLocalFile(fileId).then((result) => {
          if (result) {
            mergeLocalFiles({ [fileId]: result })
          }
          activeUploads--
          processQueues()
        })
      }
    }

    // Create the localStorage service wrapper
    const localStorageService: LocalStorageService = {
      writeFile: (path: string, file: File) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          yield* local.writeFile(path, file)
        })
      ),
      writeBytes: (path: string, data: Uint8Array, mimeType?: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          yield* local.writeBytes(path, data, mimeType)
        })
      ),
      readFile: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.readFile(path)
        })
      ),
      readBytes: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.readBytes(path)
        })
      ),
      fileExists: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.fileExists(path)
        })
      ),
      deleteFile: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          yield* local.deleteFile(path)
        })
      ),
      getFileUrl: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.getFileUrl(path)
        })
      ),
      listFiles: (directory: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.listFiles(directory)
        })
      ),
      getRoot: () => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          return yield* local.getRoot()
        })
      ),
      ensureDirectory: (path: string) => runEffect(
        Effect.gen(function* () {
          const local = yield* LocalFileStorage
          yield* local.ensureDirectory(path)
        })
      )
    }

    // Create the service
    const service: FileSyncService = {
      saveFile: async (file: File): Promise<FileSaveResult> => {
        const contentHash = await runEffect(hashFile(file))
        const path = makeStoredPath(contentHash)

        // Write to local storage
        await runEffect(
          Effect.gen(function* () {
            const local = yield* LocalFileStorage
            yield* local.writeFile(path, file)
          })
        )

        // Generate ID (using hash as ID for content-addressable storage)
        const fileId = contentHash

        // Create file record
        const createEvent = events.fileCreated({
          id: fileId,
          path,
          contentHash,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        store.commit(createEvent as Parameters<typeof store.commit>[0])

        // Mark as pending upload
        mergeLocalFiles({
          [fileId]: {
            path,
            localHash: contentHash,
            downloadStatus: "done",
            uploadStatus: "queued",
            lastSyncError: ""
          }
        })

        // Queue for upload
        uploadQueue.add(fileId)
        processQueues()

        return { fileId, path, contentHash }
      },

      deleteFile: async (fileId: string): Promise<void> => {
        const event = events.fileDeleted({
          id: fileId,
          deletedAt: new Date()
        })
        store.commit(event as Parameters<typeof store.commit>[0])
      },

      getFileUrl: async (fileId: string): Promise<string | null> => {
        const localFiles = getLocalFilesState()
        const localFile = localFiles[fileId]

        if (localFile?.localHash) {
          try {
            const url = await runEffect(
              Effect.gen(function* () {
                const local = yield* LocalFileStorage
                const exists = yield* local.fileExists(localFile.path)
                if (!exists) return null
                return yield* local.getFileUrl(localFile.path)
              })
            )
            if (url) return url
          } catch {
            // Fall through to remote URL
          }
        }

        // Try remote URL
        const filesQuery = queryDb(tables.files.where({ id: fileId }) as unknown as Parameters<typeof queryDb>[0])
        const files = store.query(filesQuery) as FileRecord[]
        const file = files[0]
        return file?.remoteUrl || null
      },

      fileExistsLocally: async (fileId: string): Promise<boolean> => {
        const localFiles = getLocalFilesState()
        const localFile = localFiles[fileId]
        if (!localFile) return false

        return runEffect(
          Effect.gen(function* () {
            const local = yield* LocalFileStorage
            return yield* local.fileExists(localFile.path)
          })
        )
      },

      getFileStatus: (fileId: string): LocalFileState | undefined => {
        const localFiles = getLocalFilesState()
        return localFiles[fileId]
      },

      isOnline: () => isOnline.value,

      triggerSync: () => {
        processQueues()
      },

      localStorage: localStorageService
    }

    // Provide the service
    provide(FileSyncKey, service)

    // Initialize runtime on mount
    onMounted(() => {
      const remoteService: RemoteStorageService = {
        upload: (file: File) => props.remoteAdapter.upload(file),
        download: (url: string) => props.remoteAdapter.download(url),
        delete: (url: string) => props.remoteAdapter.delete(url),
        checkHealth: () => props.remoteAdapter.checkHealth(),
        getConfig: () => ({ baseUrl: "" })
      }

      const RemoteStorageLive = Layer.succeed(RemoteStorage, remoteService)
      const MainLayer = Layer.merge(LocalFileStorageLive, RemoteStorageLive)

      runtime = ManagedRuntime.make(MainLayer)
      isInitialized.value = true

      // Handle online/offline events
      const handleOnline = () => {
        isOnline.value = true
        props.onEvent?.({ type: "online" })
        if (healthCheckInterval) {
          clearInterval(healthCheckInterval)
          healthCheckInterval = null
        }
        processQueues()
      }

      const handleOffline = () => {
        isOnline.value = false
        props.onEvent?.({ type: "offline" })
        startHealthChecks()
      }

      window.addEventListener("online", handleOnline)
      window.addEventListener("offline", handleOffline)

      // Check initial state
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        handleOffline()
      }

      // Subscribe to file changes
      const filesQuery = queryDb(tables.files.where({ deletedAt: null }) as unknown as Parameters<typeof queryDb>[0])

      const updateLocalFileState = async () => {
        const files = store.query(filesQuery) as FileRecord[]
        const localFiles = getLocalFilesState()
        const nextState: LocalFilesState = { ...localFiles }

        for (const file of files) {
          if (file.id in nextState) {
            // Check if download is needed
            const localFile = nextState[file.id]!
            if (localFile.localHash !== file.contentHash && file.remoteUrl) {
              nextState[file.id] = {
                ...localFile,
                downloadStatus: "pending"
              }
            }
          } else if (file.remoteUrl) {
            // New file from remote
            nextState[file.id] = {
              path: file.path,
              localHash: "",
              downloadStatus: "pending",
              uploadStatus: "done",
              lastSyncError: ""
            }
          }
        }

        const event = events.localFileStateSet({ localFiles: nextState })
        store.commit(event as Parameters<typeof store.commit>[0])

        // Queue pending transfers
        for (const [fileId, localFile] of Object.entries(nextState)) {
          if (localFile.downloadStatus === "pending") {
            setTransferStatus(fileId, "download", "queued")
            downloadQueue.add(fileId)
          }
          if (localFile.uploadStatus === "pending") {
            setTransferStatus(fileId, "upload", "queued")
            uploadQueue.add(fileId)
          }
        }

        processQueues()
      }

      unsubscribeFiles = store.subscribe(filesQuery, {
        onUpdate: updateLocalFileState
      })

      // Initial sync
      updateLocalFileState()

      // Cleanup listeners on unmount
      onUnmounted(() => {
        window.removeEventListener("online", handleOnline)
        window.removeEventListener("offline", handleOffline)
      })
    })

    // Cleanup on unmount
    onUnmounted(() => {
      if (runtime) {
        runtime.dispose()
        runtime = null
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval)
      }
      if (unsubscribeFiles) {
        unsubscribeFiles()
      }
    })

    return () => {
      return slots.default?.()
    }
  }
})
