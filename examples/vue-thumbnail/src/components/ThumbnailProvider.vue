<script setup lang="ts">
import { onUnmounted } from 'vue'
import { queryDb } from '@livestore/livestore'
import { useStore } from 'vue-livestore'
import { initThumbnails } from '@livestore-filesync/image-thumbnails'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { tables } from '../livestore/schema.ts'

const { store } = useStore()

// Create worker URL - Vite handles bundling
const workerUrl = new URL('../thumbnail.worker.ts', import.meta.url)

const dispose = initThumbnails(store, {
  sizes: {
    small: 128,
    medium: 256,
    large: 512
  },
  format: 'webp',
  fileSystem: opfsLayer(),
  workerUrl,
  // Provide access to files table for scanning
  queryDb,
  filesTable: tables.files
})

onUnmounted(() => {
  void dispose()
})
</script>

<template>
  <slot />
</template>
