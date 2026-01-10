import { initFileSync } from "@livestore-filesync/core"
import { layer as opfsLayer } from "@livestore-filesync/opfs"
import { useStore } from "@livestore/react"
import { type ReactNode, Suspense, useEffect, useState } from "react"
import { reactStoreOptions } from "../App.tsx"

type FileSyncProviderProps = {
  signerBaseUrl?: string
  headers?: Record<string, string>
  authHeaders?: () => Record<string, string>
  authToken?: string
  children?: ReactNode
}

const FileSyncProviderInner = ({
  authHeaders,
  authToken,
  children,
  headers,
  signerBaseUrl = "/api"
}: FileSyncProviderProps) => {
  const store = useStore(reactStoreOptions)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const resolvedHeaders = headers ?? authHeaders?.()
    const dispose = initFileSync(store, {
      fileSystem: opfsLayer(),
      remote: {
        signerBaseUrl,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(authToken ? { authToken } : {})
      }
    })

    // Mark as ready after initialization
    setReady(true)

    return () => void dispose()
  }, [store, signerBaseUrl, headers, authHeaders, authToken])

  return ready ? <>{children}</> : null
}

export const FileSyncProvider = (props: FileSyncProviderProps) => (
  <Suspense fallback={<div className="loading">Loading...</div>}>
    <FileSyncProviderInner {...props} />
  </Suspense>
)
