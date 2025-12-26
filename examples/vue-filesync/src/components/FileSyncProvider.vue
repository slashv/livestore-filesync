<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { disposeFileSync, initFileSync, startFileSync, stopFileSync } from '@livestore-filesync/core'

const props = defineProps<{
  remoteUrl?: string
  authHeaders?: () => HeadersInit
}>()

const { store } = useStore()

initFileSync(store, {
  remote: {
    baseUrl: props.remoteUrl ?? '/api',
    authHeaders: props.authHeaders
  }
})

onMounted(() => {
  startFileSync()
})

onUnmounted(() => {
  stopFileSync()
  void disposeFileSync()
})
</script>

<template>
  <slot />
</template>
