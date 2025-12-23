/**
 * Web adapter exports
 *
 * @module
 */

import { FileSystemOpfsLive, type OpfsFileSystemOptions } from "@livestore-filesync/core"

export const makeAdapter = (options: OpfsFileSystemOptions = {}) => FileSystemOpfsLive(options)

export { FileSystemOpfsLive }
export type { OpfsFileSystemOptions }
