# Option 3 (greenfield): Direct-to-S3 with a lightweight signing Worker

This document is a focused plan for a greenfield architecture where we accept core changes and target **one** S3-compatible remote storage implementation that works across providers via configuration (endpoint/region/bucket), without shipping provider-specific “adapters”.

The approach:
- **Data plane**: clients upload/download directly to S3-compatible object storage (no bytes through our services).
- **Control plane**: a lightweight **signing service** (deployable as a Worker) mints presigned URLs and enforces auth/authorization.

---

## Goals

- Support **any S3-compatible** storage backend via configuration (AWS S3, Cloudflare R2 S3 endpoint, MinIO, Wasabi, Backblaze, etc.).
- Remove the need for gateway endpoints like `POST /upload` that proxy bytes.
- Keep `@livestore-filesync/core` ergonomics: `saveFile`, `updateFile`, `deleteFile`, and “give me a URL to display”.
- Maintain the current content-addressable storage behavior (path derived from hash and storeId).

## Non-goals (initially)

- Full resumable/multipart uploads for very large files (we can add later; the design below supports it).
- Server-driven per-object ACL policies beyond key-prefix restrictions.

---

## The key architectural change

### Today (gateway-friendly)

The synced DB stores `remoteUrl` and core uses URL-based operations (`download(url)`, `delete(url)`).

### Option 3 (direct-to-S3)

The synced DB stores a stable **remote object identifier** (a key), and core requests **short-lived URLs** only when needed.

Why:
- Presigned URLs expire; storing them in synced state is wrong.
- A stable key is portable across providers and URLs (S3 endpoint / CDN) can change without rewriting history.

---

## Proposed core model

### Canonical remote locator: `remoteKey`

We already derive a deterministic key in the sync engine:
- `remoteKey = stripFilesRoot(file.path)`

We make this **the** persisted remote reference:
- `files.remoteKey` is synced across clients.
- `remoteKey === ""` means “not uploaded / not yet associated with remote”.

Optionally store remote metadata (useful for validation and caching):
- `remoteEtag?: string`
- `remoteSize?: number`
- `remoteContentType?: string`

---

## Required changes in core (concrete)

### 1) Schema changes (`packages/core/src/schema/index.ts`)

Replace `remoteUrl` with `remoteKey` in:
- `tables.files` columns
- `events.fileUpdated` schema and payload

Because this is greenfield, we can do this as a straight rename. If you still want event versioning hygiene, introduce `v2.FileUpdated` and remove `v1.FileUpdated` entirely.

Proposed `files` columns:
- `id: text primary key`
- `path: text`
- `remoteKey: text default ""`
- `contentHash: text`
- timestamps

### 2) Types changes (`packages/core/src/types/index.ts`)

Change `FileRecord`:
- remove `remoteUrl: string`
- add `remoteKey: string`

### 3) Service contract change: `RemoteStorage` becomes key-based + URL-minting

Current interface is URL-based (`upload -> url`, `download(url)`).

New interface proposal (minimal + pragmatic):

- `getUploadUrl(key, params) -> { url: string; headers?: Record<string, string>; method: "PUT" | "POST"; expiresAt: string }`
- `getDownloadUrl(key, params) -> { url: string; headers?: Record<string, string>; expiresAt: string }`
- `deleteObject(key) -> Effect<void, DeleteError>`
- `checkHealth() -> Effect<boolean, never>`

Optional extension for multipart later:
- `createMultipartUpload(key, params) -> { uploadId }`
- `getMultipartPartUrl(key, uploadId, partNumber) -> { url, headers?, expiresAt }`
- `completeMultipartUpload(key, uploadId, parts: Array<{partNumber, etag}>)`
- `abortMultipartUpload(key, uploadId)`

### 4) `FileSync` changes (`packages/core/src/services/file-sync/FileSync.ts`)

#### Upload path

Today:
- `remoteStorage.upload(localFile, { key }) -> remoteUrl`
- store `remoteUrl`

New flow:
- `remoteKey = stripFilesRoot(file.path)`
- `remoteStorage.getUploadUrl(remoteKey, { contentType, contentLength? })`
- `fetch(putUrl, { method, headers, body: file })` (client->S3)
- store `remoteKey` (and optionally etag/size/contentType)

