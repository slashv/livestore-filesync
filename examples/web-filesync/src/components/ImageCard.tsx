import React, { useCallback } from 'react'
import { useFileUrl, useFileStatus, useDeleteFile } from '@livestore-filesync/react'

interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

interface ImageCardProps {
  file: FileRecord
}

export function ImageCard({ file }: ImageCardProps) {
  const { url, isLoading } = useFileUrl(file.id)
  const status = useFileStatus(file.id)
  const { remove } = useDeleteFile()

  const handleDelete = useCallback(async () => {
    try {
      await remove(file.id)
    } catch (error) {
      console.error('Failed to delete:', error)
    }
  }, [file.id, remove])

  const getStatusText = () => {
    if (!status) return 'Unknown'
    if (status.uploadStatus === 'inProgress') return 'Uploading...'
    if (status.uploadStatus === 'queued') return 'Queued'
    if (status.uploadStatus === 'pending') return 'Pending'
    if (status.downloadStatus === 'inProgress') return 'Downloading...'
    if (status.downloadStatus === 'queued') return 'Queued'
    if (status.downloadStatus === 'pending') return 'Pending'
    if (status.lastSyncError) return 'Error'
    return 'Synced'
  }

  const getStatusColor = () => {
    const text = getStatusText()
    switch (text) {
      case 'Synced': return '#4caf50'
      case 'Uploading...':
      case 'Downloading...': return '#ff9800'
      case 'Queued':
      case 'Pending': return '#2196f3'
      case 'Error': return '#f44336'
      default: return '#999'
    }
  }

  return (
    <div style={styles.card} data-testid="file-card">
      <div style={styles.imageContainer}>
        {isLoading ? (
          <div style={styles.placeholder} data-testid="loading">Loading...</div>
        ) : url ? (
          <img src={url} alt={file.path} style={styles.image} data-testid="file-image" />
        ) : (
          <div style={styles.placeholder}>No preview</div>
        )}
      </div>
      <div style={styles.info}>
        <div style={styles.filename} data-testid="file-name">{file.path.split('/').pop()}</div>
        <div style={styles.statusRow}>
          <span
            style={{
              ...styles.statusBadge,
              backgroundColor: getStatusColor()
            }}
            data-testid="file-status"
          >
            {getStatusText()}
          </span>
          <button
            type="button"
            onClick={handleDelete}
            style={styles.deleteButton}
            data-testid="delete-button"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: '#fff',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    transition: 'transform 0.2s, box-shadow 0.2s'
  },
  imageContainer: {
    width: '100%',
    height: '200px',
    backgroundColor: '#f5f5f5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover'
  },
  placeholder: {
    color: '#999',
    fontSize: '14px'
  },
  info: {
    padding: '16px'
  },
  filename: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#333',
    marginBottom: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  statusBadge: {
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 'bold',
    color: '#fff'
  },
  deleteButton: {
    padding: '4px 12px',
    fontSize: '12px',
    color: '#f44336',
    backgroundColor: 'transparent',
    border: '1px solid #f44336',
    borderRadius: '4px',
    cursor: 'pointer'
  }
}
