/**
 * LiveStore integration types
 *
 * These types reflect the LiveStore store + schema shape expected by file sync.
 *
 * @module
 */

/**
 * Minimal LiveStore store interface used by file sync.
 */
export interface SyncStore {
  query: <T>(q: unknown) => T
  commit: (event: unknown) => void
  subscribe: (q: unknown, opts: { onUpdate: (result: unknown) => void }) => () => void
}

/**
 * Chainable query interface from LiveStore tables.
 */
interface ChainableQuery {
  where: (condition: Record<string, unknown>) => unknown
}

/**
 * LiveStore schema configuration for file sync.
 */
export interface SyncSchema {
  tables: {
    files: {
      where: (condition: Record<string, unknown>) => unknown
      select: () => ChainableQuery
    }
    localFileState: {
      get: () => unknown
    }
  }
  events: {
    fileCreated: (data: {
      id: string
      path: string
      contentHash: string
      createdAt: Date
      updatedAt: Date
    }) => unknown
    fileUpdated: (data: {
      id: string
      path: string
      remoteUrl: string
      contentHash: string
      updatedAt: Date
    }) => unknown
    fileDeleted: (data: { id: string; deletedAt: Date }) => unknown
    localFileStateSet: (data: { localFiles: Record<string, unknown> }) => unknown
  }
  /** Query builder - typically `queryDb` from LiveStore */
  queryDb: <T>(query: unknown) => T
}

/**
 * LiveStore store + schema dependencies.
 */
export interface LiveStoreDeps {
  store: SyncStore
  schema: SyncSchema
}
