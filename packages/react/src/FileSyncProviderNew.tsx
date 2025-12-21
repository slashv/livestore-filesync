/**
 * FileSyncProvider - React component that provides file sync context
 *
 * This is a simplified provider that wraps createFileSync from core.
 *
 * @module
 */

import React, { useEffect, useMemo, type ReactNode } from "react"
import { createFileSync, type CreateFileSyncConfig, type FileSyncInstance, type SyncEvent } from "@livestore-filesync/core"
import { FileSyncContext } from "./context.js"

/**
 * Props for FileSyncProvider
 */
export interface FileSyncProviderProps {
  /**
   * React children
   */
  children: ReactNode

  /**
   * LiveStore store instance
   */
  store: CreateFileSyncConfig["store"]

  /**
   * Schema with tables and events from createFileSyncSchema
   */
  schema: CreateFileSyncConfig["schema"]

  /**
   * Base URL for the remote storage API
   */
  remoteUrl: string

  /**
   * Optional function to get auth headers
   */
  authHeaders?: () => HeadersInit

  /**
   * Optional event callback
   */
  onEvent?: (event: SyncEvent) => void
}

/**
 * FileSyncProvider component
 *
 * Provides file sync functionality to child components via React Context.
 *
 * @example
 * ```tsx
 * import { FileSyncProvider } from '@livestore-filesync/react'
 * import { useStore } from '@livestore/react'
 *
 * function App() {
 *   const { store } = useStore()
 *
 *   return (
 *     <FileSyncProvider store={store} schema={schema} remoteUrl="/api">
 *       <YourApp />
 *     </FileSyncProvider>
 *   )
 * }
 * ```
 */
export function FileSyncProvider({
  children,
  store,
  schema,
  remoteUrl,
  authHeaders,
  onEvent
}: FileSyncProviderProps) {
  // Build config objects, avoiding undefined values for exactOptionalPropertyTypes
  const fileSync: FileSyncInstance = useMemo(() => {
    const remoteConfig: { baseUrl: string; authHeaders?: () => HeadersInit } = {
      baseUrl: remoteUrl
    }
    if (authHeaders) {
      remoteConfig.authHeaders = authHeaders
    }

    const optionsConfig: { onEvent?: (event: SyncEvent) => void } = {}
    if (onEvent) {
      optionsConfig.onEvent = onEvent
    }

    return createFileSync({
      store,
      schema,
      remote: remoteConfig,
      options: optionsConfig
    })
  }, [store, schema, remoteUrl, authHeaders, onEvent])

  // Lifecycle
  useEffect(() => {
    fileSync.start()
    return () => {
      fileSync.stop()
      fileSync.dispose()
    }
  }, [fileSync])

  return (
    <FileSyncContext.Provider value={fileSync}>
      {children}
    </FileSyncContext.Provider>
  )
}

export type { FileSyncInstance, SyncEvent }
