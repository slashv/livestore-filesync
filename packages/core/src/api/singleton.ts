/**
 * Singleton FileSync helpers
 *
 * Provides a simple, framework-agnostic API for one global FileSync instance.
 *
 * @module
 */

import type { Layer } from "effect"
import { queryDb } from "@livestore/livestore"
import { createFileSyncSchema } from "../schema/index.js"
import { createFileSync, type CreateFileSyncConfig, type FileSyncInstance } from "./createFileSync.js"
import type { SyncSchema, SyncStore } from "../livestore/types.js"
import type { FileSystem } from "../services/index.js"

const DEFAULT_SIGNER_BASE_URL = "/api"
const REQUIRED_TABLES = ["files", "localFileState"] as const
const REQUIRED_EVENTS = [
  "v1.FileCreated",
  "v1.FileUpdated",
  "v1.FileDeleted",
  "localFileStateSet"
] as const

type SchemaFallback = Pick<SyncSchema, "tables" | "events"> & {
  queryDb?: SyncSchema["queryDb"]
}

export interface InitFileSyncConfig {
  remote?: {
    signerBaseUrl?: string
    headers?: Record<string, string>
    authToken?: string
  }
  fileSystem?: Layer.Layer<FileSystem>
  options?: CreateFileSyncConfig["options"]
  schema?: SchemaFallback
}

let singleton: FileSyncInstance | null = null

const requireFileSync = (): FileSyncInstance => {
  if (!singleton) {
    throw new Error("FileSync not initialized. Call initFileSync(store) first.")
  }
  return singleton
}

const validateDefaultSchema = (store: SyncStore) => {
  const schema: any = store.schema
  const tables = schema?.state?.sqlite?.tables
  const events = schema?.eventsDefsMap

  if (!(tables instanceof Map) || !(events instanceof Map)) {
    throw new Error("FileSync store schema is not available for validation.")
  }

  const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name))
  const missingEvents = REQUIRED_EVENTS.filter((name) => !events.has(name))

  if (missingTables.length || missingEvents.length) {
    const details = [
      missingTables.length ? `tables: ${missingTables.join(", ")}` : null,
      missingEvents.length ? `events: ${missingEvents.join(", ")}` : null
    ]
      .filter(Boolean)
      .join("; ")
    throw new Error(
      `FileSync schema missing from store (${details}). ` +
      "Ensure createFileSyncSchema is merged into your LiveStore schema or pass schema to initFileSync."
    )
  }
}

const resolveSchema = (store: SyncStore, schema?: SchemaFallback): SyncSchema => {
  if (schema) {
    return {
      tables: schema.tables,
      events: schema.events,
      queryDb: schema.queryDb ?? queryDb
    }
  }

  validateDefaultSchema(store)
  const defaults = createFileSyncSchema()
  return {
    tables: defaults.tables,
    events: defaults.events,
    queryDb
  }
}

export const initFileSync = (store: SyncStore, config: InitFileSyncConfig = {}) => {
  if (singleton) return singleton

  if (!config.fileSystem && typeof window === "undefined" && typeof navigator === "undefined") {
    throw new Error("FileSync requires a fileSystem adapter outside the browser.")
  }

  const schema = resolveSchema(store, config.schema)
  const remote: CreateFileSyncConfig["remote"] = {
    signerBaseUrl: config.remote?.signerBaseUrl ?? DEFAULT_SIGNER_BASE_URL,
    ...(config.remote?.headers ? { headers: config.remote.headers } : {}),
    ...(config.remote?.authToken ? { authToken: config.remote.authToken } : {})
  }

  singleton = createFileSync({
    store,
    schema,
    remote,
    ...(config.fileSystem ? { fileSystem: config.fileSystem } : {}),
    ...(config.options ? { options: config.options } : {})
  })

  return singleton
}

export const startFileSync = () => {
  requireFileSync().start()
}

export const stopFileSync = () => {
  requireFileSync().stop()
}

export const disposeFileSync = async () => {
  const instance = requireFileSync()
  await instance.dispose()
  singleton = null
}

export const saveFile = (file: File) => requireFileSync().saveFile(file)
export const updateFile = (fileId: string, file: File) => requireFileSync().updateFile(fileId, file)
export const deleteFile = (fileId: string) => requireFileSync().deleteFile(fileId)
export const readFile = (path: string) => requireFileSync().readFile(path)
export const getFileUrl = (path: string) => requireFileSync().getFileUrl(path)
export const resolveFileUrl = (fileId: string) => requireFileSync().resolveFileUrl(fileId)
export const isOnline = () => requireFileSync().isOnline()
export const triggerSync = () => requireFileSync().triggerSync()

