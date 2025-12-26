# File URL Resolution Plan

## Goals
- Make it possible to use `file.path` directly as the display URL in web apps.
- Keep URL resolution automatic for local vs remote without explicit `loadUrl` calls.
- Preserve cross-platform behavior (web now, node later) without breaking storage paths.
- Keep integration simple and opt-in where possible.

## Current State (Core vs Reference)

Reference web flow (from `reference/vue-livestore-filesync/public/sw.js`):
- Intercepts same-origin requests to `/files/*`.
- Tries OPFS first; on miss, fetches remote `FILES_BASE_URL` (default `http://localhost:8787/api/files`).
- Optional bearer token via service worker script query params (`?token=...`).
- Sets content-type from local file or a small mime guesser; adds `cache-control: no-store`.
- Does not cache remote responses into OPFS.

Current core flow:
- `createFileSync.getFileUrl(path)` returns a local object URL only (if file exists locally).
- Examples call `getFileUrl` and store it in component state.
- Service worker helper exists (`packages/core/src/worker/file-sync-sw.ts`), but examples and docs show `getFileUrl` usage.
- Core service worker can cache remote responses into OPFS and relies on `getRemoteUrl` passed in the SW code, not via registration.

## Options and Trade-offs

### Option A: Service Worker First (Web)
Use `file.path` as a URL (`/files/<hash>`), and the SW resolves local vs remote.

Pros:
- Best ergonomics for UI: no `loadUrl`, no object URL lifecycle.
- Matches reference behavior and “automatic path resolution” goal.
- Lets standard `<img src>` and CSS `url()` work without code changes.

Cons:
- Requires SW registration and proper scope.
- Not available in node or SSR-only contexts.
- Auth/config needs a strategy (query params vs message vs baked-in config).
- Needs a clear fallback story if SW is unsupported or not registered.

### Option B: Helper Function (All Platforms)
Introduce `fileUrl(path)` or `resolveFileUrl(fileRecord)` that returns:
- local object URL if available, otherwise remote URL, otherwise null.

Pros:
- Works in node/SSR or environments without SW.
- Clear, explicit behavior; easier to test.
- No SW installation required.

Cons:
- Always async and forces UI to wait on `await`.
- Requires managing object URL lifecycle (revoke on cleanup).
- Does not allow simple HTML usage of `file.path` by default.

### Option C: Hybrid (Recommended)
Use SW for web to keep `file.path` ergonomic, and provide a helper for fallback/other runtimes.

Pros:
- Best UX in web, while still covering node/SSR and unsupported browsers.
- Allows gradual migration: apps can opt into SW and keep helper for safety.

Cons:
- Slightly more surface area to document and maintain.
- Needs clear precedence rules and config routing.

## Recommendation
Adopt the hybrid approach:
- Web: encourage the SW path proxy so `file.path` is a direct URL (no `loadUrl`).
- Node/SSR: provide a helper `fileUrl` or `resolveFileUrl` that falls back to remote or local file system paths.
- Keep `file.path` as the storage path (`files/<hash>`), but add a tiny helper to make it a URL-safe path (prefix with `/` and optional cache-busting query).

## Proposed Implementation Steps
1. Document the SW-first workflow in README and examples:
   - Register the SW on app startup.
   - Use `<img src={file.path}>` or `<img src={fileUrl(file.path)}>`.
2. Add a small helper in core (name TBD) to convert a stored path to a URL:
   - `filePathToUrl(path, { pathPrefix = "/files/" })`.
   - Ensures leading slash and handles optional query params for cache busting.
3. Extend SW configuration to accept remote base URL and auth headers:
   - Keep query params like reference (`?filesBaseUrl=...&token=...`).
   - Decide on a token refresh strategy if auth is short-lived.
4. Align `createFileSync.getFileUrl` with the new flow:
   - If SW is expected, return the URL-form path immediately.
   - Otherwise, keep the current local object URL behavior as a fallback.
5. Node strategy (defer):
   - Revisit after web behavior is finalized.
6. Update examples to remove `loadUrl`/`getFileUrl` state when SW is enabled.
7. Add lightweight tests for `filePathToUrl` and SW path matching logic.

## Decisions
- Use query params for SW config (reference-style).
- Keep current cache behavior in the core SW.
- Keep `file.path` stored as `files/<hash>`, with a helper that prefixes `/` for URL usage.
- Keep SW registration manual.
- Defer node URL strategy until after web is complete.
