/**
 * Vue composables for file sync
 *
 * @module
 */

import { ref, onMounted, onUnmounted, type Ref } from "vue"
import { useFileSyncContext } from "./FileSyncContext.js"
import type { LocalFileState, FileSaveResult } from "./types.js"

/**
 * Composable to access the file sync service
 */
export function useFileSync() {
  return useFileSyncContext()
}

/**
 * Composable to save a file and get the result
 */
export function useSaveFile() {
  const { saveFile } = useFileSyncContext()
  const isLoading = ref(false)
  const error = ref<Error | null>(null)
  const result = ref<FileSaveResult | null>(null)

  const save = async (file: File): Promise<FileSaveResult> => {
    isLoading.value = true
    error.value = null

    try {
      const saveResult = await saveFile(file)
      result.value = saveResult
      return saveResult
    } catch (err) {
      const saveError = err instanceof Error ? err : new Error(String(err))
      error.value = saveError
      throw saveError
    } finally {
      isLoading.value = false
    }
  }

  return { save, isLoading, error, result }
}

/**
 * Composable to get a file URL (reactive)
 */
export function useFileUrl(fileId: Ref<string | null> | string | null): {
  url: Ref<string | null>
  isLoading: Ref<boolean>
  error: Ref<Error | null>
  refresh: () => void
} {
  const { getFileUrl } = useFileSyncContext()
  const url = ref<string | null>(null)
  const isLoading = ref(false)
  const error = ref<Error | null>(null)
  let refreshTrigger = 0

  const getId = () => {
    if (fileId === null) return null
    if (typeof fileId === 'string') return fileId
    return fileId.value
  }

  const fetchUrl = async () => {
    const id = getId()
    if (!id) {
      url.value = null
      return
    }

    isLoading.value = true
    error.value = null

    try {
      url.value = await getFileUrl(id)
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
    } finally {
      isLoading.value = false
    }
  }

  const refresh = () => {
    refreshTrigger++
    fetchUrl()
  }

  onMounted(() => {
    fetchUrl()
  })

  return { url, isLoading, error, refresh }
}

/**
 * Composable to get a file's sync status (reactive)
 */
export function useFileStatus(fileId: Ref<string | null> | string | null): Ref<LocalFileState | undefined> {
  const { getFileStatus } = useFileSyncContext()
  const status = ref<LocalFileState | undefined>()
  let intervalId: ReturnType<typeof setInterval> | null = null

  const getId = () => {
    if (fileId === null) return null
    if (typeof fileId === 'string') return fileId
    return fileId.value
  }

  const updateStatus = () => {
    const id = getId()
    if (!id) {
      status.value = undefined
      return
    }
    status.value = getFileStatus(id)
  }

  onMounted(() => {
    updateStatus()
    // Poll for updates
    intervalId = setInterval(updateStatus, 500)
  })

  onUnmounted(() => {
    if (intervalId) {
      clearInterval(intervalId)
    }
  })

  return status
}

/**
 * Composable to check if the service is online
 */
export function useIsOnline(): Ref<boolean> {
  const { isOnline } = useFileSyncContext()
  const online = ref(isOnline())
  let intervalId: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    intervalId = setInterval(() => {
      online.value = isOnline()
    }, 1000)
  })

  onUnmounted(() => {
    if (intervalId) {
      clearInterval(intervalId)
    }
  })

  return online
}

/**
 * Composable to check if a file exists locally
 */
export function useFileExistsLocally(fileId: Ref<string | null> | string | null): {
  exists: Ref<boolean | null>
  isLoading: Ref<boolean>
  refresh: () => void
} {
  const { fileExistsLocally } = useFileSyncContext()
  const exists = ref<boolean | null>(null)
  const isLoading = ref(false)

  const getId = () => {
    if (fileId === null) return null
    if (typeof fileId === 'string') return fileId
    return fileId.value
  }

  const checkExists = async () => {
    const id = getId()
    if (!id) {
      exists.value = null
      return
    }

    isLoading.value = true
    try {
      exists.value = await fileExistsLocally(id)
    } finally {
      isLoading.value = false
    }
  }

  const refresh = () => {
    checkExists()
  }

  onMounted(() => {
    checkExists()
  })

  return { exists, isLoading, refresh }
}

/**
 * Composable to delete a file
 */
export function useDeleteFile() {
  const { deleteFile } = useFileSyncContext()
  const isLoading = ref(false)
  const error = ref<Error | null>(null)

  const remove = async (fileId: string): Promise<void> => {
    isLoading.value = true
    error.value = null

    try {
      await deleteFile(fileId)
    } catch (err) {
      const deleteError = err instanceof Error ? err : new Error(String(err))
      error.value = deleteError
      throw deleteError
    } finally {
      isLoading.value = false
    }
  }

  return { remove, isLoading, error }
}
