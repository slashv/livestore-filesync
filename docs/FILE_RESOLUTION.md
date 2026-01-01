# File Resolution with the Service Worker

The file sync service worker lets the browser fetch `file.path` directly. Any GET request whose pathname starts with the configured prefix (default `/livestore-filesync-files/`) is intercepted and resolved from local OPFS storage when available, falling back to remote storage when not.

## Quick Setup

The core package provides a pre-bundled service worker that works in all browsers (including Firefox, which doesn't support ES module service workers).

### 1. Copy the bundled service worker to your public folder

Add a postinstall script to your `package.json`:

```json
{
  "scripts": {
    "postinstall": "cp node_modules/@livestore-filesync/core/dist/file-sync-sw.iife.js public/file-sync-sw.js"
  }
}
```

Or run manually:
```bash
cp node_modules/@livestore-filesync/core/dist/file-sync-sw.iife.js public/file-sync-sw.js
```

### 2. Initialize the service worker

The service worker must be initialized before any file URLs can be resolved. Call `initServiceWorker` and await it before rendering:

```typescript
import { initServiceWorker } from '@livestore-filesync/core/worker'

// This must complete before file URLs will work
await initServiceWorker({ authToken: 'your-auth-token' })
```

### 3. Initialize FileSync (separate from service worker)

```typescript
import { initFileSync } from '@livestore-filesync/core'
import { layer as opfsLayer } from '@livestore-filesync/opfs'

const dispose = initFileSync(store, {
  fileSystem: opfsLayer(),
  remote: { signerBaseUrl: '/api' }
})
```

### 4. Use file.path directly in your UI

```tsx
<img src={`/${file.path}`} alt={file.name} />
```

## React Example

```tsx
// FileSyncProvider.tsx
<FileSyncProvider 
  signerBaseUrl="/api"
  authToken={authToken}
  serviceWorker  // Enable service worker
>
  {children}
</FileSyncProvider>
```

The `FileSyncProvider` component handles everything: initializing the service worker, initializing FileSync, and waiting for the service worker to be ready before rendering children.

## Advanced: Low-level Registration

If you need more control, you can use the low-level registration API:

```typescript
import { registerFileSyncServiceWorker } from '@livestore-filesync/core/worker'

const swUrl = new URL('/file-sync-sw.js', window.location.origin)
swUrl.searchParams.set('filesBaseUrl', window.location.origin)
swUrl.searchParams.set('token', authToken)

await registerFileSyncServiceWorker({ scriptUrl: swUrl.toString() })
await navigator.serviceWorker.ready
```

## Configuration via URL parameters

The bundled service worker reads configuration from URL search params:
- `filesBaseUrl`: Base URL for remote file fetches (e.g., `window.location.origin`)
- `token`: Optional bearer token for authentication

The worker is configured with:
- `pathPrefix: "/livestore-filesync-files/"` so `file.path` can be used as-is in the UI.
- `getRemoteUrl: (path) => baseUrl ? \`\${baseUrl}/\${path}\` : \`/\${path}\`` to build the remote fetch URL when OPFS does not contain the file.
- `getRemoteHeaders`: adds `Authorization: Bearer <token>` when provided.
- `cacheRemoteResponses: true` so remote fetches are stored back into OPFS for future reads.

## How requests are resolved
- The worker listens for `fetch` events and only handles GET requests whose pathname begins with `pathPrefix`.
- It derives `storedPath` from the request pathname (leading slash removed) and first tries `navigator.storage.getDirectory()` to read the file from OPFS. On a hit it returns the file with `Content-Type`, `Content-Length`, and `X-Source: opfs`.
- On a miss, it calls `getRemoteUrl(storedPath)` and fetches that URL with optional `getRemoteHeaders`. When the response is OK and `cacheRemoteResponses` is true, the body is cloned, stored in OPFS with the original path, and the response is returned with `X-Source: remote`.
- If no remote URL is provided or the fetch fails, the worker returns a 404 response.

## Using `file.path` in the UI
Components such as `examples/react-filesync/src/components/ImageCard.tsx` can pass `file.path` directly to `<img src>`. The service worker ensures that path resolves either to the locally synced copy (OPFS) or to the remote storage URL without extra client-side URL resolution code.

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

