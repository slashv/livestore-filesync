<script setup lang="ts">
import { onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { initThumbnails } from '@livestore-filesync/image-thumbnails'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { tables } from '../livestore/schema.ts'

const { store } = useStore()

// Create worker URL - Vite handles bundling
const workerUrl = new URL('../thumbnail.worker.ts', import.meta.url)

// Use the simplified API - just pass tables object
const dispose = initThumbnails(store, {
  sizes: {
    small: 128,
    medium: 256,
    large: 512
  },
  format: 'webp',
  fileSystem: opfsLayer(),
  workerUrl,
  schema: { tables }
})

onUnmounted(() => {
  void dispose()
})
</script>

<template>
  <slot />
</template>
