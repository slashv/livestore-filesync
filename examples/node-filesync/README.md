# Node FileSync Example

Minimal Node.js example that mirrors the Vue FileSync setup and can interoperate
with the Vue app when pointed at the same sync and file API endpoints.

## Run

```sh
nvm use 24
pnpm install
pnpm --filter livestore-filesync-node-example dev
```

## Environment

- `STORE_ID` (default: `vue_filesync_store`)
- `AUTH_TOKEN` (default: `insecure-token-change-me`)
- `LIVESTORE_SYNC_URL` (default: `http://localhost:60004/sync`)
- `FILESYNC_BASE_URL` (default: `http://localhost:60004/api`)
