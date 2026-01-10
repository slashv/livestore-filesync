import { deleteFile, getFileDisplayState, readFile, updateFile } from "@livestore-filesync/core"
import { useStore } from "@livestore/react"
import React from "react"
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

  const src = `/${file.path.replace(/^\/+/, "")}`

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
        {canDisplay ?
          (
            <img
              src={src}
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
              <td className="label">src</td>
              <td>{src}</td>
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
              <td className="label">File: Updated At</td>
              <td>{String(file.updatedAt)}</td>
            </tr>
            <tr>
              <td className="label">Local File: Hash</td>
              <td>{localFile?.localHash}</td>
            </tr>
            <tr>
              <td className="label">Local File: Download</td>
              <td data-testid="file-download-status">{localFile?.downloadStatus}</td>
            </tr>
            <tr>
              <td className="label">Local File: Upload</td>
              <td data-testid="file-upload-status">{localFile?.uploadStatus}</td>
            </tr>
            <tr>
              <td className="label">Can Display</td>
              <td data-testid="file-can-display">{String(canDisplay)}</td>
            </tr>
            {localFile?.lastSyncError ?
              (
                <tr>
                  <td className="label">Error</td>
                  <td>{localFile.lastSyncError}</td>
                </tr>
              ) :
              null}
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
