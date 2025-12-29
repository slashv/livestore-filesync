<script setup lang="ts">
import { ref } from 'vue'
import { queryDb } from '@livestore/livestore'
import { useQuery } from 'vue-livestore'
import { isOnline, saveFile } from '@livestore-filesync/core'
import { tables } from '../livestore/schema.ts'
import ImageCard from './ImageCard.vue'

const inputRef = ref<HTMLInputElement | null>(null)

const files = useQuery(queryDb(tables.files.where({ deletedAt: null })))

const handleUploadClick = () => {
  inputRef.value?.click()
}

const handleFileChange = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  try {
    const result = await saveFile(file)
    console.log('File saved:', result)
  } catch (error) {
    console.error('Failed to save file:', error)
  }

  // Reset input
  if (inputRef.value) {
    inputRef.value.value = ''
  }
}
</script>

<template>
  <div
    class="container"
    data-testid="gallery"
  >
    <div class="toolbar">
      <button
        type="button"
        @click="handleUploadClick"
        data-testid="upload-button"
      >
        + Upload Image
      </button>
      <input
        ref="inputRef"
        type="file"
        accept="image/*"
        @change="handleFileChange"
        class="hidden"
        data-testid="file-input"
      />
      <div
        class="status"
        data-testid="status-indicator"
      >
        <span
          class="status-dot"
          :class="{ online: isOnline() }"
        />
        {{ isOnline() ? 'Online' : 'Offline' }}
      </div>
    </div>

    <div
      v-if="!files || files.length === 0"
      class="empty"
      data-testid="empty-state"
    >
      <p>No images yet. Upload one to get started!</p>
    </div>
    <div
      v-else
      class="layout"
    >
      <ImageCard
        v-for="file in files"
        :key="file.id"
        :file="file"
      />
    </div>
  </div>
</template>

<style scoped>
.container {
  padding: 1rem;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.hidden {
  display: none;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: #999;
}

.status-dot.online {
  background-color: #090;
}

.empty {
  padding: 3rem 1rem;
  text-align: center;
  color: #666;
}

.layout {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
