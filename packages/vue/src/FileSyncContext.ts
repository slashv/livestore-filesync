/**
 * FileSyncContext
 *
 * Vue provide/inject context for file sync state and operations.
 *
 * @module
 */

import { inject, type InjectionKey } from "vue"
import type { FileSyncService } from "./types.js"

export const FileSyncKey: InjectionKey<FileSyncService> = Symbol("FileSync")

export function useFileSyncContext(): FileSyncService {
  const context = inject(FileSyncKey)
  if (!context) {
    throw new Error("useFileSyncContext must be used within a FileSyncProvider")
  }
  return context
}
