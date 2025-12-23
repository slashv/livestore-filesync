/**
 * Node adapter exports
 *
 * @module
 */

import path from "node:path"
import { Effect, Layer } from "effect"
import * as PlatformFileSystem from "@effect/platform/FileSystem"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import {
  FileSystem,
  FileSystemError,
  type FileSystemService,
  type FileSystemStat
} from "@livestore-filesync/core"

export interface NodeFileSystemOptions {
  readonly baseDirectory?: string
}

const mapError = (operation: string, targetPath: string, cause: unknown) =>
  new FileSystemError({
    message: `File system operation failed: ${operation}`,
    operation,
    path: targetPath,
    cause
  })

const resolvePath = (baseDirectory: string | undefined, targetPath: string): string =>
  baseDirectory ? path.join(baseDirectory, targetPath) : targetPath

const toStat = (info: PlatformFileSystem.File.Info): FileSystemStat => ({
  type: info.type === "Directory" ? "directory" : "file"
})

const makeNodeFileSystem = (options: NodeFileSystemOptions = {}) =>
  Effect.gen(function*() {
    const fs = yield* PlatformFileSystem.FileSystem
    const baseDirectory = options.baseDirectory

    const readFile: FileSystemService["readFile"] = (targetPath) =>
      fs.readFile(resolvePath(baseDirectory, targetPath)).pipe(
        Effect.mapError((cause) => mapError("readFile", targetPath, cause))
      )

    const writeFile: FileSystemService["writeFile"] = (targetPath, data) =>
      fs.writeFile(resolvePath(baseDirectory, targetPath), data).pipe(
        Effect.mapError((cause) => mapError("writeFile", targetPath, cause))
      )

    const readDirectory: FileSystemService["readDirectory"] = (targetPath) =>
      fs.readDirectory(resolvePath(baseDirectory, targetPath)).pipe(
        Effect.mapError((cause) => mapError("readDirectory", targetPath, cause))
      )

    const makeDirectory: FileSystemService["makeDirectory"] = (targetPath, opts) =>
      fs.makeDirectory(resolvePath(baseDirectory, targetPath), opts).pipe(
        Effect.mapError((cause) => mapError("makeDirectory", targetPath, cause))
      )

    const remove: FileSystemService["remove"] = (targetPath, opts) =>
      fs.remove(resolvePath(baseDirectory, targetPath), opts).pipe(
        Effect.mapError((cause) => mapError("remove", targetPath, cause))
      )

    const exists: FileSystemService["exists"] = (targetPath) =>
      fs.exists(resolvePath(baseDirectory, targetPath)).pipe(
        Effect.mapError((cause) => mapError("exists", targetPath, cause))
      )

    const stat: FileSystemService["stat"] = (targetPath) =>
      fs.stat(resolvePath(baseDirectory, targetPath)).pipe(
        Effect.map(toStat),
        Effect.mapError((cause) => mapError("stat", targetPath, cause))
      )

    return {
      readFile,
      writeFile,
      readDirectory,
      makeDirectory,
      remove,
      exists,
      stat
    }
  })

export const FileSystemNodeLive = (options: NodeFileSystemOptions = {}) =>
  Layer.provide(NodeFileSystem.layer)(Layer.effect(FileSystem, makeNodeFileSystem(options)))

export const makeAdapter = (options: NodeFileSystemOptions = {}) => FileSystemNodeLive(options)
