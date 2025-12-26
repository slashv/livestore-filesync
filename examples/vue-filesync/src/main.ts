import { createApp } from 'vue'
import App from './App.vue'

import { registerFileSyncServiceWorker } from '@livestore-filesync/core/worker'

const authToken = import.meta.env.VITE_AUTH_TOKEN
const swUrl = new URL('../file-sync-sw.ts', import.meta.url)
swUrl.searchParams.set('filesBaseUrl', window.location.origin)
if (authToken) {
  swUrl.searchParams.set('token', authToken)
}

void registerFileSyncServiceWorker({
  scriptUrl: swUrl.toString(),
  type: 'module'
})

createApp(App).mount('#app')
