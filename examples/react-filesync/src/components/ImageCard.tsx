import React from 'react'
import { useStore } from '@livestore/react'
import { useFileSync } from '@livestore-filesync/react'
import { tables } from '../livestore/schema.ts'

interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

export const ImageCard: React.FC<{ file: FileRecord }> = ({ file }) => {
  const { store } = useStore()
  const fileSync = useFileSync()
  const [url, setUrl] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const [localFileState] = store.useClientDocument(tables.localFileState)
  const localFile = localFileState?.localFiles?.[file.id]
  const downloadStatus = localFile?.downloadStatus

  const loadUrl = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const nextUrl = await fileSync.getFileUrl(file.path)
      setUrl(nextUrl)
    } catch (error) {
      console.error('Failed to load file URL:', error)
      setUrl(null)
    } finally {
      setIsLoading(false)
    }
  }, [file.path, fileSync])

  React.useEffect(() => {
    void loadUrl()
  }, [loadUrl])

  const previousStatusRef = React.useRef(downloadStatus)
  React.useEffect(() => {
    if (downloadStatus === 'done' && downloadStatus !== previousStatusRef.current) {
      void loadUrl()
    }
    previousStatusRef.current = downloadStatus
  }, [downloadStatus, loadUrl])

  const handleDelete = async () => {
    try {
      await fileSync.deleteFile(file.id)
    } catch (error) {
      console.error('Failed to delete:', error)
    }
  }

  const filename = file.path.split('/').pop()

  return (
    <div className="card" data-testid="file-card">
      <div className="image-container">
        {isLoading ? (
          <div className="placeholder" data-testid="loading">Loading...</div>
        ) : url ? (
          <img src={url} alt={file.path} className="image" data-testid="file-image" />
        ) : (
          <div className="placeholder">No preview</div>
        )}
      </div>
      <div className="info">
        <div className="filename" data-testid="file-name">{filename}</div>
        <div className="actions">
          <span className="status" data-testid="file-status">
            {file.remoteUrl ? 'Synced' : 'Local'}
          </span>
          <button type="button" onClick={handleDelete} data-testid="delete-button">
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
