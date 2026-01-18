import { initFileSync } from "@livestore-filesync/core"
import { initThumbnails, type ThumbnailFormat, type ThumbnailSizes } from "@livestore-filesync/image/thumbnails"
import { layer as opfsLayer } from "@livestore-filesync/opfs"
import { useStore } from "@livestore/react"
import { type ReactNode, Suspense, useEffect, useState } from "react"
import { reactStoreOptions } from "../App.tsx"
import { tables } from "../livestore/schema.ts"

type FileSyncProviderProps = {
  signerBaseUrl?: string
  headers?: Record<string, string>
  authHeaders?: () => Record<string, string>
  authToken?: string
  children?: ReactNode
  thumbnails?: {
    workerUrl: URL | string
    sizes?: ThumbnailSizes
    format?: ThumbnailFormat
  }
}

const FileSyncProviderInner = ({
  authHeaders,
  authToken,
  children,
  headers,
  signerBaseUrl = "/api",
  thumbnails
}: FileSyncProviderProps) => {
  const store = useStore(reactStoreOptions)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const fileSystem = opfsLayer()
    const resolvedHeaders = headers ?? authHeaders?.()
    const disposeFileSync = initFileSync(store, {
      fileSystem,
      remote: {
        signerBaseUrl,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(authToken ? { authToken } : {})
      }
    })

    // Initialize thumbnails if configured
    let disposeThumbnails: (() => Promise<void>) | null = null
    if (thumbnails) {
      disposeThumbnails = initThumbnails(store, {
        sizes: thumbnails.sizes ?? { small: 128, medium: 256, large: 512 },
        format: thumbnails.format ?? "webp",
        fileSystem,
        workerUrl: thumbnails.workerUrl,
        schema: { tables }
      })
    }

    // Mark as ready on next tick to ensure initialization has fully completed
    setReady(true)

    return () => {
      void disposeFileSync()
      if (disposeThumbnails) {
        void disposeThumbnails()
      }
    }
  }, [store, signerBaseUrl, headers, authHeaders, authToken, thumbnails])

  return ready ? <>{children}</> : null
}

export const FileSyncProvider = (props: FileSyncProviderProps) => (
  <Suspense fallback={<div className="loading">Loading...</div>}>
    <FileSyncProviderInner {...props} />
  </Suspense>
)
