/**
 * React context for FileSyncInstance
 *
 * @module
 */

import { createContext, useContext } from "react"
import type { FileSyncInstance } from "@livestore-filesync/core"

/**
 * React context for the file sync instance
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
 * function Gallery() {
 *   const fileSync = useFileSync()
 *
 *   const handleSave = async (file: File) => {
 *     const result = await fileSync.saveFile(file)
 *     console.log('Saved:', result.fileId)
 *   }
 *
 *   return <input type="file" onChange={(e) => handleSave(e.target.files?.[0]!)} />
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
