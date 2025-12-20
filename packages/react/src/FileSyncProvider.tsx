/**
 * FileSyncProvider
 *
 * React provider that manages file synchronization with LiveStore.
 * This provider should be placed inside the LiveStoreProvider.
 *
 * @module
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Effect, ManagedRuntime, Layer } from "effect"
import { useStore } from "@livestore/react"
import { queryDb } from "@livestore/livestore"
import {
  LocalFileStorage,
  LocalFileStorageLive,
  RemoteStorage,
  hashFile,
  makeStoredPath,
  type RemoteStorageService
} from "@livestore-filesync/core"

import { FileSyncContext } from "./FileSyncContext.js"
import type {
  FileSyncProviderConfig,
  FileSyncService,
  LocalFileState,
  LocalFilesState,
  LocalStorageService,
  FileSaveResult
} from "./types.js"

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

interface FileSyncProviderProps extends FileSyncProviderConfig {
  children: React.ReactNode
  /**
   * Schema from createFileSyncSchema
   */
  schema: FileSyncSchema
}

export function FileSyncProvider({
  children,
  remoteAdapter,
  maxConcurrentDownloads = 2,
  maxConcurrentUploads = 2,
  onEvent,
  schema
}: FileSyncProviderProps) {
  const { store } = useStore()
  const { tables, events } = schema
  const [isOnline, setIsOnline] = useState(true)
  const [isInitialized, setIsInitialized] = useState(false)
  const runtimeRef = useRef<ManagedRuntime.ManagedRuntime<LocalFileStorage | RemoteStorage, never> | null>(null)
  const uploadQueueRef = useRef<Set<string>>(new Set())
  const downloadQueueRef = useRef<Set<string>>(new Set())
  const activeUploadsRef = useRef<number>(0)
  const activeDownloadsRef = useRef<number>(0)
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Initialize runtime
  useEffect(() => {
    const remoteService: RemoteStorageService = {
      upload: (file: File) => remoteAdapter.upload(file),
      download: (url: string) => remoteAdapter.download(url),
      delete: (url: string) => remoteAdapter.delete(url),
      checkHealth: () => remoteAdapter.checkHealth(),
      getConfig: () => ({ baseUrl: "" })
    }

    const RemoteStorageLive = Layer.succeed(RemoteStorage, remoteService)
    const MainLayer = Layer.merge(LocalFileStorageLive, RemoteStorageLive)

    runtimeRef.current = ManagedRuntime.make(MainLayer)
    setIsInitialized(true)

    return () => {
      if (runtimeRef.current) {
        runtimeRef.current.dispose()
        runtimeRef.current = null
      }
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current)
      }
    }
  }, [remoteAdapter])

  // Helper to run effects
  const runEffect = useCallback(<A, E>(effect: Effect.Effect<A, E, LocalFileStorage | RemoteStorage>): Promise<A> => {
    if (!runtimeRef.current) {
      return Promise.reject(new Error("Runtime not initialized"))
    }
    return runtimeRef.current.runPromise(effect)
  }, [])

  // Get local files state from store
  const getLocalFilesState = useCallback((): LocalFilesState => {
    try {
      const state = store.query(queryDb(tables.localFileState.get() as unknown as Parameters<typeof queryDb>[0]))
      return ((state as { localFiles?: LocalFilesState }).localFiles) || {}
    } catch {
      return {}
    }
  }, [store, tables.localFileState])

  // Merge local files state
  const mergeLocalFiles = useCallback((patch: Record<string, LocalFileState>) => {
    const current = getLocalFilesState()
    const event = events.localFileStateSet({ localFiles: { ...current, ...patch } })
    store.commit(event as Parameters<typeof store.commit>[0])
  }, [store, events, getLocalFilesState])

  // Set transfer status
  const setTransferStatus = useCallback((
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
  }, [store, events, getLocalFilesState])

  // Start health checks when offline
  const startHealthChecks = useCallback(() => {
    if (healthCheckIntervalRef.current) return

    healthCheckIntervalRef.current = setInterval(async () => {
      try {
        const ok = await runEffect(
          Effect.gen(function* () {
            const remote = yield* RemoteStorage
            return yield* remote.checkHealth()
          })
        )
        if (ok) {
          setIsOnline(true)
          onEvent?.({ type: "online" })
          if (healthCheckIntervalRef.current) {
            clearInterval(healthCheckIntervalRef.current)
            healthCheckIntervalRef.current = null
          }
        }
      } catch {
        // Remain offline
      }
    }, 10000)
  }, [runEffect, onEvent])

  // Download a file from remote
  const downloadRemoteFile = useCallback(async (fileId: string): Promise<LocalFileState | null> => {
    try {
      const filesQuery = queryDb(tables.files.where({ id: fileId }) as unknown as Parameters<typeof queryDb>[0])
      const files = store.query(filesQuery) as FileRecord[]
      const file = files[0]
      if (!file || !file.remoteUrl) {
        throw new Error(`File ${fileId} not found or has no remote URL`)
      }

      onEvent?.({ type: "download:start", fileId })

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

      onEvent?.({ type: "download:complete", fileId })

      return {
        path: file.path,
        localHash: hash,
        downloadStatus: "done",
        uploadStatus: "done",
        lastSyncError: ""
      }
    } catch (error) {
      onEvent?.({ type: "download:error", fileId, error })
      startHealthChecks()
      return null
    }
  }, [store, tables.files, onEvent, runEffect, startHealthChecks])

  // Upload a file to remote
  const uploadLocalFile = useCallback(async (fileId: string): Promise<LocalFileState | null> => {
    try {
      const localFiles = getLocalFilesState()
      const localFile = localFiles[fileId]
      if (!localFile) {
        throw new Error(`Local file ${fileId} not found`)
      }

      onEvent?.({ type: "upload:start", fileId })

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

      onEvent?.({ type: "upload:complete", fileId })

      return {
        ...localFile,
        uploadStatus: "done",
        lastSyncError: ""
      }
    } catch (error) {
      onEvent?.({ type: "upload:error", fileId, error })
      startHealthChecks()
      return null
    }
  }, [store, events, getLocalFilesState, onEvent, runEffect, startHealthChecks])

  // Process queues
  const processQueues = useCallback(async () => {
    if (!isOnline) return

    // Process downloads
    while (activeDownloadsRef.current < maxConcurrentDownloads && downloadQueueRef.current.size > 0) {
      const fileId = downloadQueueRef.current.values().next().value
      if (!fileId) break

      downloadQueueRef.current.delete(fileId)
      activeDownloadsRef.current++

      setTransferStatus(fileId, "download", "inProgress")

      downloadRemoteFile(fileId).then((result) => {
        if (result) {
          mergeLocalFiles({ [fileId]: result })
        }
        activeDownloadsRef.current--
        processQueues()
      })
    }

    // Process uploads
    while (activeUploadsRef.current < maxConcurrentUploads && uploadQueueRef.current.size > 0) {
      const fileId = uploadQueueRef.current.values().next().value
      if (!fileId) break

      uploadQueueRef.current.delete(fileId)
      activeUploadsRef.current++

      setTransferStatus(fileId, "upload", "inProgress")

      uploadLocalFile(fileId).then((result) => {
        if (result) {
          mergeLocalFiles({ [fileId]: result })
        }
        activeUploadsRef.current--
        processQueues()
      })
    }
  }, [
    isOnline,
    maxConcurrentDownloads,
    maxConcurrentUploads,
    downloadRemoteFile,
    uploadLocalFile,
    setTransferStatus,
    mergeLocalFiles
  ])

  // Handle online/offline events
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      onEvent?.({ type: "online" })
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current)
        healthCheckIntervalRef.current = null
      }
      processQueues()
    }

    const handleOffline = () => {
      setIsOnline(false)
      onEvent?.({ type: "offline" })
      startHealthChecks()
    }

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    // Check initial state
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      handleOffline()
    }

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [onEvent, processQueues, startHealthChecks])

  // Subscribe to file changes and sync
  useEffect(() => {
    if (!isInitialized) return

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
          downloadQueueRef.current.add(fileId)
        }
        if (localFile.uploadStatus === "pending") {
          setTransferStatus(fileId, "upload", "queued")
          uploadQueueRef.current.add(fileId)
        }
      }

      processQueues()
    }

    const unsubscribe = store.subscribe(filesQuery, {
      onUpdate: updateLocalFileState
    })

    // Initial sync
    updateLocalFileState()

    return unsubscribe
  }, [isInitialized, store, tables.files, events, getLocalFilesState, setTransferStatus, processQueues])

  // Create the localStorage service wrapper
  const localStorageService = useMemo((): LocalStorageService => ({
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
  }), [runEffect])

  // Create the service
  const service = useMemo<FileSyncService>(() => ({
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
      uploadQueueRef.current.add(fileId)
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

    isOnline: () => isOnline,

    triggerSync: () => {
      processQueues()
    },

    localStorage: localStorageService
  }), [store, events, tables.files, isOnline, getLocalFilesState, mergeLocalFiles, runEffect, processQueues, localStorageService])

  return (
    <FileSyncContext.Provider value={service}>
      {children}
    </FileSyncContext.Provider>
  )
}
