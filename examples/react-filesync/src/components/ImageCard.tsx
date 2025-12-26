import { useStore } from '@livestore/react'
import { useFileSync } from '@livestore-filesync/react'
import { tables } from '../livestore/schema.ts'
import type { FileType } from '../types'

export const ImageCard: React.FC<{ file: FileType }> = ({ file }) => {
  const { store } = useStore()
  const fileSync = useFileSync()

  const [localFileState] = store.useClientDocument(tables.localFileState)
  const localFile = localFileState?.localFiles?.[file.id]

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
        <img src={file.path} alt={file.path} className="image" data-testid="file-image" />
      </div>
      <div className="info">
        <div className="filename" data-testid="file-name">{filename}</div>
        <div className="actions">
          <span className="status" data-testid="file-status">
            {localFile?.downloadStatus ?? 'Pending'}
          </span>
          <button type="button" onClick={handleDelete} data-testid="delete-button">
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
