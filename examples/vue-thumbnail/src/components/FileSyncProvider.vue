<script setup lang="ts">
import { onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const props = defineProps<{
  signerBaseUrl?: string
  headers?: Record<string, string>
  authToken?: string
}>()

const { store } = useStore()

const dispose = initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: {
    signerBaseUrl: props.signerBaseUrl ?? '/api',
    headers: props.headers,
    authToken: props.authToken
  }
})

onUnmounted(() => {
  void dispose()
})
</script>

<template>
  <slot />
</template>
