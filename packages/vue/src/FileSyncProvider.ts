/**
 * FileSyncProvider - Vue component that provides file sync context
 *
 * This is a simplified provider that wraps createFileSync from core.
 *
 * @module
 */

import { defineComponent, onMounted, onUnmounted, provide, type PropType } from "vue"
import { createFileSync, type CreateFileSyncConfig, type FileSyncInstance, type SyncEvent } from "@livestore-filesync/core"
import { FileSyncKey } from "./context.js"

/**
 * Props for FileSyncProvider
 */
export interface FileSyncProviderProps {
  /**
   * LiveStore store instance
   */
  store: CreateFileSyncConfig["store"]

  /**
   * Schema with tables and events from createFileSyncSchema
   */
  schema: CreateFileSyncConfig["schema"]

  /**
   * Base URL for the remote storage API
   */
  remoteUrl: string

  /**
   * Optional function to get auth headers
   */
  authHeaders?: () => HeadersInit

  /**
   * Optional event callback
   */
  onEvent?: (event: SyncEvent) => void
}

/**
 * FileSyncProvider component
 *
 * Provides file sync functionality to child components via Vue's provide/inject.
 *
 * @example
 * ```vue
 * <template>
 *   <FileSyncProvider :store="store" :schema="schema" remote-url="/api">
 *     <YourApp />
 *   </FileSyncProvider>
 * </template>
 *
 * <script setup>
 * import { FileSyncProvider } from '@livestore-filesync/vue'
 * import { useStore } from 'vue-livestore'
 *
 * const { store } = useStore()
 * </script>
 * ```
 */
export const FileSyncProvider = defineComponent({
  name: "FileSyncProvider",

  props: {
    store: {
      type: Object as PropType<CreateFileSyncConfig["store"]>,
      required: true
    },
    schema: {
      type: Object as PropType<CreateFileSyncConfig["schema"]>,
      required: true
    },
    remoteUrl: {
      type: String,
      required: true
    },
    authHeaders: {
      type: Function as PropType<() => HeadersInit>,
      default: undefined
    },
    onEvent: {
      type: Function as PropType<(event: SyncEvent) => void>,
      default: undefined
    }
  },

  setup(props, { slots }) {
    // Build remote config
    const remoteConfig: { baseUrl: string; authHeaders?: () => HeadersInit } = {
      baseUrl: props.remoteUrl
    }
    if (props.authHeaders) {
      remoteConfig.authHeaders = props.authHeaders
    }

    // Build options config
    const optionsConfig: { onEvent?: (event: SyncEvent) => void } = {}
    if (props.onEvent) {
      optionsConfig.onEvent = props.onEvent
    }

    // Create the file sync instance
    const fileSync: FileSyncInstance = createFileSync({
      store: props.store,
      schema: props.schema,
      remote: remoteConfig,
      options: optionsConfig
    })

    // Provide to children
    provide(FileSyncKey, fileSync)

    // Lifecycle
    onMounted(() => {
      fileSync.start()
    })

    onUnmounted(() => {
      fileSync.stop()
      fileSync.dispose()
    })

    // Render slot
    return () => slots.default?.()
  }
})

export type { FileSyncInstance, SyncEvent }
