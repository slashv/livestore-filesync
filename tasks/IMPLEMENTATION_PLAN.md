# LiveStore FileSync - Implementation Plan

## Overview

This document outlines the implementation plan for a framework-agnostic npm package that provides file syncing capabilities for LiveStore applications. The package will handle local file storage (OPFS), remote synchronization, and offline-first operation with automatic conflict resolution.

## Architecture Decisions

Based on requirements analysis:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Remote Storage | Pluggable adapters | Flexibility for different backends (S3, Cloudflare R2, Supabase, custom APIs) |
| Effect.ts Integration | Throughout | Full use of Effect for error handling, concurrency, resource management |
| Service Worker | Included | Provides seamless file URL handling with OPFS fallback |
| Framework Adapters | Core first | Framework-agnostic core, adapters added later |

## Package Structure

```
src/
├── services/
│   ├── file-storage/
│   │   ├── index.ts           # Public exports
│   │   ├── file-storage.ts    # High-level file operations service
│   │   └── file-storage.test.ts
│   ├── local-file-storage/
│   │   ├── index.ts
│   │   ├── local-file-storage.ts    # OPFS operations
│   │   ├── opfs-filesystem.ts       # Effect-style OPFS abstraction
│   │   └── local-file-storage.test.ts
│   ├── remote-file-storage/
│   │   ├── index.ts
│   │   ├── remote-file-storage.ts   # Remote operations orchestration
│   │   ├── adapter.ts               # RemoteStorageAdapter interface
│   │   ├── adapters/
│   │   │   ├── http-adapter.ts      # Generic HTTP adapter
│   │   │   └── cloudflare-adapter.ts # Cloudflare R2 example
│   │   └── remote-file-storage.test.ts
│   ├── file-sync/
│   │   ├── index.ts
│   │   ├── file-sync.ts             # Core sync orchestration
│   │   ├── sync-state.ts            # State management helpers
│   │   └── file-sync.test.ts
│   └── sync-executor/
│       ├── index.ts
│       ├── sync-executor.ts         # Concurrent queue with backoff
│       └── sync-executor.test.ts
├── schema/
│   ├── index.ts                     # Public schema exports
│   ├── files.ts                     # Files table definition
│   ├── local-file-state.ts          # Client-only sync state
│   └── events.ts                    # Event definitions
├── utils/
│   ├── hash.ts                      # File hashing (SHA-256)
│   ├── path.ts                      # Content-addressable path generation
│   └── file.ts                      # File utilities
├── worker/
│   ├── index.ts                     # Service worker exports
│   ├── file-sync-sw.ts              # Service worker implementation
│   └── registration.ts              # SW registration helpers
├── layers/
│   ├── index.ts                     # Effect layers exports
│   ├── live.ts                      # Production layer composition
│   └── test.ts                      # Test layer with mocks
├── errors/
│   └── index.ts                     # Typed error definitions
├── types/
│   └── index.ts                     # Public type exports
└── index.ts                         # Main package entry
```

## Core Components

### 1. Effect Service Definitions

Each service will be defined as an Effect Service with explicit dependencies:

```typescript
// Example: LocalFileStorage service definition
import { Context, Effect, Layer } from 'effect'

export class LocalFileStorage extends Context.Tag('LocalFileStorage')<
  LocalFileStorage,
  {
    readonly writeFile: (path: string, file: File) => Effect.Effect<void, StorageError>
    readonly readFile: (path: string) => Effect.Effect<File, FileNotFoundError | StorageError>
    readonly deleteFile: (path: string) => Effect.Effect<void, StorageError>
    readonly fileExists: (path: string) => Effect.Effect<boolean, StorageError>
    readonly getFileUrl: (path: string) => Effect.Effect<string, FileNotFoundError | StorageError>
    readonly listFiles: (folder: string) => Effect.Effect<string[], StorageError>
  }
>() {}
```

### 2. Remote Storage Adapter Interface

```typescript
// src/services/remote-file-storage/adapter.ts
import { Effect } from 'effect'

export interface RemoteStorageAdapter {
  readonly upload: (file: File, options?: { key?: string }) => Effect.Effect<string, UploadError>  // Returns URL
  readonly download: (url: string) => Effect.Effect<File, DownloadError>
  readonly delete: (url: string) => Effect.Effect<void, DeleteError>
  readonly checkHealth: () => Effect.Effect<boolean, never>
}

export class RemoteStorage extends Context.Tag('RemoteStorage')<
  RemoteStorage,
  RemoteStorageAdapter
>() {}
```

