/**
 * FileSystem service (subset of Effect Platform FileSystem)
 *
 * @module
 */

import { Context, Effect } from "effect"
import { FileSystemError } from "../../errors/index.js"

export type FileSystemEntryType = "file" | "directory"

export interface FileSystemStat {
  readonly type: FileSystemEntryType
}

export interface FileSystemMakeDirectoryOptions {
  readonly recursive?: boolean
}

export interface FileSystemRemoveOptions {
  readonly recursive?: boolean
}

export interface FileSystemService {
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, FileSystemError>
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, FileSystemError>
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>
  readonly makeDirectory: (
    path: string,
    options?: FileSystemMakeDirectoryOptions
  ) => Effect.Effect<void, FileSystemError>
  readonly remove: (path: string, options?: FileSystemRemoveOptions) => Effect.Effect<void, FileSystemError>
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>
  readonly stat: (path: string) => Effect.Effect<FileSystemStat, FileSystemError>
}

export class FileSystem extends Context.Tag("FileSystem")<
  FileSystem,
  FileSystemService
>() {}