Important: if upload finishes but record deleted concurrently, call `remoteStorage.deleteObject(remoteKey)` best-effort.

#### Download path

Today:
- requires `file.remoteUrl`
- `remoteStorage.download(file.remoteUrl)`

New flow:
- requires `file.remoteKey`
- `remoteStorage.getDownloadUrl(file.remoteKey)` + `fetch(url)`
- write to local storage

### 5) `FileStorage.getFileUrl` changes (`packages/core/src/services/file-storage/FileStorage.ts`)

Today it falls back to returning `file.remoteUrl`.

New semantics:
- If local exists -> return local URL (unchanged).
- Else if `remoteKey` exists -> return a **fresh download URL** (presigned or public).
- Else -> return `null`.

This means `getFileUrl(fileId)` becomes “may mint remote URL” and will often be async (already is).

### 6) `createFileSync` config changes (`packages/core/src/api/createFileSync.ts`)

Today `remote` config is gateway-based:
- `{ baseUrl, headers?, authToken? }`

New config is signer-based:
- `{ signerBaseUrl, headers?, authToken? }`

Core should not need to know S3 endpoint/bucket; the signer encapsulates provider configuration.

### 7) Service Worker integration (`packages/core/src/worker/file-sync-sw.ts`)

The SW already has:
- `getRemoteUrl(path) => Promise<string | null>`
- `getRemoteHeaders(path)`

In Option 3 this becomes:
- `getRemoteUrl(storedPath)`: call signer to mint a presigned **GET** URL for `remoteKey = stripFilesRoot(storedPath)`
- `getRemoteHeaders(storedPath)`: return any headers required by the presigned URL response (usually none) or auth to signer (not to S3).

Because the SW intercepts same-origin `GET /livestore-filesync-files/...`, you get:
- **best UX** for `<img src="/livestore-filesync-files/...">` style usage
- automatic OPFS caching on first remote fetch (existing SW behavior)

---

## The signing service (Worker) design

### Responsibilities

- Authenticate caller (Bearer token or other mechanism).
- Authorize the requested object key (at minimum: ensure it is under a permitted prefix such as `"<storeId>/"`).
- Generate SigV4-presigned URLs against an S3-compatible endpoint for:
  - PUT (upload)
  - GET (download)
  - DELETE (delete) or server-side delete (preferred)
- Provide a `health` endpoint used by `RemoteStorage.checkHealth`.

### Worker configuration (per deployment)

Environment variables / secrets:
- `S3_ENDPOINT` (for AWS can be `https://s3.<region>.amazonaws.com`; for R2 S3 endpoint, MinIO, etc.)
- `S3_REGION` (some S3-compatible providers accept `"auto"`-like regions; we should treat this as required and document per provider)
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
- optional: `S3_FORCE_PATH_STYLE` (needed for some S3-compatible endpoints)
- optional: `ALLOWED_KEY_PREFIXES` or a function of caller identity

### Signer HTTP API (v1)

All endpoints require auth (unless explicitly configured otherwise).

- `GET /health`
  - checks signer is running and optionally does a cheap S3 call (like `HEAD` bucket or `HEAD` a known object)
  - returns `200` if healthy

- `POST /v1/sign/upload`
  - body: `{ key: string; contentType?: string; contentLength?: number }`
  - returns: `{ method: "PUT"; url: string; headers?: Record<string,string>; expiresAt: string }`

- `POST /v1/sign/download`
  - body: `{ key: string }`
  - returns: `{ url: string; expiresAt: string }`

- `POST /v1/delete`
  - body: `{ key: string }`
  - performs server-side delete via S3 API (recommended)
  - returns: `204`

Notes:
- Prefer server-side delete over presigned DELETE because it centralizes authz and avoids CORS complexity.
- Upload signing can optionally include checksum requirements later.

---

## Key operation flows (sequence diagrams)

### A) `saveFile(file)` + background upload (FileSync)