### 3. OPFS Filesystem Abstraction

Following Effect Platform's FileSystem patterns while supporting OPFS:

```typescript
// src/services/local-file-storage/opfs-filesystem.ts
import { Effect } from 'effect'

// Subset of Effect Platform FileSystem that we need
export interface OPFSFileSystem {
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, FileSystemError>
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, FileSystemError>
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>
  readonly makeDirectory: (path: string) => Effect.Effect<void, FileSystemError>
  readonly readDirectory: (path: string) => Effect.Effect<string[], FileSystemError>
}
```

### 4. LiveStore Schema Exports

The package exports schema components that apps extend:

```typescript
// src/schema/index.ts
export const files = {
  table: /* files table definition */,
  events: {
    created: /* fileCreated event */,
    updated: /* fileUpdated event */,
    deleted: /* fileDeleted event */,
  }
}

export const localFileState = {
  clientDocument: /* localFileState definition */,
  events: {
    set: /* localFileStateSet event */,
  }
}

// Helper to extend app schema
export const extendSchema = <T extends Schema>(appSchema: T) => /* merged schema */
```

### 5. Sync Executor (Effect-based)

```typescript
// src/services/sync-executor/sync-executor.ts
import { Effect, Queue, Ref, Schedule, Fiber } from 'effect'

export interface SyncExecutorConfig {
  maxConcurrentDownloads: number
  maxConcurrentUploads: number
  retrySchedule: Schedule.Schedule<unknown, unknown, unknown>
}

export class SyncExecutor extends Context.Tag('SyncExecutor')<
  SyncExecutor,
  {
    readonly enqueueDownload: (fileId: string) => Effect.Effect<void>
    readonly enqueueUpload: (fileId: string) => Effect.Effect<void>
    readonly pause: () => Effect.Effect<void>
    readonly resume: () => Effect.Effect<void>
    readonly awaitIdle: () => Effect.Effect<void>
  }
>() {}
```

## Implementation Phases

### Phase 1: Foundation

**Goal**: Core services with Effect patterns, basic OPFS operations

1. **Project Setup**
   - Initialize TypeScript project with Effect dependencies
   - Configure Vitest for testing
   - Set up build configuration (tsup/esbuild)

2. **Error Types**
   - Define typed errors using Effect's Data.TaggedError
   - StorageError, FileNotFoundError, UploadError, DownloadError, etc.

3. **Utility Functions**
   - `hashFile`: SHA-256 hashing using SubtleCrypto
   - `makeStoredPath`: Content-addressable path from hash
   - File type utilities

4. **LocalFileStorage Service**
   - OPFS filesystem abstraction
   - Implement all CRUD operations
   - Directory creation/navigation
   - Unit tests with mock filesystem

### Phase 2: Remote Storage & Sync

**Goal**: Remote storage adapters and sync orchestration

1. **Remote Storage Adapter**
   - Define adapter interface
   - Implement generic HTTP adapter
   - Cloudflare R2 adapter as example

2. **Sync Executor**
   - Effect-based concurrent queue
   - Exponential backoff using Effect Schedule
   - Pause/resume for offline mode
   - Transfer status tracking

3. **FileSync Service**
   - Store subscription and state management
   - Two-pass reconciliation (metadata check, then disk I/O)
   - Download/upload orchestration
   - Offline detection and recovery
   - Cleanup of deleted files

4. **FileStorage Service (High-level)**
   - `saveFile`, `updateFile`, `deleteFile`
   - Coordinates local storage and sync

### Phase 3: LiveStore Integration

**Goal**: Schema exports and store integration

1. **Schema Definitions**
   - Files table with all required columns
   - LocalFileState clientDocument
   - Event definitions with materializers
   - Schema extension helpers

2. **Store Integration Layer**
   - Abstract store interface for framework-agnostic usage
   - Query helpers
   - Subscription management

### Phase 4: Service Worker

**Goal**: Seamless file URL handling

1. **Service Worker Module**
   - File request interception (`/livestore-filesync-files/*`)
   - OPFS-first lookup with remote fallback
   - Proper caching headers

2. **Registration Helpers**
   - `registerFileSyncServiceWorker()`
   - Configuration options

### Phase 5: Layer Composition & Public API

**Goal**: Easy-to-use public API

1. **Effect Layers**
   - `LiveLayer`: Production configuration with all services
   - `TestLayer`: Mocked services for testing
   - Custom layer composition helpers

