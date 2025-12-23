/**
 * React context for FileSyncInstance
 *
 * @module
 */

import { createContext, useContext } from "react"
import type { FileSyncInstance } from "@livestore-filesync/core"

/**
 * Context for the file sync instance
 */
export const FileSyncContext = createContext<FileSyncInstance | null>(null)

/**
 * Get the file sync instance from context
 *
 * Must be used within a FileSyncProvider component.
 *
 * @example
 * ```tsx
 * import { useFileSync } from '@livestore-filesync/react'
 *
 * const fileSync = useFileSync()
 *
 * const handleSave = async (file: File) => {
 *   const result = await fileSync.saveFile(file)
 *   console.log('Saved:', result.fileId)
 * }
 * ```
 */
export function useFileSync(): FileSyncInstance {
  const fileSync = useContext(FileSyncContext)
  if (!fileSync) {
    throw new Error("useFileSync must be used within a FileSyncProvider")
  }
  return fileSync
}
