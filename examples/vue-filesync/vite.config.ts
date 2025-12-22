import process from 'node:process'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const defaultPort = 60004

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : defaultPort,
    fs: { strict: false },
  },
  worker: { format: 'es' },
  plugins: [vue()],
  resolve: {
    dedupe: ['vue', '@livestore/livestore', 'vue-livestore', 'effect']
  },
  optimizeDeps: {
    exclude: ['@livestore/wa-sqlite']
  }
})
