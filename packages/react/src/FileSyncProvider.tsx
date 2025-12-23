/**
 * FileSyncProvider - React component that provides file sync context
 *
 * Automatically integrates with LiveStore via useStore() and uses the
 * standard file sync schema.
 *
 * @module
 */

import type { Layer } from "effect"
import { useEffect, useMemo, type ReactNode } from "react"
import { useStore } from "@livestore/react"
import { queryDb } from "@livestore/livestore"
import {
  createFileSync,
  type FileSyncInstance,
  type SyncEvent,
  type FileSystem
} from "@livestore-filesync/core"
import { FileSyncContext } from "./context.js"
import { fileSyncSchema } from "./schema.js"

/**
 * Props for FileSyncProvider
 */
export interface FileSyncProviderProps {
  /**
   * Base URL for the remote storage API
   * @default "/api"
   */
  remoteUrl?: string

  /**
   * Optional function to get auth headers
   */
  authHeaders?: () => HeadersInit

  /**
   * Optional event callback
   */
  onEvent?: (event: SyncEvent) => void

  /**
   * Filesystem layer to use for local file storage
   */
  fileSystem: Layer.Layer<FileSystem>

  /**
   * Child components
   */
  children?: ReactNode
}

/**
 * FileSyncProvider component
 *
 * Provides file sync functionality to child components via React context.
 * Automatically gets the store from LiveStoreProvider context.
 *
 * @example
 * ```tsx
 * <LiveStoreProvider schema={schema} adapter={adapter}>
 *   <FileSyncProvider fileSystem={fileSystem} remoteUrl="/api">
 *     <YourApp />
 *   </FileSyncProvider>
 * </LiveStoreProvider>
 * ```
 */
export const FileSyncProvider = ({
  remoteUrl = "/api",
  authHeaders,
  onEvent,
  fileSystem,
  children
}: FileSyncProviderProps) => {
  // Get store from LiveStoreProvider context
  const { store } = useStore()

  const fileSync: FileSyncInstance = useMemo(() => {
    // Build remote config
    const remoteConfig: { baseUrl: string; authHeaders?: () => HeadersInit } = {
      baseUrl: remoteUrl
    }
    if (authHeaders) {
      remoteConfig.authHeaders = authHeaders
    }

    // Build options config
    const optionsConfig: { onEvent?: (event: SyncEvent) => void } = {}
    if (onEvent) {
      optionsConfig.onEvent = onEvent
    }

    // Create the file sync instance
    return createFileSync({
      store,
      schema: {
        tables: fileSyncSchema.tables,
        events: fileSyncSchema.events,
        queryDb: queryDb
      },
      remote: remoteConfig,
      fileSystem,
      options: optionsConfig
    })
  }, [authHeaders, fileSystem, onEvent, remoteUrl, store])

  useEffect(() => {
    fileSync.start()

    return () => {
      fileSync.stop()
      void fileSync.dispose()
    }
  }, [fileSync])

  return <FileSyncContext.Provider value={fileSync}>{children}</FileSyncContext.Provider>
}

export type { FileSyncInstance, SyncEvent }
