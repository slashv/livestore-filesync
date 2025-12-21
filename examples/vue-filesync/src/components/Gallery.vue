<script setup lang="ts">
import { ref, computed } from 'vue'
import { queryDb } from '@livestore/livestore'
import { useStore, useQuery } from 'vue-livestore'
import { useFileSync, useIsOnline } from '@livestore-filesync/vue'
import { tables } from '../livestore/schema.ts'
import ImageCard from './ImageCard.vue'

interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

const { store } = useStore()
const { saveFile } = useFileSync()
const isOnline = useIsOnline()
const inputRef = ref<HTMLInputElement | null>(null)

const filesQuery = queryDb((tables.files as any).where({ deletedAt: null }), { label: 'files' })
const files = useQuery(filesQuery) as unknown as ReturnType<typeof ref<FileRecord[]>>

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

const statusDotStyle = computed(() => ({
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  backgroundColor: isOnline.value ? '#4caf50' : '#f44336'
}))
</script>

<template>
  <div :style="containerStyle" data-testid="gallery">
    <div :style="toolbarStyle">
      <button
        type="button"
        @click="handleUploadClick"
        :style="uploadButtonStyle"
        data-testid="upload-button"
      >
        + Upload Image
      </button>
      <input
        ref="inputRef"
        type="file"
        accept="image/*"
        @change="handleFileChange"
        :style="hiddenInputStyle"
        data-testid="file-input"
      />
      <div
        :style="statusStyle"
        data-testid="status-indicator"
      >
        <span :style="statusDotStyle" />
        {{ isOnline ? 'Online' : 'Offline' }}
      </div>
    </div>

    <div v-if="!files || files.length === 0" :style="emptyStyle" data-testid="empty-state">
      <p>No images yet. Upload one to get started!</p>
    </div>
    <div v-else :style="gridStyle">
      <ImageCard
        v-for="file in files"
        :key="file.id"
        :file="file"
      />
    </div>
  </div>
</template>

<script lang="ts">
const containerStyle = {
  width: '100%'
}

const toolbarStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '24px',
  padding: '16px',
  backgroundColor: '#fff',
  borderRadius: '8px',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
}

const uploadButtonStyle = {
  padding: '12px 24px',
  fontSize: '16px',
  fontWeight: 'bold',
  color: '#fff',
  backgroundColor: '#2196f3',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  transition: 'background-color 0.2s'
}

const hiddenInputStyle = {
  display: 'none'
}

const statusStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '14px',
  color: '#666'
}

const emptyStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '80px 20px',
  backgroundColor: '#fff',
  borderRadius: '8px',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  color: '#999'
}

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
  gap: '20px'
}
</script>
