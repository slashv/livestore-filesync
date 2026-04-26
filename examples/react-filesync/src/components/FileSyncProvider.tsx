import { initFileSync, triggerSync } from "@livestore-filesync/core"
import { layer as opfsLayer } from "@livestore-filesync/opfs"
import { type ReactNode, Suspense, useEffect, useState } from "react"
import { useAppStore } from "../livestore/store.ts"

type FileSyncProviderProps = {
  signerBaseUrl?: string
  headers?: Record<string, string>
  authHeaders?: () => Record<string, string>
  authToken?: string
  healthCheckIntervalMs?: number
  children?: ReactNode
}

const FileSyncProviderInner = ({
  authHeaders,
  authToken,
  children,
  headers,
  healthCheckIntervalMs,
  signerBaseUrl = "/api"
}: FileSyncProviderProps) => {
  const store = useAppStore()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const resolvedHeaders = headers ?? authHeaders?.()
    const dispose = initFileSync(store, {
      fileSystem: opfsLayer(),
      remote: {
        signerBaseUrl,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(authToken ? { authToken } : {})
      },
      ...(healthCheckIntervalMs !== undefined ? { options: { healthCheckIntervalMs } } : {})
    })

    // Mark as ready on next tick to ensure initFileSync has fully completed
    // and React has flushed any pending state updates
    setReady(true)
    const retryQueuedTransfers = window.setTimeout(() => triggerSync(), 0)

    return () => {
      window.clearTimeout(retryQueuedTransfers)
      void dispose()
    }
  }, [store, signerBaseUrl, headers, authHeaders, authToken, healthCheckIntervalMs])

  return ready ? <>{children}</> : null
}

export const FileSyncProvider = (props: FileSyncProviderProps) => (
  <Suspense fallback={<div className="loading">Loading...</div>}>
    <FileSyncProviderInner {...props} />
  </Suspense>
)
