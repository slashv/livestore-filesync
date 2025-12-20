/**
 * React hooks for file sync
 *
 * @module
 */

import { useCallback, useEffect, useState } from "react"
import { useFileSyncContext } from "./FileSyncContext.js"
import type { LocalFileState, FileSaveResult } from "./types.js"

/**
 * Hook to access the file sync service
 */
export function useFileSync() {
  return useFileSyncContext()
}

/**
 * Hook to save a file and get the result
 */
export function useSaveFile() {
  const { saveFile } = useFileSyncContext()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [result, setResult] = useState<FileSaveResult | null>(null)

  const save = useCallback(async (file: File): Promise<FileSaveResult> => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await saveFile(file)
      setResult(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [saveFile])

  return { save, isLoading, error, result }
}

/**
 * Hook to get a file URL (reactive)
 */
export function useFileUrl(fileId: string | null): {
  url: string | null
  isLoading: boolean
  error: Error | null
  refresh: () => void
} {
  const { getFileUrl } = useFileSyncContext()
  const [url, setUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    if (!fileId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    getFileUrl(fileId)
      .then((url) => {
        if (!cancelled) {
          setUrl(url)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [fileId, getFileUrl, refreshTrigger])

  const refresh = useCallback(() => {
    setRefreshTrigger((t) => t + 1)
  }, [])

  return { url, isLoading, error, refresh }
}

/**
 * Hook to get a file's sync status (reactive)
 */
export function useFileStatus(fileId: string | null): LocalFileState | undefined {
  const { getFileStatus } = useFileSyncContext()
  const [status, setStatus] = useState<LocalFileState | undefined>()

  useEffect(() => {
    if (!fileId) {
      setStatus(undefined)
      return
    }

    // Initial fetch
    setStatus(getFileStatus(fileId))

    // Poll for updates (could be improved with subscription)
    const interval = setInterval(() => {
      setStatus(getFileStatus(fileId))
    }, 500)

    return () => clearInterval(interval)
  }, [fileId, getFileStatus])

  return status
}

/**
 * Hook to check if the service is online
 */
export function useIsOnline(): boolean {
  const { isOnline } = useFileSyncContext()
  const [online, setOnline] = useState(isOnline())

  useEffect(() => {
    const interval = setInterval(() => {
      setOnline(isOnline())
    }, 1000)

    return () => clearInterval(interval)
  }, [isOnline])

  return online
}

/**
 * Hook to check if a file exists locally
 */
export function useFileExistsLocally(fileId: string | null): {
  exists: boolean | null
  isLoading: boolean
  refresh: () => void
} {
  const { fileExistsLocally } = useFileSyncContext()
  const [exists, setExists] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    if (!fileId) {
      setExists(null)
      return
    }

    let cancelled = false
    setIsLoading(true)

    fileExistsLocally(fileId)
      .then((exists) => {
        if (!cancelled) {
          setExists(exists)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [fileId, fileExistsLocally, refreshTrigger])

  const refresh = useCallback(() => {
    setRefreshTrigger((t) => t + 1)
  }, [])

  return { exists, isLoading, refresh }
}

/**
 * Hook to delete a file
 */
export function useDeleteFile() {
  const { deleteFile } = useFileSyncContext()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const remove = useCallback(async (fileId: string): Promise<void> => {
    setIsLoading(true)
    setError(null)

    try {
      await deleteFile(fileId)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [deleteFile])

  return { remove, isLoading, error }
}
