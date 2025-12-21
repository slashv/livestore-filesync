<script setup lang="ts">
import { computed } from 'vue'
import { useFileUrl, useFileStatus, useDeleteFile } from '@livestore-filesync/vue'

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

const { url, isLoading } = useFileUrl(props.file.id)
const status = useFileStatus(props.file.id)
const { remove } = useDeleteFile()

const handleDelete = async () => {
  try {
    await remove(props.file.id)
  } catch (error) {
    console.error('Failed to delete:', error)
  }
}

const statusText = computed(() => {
  if (!status.value) return 'Unknown'
  if (status.value.uploadStatus === 'inProgress') return 'Uploading...'
  if (status.value.uploadStatus === 'queued') return 'Queued'
  if (status.value.uploadStatus === 'pending') return 'Pending'
  if (status.value.downloadStatus === 'inProgress') return 'Downloading...'
  if (status.value.downloadStatus === 'queued') return 'Queued'
  if (status.value.downloadStatus === 'pending') return 'Pending'
  if (status.value.lastSyncError) return 'Error'
  return 'Synced'
})

const statusColor = computed(() => {
  const text = statusText.value
  switch (text) {
    case 'Synced': return '#4caf50'
    case 'Uploading...':
    case 'Downloading...': return '#ff9800'
    case 'Queued':
    case 'Pending': return '#2196f3'
    case 'Error': return '#f44336'
    default: return '#999'
  }
})

const statusBadgeStyle = computed(() => ({
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  fontWeight: 'bold',
  color: '#fff',
  backgroundColor: statusColor.value
}))

const filename = computed(() => props.file.path.split('/').pop())
</script>

<template>
  <div :style="cardStyle" data-testid="file-card">
    <div :style="imageContainerStyle">
      <div v-if="isLoading" :style="placeholderStyle" data-testid="loading">Loading...</div>
      <img
        v-else-if="url"
        :src="url"
        :alt="file.path"
        :style="imageStyle"
        data-testid="file-image"
      />
      <div v-else :style="placeholderStyle">No preview</div>
    </div>
    <div :style="infoStyle">
      <div :style="filenameStyle" data-testid="file-name">{{ filename }}</div>
      <div :style="statusRowStyle">
        <span :style="statusBadgeStyle" data-testid="file-status">
          {{ statusText }}
        </span>
        <button
          type="button"
          @click="handleDelete"
          :style="deleteButtonStyle"
          data-testid="delete-button"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
const cardStyle = {
  backgroundColor: '#fff',
  borderRadius: '8px',
  overflow: 'hidden',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  transition: 'transform 0.2s, box-shadow 0.2s'
}

const imageContainerStyle = {
  width: '100%',
  height: '200px',
  backgroundColor: '#f5f5f5',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
}

const imageStyle = {
  width: '100%',
  height: '100%',
  objectFit: 'cover' as const
}

const placeholderStyle = {
  color: '#999',
  fontSize: '14px'
}

const infoStyle = {
  padding: '16px'
}

const filenameStyle = {
  fontSize: '14px',
  fontWeight: 'bold',
  color: '#333',
  marginBottom: '8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const
}

const statusRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between'
}

const deleteButtonStyle = {
  padding: '4px 12px',
  fontSize: '12px',
  color: '#f44336',
  backgroundColor: 'transparent',
  border: '1px solid #f44336',
  borderRadius: '4px',
  cursor: 'pointer'
}
</script>
