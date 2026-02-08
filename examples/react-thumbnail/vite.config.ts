import { cloudflare } from "@cloudflare/vite-plugin"
import { livestoreDevtoolsPlugin } from "@livestore/devtools-vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const defaultPort = 60006

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : defaultPort,
    fs: { strict: false }
  },
  worker: { format: "es" },
  plugins: [
    cloudflare(),
    react(),
    livestoreDevtoolsPlugin({ schemaPath: "./src/livestore/schema.ts" })
  ],
  resolve: {
    alias: {
      "@livestore/wa-sqlite": path.resolve(__dirname, "node_modules/@livestore/wa-sqlite")
    },
    dedupe: ["react", "react-dom", "@livestore/livestore", "@livestore/react", "effect"]
  },
  optimizeDeps: {
    exclude: ["@livestore/wa-sqlite"]
  }
})
