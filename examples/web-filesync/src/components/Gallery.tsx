import React, { useCallback, useRef } from 'react'
import { queryDb } from '@livestore/livestore'
import { useStore } from '@livestore/react'
import { useFileSync, useIsOnline } from '@livestore-filesync/react'
import { tables } from '../livestore/schema.ts'
import { ImageCard } from './ImageCard.tsx'

interface FileRecord {
  id: string
  path: string
  remoteUrl: string | null
  contentHash: string
  deletedAt: Date | null
}

const filesQuery = queryDb((tables.files as any).where({ deletedAt: null }), { label: 'files' })

export function Gallery() {
  const { store } = useStore()
  const { saveFile } = useFileSync()
  const isOnline = useIsOnline()
  const inputRef = useRef<HTMLInputElement>(null)

  const files = store.useQuery(filesQuery) as FileRecord[]

  const handleUploadClick = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const result = await saveFile(file)
      console.log('File saved:', result)
    } catch (error) {
      console.error('Failed to save file:', error)
    }

    // Reset input
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }, [saveFile])

  return (
    <div style={styles.container} data-testid="gallery">
      <div style={styles.toolbar}>
        <button
          type="button"
          onClick={handleUploadClick}
          style={styles.uploadButton}
          data-testid="upload-button"
        >
          + Upload Image
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          style={styles.hiddenInput}
          data-testid="file-input"
        />
        <div
          style={styles.status}
          data-testid="status-indicator"
          {...(isOnline ? { 'data-testid-online': 'online-status' } : { 'data-testid-offline': 'offline-status' })}
        >
          <span style={{
            ...styles.statusDot,
            backgroundColor: isOnline ? '#4caf50' : '#f44336'
          }} />
          {isOnline ? 'Online' : 'Offline'}
        </div>
      </div>

      {files.length === 0 ? (
        <div style={styles.empty} data-testid="empty-state">
          <p>No images yet. Upload one to get started!</p>
        </div>
      ) : (
        <div style={styles.grid}>
          {files.map((file) => (
            <ImageCard key={file.id} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%'
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '24px',
    padding: '16px',
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  uploadButton: {
    padding: '12px 24px',
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#fff',
    backgroundColor: '#2196f3',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.2s'
  },
  hiddenInput: {
    display: 'none'
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
    color: '#666'
  },
  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%'
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '80px 20px',
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    color: '#999'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
    gap: '20px'
  }
}
