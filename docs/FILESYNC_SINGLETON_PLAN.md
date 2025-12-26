# FileSync Singleton Pattern (Draft)

## Goal

Provide a minimal, framework-agnostic API that allows apps to do:

```ts
initFileSync(store)
```

and then import generic operations like `saveFile`, `readFile`, `deleteFile`, etc, without
framework-specific adapters or hooks.

## Context

- `createFileSync` already provides a framework-agnostic instance.
- Current API requires `schema: { tables, events, queryDb }` because FileSync reads and writes
  LiveStore tables/events directly.
- `queryDb` is exported by LiveStore, so `@livestore-filesync/core` can import it internally.

## Decision

We will implement Option B (infer schema from store) as the default.
Option A remains as a fallback if inference or validation proves brittle.

## Proposed Singleton API

```ts
// core (new)
initFileSync(store, config?)
startFileSync()
stopFileSync()
disposeFileSync()

saveFile(file)
updateFile(fileId, file)
deleteFile(fileId)
readFile(path)
getFileUrl(path)
isOnline()
triggerSync()
```

### Notes

- Single global instance (per JS runtime).
- `initFileSync` is idempotent and returns the existing instance.
- `disposeFileSync` clears the singleton.
- Defaults: `remote.baseUrl = "/api"`, OPFS file system in browser.
- Node requires explicit `fileSystem` adapter.

## Option B (Chosen): Infer Schema from Store (Default FileSync Schema)

```ts
initFileSync(store, {
  remote: { baseUrl: "/api", authHeaders },
  fileSystem
})
```

### How it works

- Core imports `createFileSyncSchema()` and `queryDb`, builds:
  `schema: { tables, events, queryDb }`.
- Runtime guard validates that the store contains the expected tables/events:
  - tables: `files`, `localFileState`
  - events: `v1.FileCreated`, `v1.FileUpdated`, `v1.FileDeleted`, `localFileStateSet`

### Pros

- The simplest call site: `initFileSync(store)`.
- No need to pass schema at all.

### Cons

- Requires default schema names and shapes.
- Needs a runtime check and a clear error if the store is missing the tables/events.

## Option A (Fallback): Pass Schema Explicitly

```ts
initFileSync(store, {
  schema: { tables, events },
  remote: { baseUrl: "/api", authHeaders },
  fileSystem
})
```

### How it works

- `initFileSync` calls `createFileSync({ store, schema: { tables, events, queryDb }, ... })`.
- `queryDb` is imported internally from LiveStore.
- `schema` is the same object apps already use when creating the store.

### Pros

- Minimal magic; matches current `createFileSync` requirements.
- Works with custom table/event names or alternative file sync schemas.
- No runtime inference needed.

### Cons

- Slightly more boilerplate in app init.

## Suggested Implementation (Singleton Wrapper)

1. Add a new singleton module in `packages/core`:
   - Keeps `let instance: FileSyncInstance | null`.
   - Exposes `initFileSync` + pass-through operations.
2. `initFileSync` uses Option B by default:
   - Build schema internally with `createFileSyncSchema()` and `queryDb`.
   - Validate that the store includes required tables/events.
   - Allow an escape hatch to Option A via `config.schema` if needed.
3. Enforce default config:
   - `remote.baseUrl = "/api"` if not provided.
   - Use `FileSystemOpfsLive()` in browser.
   - Throw a clear error when running in Node without `fileSystem`.
4. Keep `createFileSync` as the advanced API for multi-instance or custom schema use cases.

## Open Questions

- Do we want a dedicated runtime "schema validation" helper in core for the default schema?
- Should `initFileSync` be named `createFileSyncSingleton` to avoid confusion?
