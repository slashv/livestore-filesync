/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_TOKEN?: string
  readonly VITE_LIVESTORE_SYNC_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
