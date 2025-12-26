<script setup lang="ts">
import { tables } from '../livestore/schema'
import { computed } from 'vue'
import { useFileSync } from '@livestore-filesync/vue'
import { useStore } from 'vue-livestore'
import type { FileType } from '../types'

const props = defineProps<{
  file: FileType
}>()

const fileSync = useFileSync()
const { store } = useStore()

const { localFiles } = store.useClientDocument(tables.localFileState)
const localFile = computed(() => localFiles.value[props.file.id])

const handleDelete = async () => {
  try {
    await fileSync.deleteFile(props.file.id)
  } catch (error) {
    console.error('Failed to delete:', error)
  }
}

const filename = computed(() => props.file.path.split('/').pop())
</script>

<template>
  <div
    class="card"
    data-testid="file-card"
  >
    <div class="image-container">
      <img
        :src="file.path"
        class="image"
        data-testid="file-image"
      />
    </div>
    <div class="info">
      <div
        class="filename"
        data-testid="file-name"
      >{{ filename }}</div>
      <div class="actions">
        <span
          class="status"
          data-testid="file-status"
        >
          {{ localFile?.downloadStatus ?? 'Pending' }}
        </span>
        <button
          type="button"
          @click="handleDelete"
          data-testid="delete-button"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid #ccc;
}

.image-container {
  height: 150px;
  background: #eee;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.placeholder {
  color: #666;
}

.info {
  padding: 0.5rem;
}

.filename {
  font-weight: bold;
  margin-bottom: 0.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status {
  font-size: 0.875rem;
  color: #666;
}
</style>
