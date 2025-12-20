/**
 * FileSyncContext
 *
 * React context for file sync state and operations.
 *
 * @module
 */

import { createContext, useContext } from "react"
import type { FileSyncService } from "./types.js"

export const FileSyncContext = createContext<FileSyncService | null>(null)

export function useFileSyncContext(): FileSyncService {
  const context = useContext(FileSyncContext)
  if (!context) {
    throw new Error("useFileSyncContext must be used within a FileSyncProvider")
  }
  return context
}
