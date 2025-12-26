import { useEffect, type ReactNode } from 'react'
import { useStore } from '@livestore/react'
import {
  disposeFileSync,
  initFileSync,
  startFileSync,
  stopFileSync
} from '@livestore-filesync/core'

type FileSyncProviderProps = {
  remoteUrl?: string
  authHeaders?: () => HeadersInit
  children?: ReactNode
}

export const FileSyncProvider = ({
  remoteUrl = '/api',
  authHeaders,
  children
}: FileSyncProviderProps) => {
  const { store } = useStore()

  const remote: { baseUrl: string; authHeaders?: () => HeadersInit } = { baseUrl: remoteUrl }
  if (authHeaders) {
    remote.authHeaders = authHeaders
  }
  initFileSync(store, { remote })

  useEffect(() => {
    startFileSync()

    return () => {
      stopFileSync()
      void disposeFileSync()
    }
  }, [authHeaders, remoteUrl, store])

  return <>{children}</>
}
