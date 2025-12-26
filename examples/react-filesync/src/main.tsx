import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'

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

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element not found')
}

createRoot(rootElement).render(<App />)
