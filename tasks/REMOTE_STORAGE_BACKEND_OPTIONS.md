# Remote storage backend options (Gateway vs direct-to-S3)

This document covers:
- The correlation between `@livestore-filesync/core`’s `RemoteStorage` service and the Worker-side dev/data-plane implementation.
- Options for supporting “any S3-compatible backend” without a package per provider.
- A deeper expansion of the “skip gateway entirely” approach: the concrete changes needed in core (schema/types/services) and how the runtime flows look.

## Current correlation: `RemoteStorage` (core) ↔ Cloudflare R2 package

Core’s default remote adapter (`makeHttpRemoteStorage`) assumes a **Remote Storage Gateway** that speaks a simple HTTP contract:
- `POST {baseUrl}/upload` (multipart form-data: `file`, optional `key`) → JSON `{ url: string }`
- `GET {url}` → bytes
- `DELETE {url}` → deletes bytes
- `GET {baseUrl}/health` → `2xx` when healthy

A Worker-side helper can implement exactly that contract, backed by the Worker’s `R2Bucket` binding:
- `GET {basePath}/health` (default `/api/health`) → validates bucket access.
- `POST {basePath}/upload` (default `/api/upload`) → writes to R2 and returns JSON including `url`.
- `GET/DELETE {filesBasePath}/:key` (default `/livestore-filesync-files/:key`) → fetch/delete from R2.

Auth:
- Core sends `Authorization: Bearer <token>` when configured.
- Cloudflare handler accepts Bearer auth and an additional `X-Worker-Auth` header.

### Why this matters for “generic S3”

The Worker package is not “using the S3 API”. It’s using Cloudflare’s R2 binding API (`bucket.put/get/delete`). It looks like an S3 gateway only because it exposes an HTTP surface that core already knows how to talk to.

So: generalizing “Cloudflare” into “generic S3 gateway” is possible, but it is a different implementation strategy (SigV4 + AWS SDK or similar) than the current R2-binding implementation.

## Option 1: Keep the gateway contract; ship one generic S3 gateway (recommended for simplicity)

### Summary
Keep core unchanged: it talks to a gateway that implements `/upload`, `/health`, `GET`, `DELETE`.

Provide one generic gateway implementation that can target:
- AWS S3
- Cloudflare R2 (via S3 API)
- MinIO
- Wasabi
- Backblaze B2 S3-compatible
- …anything that works with S3-compatible clients

### Pros
- No schema changes in core.
- Stable `remoteUrl` stored in LiveStore (`files.remoteUrl`) remains valid long-term.
- Easiest for consumers: configure `remote.baseUrl` and go.
- Works with private buckets without exposing S3 credentials to browsers.

### Cons
- Gateway pays bandwidth and becomes a data plane (bytes flow through it).
- You need to operate a gateway service (but it can be very small).

### Implementation sketch
Create a new package (example name) `@livestore-filesync/gateway` that:
- Implements the existing HTTP contract.
- Uses AWS SDK v3 S3 client configured by env vars.
- Returns `url` pointing back at the gateway (`/livestore-filesync-files/:key`) so GET/DELETE remain gateway-local and stable.

Diagram:

```text
[App] -> [FileStorage] -> local write + DB update + schedule
                 |
                 v
             [FileSync] -> [RemoteStorage(makeHttpRemoteStorage)]
                 |
                 v
           POST/GET/DELETE/health
                 |
                 v
        [Gateway service (Node/Serverless)]
                 |
                 v
               [S3 API]
                 |
                 v
        [S3-compatible object storage]
```

## Option 2: Reuse an existing upload platform (Uppy Companion / tusd / etc.) + adapt core

### Summary
Adopt an off-the-shelf solution for uploads/downloads and modify core to integrate.

### Pros
- Less code to maintain for tricky multipart/resume scenarios.
- Mature battle-tested behavior.

### Cons
- Their APIs are not your current contract.
- You will almost certainly need a new `RemoteStorageAdapter` and additional metadata in the schema (upload sessions, part etags, etc.).
- You still likely run a server component.

This option is viable if you want resumable uploads as a first-class product feature.

## Option 3: Skip the gateway entirely (direct-to-S3 from clients)

This is the path you asked to expand. It is the “architecturally clean” approach if you accept schema/API changes.

### What “skip gateway” actually means

