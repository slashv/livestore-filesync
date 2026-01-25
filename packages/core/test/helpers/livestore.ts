import { makeAdapter } from "@livestore/adapter-node"
import { createStorePromise, makeSchema, queryDb, State } from "@livestore/livestore"
import type { LiveStoreDeps } from "../../src/livestore/types.js"
import { createFileSyncSchema } from "../../src/schema/index.js"
import { sanitizeStoreId } from "../../src/utils/index.js"

interface TestStoreOptions {
  storeId?: string
  localPathRoot?: string
}

export const createTestStore = async (options: TestStoreOptions = {}) => {
  const adapter = makeAdapter({ storage: { type: "in-memory" } })
  const fileSyncSchema = createFileSyncSchema()
  const { createMaterializers, events, tables } = fileSyncSchema
  const materializers = State.SQLite.materializers(events, createMaterializers(tables))
  const state = State.SQLite.makeState({ tables, materializers })
  const schema = makeSchema({ events, state })
  const storeId = options.storeId ?? `test-store-${Date.now()}`
  const store = await createStorePromise({ adapter, schema, storeId })

  const deps: LiveStoreDeps = {
    store: store as LiveStoreDeps["store"],
    schema: { tables, events, queryDb },
    storeId: sanitizeStoreId(store.storeId)
  }
  if (options.localPathRoot !== undefined) {
    deps.localPathRoot = options.localPathRoot
  }

  return {
    store,
    deps,
    schema,
    tables,
    events,
    async shutdown() {
      await store.shutdownPromise()
    }
  }
}

/**
 * Generate a test file with configurable content
 */
export interface GenerateTestFileOptions {
  /** File name (default: test-{timestamp}.txt) */
  name?: string
  /** Size in bytes (default: 100) */
  sizeBytes?: number
  /** Explicit content (overrides sizeBytes) */
  content?: string
  /** MIME type (default: text/plain) */
  type?: string
}

export function generateTestFile(options: GenerateTestFileOptions = {}): File {
  const name = options.name ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  const type = options.type ?? "text/plain"

  let content: string
  if (options.content !== undefined) {
    content = options.content
  } else {
    const size = options.sizeBytes ?? 100
    content = "x".repeat(size)
  }

  return new File([content], name, { type })
}

/**
 * Helper to create multiple unique test files
 */
export function generateTestFiles(
  count: number,
  options: Omit<GenerateTestFileOptions, "name" | "content"> = {}
): Array<File> {
  return Array.from({ length: count }, (_, i) =>
    generateTestFile({
      ...options,
      name: `test-file-${i}-${Date.now()}.txt`,
      content: `content-for-file-${i}-${Math.random().toString(36).slice(2)}`
    }))
}

/**
 * Simple delay helper for tests
 */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface WaitForOptions {
  timeoutMs?: number
  intervalMs?: number
  message?: string
}

export async function waitFor<T, S extends T>(
  check: () => Promise<T> | T,
  predicate: (value: T) => value is S,
  options?: WaitForOptions
): Promise<S>
export async function waitFor<T>(
  check: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  options?: WaitForOptions
): Promise<T>
export async function waitFor<T>(
  check: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  options: WaitForOptions = {}
): Promise<T> {
  const { timeoutMs = 2000, intervalMs = 25, message = "Timed out waiting for condition" } = options
  const start = Date.now()

  while (true) {
    const value = await check()
    if (predicate(value)) return value
    if (Date.now() - start > timeoutMs) {
      throw new Error(message)
    }
    await delay(intervalMs)
  }
}
