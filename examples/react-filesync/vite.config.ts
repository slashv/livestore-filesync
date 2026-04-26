import { cloudflare } from "@cloudflare/vite-plugin"
import { livestoreDevtoolsPlugin } from "@livestore/devtools-vite"
import react from "@vitejs/plugin-react"
import process from "node:process"
import { defineConfig } from "vite"

const defaultPort = 60004

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
  optimizeDeps: {
    include: [
      "@livestore/adapter-web",
      "@livestore/adapter-web/shared-worker",
      "@livestore/adapter-web/worker",
      "@livestore/livestore",
      "@livestore/react",
      "@livestore/sync-cf/client"
    ],
    exclude: ["@livestore/wa-sqlite"]
  }
})
