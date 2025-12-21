<script setup lang="ts">
import { useStore } from 'vue-livestore'
import { FileSyncProvider, type RemoteStorageAdapter } from '@livestore-filesync/vue'

const props = defineProps<{
  remoteAdapter: RemoteStorageAdapter
  schema: any
  onEvent?: (event: { type: string }) => void
}>()

const { store } = useStore()
</script>

<template>
  <FileSyncProvider
    :store="store"
    :remote-adapter="remoteAdapter"
    :schema="schema"
    :on-event="onEvent"
  >
    <slot />
  </FileSyncProvider>
</template>