If you do not want a bytes gateway, you still need one of:
- A **signing service** (control plane only) that returns presigned URLs and performs privileged operations (health, delete).
- Or exposing long-lived S3 credentials to clients (usually unacceptable) via federated identity (Cognito / STS / custom broker), plus CORS configuration.

In practice, “skip gateway” usually becomes:
- **Direct data plane**: browser uploads/downloads directly to S3 using **presigned URLs**.
- **Small control plane**: a signing endpoint that mint presigned URLs and (optionally) performs deletes.

The biggest functional change: **do not store a long-lived `remoteUrl`** in synced state, because direct-to-S3 URLs are often:
- time-limited (presigned) or
- provider/CDN-dependent and potentially changeable

Instead, store a stable locator such as a **remote key** and derive/mint URLs at access time.

### Current code signals that this is already halfway-designed

In `FileSync`, upload derives a stable key:
- `remoteKey = stripFilesRoot(file.path)`

But then it stores only:
- `files.remoteUrl` (synced across clients)

So the missing piece is: **persist the stable remote locator** rather than persisting a gateway URL.

### Required core changes (concrete)

#### 1) Schema changes (`packages/core/src/schema/index.ts`)

Today the synced file table and event payload include:
- `remoteUrl: string`

For skip-gateway, change the synced representation to store a stable remote identifier:
- `remoteKey: string` (or `remote: { key: string; etag?: string; versionId?: string }`)

Concretely:
- Table `files`:
  - replace (or supplement) `remoteUrl` with `remoteKey`
  - consider adding `remoteProviderId` only if multi-backend per store is needed
- Event `v1.FileUpdated`:
  - replace `remoteUrl` with `remoteKey` (this is a breaking schema version; likely becomes `v2.FileUpdated`)

Rationale:
- With presigning, the “URL” is ephemeral; the “key” is stable.

#### 2) Types (`packages/core/src/types/index.ts`)

`FileRecord` currently requires `remoteUrl: string`. For skip-gateway you want:
- `remoteKey: string` (empty if not uploaded)
- optionally `remoteUrl?: string` if you support both modes during migration

#### 3) `RemoteStorage` service interface (`packages/core/src/services/remote-file-storage/RemoteStorage.ts`)

Today the interface is “URL-based”:
- `upload(file, {key}) -> string (url)`
- `download(url) -> File`
- `delete(url) -> void`

For skip-gateway it should be “key-based” and include URL derivation:

Minimal key-based design:
- `upload(file, { key }) -> { key: string; etag?: string }`
- `download(key) -> File` (implementation may use a presigned GET internally)
- `delete(key) -> void`
- `getDownloadUrl(key, { expiresInSeconds }) -> string` (for Service Worker / UI)
- `checkHealth()`

Alternative (more “direct”): separate the signing step and the transfer step:
- `getUploadUrl(key, { contentType, expiresInSeconds }) -> { url, headers? }`
- `getDownloadUrl(key, { expiresInSeconds }) -> { url, headers? }`
- `delete(key)` (server-side or presigned DELETE)

The second model aligns with “skip gateway” because the SDK is no longer responsible for moving bytes; it only mints URLs and the client does the transfer.

#### 4) `FileSync` changes (`packages/core/src/services/file-sync/FileSync.ts`)

Upload path today:
- reads local file
- `remoteStorage.upload(localFile, { key }) -> remoteUrl`
- stores `remoteUrl` in DB

Skip-gateway upload path (presigned):
- reads local file
- `remoteStorage.getUploadUrl(remoteKey, ...) -> { url, headers? }`
- `fetch(url, { method: "PUT", body: bytes, headers })` (or multipart strategy)
- stores `remoteKey` in DB (and optionally `etag`)

Download path today:
- requires `file.remoteUrl`
- `remoteStorage.download(file.remoteUrl)`

Skip-gateway download path:
- requires `file.remoteKey`
- either:
  - `remoteStorage.download(file.remoteKey)` (which internally presigns and fetches), or
  - `remoteStorage.getDownloadUrl(file.remoteKey)` + fetch in `FileSync`/SW depending on where you want the byte transfer to occur

#### 5) `FileStorage.getFileUrl` changes (`packages/core/src/services/file-storage/FileStorage.ts`)

Today it falls back to returning `file.remoteUrl`.

Skip-gateway:
- If local exists: same behavior (local file URL).
- Else if `remoteKey` exists:
  - return a **minted URL**:
    - either a presigned S3 GET URL, or
    - a stable path that the Service Worker resolves (but that implies a gateway again)

