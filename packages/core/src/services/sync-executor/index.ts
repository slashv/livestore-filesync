/**
 * SyncExecutor service exports
 *
 * @module
 */

export {
  defaultConfig,
  makeSyncExecutor,
  makeSyncExecutorLayer,
  SyncExecutor,
  type SyncExecutorConfig,
  type SyncExecutorService,
  type TaskCompleteCallback,
  type TransferHandler,
  type TransferKind,
  type TransferResult,
  type TransferTask
} from "./SyncExecutor.js"

// Note: TransferStatus is exported from schema/index.ts (single source of truth)
