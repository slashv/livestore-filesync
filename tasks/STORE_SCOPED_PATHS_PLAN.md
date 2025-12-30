# Store-Scoped File Paths Plan (Option B)

## Goal
Store all files under a store-scoped directory with a consistent path across local storage,
remote storage, and HTTP file URLs:

`livestore-filesync-files/{storeId}/{hash}`

Keep control endpoints under `/api` while file downloads and deletes are served from the
files base path (`/livestore-filesync-files/...`).

## Non-Goals
- Backward compatibility or migration from the legacy `files/` directory.
- Multi-store concurrency within a single origin (design supports it, but not required now).

## Path and Sanitization
- Canonical path format: `livestore-filesync-files/{safeStoreId}/{hash}`.
- `safeStoreId` sanitization:
  - Allow `[A-Za-z0-9._-]`.
  - Replace all other characters with `_`.
  - Optionally cap to a max length (e.g. 128) to avoid path length issues.
- Centralize in a single helper (core utils) so the same rules apply everywhere.

## API Endpoints (Option B)
- Control plane (unchanged base):
  - `POST /api/upload`
  - `GET /api/health`
- Data plane:
  - `GET /livestore-filesync-files/{storeId}/{hash}`
  - `DELETE /livestore-filesync-files/{storeId}/{hash}`

Notes:
- Upload returns a `url` that points to `/livestore-filesync-files/{storeId}/{hash}`.
- The service worker only intercepts `/livestore-filesync-files/` paths.

## Implementation Steps

### 1) Core path utilities
- Add constants and helpers in `packages/core/src/utils/path.ts`:
  - `FILES_ROOT = "livestore-filesync-files"`.
  - `sanitizeStoreId(storeId: string): string`.
  - `makeStoredPath(storeId: string, hash: string): string`.
  - Update any helpers/tests that assume `files/` prefix.

### 2) Use storeId automatically
- In `packages/core/src/api/createFileSync.ts`, derive storeId from `config.store`:
  - `const storeId = store.storeId` (confirm runtime shape).
  - Pass `storeId` into FileStorage/FileSync helpers as needed.
- Update `FileStorage` save/update to call `makeStoredPath(storeId, hash)`.
  - `packages/core/src/services/file-storage/FileStorage.ts`
- Update cleanup/listing in `FileSync` to list the store root:
  - `packages/core/src/services/file-sync/FileSync.ts` should list
    `livestore-filesync-files/{safeStoreId}` and not the old `files`.

### 3) Local storage usage (OPFS + Node)
- Keep `FileSystemOpfsLive` and Node adapters unchanged; they operate on paths passed in.
- Ensure any code that lists paths uses the store-scoped root.
- Confirm metadata handling (`.meta.json`) stays under the store-scoped path.

### 4) Service Worker
- Update `packages/core/src/worker/file-sync-sw.ts`:
  - `pathPrefix` default becomes `/livestore-filesync-files/`.
  - For OPFS, use the URL path (minus the leading slash) directly.
  - `getRemoteUrl` should map `normalizedPath` to `${filesBaseUrl}/${normalizedPath}`.
- Update `examples/*/file-sync-sw.ts` to pass `filesBaseUrl`
  (or derive from env) and use the new path prefix.

### 5) Remote storage adapter (client)
- Update `makeHttpRemoteStorage` in
  `packages/core/src/services/remote-file-storage/RemoteStorage.ts`:
  - Include storeId in upload payload:
    - Preferred: `FormData.append("file", file, key)`
      where `key = makeStoredPath(storeId, hash)` (pass storeId into adapter).
    - Alternative: add `key` field and have server use it.
  - Accept a `filesBaseUrl` in config to build download URLs if needed.
- Ensure `FileSync` uses `remoteUrl` returned by upload; download uses that.

### 6) Cloudflare worker changes
- Update routes in the Cloudflare Worker implementation:
  - Accept file reads/deletes at `/livestore-filesync-files/{key}` (no `/api/files`).
  - Update upload to store under provided key (from filename or `key` field).
  - Health remains under `/api/health`.
- Return `url` pointing to `/livestore-filesync-files/{key}`.

### 7) Examples and docs
- Update example apps to use new SW path and endpoint URLs.
  - `examples/react-filesync/src/App.tsx`
  - `examples/vue-filesync/src/App.vue`
  - `examples/node-filesync/src/main.ts`
- Add/update docs describing:
  - New path scheme and sanitization rules.
  - Endpoint split (control vs data).

### 8) Tests
- Update tests that assert `files/` prefix:
  - `packages/core/test/utils.test.ts`
  - `packages/core/test/LocalFileStorage.test.ts`
  - Any RemoteStorage tests that assume `/files/`
- Add tests for:
  - Sanitization behavior.
  - StoreId-specific paths.
  - File URL generation with `/livestore-filesync-files/...`.

## Open Questions
- Decide if `filesBaseUrl` is a separate config value or derived from `remote.baseUrl`.
