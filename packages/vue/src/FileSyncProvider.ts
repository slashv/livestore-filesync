/**
 * FileSyncProvider - Vue component that provides file sync context
 *
 * Automatically integrates with LiveStore via useStore() and uses the
 * standard file sync schema.
 *
 * @module
 */

import { defineComponent, onMounted, onUnmounted, provide, type PropType } from "vue"
import type { Layer } from "effect"
import { useStore } from "vue-livestore"
import { queryDb } from "@livestore/livestore"
import {
  createFileSync,
  type FileSyncInstance,
  type SyncEvent,
  type FileSystem
} from "@livestore-filesync/core"
import { FileSyncKey } from "./context.js"
import { fileSyncSchema } from "./schema.js"

/**
 * Props for FileSyncProvider
 */
export interface FileSyncProviderProps {
  /**
   * Base URL for the remote storage API
   * @default "/api"
   */
  remoteUrl?: string

  /**
   * Optional function to get auth headers
   */
  authHeaders?: () => HeadersInit

  /**
   * Optional event callback
   */
  onEvent?: (event: SyncEvent) => void

  /**
   * Optional filesystem layer override
   */
  fileSystem?: Layer.Layer<FileSystem>
}

/**
 * FileSyncProvider component
 *
 * Provides file sync functionality to child components via Vue's provide/inject.
 * Automatically gets the store from LiveStoreProvider context.
 *
 * @example
 * ```vue
 * <template>
 *   <LiveStoreProvider :options="storeOptions">
 *     <FileSyncProvider remote-url="/api">
 *       <YourApp />
 *     </FileSyncProvider>
 *   </LiveStoreProvider>
 * </template>
 * ```
 */
export const FileSyncProvider = defineComponent({
  name: "FileSyncProvider",

  props: {
    remoteUrl: {
      type: String,
      default: "/api"
    },
    authHeaders: {
      type: Function as PropType<() => HeadersInit>,
      default: undefined
    },
    onEvent: {
      type: Function as PropType<(event: SyncEvent) => void>,
      default: undefined
    },
    fileSystem: {
      type: Object as PropType<Layer.Layer<FileSystem>>,
      default: undefined
    }
  },

  setup(props, { slots }) {
    // Get store from LiveStoreProvider context
    const { store } = useStore()

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
      store,
      schema: {
        tables: fileSyncSchema.tables as any,
        events: fileSyncSchema.events as any,
        queryDb: queryDb as any
      },
      remote: remoteConfig,
      ...(props.fileSystem ? { fileSystem: props.fileSystem } : {}),
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
