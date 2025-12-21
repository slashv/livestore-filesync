/**
 * Vue context for FileSyncInstance
 *
 * @module
 */

import type { InjectionKey } from "vue"
import { inject } from "vue"
import type { FileSyncInstance } from "@livestore-filesync/core"

/**
 * Injection key for the file sync instance
 */
export const FileSyncKey: InjectionKey<FileSyncInstance> = Symbol("FileSync")

/**
 * Get the file sync instance from context
 *
 * Must be used within a FileSyncProvider component.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useFileSync } from '@livestore-filesync/vue'
 *
 * const fileSync = useFileSync()
 *
 * const handleSave = async (file: File) => {
 *   const result = await fileSync.saveFile(file)
 *   console.log('Saved:', result.fileId)
 * }
 * </script>
 * ```
 */
export function useFileSync(): FileSyncInstance {
  const fileSync = inject(FileSyncKey)
  if (!fileSync) {
    throw new Error("useFileSync must be used within a FileSyncProvider")
  }
  return fileSync
}
