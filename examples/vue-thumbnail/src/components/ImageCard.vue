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
import {
  parseThumbnailSizes,
  resolveThumbnailUrl,
} from '@livestore-filesync/image/thumbnails'
import { queryDb } from '@livestore/livestore'
import { useStore, useQuery } from 'vue-livestore'
import type { FileType } from '../types'

const props = defineProps<{
  file: FileType
}>()

const { store } = useStore()

// Per-file queries: only re-render when THIS file's state changes
const localFileState = useQuery(queryDb(tables.localFileState.where({ fileId: props.file.id }).first()))
const localFile = computed(() => localFileState.value)

const displayState = computed(() =>
  getFileDisplayState(props.file, localFileState.value ?? undefined)
)
const canDisplay = computed(() => displayState.value.canDisplay)
const isUploading = computed(() => displayState.value.isUploading)

// Per-file thumbnail query
const thumbRow = useQuery(queryDb(tables.thumbnailState.where({ fileId: props.file.id }).first()))
const sizes = computed(() => parseThumbnailSizes(thumbRow.value?.sizesJson))
const smallThumbnailStatus = computed(() => sizes.value['small']?.status ?? 'pending')

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
    // Simple invert filter
    const editedFile = await invertImageFile(srcFile)
    await updateFile(props.file.id, editedFile)
  } catch (error) {
    console.error('Failed to edit:', error)
  }
}

// Simple image inversion for edit demo
const invertImageFile = async (srcFile: File): Promise<File> => {
  const blobUrl = URL.createObjectURL(srcFile)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = (e) => reject(e)
      el.src = blobUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i]!
      data[i + 1] = 255 - data[i + 1]!
      data[i + 2] = 255 - data[i + 2]!
    }
    ctx.putImageData(imageData, 0, 0)

    const editedBlob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), srcFile.type))
    return new File([editedBlob], srcFile.name, { type: srcFile.type, lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

// Image URLs
const fullSrc = ref("")
const thumbnailSrc = ref("")

const loadFullUrl = async () => {
  const url = await resolveFileUrl(props.file.id)
  if (url) fullSrc.value = url
}

const loadThumbnailUrl = async () => {
  const thumbUrl = await resolveThumbnailUrl(props.file.id, 'small')
  if (thumbUrl) thumbnailSrc.value = thumbUrl
}

onMounted(() => {
  loadFullUrl()
  loadThumbnailUrl()
})

// Reload full URL when file changes
watch(() => props.file.updatedAt, loadFullUrl)

// Reload thumbnail URL when thumbnail state changes to 'done'
watch(
  () => smallThumbnailStatus.value,
  (newStatus) => {
    if (newStatus === 'done') {
      loadThumbnailUrl()
    }
  }
)

// Use thumbnail if available, fallback to full image
const displaySrc = computed(() => thumbnailSrc.value || fullSrc.value)
</script>

<template>
  <div
    class="card"
    data-testid="file-card"
  >
    <div class="image-container">
      <img
        v-if="canDisplay && displaySrc"
        :src="displaySrc"
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
      <!-- Thumbnail badge -->
      <div v-if="thumbnailSrc" class="thumbnail-badge" data-testid="thumbnail-badge">
        Thumbnail
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
            <td class="label">Display src</td>
            <td>{{ displaySrc ? 'Set' : 'Not set' }}</td>
          </tr>
          <tr>
            <td class="label">Thumbnail URL</td>
            <td data-testid="thumbnail-url">{{ thumbnailSrc ? 'Generated' : 'Not generated' }}</td>
          </tr>
          <tr>
            <td class="label">Thumbnail Status</td>
            <td data-testid="thumbnail-status">{{ smallThumbnailStatus }}</td>
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
            <td class="label">Local File: Upload</td>
            <td data-testid="file-upload-status">{{ localFile?.uploadStatus }}</td>
          </tr>
          <tr>
            <td class="label">Can Display</td>
            <td data-testid="file-can-display">{{ String(canDisplay) }}</td>
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

.thumbnail-badge {
  position: absolute;
  bottom: 4px;
  left: 4px;
  background: rgba(0, 128, 0, 0.8);
  color: white;
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 4px;
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
