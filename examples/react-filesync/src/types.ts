import { tables } from './livestore/schema'
import { fileSyncSchema } from '@livestore-filesync/react'

export type LocalFile = typeof fileSyncSchema.schemas.localFileState.Type
export type LocalFilesState = typeof fileSyncSchema.schemas.localFilesState.Type
export type FileType = typeof tables.files.rowSchema.Type

export type TransferStatus = typeof fileSyncSchema.schemas.transferStatus.Type