```text
App
  -> FileStorage.saveFile(File)
      - hash -> path = makeStoredPath(storeId, hash)
      - write OPFS
      - commit DB record (remoteKey = "")
      - markLocalFileChanged

FileSync (later / queued)
  - remoteKey = stripFilesRoot(file.path)
  -> Signer: POST /v1/sign/upload { key: remoteKey, contentType }
  <- { method: PUT, url, expiresAt }
  -> S3: PUT presignedUrl (body = File bytes)
  <- 200 + ETag
  -> LiveStore: update file record remoteKey = remoteKey (+ remoteEtag)
  -> local state: uploadStatus = done
```

### B) Download during reconciliation (FileSync)

```text
FileSync sees:
  - record exists in LiveStore
  - file missing locally
  - remoteKey != ""

FileSync
  -> Signer: POST /v1/sign/download { key: remoteKey }
  <- { url }
  -> S3: GET presignedUrl
  <- 200 + bytes
  -> OPFS: writeFile(file.path, downloadedFile)
  -> local state: downloadStatus = done
```

### C) UI URL resolution (`getFileUrl(fileId)`)

Two viable UX patterns (choose one; both are compatible with Option 3):

#### Pattern C1: Return presigned GET URL directly

```text
UI -> FileStorage.getFileUrl(fileId)
  - if local exists -> return objectURL/local path
  - else if remoteKey:
      -> Signer: /v1/sign/download
      <- presigned GET URL
      return presigned GET URL
```

Tradeoff: presigned URLs expire; UI may need to refresh them.

#### Pattern C2: Prefer Service Worker path URLs for web

Return the stable path URL (same-origin) and let SW do presigning/fetch/caching:
- UI uses `<img src={"/" + file.path}>` (or helper that formats it)
- SW handles remote miss

```text
Browser requests GET /livestore-filesync-files/<storeId>/<hash>
  -> ServiceWorker
    - OPFS miss
    - remoteKey = stripFilesRoot(storedPath)
    -> Signer: /v1/sign/download { key: remoteKey }
    <- { url }
    -> S3: GET presignedUrl
    <- 200
    - cache into OPFS
    - respond to browser
```

This is the best “stable URL” story without a bytes gateway.

### D) Delete (`deleteFile(fileId)`)

```text
App -> FileStorage.deleteFile(fileId)
  - mark deleted in LiveStore
  - delete local file best-effort
  - if remoteKey:
      -> Signer: POST /v1/delete { key: remoteKey }
      <- 204
```

If you want to avoid immediate remote delete (for eventual consistency / undos), you can:
- keep a tombstone and run GC later; still uses signer delete.

### E) Health check (offline -> online transitions)

```text
FileSync health loop
  -> Signer: GET /health
  <- 200
  (optional) Signer also checks S3 connectivity
  -> FileSync resumes executor + triggers sync
```

---

## Provider compatibility (S3-compatible as “one adapter”)

The “single adapter” story is:
- Core talks only to the signer (stable, same API everywhere).
- The signer is configured for any provider via `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, credentials.

Provider differences to account for (documented constraints):
- **Path-style vs virtual-host style** addressing.
- Region quirks (some S3-compatible providers do not validate region strictly; AWS does).
- Required headers for PUT (content-type, content-length, checksum headers if enforced).
- CORS on the bucket for browser direct PUT/GET.

---

## Security / authorization model (minimum viable)

### Key restriction

The signer must reject any key that is not under an allowed prefix.

If your file paths are `livestore-filesync-files/<storeId>/<hash>`, and `remoteKey = "<storeId>/<hash>"`, then:
- authorize that the caller is allowed to access `<storeId>/`

### Token model

Keep the same approach as today:
- core sends `Authorization: Bearer <token>` to signer
- signer verifies token and derives allowed storeIds/prefixes

---

## Implementation sequencing (recommended order)

1) Core refactor to key-based schema/types and key-based `RemoteStorage` service interface.
2) Implement `RemoteStorageS3Signed` in core that calls signer endpoints.
3) Implement a minimal signer Worker (new package) that:
   - validates auth
   - signs URLs for PUT/GET
   - deletes server-side
4) Wire SW `getRemoteUrl` to signer to enable stable `/livestore-filesync-files/...` URLs in web.
5) Add multipart support only if needed (big files / flaky networks).


