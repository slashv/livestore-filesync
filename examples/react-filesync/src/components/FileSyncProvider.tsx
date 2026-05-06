import { initFileSync, triggerSync } from "@livestore-filesync/core"
import { createImagePreprocessor } from "@livestore-filesync/image/preprocessor"
import { layer as opfsLayer } from "@livestore-filesync/opfs"
import { type ReactNode, Suspense, useEffect, useState } from "react"
import { useAppStore } from "../livestore/store.ts"

type FileSyncProviderProps = {
  signerBaseUrl?: string
  localOnly?: boolean
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
  localOnly = false,
  signerBaseUrl = "/api"
}: FileSyncProviderProps) => {
  const store = useAppStore()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const resolvedHeaders = headers ?? authHeaders?.()
    const dispose = initFileSync(store, {
      fileSystem: opfsLayer(),
      remote: localOnly
        ? false
        : {
          signerBaseUrl,
          ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
          ...(authToken ? { authToken } : {})
        },
      options: {
        ...(healthCheckIntervalMs !== undefined ? { healthCheckIntervalMs } : {}),
        preprocessors: {
          "image/*": createImagePreprocessor({
            processor: "canvas",
            maxDimension: 1500,
            quality: 90,
            format: "jpeg"
          })
        }
      }
    })

    // Mark as ready on next tick to ensure initFileSync has fully completed
    // and React has flushed any pending state updates
    setReady(true)
    const retryQueuedTransfers = window.setTimeout(() => triggerSync(), 0)

    return () => {
      window.clearTimeout(retryQueuedTransfers)
      void dispose()
    }
  }, [store, signerBaseUrl, headers, authHeaders, authToken, healthCheckIntervalMs, localOnly])

  return ready ? <>{children}</> : null
}

export const FileSyncProvider = (props: FileSyncProviderProps) => (
  <Suspense fallback={<div className="loading">Loading...</div>}>
    <FileSyncProviderInner {...props} />
  </Suspense>
)
