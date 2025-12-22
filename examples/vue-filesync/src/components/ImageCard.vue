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
  <div
    :style="cardStyle"
    data-testid="file-card"
  >
    <div :style="imageContainerStyle">
      <div
        v-if="isLoading"
        :style="placeholderStyle"
        data-testid="loading"
      >Loading...</div>
      <img
        v-else-if="url"
        :src="url"
        :alt="file.path"
        :style="imageStyle"
        data-testid="file-image"
      />
      <div
        v-else
        :style="placeholderStyle"
      >No preview</div>
    </div>
    <div :style="infoStyle">
      <div
        :style="filenameStyle"
        data-testid="file-name"
      >{{ filename }}</div>
      <div :style="statusRowStyle">
        <span
          :style="statusBadgeStyle"
          data-testid="file-status"
        >
          {{ file.remoteUrl ? 'Synced' : 'Local' }}
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

const statusBadgeStyle = {
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  fontWeight: 'bold',
  color: '#fff',
  backgroundColor: '#4caf50'
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
