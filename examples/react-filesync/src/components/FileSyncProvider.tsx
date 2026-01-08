import { initFileSync } from "@livestore-filesync/core"
import { initServiceWorker, type ServiceWorkerOptions } from "@livestore-filesync/core/worker"
import { layer as opfsLayer } from "@livestore-filesync/opfs"
import { useStore } from "@livestore/react"
import { type ReactNode, Suspense, useEffect, useState } from "react"
import { reactStoreOptions } from "../App.tsx"

type FileSyncProviderProps = {
  signerBaseUrl?: string
  headers?: Record<string, string>
  authHeaders?: () => Record<string, string>
  authToken?: string
  serviceWorker?: boolean | ServiceWorkerOptions
  children?: ReactNode
}

const FileSyncProviderInner = ({
  authHeaders,
  authToken,
  children,
  headers,
  serviceWorker,
  signerBaseUrl = "/api"
}: FileSyncProviderProps) => {
  const store = useStore(reactStoreOptions)
  const [ready, setReady] = useState(!serviceWorker)

  useEffect(() => {
    if (serviceWorker) {
      const swOptions = typeof serviceWorker === "object" ? serviceWorker : {}
      initServiceWorker({ authToken, ...swOptions }).then(() => setReady(true))
    }

    const resolvedHeaders = headers ?? authHeaders?.()
    const dispose = initFileSync(store, {
      fileSystem: opfsLayer(),
      remote: {
        signerBaseUrl,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(authToken ? { authToken } : {})
      }
    })

    return () => void dispose()
  }, [store, signerBaseUrl, headers, authHeaders, authToken, serviceWorker])

  return ready ? <>{children}</> : null
}

export const FileSyncProvider = (props: FileSyncProviderProps) => (
  <Suspense fallback={<div className="loading">Loading...</div>}>
    <FileSyncProviderInner {...props} />
  </Suspense>
)
