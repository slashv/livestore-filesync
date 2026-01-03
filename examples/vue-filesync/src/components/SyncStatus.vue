<script setup lang="ts">
import { computed } from 'vue'
import { useStore } from 'vue-livestore'
import { getSyncStatus } from '@livestore-filesync/core'
import { tables } from '../livestore/schema'

const { store } = useStore()
const { localFiles } = store.useClientDocument(tables.localFileState)

const syncStatus = computed(() => {
  return getSyncStatus(localFiles.value ?? {})
})
</script>

<template>
  <div class="sync-status">
    <h3>Sync Status</h3>
    
    <table>
      <tbody>
        <tr>
          <td>Syncing</td>
          <td>{{ syncStatus.isSyncing ? 'Yes' : 'No' }}</td>
        </tr>
        <tr>
          <td>Has Pending</td>
          <td>{{ syncStatus.hasPending ? 'Yes' : 'No' }}</td>
        </tr>
      </tbody>
    </table>

    <h4>Counts</h4>
    <table>
      <tbody>
        <tr>
          <td>Uploading</td>
          <td>{{ syncStatus.uploadingCount }}</td>
        </tr>
        <tr>
          <td>Downloading</td>
          <td>{{ syncStatus.downloadingCount }}</td>
        </tr>
        <tr>
          <td>Queued Upload</td>
          <td>{{ syncStatus.queuedUploadCount }}</td>
        </tr>
        <tr>
          <td>Queued Download</td>
          <td>{{ syncStatus.queuedDownloadCount }}</td>
        </tr>
        <tr>
          <td>Pending Upload</td>
          <td>{{ syncStatus.pendingUploadCount }}</td>
        </tr>
        <tr>
          <td>Pending Download</td>
          <td>{{ syncStatus.pendingDownloadCount }}</td>
        </tr>
        <tr>
          <td>Errors</td>
          <td>{{ syncStatus.errorCount }}</td>
        </tr>
      </tbody>
    </table>

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
</style>
