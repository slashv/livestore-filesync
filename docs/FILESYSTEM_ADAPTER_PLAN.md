# File System Adapter Plan

## Goals

- Allow FileSync to run in browser and Node by injecting a filesystem adapter.
- Align with `@effect/platform/FileSystem` naming while limiting to the subset we need.
- Keep `createFileSync` and `FileSyncProvider` ergonomics similar to LiveStore adapters.
- Preserve current OPFS behavior as the default for web.

## Constraints and Notes

- Effect Platform browser does not provide OPFS today, so we need a custom OPFS adapter.
- Current `LocalFileStorage` is OPFS-specific and exposes OPFS handles that are not used elsewhere.
- `File` handling and MIME types need a strategy in non-browser environments.

## Proposed Abstraction (Subset of Effect FileSystem)

Define a minimal interface that mirrors Effect Platform names and types.
This makes it easy to reuse `@effect/platform-node` later.

Suggested minimal surface:

- `readFile(path) -> Uint8Array`
- `writeFile(path, data, options?) -> void`
- `remove(path) -> void`
- `exists(path) -> boolean`
- `readDirectory(path, options?) -> ReadonlyArray<DirectoryEntry>`
- `makeDirectory(path, options?) -> void`
- `stat(path) -> { type: "file" | "directory" }` (only if `readDirectory` does not return entry types)

Errors:
- Align with `@effect/platform/FileSystemError` and keep existing storage errors only where needed
  (prefer to standardize on Effect Platform error shapes).

## Step 1: Add FileSystem Service in Core

New module: `packages/core/src/services/file-system/`

- `FileSystem.ts`: define the subset interface and `Context.Tag`.
- `index.ts`: export the service and helper types.
- Provide a small adapter utility to wrap a full Effect `FileSystem` into the subset.

Decision point:
- Migrate `LocalFileStorage` to depend on this `FileSystem` service (preferred),
  so `FileStorage` / `FileSync` stay stable and OPFS-only hooks are dropped.

## Step 2: OPFS Adapter (Browser)

New adapter package: `packages/adapter-web/`

- Exports `makeAdapter` or `FileSystemOpfsLive` that provides the new `FileSystem` service.
- Implements the subset using OPFS handles:
  - `readFile` / `writeFile` use `getFileHandle` + `createWritable`
  - `readDirectory` enumerates entries and returns names + type
  - `makeDirectory` creates nested dirs as needed
- Keep OPFS path resolution logic in a shared helper (service worker stays browser-only for now).

Open question:
- Where to store MIME type and lastModified in non-OPFS environments.
  If the adapter only has bytes, consider a sidecar metadata file.

## Step 3: Node Adapter

New adapter package: `packages/adapter-node/`

- Wrap `@effect/platform-node/FileSystem` into the subset.
- Exports `makeAdapter` or `FileSystemNodeLive`.
- If `File` is not available in Node, convert `Uint8Array` to a `File` in `LocalFileStorage`
  using a lightweight polyfill or a default MIME type.

## Step 4: Wire Adapter Into API

Core API changes:

- `createFileSync` accepts a new optional field:
  - `fileSystem?: Layer.Layer<FileSystem>` or `fileSystem?: FileSystemService`
- Default remains OPFS (web) to avoid breaking existing users.
- `FileSyncProvider` (Vue) exposes a prop to pass the adapter through.

Example usage (web):

```ts
import { makeAdapter } from "@livestore-filesync/adapter-web"

const fileSystem = makeAdapter({ type: "opfs" })

createFileSync({
  store,
  schema,
  remote,
  fileSystem
})
```

Example usage (node):

```ts
import { makeAdapter } from "@livestore-filesync/adapter-node"

const fileSystem = makeAdapter({ baseDirectory: "./data" })

createFileSync({
  store,
  schema,
  remote,
  fileSystem
})
```

## Step 5: Update Tests and Docs

- Replace OPFS-only tests with the memory adapter or node adapter where appropriate.
- Add adapter-specific tests:
  - OPFS (browser / Playwright)
  - Node (fs-backed integration)
- Document the new adapter API in `README.md` and example snippets.
- Service worker remains browser-only; do not wire it into the Node adapter.

## Open Questions

- How do we persist MIME type when adapters only support bytes?
- Should the service worker be refactored to use the new adapter in browser, or remain OPFS-only?
