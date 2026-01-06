<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vue-livestore'
import {
  getSyncStatus,
  onFileSyncEvent,
  createActiveTransferProgress,
  updateActiveTransfers,
  removeActiveTransfer,
  computeTotalProgress,
  type ActiveTransfers
} from '@livestore-filesync/core'
import { tables } from '../livestore/schema'

const { store } = useStore()
const { localFiles } = store.useClientDocument(tables.localFileState)

const syncStatus = computed(() => {
  return getSyncStatus(localFiles.value ?? {})
})

// Track active transfer progress
const activeTransfers = ref<ActiveTransfers>({})

// Subscribe to file sync events for progress tracking
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = onFileSyncEvent((event) => {
    if (event.type === 'upload:progress' || event.type === 'download:progress') {
      const progress = createActiveTransferProgress(
        event.fileId,
        event.progress.kind,
        event.progress.loaded,
        event.progress.total
      )
      activeTransfers.value = updateActiveTransfers(activeTransfers.value, progress)
    } else if (
      event.type === 'upload:complete' ||
      event.type === 'upload:error' ||
      event.type === 'download:complete' ||
      event.type === 'download:error'
    ) {
      activeTransfers.value = removeActiveTransfer(activeTransfers.value, event.fileId)
    }
  })
})

onUnmounted(() => {
  unsubscribe?.()
})

// Computed total progress
const totalProgress = computed(() => computeTotalProgress(activeTransfers.value))

// List of active transfers for display
const activeTransfersList = computed(() => Object.values(activeTransfers.value))
</script>

<template>
  <div class="sync-status" data-testid="sync-status-panel">
    <h3>Sync Status</h3>
    
    <table>
      <tbody>
        <tr>
          <td>Syncing</td>
          <td data-testid="sync-is-syncing">{{ syncStatus.isSyncing ? 'Yes' : 'No' }}</td>
        </tr>
        <tr>
          <td>Has Pending</td>
          <td data-testid="sync-has-pending">{{ syncStatus.hasPending ? 'Yes' : 'No' }}</td>
        </tr>
      </tbody>
    </table>

    <h4>Counts</h4>
    <table>
      <tbody>
        <tr>
          <td>Uploading</td>
          <td data-testid="sync-uploading-count">{{ syncStatus.uploadingCount }}</td>
        </tr>
        <tr>
          <td>Downloading</td>
          <td data-testid="sync-downloading-count">{{ syncStatus.downloadingCount }}</td>
        </tr>
        <tr>
          <td>Queued Upload</td>
          <td data-testid="sync-queued-upload-count">{{ syncStatus.queuedUploadCount }}</td>
        </tr>
        <tr>
          <td>Queued Download</td>
          <td data-testid="sync-queued-download-count">{{ syncStatus.queuedDownloadCount }}</td>
        </tr>
        <tr>
          <td>Pending Upload</td>
          <td data-testid="sync-pending-upload-count">{{ syncStatus.pendingUploadCount }}</td>
        </tr>
        <tr>
          <td>Pending Download</td>
          <td data-testid="sync-pending-download-count">{{ syncStatus.pendingDownloadCount }}</td>
        </tr>
        <tr>
          <td>Errors</td>
          <td data-testid="sync-error-count">{{ syncStatus.errorCount }}</td>
        </tr>
      </tbody>
    </table>

    <template v-if="totalProgress.count > 0">
      <h4>Transfer Progress</h4>
      <div data-testid="transfer-progress-section">
        <div data-testid="transfer-progress-total">
          Total: {{ totalProgress.percent !== null ? totalProgress.percent + '%' : 'calculating...' }}
          ({{ totalProgress.totalLoaded }} / {{ totalProgress.totalSize }} bytes, {{ totalProgress.count }} transfers)
        </div>
        <div v-for="transfer in activeTransfersList" :key="transfer.fileId" class="transfer-item" data-testid="transfer-progress-item">
          <span data-testid="transfer-file-id">{{ transfer.fileId.slice(0, 8) }}...</span>
          <span data-testid="transfer-kind">{{ transfer.kind }}</span>
          <span data-testid="transfer-percent">{{ transfer.percent !== null ? transfer.percent + '%' : '?' }}</span>
          <span data-testid="transfer-bytes">({{ transfer.loaded }}/{{ transfer.total }})</span>
        </div>
      </div>
    </template>

    <template v-if="syncStatus.uploadingFileIds.length > 0">
      <h4>Uploading Files</h4>
      <ul>
        <li v-for="id in syncStatus.uploadingFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.downloadingFileIds.length > 0">
      <h4>Downloading Files</h4>
      <ul>
        <li v-for="id in syncStatus.downloadingFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.queuedUploadFileIds.length > 0">
      <h4>Queued Uploads</h4>
      <ul>
        <li v-for="id in syncStatus.queuedUploadFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.queuedDownloadFileIds.length > 0">
      <h4>Queued Downloads</h4>
      <ul>
        <li v-for="id in syncStatus.queuedDownloadFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.pendingUploadFileIds.length > 0">
      <h4>Pending Uploads</h4>
      <ul>
        <li v-for="id in syncStatus.pendingUploadFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.pendingDownloadFileIds.length > 0">
      <h4>Pending Downloads</h4>
      <ul>
        <li v-for="id in syncStatus.pendingDownloadFileIds" :key="id">{{ id }}</li>
      </ul>
    </template>

    <template v-if="syncStatus.errors.length > 0">
      <h4>Errors</h4>
      <ul>
        <li v-for="err in syncStatus.errors" :key="err.fileId">
          <strong>{{ err.fileId }}:</strong> {{ err.error }}
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.sync-status {
  font-size: 12px;
  padding: 12px;
  border-left: 1px solid #000;
  min-width: 200px;
  max-width: 280px;
  overflow-y: auto;
}

h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
}

h4 {
  margin: 12px 0 6px 0;
  font-size: 12px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

td {
  padding: 4px 6px;
  border: 1px solid #000;
}

td:first-child {
  font-weight: 500;
}

td:last-child {
  text-align: right;
}

ul {
  margin: 0;
  padding: 0 0 0 16px;
  list-style: none;
}

li {
  padding: 2px 0;
  word-break: break-all;
}

.transfer-item {
  display: flex;
  gap: 8px;
  font-size: 11px;
  padding: 2px 0;
}

.transfer-item span {
  white-space: nowrap;
}
</style>
