import type { fileSyncSchema, tables, thumbnailSchema } from "./livestore/schema"

export type LocalFile = typeof fileSyncSchema.schemas.LocalFileStateSchema.Type
export type LocalFilesState = typeof fileSyncSchema.schemas.LocalFilesStateSchema.Type
export type FileType = typeof tables.files.rowSchema.Type

export type TransferStatus = typeof fileSyncSchema.schemas.TransferStatusSchema.Type
export type ThumbnailState = typeof thumbnailSchema.schemas.ThumbnailStateDocumentSchema.Type
