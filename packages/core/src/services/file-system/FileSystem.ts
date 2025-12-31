/**
 * FileSystem service re-export from @effect/platform
 *
 * This module re-exports the FileSystem service from @effect/platform,
 * allowing users to pass any compatible FileSystem implementation
 * (e.g., @livestore-filesync/opfs for browsers, @effect/platform-node for Node).
 *
 * @module
 */

export { FileSystem } from "@effect/platform/FileSystem"
export type { FileSystem as FileSystemService } from "@effect/platform/FileSystem"
