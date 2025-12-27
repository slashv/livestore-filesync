# File Resolution with the Service Worker

The file sync service worker lets the browser fetch `file.path` directly. Any GET request whose pathname starts with the configured prefix (default `/livestore-filesync-files/`) is intercepted and resolved from local OPFS storage when available, falling back to remote storage when not.

## Registering the worker (main thread)
- Import and call `registerFileSyncServiceWorker` during app startup.
- Point `scriptUrl` to a service worker module that calls `initFileSyncServiceWorker`.
- In the Vue example (`examples/vue-filesync/src/main.ts`), we build a module URL for `../file-sync-sw.ts`, add query params for `filesBaseUrl` and an optional bearer `token`, then register it with `{ type: "module" }`.

## Service worker module configuration
`examples/vue-filesync/file-sync-sw.ts` reads `filesBaseUrl` and `token` from its own URL search params and calls:
- `pathPrefix: "/livestore-filesync-files/"` so `file.path` can be used as-is in the UI.
- `getRemoteUrl: (path) => baseUrl ? \`\${baseUrl}/\${path}\` : \`/\${path}\`` to build the remote fetch URL when OPFS does not contain the file. The `path` passed in already includes the storage prefix.
- `getRemoteHeaders`: adds `Authorization: Bearer <token>` when provided.
- `cacheRemoteResponses: true` so remote fetches are stored back into OPFS for future reads.

## How requests are resolved
- The worker listens for `fetch` events and only handles GET requests whose pathname begins with `pathPrefix`.
- It derives `storedPath` from the request pathname (leading slash removed) and first tries `navigator.storage.getDirectory()` to read the file from OPFS. On a hit it returns the file with `Content-Type`, `Content-Length`, and `X-Source: opfs`.
- On a miss, it calls `getRemoteUrl(storedPath)` and fetches that URL with optional `getRemoteHeaders`. When the response is OK and `cacheRemoteResponses` is true, the body is cloned, stored in OPFS with the original path, and the response is returned with `X-Source: remote`.
- If no remote URL is provided or the fetch fails, the worker returns a 404 response.

## Using `file.path` in the UI
Components such as `examples/vue-filesync/src/components/ImageCard.vue` pass `file.path` directly to `<img :src>` and other fetches. The service worker ensures that path resolves either to the locally synced copy (OPFS) or to the remote storage URL without extra client-side URL resolution code.

## Optional messaging hooks
The worker exposes `createMessageHandler` to respond to `CLEAR_CACHE` and `PREFETCH` messages from the main thread (e.g., via `sendMessageToServiceWorker`). The example worker currently only initializes fetch handling; add `createMessageHandler` in the worker module if you need those commands.

## Resolving file URLs in Node/Electron (no service worker)
- Use the new `resolveFileUrl(fileId)` method from `createFileSync`. It returns a Node-friendly URL: `file://...` when the file exists locally, otherwise the remote URL stored in the record.
- Pass `options.localPathRoot` when creating `fileSync` so local paths can be turned into `file://` URLs. In the Node example we set `localPathRoot: "tmp/filesync"` to match the FileSystem adapter base directory.
- Example (`examples/node-filesync/src/main.ts`):
  - Create `fileSync` with `options: { localPathRoot: "tmp/filesync" }`.
  - After saving or syncing, call `const url = await fileSync.resolveFileUrl(result.fileId)`.
  - Use that URL for serving or logging; when local it points to the on-disk copy, otherwise to the remote location.
- Electron renderer can still use the service worker path approach; Electron main can use `resolveFileUrl` the same way Node does, or expose a custom protocol that serves those `file://` paths.

