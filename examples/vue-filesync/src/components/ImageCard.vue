<script setup lang="ts">
import { tables } from '../livestore/schema'
import { computed, onMounted, ref, watch } from 'vue'
import {
  deleteFile,
  getFileDisplayState,
  readFile,
  resolveFileUrl,
  updateFile,
} from '@livestore-filesync/core'
import { useStore } from 'vue-livestore'
import type { FileType } from '../types'
import { invertImageFile } from '../utils/image.utils'

const props = defineProps<{
  file: FileType
}>()

const { store } = useStore()

const { localFiles } = store.useClientDocument(tables.localFileState)
const localFile = computed(() => localFiles.value[props.file.id])

const displayState = computed(() =>
  getFileDisplayState(props.file, localFiles.value)
)
const canDisplay = computed(() => displayState.value.canDisplay)
const isUploading = computed(() => displayState.value.isUploading)

const handleDelete = async () => {
  try {
    await deleteFile(props.file.id)
  } catch (error) {
    console.error('Failed to delete:', error)
  }
}

const handleEdit = async () => {
  try {
    const srcFile = await readFile(props.file.path)
    const edited = await invertImageFile(srcFile)
    await updateFile(props.file.id, edited)
  } catch (error) {
    console.error('Failed to edit:', error)
  }
}

const src = ref("")
onMounted(async () => {
  const url = await resolveFileUrl(props.file.id)
  if (url) src.value = url
})

watch(() => props.file.updatedAt, async () => {
  const url = await resolveFileUrl(props.file.id)
  if (url) src.value = url
})
</script>

<template>
  <div
    class="card"
    data-testid="file-card"
  >
    <div class="image-container">
      <img
        v-if="canDisplay && src"
        :src="src"
        :alt="file.path"
        class="image"
        data-testid="file-image"
      />
      <div
        v-else
        class="image-placeholder"
        data-testid="file-placeholder"
      >
        {{ isUploading ? 'Uploading...' : 'Waiting for file...' }}
      </div>
    </div>
    <div class="info">
      <div class="header">
        <span data-testid="file-name"><strong>File ID:</strong> {{ file.id }}</span>
        <div class="actions">
          <button
            type="button"
            @click="handleEdit"
            data-testid="edit-button"
          >Edit</button>
          <button
            type="button"
            @click="handleDelete"
            data-testid="delete-button"
          >Delete</button>
        </div>
      </div>
      <table class="debug-table">
        <tbody>
          <tr>
            <td class="label">src</td>
            <td>{{ src }}</td>
          </tr>
          <tr>
            <td class="label">File: Path</td>
            <td>{{ file.path }}</td>
          </tr>
          <tr>
            <td class="label">File: Remote Key</td>
            <td data-testid="file-remote-key">{{ file.remoteKey }}</td>
          </tr>
          <tr>
            <td class="label">File: Hash</td>
            <td>{{ file.contentHash }}</td>
          </tr>
          <tr>
            <td class="label">File: Updated At</td>
            <td>{{ file.updatedAt }}</td>
          </tr>
          <tr>
            <td class="label">Local File: Hash</td>
            <td data-testid="file-local-hash">{{ localFile?.localHash }}</td>
          </tr>
          <tr>
            <td class="label">Local File: Download</td>
            <td data-testid="file-download-status">{{ localFile?.downloadStatus }}</td>
          </tr>
          <tr>
            <td class="label">Local File: Upload</td>
            <td data-testid="file-upload-status">{{ localFile?.uploadStatus }}</td>
          </tr>
          <tr>
            <td class="label">Can Display</td>
            <td data-testid="file-can-display">{{ String(canDisplay) }}</td>
          </tr>
          <tr v-if="localFile?.lastSyncError">
            <td class="label">Error</td>
            <td>{{ localFile?.lastSyncError }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.card {
  width: 100%;
  border: 1px solid #ccc;
  display: grid;
  grid-template-columns: 200px 1fr;
}

.image-container {
  position: relative;
  min-height: 200px;
  background: #eee;
  border-right: 1px solid #ccc;
  align-self: stretch;
}

.image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 0.875rem;
}

.info {
  display: flex;
  flex-direction: column;
}

.header {
  padding: 0.5rem;
  border-bottom: 1px solid #ccc;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.875rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.debug-table {
  width: 100%;
  font-size: 0.875rem;
  border-collapse: collapse;
}

.debug-table td {
  padding: 0.5rem;
  border-bottom: 1px solid #ccc;
}

.debug-table tr:last-child td {
  border-bottom: none;
}

.debug-table .label {
  width: 150px;
  white-space: nowrap;
  border-right: 1px solid #ccc;
  font-weight: 500;
}
</style>
