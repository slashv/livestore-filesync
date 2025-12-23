<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useStore } from 'vue-livestore'
import { useFileSync } from '@livestore-filesync/vue'
import { tables } from '../livestore/schema.ts'

interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

const props = defineProps<{
  file: FileRecord
}>()

const { store } = useStore()
const fileSync = useFileSync()
const url = ref<string | null>(null)
const isLoading = ref(true)
const { localFiles } = store.useClientDocument(tables.localFileState)
const localFile = computed(() => localFiles.value[props.file.id])

// Load file URL on mount and when file changes
const loadUrl = async () => {
  isLoading.value = true
  try {
    url.value = await fileSync.getFileUrl(props.file.path)
  } catch (error) {
    console.error('Failed to load file URL:', error)
    url.value = null
  }
  isLoading.value = false
}

onMounted(loadUrl)
watch(() => props.file.path, loadUrl)
watch(
  () => localFile.value?.downloadStatus,
  (status, prevStatus) => {
    if (status === 'done' && status !== prevStatus) {
      void loadUrl()
    }
  }
)

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
  <div class="card" data-testid="file-card">
    <div class="image-container">
      <div v-if="isLoading" class="placeholder" data-testid="loading">Loading...</div>
      <img
        v-else-if="url"
        :src="url"
        :alt="file.path"
        class="image"
        data-testid="file-image"
      />
      <div v-else class="placeholder">No preview</div>
    </div>
    <div class="info">
      <div class="filename" data-testid="file-name">{{ filename }}</div>
      <div class="actions">
        <span class="status" data-testid="file-status">
          {{ file.remoteUrl ? 'Synced' : 'Local' }}
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