2. **Non-Effect Public API**
   - Wrap Effect services for non-Effect consumers
   - Promise-based alternatives
   - Simple initialization function

3. **Documentation**
   - API documentation
   - Usage examples
   - Integration guides

## Effect Patterns Used

### Error Handling

```typescript
import { Data, Effect } from 'effect'

export class FileNotFoundError extends Data.TaggedError('FileNotFoundError')<{
  path: string
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
  message: string
  cause?: unknown
}> {}
```

### Resource Management

```typescript
// Scoped resources for cleanup
const acquireOPFSRoot = Effect.tryPromise({
  try: () => navigator.storage.getDirectory(),
  catch: (e) => new StorageError({ message: 'Failed to get OPFS root', cause: e })
})
```

### Concurrency

```typescript
// Using Effect's built-in primitives
const downloadQueue = Queue.bounded<string>(100)
const processDownloads = pipe(
  Queue.take(downloadQueue),
  Effect.flatMap(downloadFile),
  Effect.retry(retrySchedule),
  Effect.forever,
  Effect.fork,
  Effect.replicateEffect(maxConcurrent)
)
```

### Scheduling

```typescript
const retrySchedule = pipe(
  Schedule.exponential('1 second'),
  Schedule.jittered,
  Schedule.upTo('1 minute')
)
```

### Progress Events (Dual API)

```typescript
// Effect Stream API
const progressStream: Stream.Stream<TransferProgress, never, FileSync> =
  fileSync.progressStream

// Callback API
fileSync.onProgress((event: TransferProgress) => {
  console.log(`${event.kind}: ${event.fileId} - ${event.loaded}/${event.total}`)
})

// TransferProgress type
interface TransferProgress {
  kind: 'upload' | 'download'
  fileId: string
  status: TransferStatus
  loaded: number
  total: number
}
```

## Testing Strategy

1. **Unit Tests** (per service)
   - Mock OPFS using in-memory Map
   - Mock remote storage adapter
   - Test Effect programs with Effect.runPromise in tests

2. **Integration Tests**
   - Test layer composition
   - Sync flow tests
   - Offline/online transitions

3. **Browser Tests** (Playwright)
   - Real OPFS operations
   - Service worker testing
   - Multi-tab sync

## Dependencies

```json
{
  "dependencies": {
    "effect": "^3.x",
    "@effect/platform": "^0.x"
  },
  "peerDependencies": {
    "@livestore/livestore": "^x.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^2.x",
    "tsup": "^8.x",
    "@vitest/browser": "^2.x",
    "playwright": "^1.x"
  }
}
```

## Public API Surface

### For Effect Users

```typescript
import { FileSyncLive, FileStorage, LocalFileStorage, RemoteStorage } from 'livestore-filesync'
import { Effect, Layer } from 'effect'

// Compose with custom remote adapter
const AppLayer = Layer.provide(FileSyncLive, MyRemoteAdapterLive)

// Use services
const program = Effect.gen(function* () {
  const fileStorage = yield* FileStorage
  const fileId = yield* fileStorage.saveFile(file)
  return fileId
})

Effect.runPromise(Effect.provide(program, AppLayer))
```

### For Non-Effect Users

```typescript
import { createFileSync } from 'livestore-filesync'

const fileSync = createFileSync({
  remoteAdapter: myHttpAdapter,
  store: myLiveStore,
})

// Promise-based API
const fileId = await fileSync.saveFile(file)
await fileSync.start() // Begins sync loop
```

### Schema Extension

```typescript
import { fileSyncSchema } from 'livestore-filesync/schema'
import { Schema } from '@livestore/livestore'

const appSchema = Schema.merge(
  fileSyncSchema,
  {
    tables: {
      images: /* your tables */,
    },
    events: /* your events */,
  }
)
```

## Resolved Decisions

| Question | Decision | Notes |
|----------|----------|-------|
| OPFS Fallback | Require OPFS | Chrome 86+, Firefox 111+, Safari 15.2+ - sufficient coverage |
| Progress Events | Both Stream & Callbacks | Effect Stream for Effect users, event callbacks for non-Effect |
| Large File Chunking | Not in v1 | Keep initial implementation simple, add later if needed |
| Conflict Resolution | Last-write-wins | Based on contentHash comparison (can extend later)

## Next Steps

After plan approval:

1. Initialize project structure and build configuration
2. Implement error types and utilities
3. Build LocalFileStorage service with tests
4. Continue through phases sequentially

Each phase will include comprehensive tests before moving to the next.
