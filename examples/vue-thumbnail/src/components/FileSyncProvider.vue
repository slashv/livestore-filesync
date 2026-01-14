<script setup lang="ts">
import { onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import { initFileSync } from '@livestore-filesync/core'
import { initThumbnails, type ThumbnailSizes, type ThumbnailFormat } from '@livestore-filesync/image-thumbnails'
import { layer as opfsLayer } from '@livestore-filesync/opfs'
import { tables } from '../livestore/schema.ts'

const props = defineProps<{
  signerBaseUrl?: string
  headers?: Record<string, string>
  authToken?: string
  // Thumbnail options (optional - pass to enable thumbnails)
  thumbnails?: {
    workerUrl: URL | string
    sizes?: ThumbnailSizes
    format?: ThumbnailFormat
  }
}>()

const { store } = useStore()

const fileSystem = opfsLayer()

// Initialize file sync
const disposeFileSync = initFileSync(store, {
  fileSystem,
  remote: {
    signerBaseUrl: props.signerBaseUrl ?? '/api',
    headers: props.headers,
    authToken: props.authToken
  }
})

// Initialize thumbnails if configured
let disposeThumbnails: (() => Promise<void>) | null = null
if (props.thumbnails) {
  disposeThumbnails = initThumbnails(store, {
    sizes: props.thumbnails.sizes ?? { small: 128, medium: 256, large: 512 },
    format: props.thumbnails.format ?? 'webp',
    fileSystem,
    workerUrl: props.thumbnails.workerUrl,
    schema: { tables }
  })
}

onUnmounted(() => {
  void disposeFileSync()
  if (disposeThumbnails) {
    void disposeThumbnails()
  }
})
</script>

<template>
  <slot />
</template>
