import { deleteFile, getFileDisplayState, readFile, resolveFileUrl, updateFile } from "@livestore-filesync/core"
import { resolveThumbnailUrl } from "@livestore-filesync/image/thumbnails"
import { useStore } from "@livestore/react"
import React, { useEffect, useMemo, useState } from "react"
import { reactStoreOptions } from "../App.tsx"
import { tables } from "../livestore/schema.ts"
import type { FileType } from "../types"

export const ImageCard: React.FC<{ file: FileType }> = ({ file }) => {
  const store = useStore(reactStoreOptions)

  const [localFileState] = store.useClientDocument(tables.localFileState)
  const displayState = getFileDisplayState(
    file,
    localFileState?.localFiles ?? {}
  )
  const { canDisplay, isUploading, localState: localFile } = displayState

  // Thumbnail state from LiveStore client document
  const [thumbnailStateDoc] = store.useClientDocument(tables.thumbnailState)
  const thumbnailState = thumbnailStateDoc?.files?.[file.id]
  const smallThumbnailStatus = useMemo(
    () => thumbnailState?.sizes?.["small"]?.status ?? "pending",
    [thumbnailState]
  )

  const [fullSrc, setFullSrc] = useState<string | null>(null)
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null)

  // Resolve full image URL on mount and when file updates
  useEffect(() => {
    resolveFileUrl(file.id).then((url) => {
      if (url) setFullSrc(url)
    })
  }, [file.id, file.updatedAt])

  // Resolve thumbnail URL when thumbnail state changes to 'done'
  useEffect(() => {
    if (smallThumbnailStatus === "done") {
      resolveThumbnailUrl(file.id, "small").then((url) => {
        if (url) setThumbnailSrc(url)
      })
    }
  }, [file.id, smallThumbnailStatus])

  // Use thumbnail if available, fallback to full image
  const displaySrc = thumbnailSrc || fullSrc

  const handleDelete = async () => {
    try {
      await deleteFile(file.id)
    } catch (error) {
      console.error("Failed to delete:", error)
    }
  }

  const handleEdit = async () => {
    try {
      const srcFile = await readFile(file.path)
      const edited = await invertImageFile(srcFile)
      await updateFile(file.id, edited)
    } catch (error) {
      console.error("Failed to edit:", error)
    }
  }

  return (
    <div className="card" data-testid="file-card">
      <div className="image-container">
        {canDisplay && displaySrc ?
          (
            <img
              src={displaySrc}
              alt={file.path}
              className="image"
              data-testid="file-image"
            />
          ) :
          (
            <div className="image-placeholder" data-testid="file-placeholder">
              {isUploading ? "Uploading..." : "Waiting for file..."}
            </div>
          )}
        {/* Thumbnail badge */}
        {thumbnailSrc && (
          <div className="thumbnail-badge" data-testid="thumbnail-badge">
            Thumbnail
          </div>
        )}
      </div>
      <div className="info">
        <div className="header">
          <span data-testid="file-name">
            <strong>File ID:</strong> {file.id}
          </span>
          <div className="actions">
            <button
              type="button"
              onClick={handleEdit}
              data-testid="edit-button"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              data-testid="delete-button"
            >
              Delete
            </button>
          </div>
        </div>
        <table className="debug-table">
          <tbody>
            <tr>
              <td className="label">Display src</td>
              <td>{displaySrc ? "Set" : "Not set"}</td>
            </tr>
            <tr>
              <td className="label">Thumbnail URL</td>
              <td data-testid="thumbnail-url">{thumbnailSrc ? "Generated" : "Not generated"}</td>
            </tr>
            <tr>
              <td className="label">Thumbnail Status</td>
              <td data-testid="thumbnail-status">{smallThumbnailStatus}</td>
            </tr>
            <tr>
              <td className="label">File: Path</td>
              <td>{file.path}</td>
            </tr>
            <tr>
              <td className="label">File: Remote Key</td>
              <td data-testid="file-remote-key">{file.remoteKey}</td>
            </tr>
            <tr>
              <td className="label">File: Hash</td>
              <td>{file.contentHash}</td>
            </tr>
            <tr>
              <td className="label">Local File: Upload</td>
              <td data-testid="file-upload-status">{localFile?.uploadStatus}</td>
            </tr>
            <tr>
              <td className="label">Can Display</td>
              <td data-testid="file-can-display">{String(canDisplay)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

async function invertImageFile(file: File): Promise<File> {
  const imageBitmap = await createImageBitmap(file)
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height)
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("Canvas context not available")
  }
  ctx.drawImage(imageBitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = imageData
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]
    data[i + 1] = 255 - data[i + 1]
    data[i + 2] = 255 - data[i + 2]
  }
  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: file.type || "image/png" })
  return new File([blob], file.name, { type: blob.type })
}
