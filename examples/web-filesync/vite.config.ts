import path from 'node:path'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const defaultPort = 60003

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : defaultPort,
    fs: { strict: false },
  },
  worker: { format: 'es' },
  plugins: [react()],
  resolve: {
    alias: {
      '@livestore-filesync/core/schema': path.resolve(__dirname, '../../packages/core/dist/schema/index.js'),
      '@livestore-filesync/core': path.resolve(__dirname, '../../packages/core/dist/index.js'),
      '@livestore-filesync/react': path.resolve(__dirname, '../../packages/react/dist/index.js'),
      // Ensure a single copy of React is used (fixes "Invalid hook call" errors)
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      // Ensure single instances of livestore packages
      '@livestore/react': path.resolve(__dirname, 'node_modules/@livestore/react'),
      '@livestore/livestore': path.resolve(__dirname, 'node_modules/@livestore/livestore'),
    },
    dedupe: ['react', 'react-dom', '@livestore/react', '@livestore/livestore']
  },
  optimizeDeps: {
    exclude: ['@livestore/wa-sqlite'],
    include: ['@livestore-filesync/core', '@livestore-filesync/react']
  }
})
