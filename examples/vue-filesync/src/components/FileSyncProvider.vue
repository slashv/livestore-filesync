<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { disposeFileSync, initFileSync, startFileSync, stopFileSync } from '@livestore-filesync/core'

const props = defineProps<{
  signerBaseUrl?: string
  headers?: Record<string, string>
  authToken?: string
}>()

const { store } = useStore()

initFileSync(store, {
  remote: {
    signerBaseUrl: props.signerBaseUrl ?? '/api',
    headers: props.headers,
    authToken: props.authToken
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
