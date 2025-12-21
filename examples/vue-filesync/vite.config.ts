import path from 'node:path'
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
    alias: {
      '@livestore-filesync/core/schema': path.resolve(__dirname, '../../packages/core/dist/schema/index.js'),
      '@livestore-filesync/core': path.resolve(__dirname, '../../packages/core/dist/index.js'),
      '@livestore-filesync/vue': path.resolve(__dirname, '../../packages/vue/dist/index.js'),
      // Ensure single instances of livestore packages
      '@livestore/livestore': path.resolve(__dirname, 'node_modules/@livestore/livestore'),
      'vue': path.resolve(__dirname, 'node_modules/vue'),
      // Ensure single effect instance
      'effect': path.resolve(__dirname, 'node_modules/effect'),
    },
    dedupe: ['vue', '@livestore/livestore', 'vue-livestore', 'effect']
  },
  optimizeDeps: {
    exclude: ['@livestore/wa-sqlite'],
    include: ['@livestore-filesync/core', '@livestore-filesync/vue']
  }
})
