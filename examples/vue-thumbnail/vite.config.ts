import { cloudflare } from "@cloudflare/vite-plugin"
import { livestoreDevtoolsPlugin } from "@livestore/devtools-vite"
import vue from "@vitejs/plugin-vue"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const defaultPort = 60005

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : defaultPort,
    fs: { strict: false },
    headers: {
      // Required for wasm-vips SharedArrayBuffer support
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  },
  worker: { format: "es" },
  plugins: [
    cloudflare(),
    vue(),
    livestoreDevtoolsPlugin({ schemaPath: "./src/livestore/schema.ts" })
  ],
  resolve: {
    alias: {
      "@livestore/wa-sqlite": path.resolve(__dirname, "node_modules/@livestore/wa-sqlite")
    },
    dedupe: ["vue", "@livestore/livestore", "vue-livestore", "effect"]
  },
  optimizeDeps: {
    exclude: ["@livestore/wa-sqlite", "wasm-vips"]
  }
})