With presigned URLs you must decide caching behavior:
- Returning short-lived presigned URLs can work for `<img src=...>` but requires refresh on expiry.
- If you want stable `<img src="/livestore-filesync-files/...">`, you’re back to a gateway/SW proxy.

#### 6) Service Worker integration (`packages/core/src/worker/file-sync-sw.ts`)

The SW currently uses:
- `getRemoteUrl(path) -> Promise<string | null>`
- optional `getRemoteHeaders(path)`

For skip-gateway, this is actually a good fit if you reinterpret it as:
- `getRemoteUrl(path)` returns a **fresh presigned GET URL** for the object key that corresponds to `path`.

However, SW only knows `storedPath` (e.g. `livestore-filesync-files/<storeId>/<hash>`). You need a consistent mapping:
- Derive `remoteKey` from `storedPath` deterministically (as you already do in `FileSync.stripFilesRoot`).

If your remoteKey is exactly `stripFilesRoot(file.path)`, SW can do the same mapping:
- `remoteKey = stripFilesRoot(storedPath)`
- `getRemoteUrl` calls a signer endpoint to get presigned URL for that key

Diagram (download via SW + signer):

```text
[Browser] GET /livestore-filesync-files/<storeId>/<hash>
    |
    v
[Service Worker]
  - OPFS miss
  - remoteKey = stripFilesRoot(storedPath)
  - GET signer /download-url?key=remoteKey
    |
    v
[Signer service] --(AWS SigV4)--> returns presigned GET URL (expires 60s)
    |
    v
[Service Worker] fetch(presignedUrl) -> caches into OPFS -> responds to browser
```

### The unavoidable question: what server component remains?

If you want private buckets (typical) and do not want to ship S3 credentials to browsers, you still need a minimal server:
- a “signer” API that mints presigned URLs and enforces auth and authorization (per user / per storeId / per file key).

This is not a gateway for bytes. It is a control plane, and it can be extremely small and cheap.

### Practical design choices for skip-gateway

#### Choice A: “Signer only” (recommended if you truly want no data-plane server)
- Upload/download are direct-to-S3 using presigned URLs.
- Delete can be:
  - server-side delete (signer performs it), or
  - presigned DELETE URL (supported by S3).

#### Choice B: “Public read, signed write”
- Store objects private for write but replicate to a public CDN for read (or configure bucket public read for certain prefixes).
- Then `remoteUrl` can be stable (CDN URL) and you only sign uploads.
- This can avoid schema changes if you keep storing a stable public URL.

This is a strong contrarian option if your product tolerates public-read semantics (often it does not).

### Migration / compatibility strategy

The skip-gateway approach implies a breaking schema change because `remoteUrl` is currently in the synced table and events.

Two migration-friendly approaches:

1) Dual fields during a transition
- Add `remoteKey` alongside `remoteUrl`.
- Prefer `remoteKey` everywhere when present; otherwise fall back to `remoteUrl`.
- Emit new events that set both fields when possible.

2) Versioned events / v2 schema
- Introduce `v2.FileUpdated` with `remoteKey` instead of `remoteUrl`.
- Keep reading old rows/events for backward compatibility if required.

### What changes the least for “skip-gateway” while still giving you the benefits?

If your goal is mainly “no package per backend” and “easy S3-compatible configuration”, the minimum-effort variant is:
- Keep the current gateway contract (Option 1) and ship one generic S3 gateway.

If your goal is “no bytes through our servers”, the smallest stepping stone is:
- Keep your current HTTP gateway for downloads (stable URLs), but switch uploads to presigned direct-to-S3.
- That is a hybrid that reduces bandwidth costs without requiring the full schema refactor on day one.

## Appendix: Key places in core affected by the `remoteUrl` vs `remoteKey` decision

These are the primary coupling points where a refactor would land:
- Schema: `packages/core/src/schema/index.ts` (`files.remoteUrl`, `v1.FileUpdated.remoteUrl`)
- Types: `packages/core/src/types/index.ts` (`FileRecord.remoteUrl`)
- File sync engine: `packages/core/src/services/file-sync/FileSync.ts` (download requires `file.remoteUrl`; upload stores remoteUrl)
- File URL resolution: `packages/core/src/services/file-storage/FileStorage.ts` (fallback to returning `file.remoteUrl`)
- Service worker: `packages/core/src/worker/file-sync-sw.ts` (remote fetch via `getRemoteUrl(path)`)


