import { getFileDisplayState, resolveFileUrl, rowsToLocalFilesState } from "@livestore-filesync/core"
import { resolveThumbnailUrl, rowsToThumbnailFilesState } from "@livestore-filesync/image/thumbnails"
import { queryDb } from "@livestore/livestore"
import { useStore } from "@livestore/react"
import React, { useEffect, useMemo, useState } from "react"
import { reactStoreOptions } from "../App.tsx"
import { tables } from "../livestore/schema.ts"

type FillMode = "contain" | "cover" | "fill" | "none" | "scale-down"

interface FileSyncImageProps {
  fileId: string
  size?: string
  fillMode?: FillMode
  className?: string
  alt?: string
  showThumbnailBadge?: boolean
}

export const FileSyncImage: React.FC<FileSyncImageProps> = ({
  alt,
  className,
  fileId,
  fillMode = "cover",
  showThumbnailBadge = false,
  size
}) => {
  const store = useStore(reactStoreOptions)

  const localFileStateRows = store.useQuery(queryDb(tables.localFileState.select()))
  const localFilesState = useMemo(() => rowsToLocalFilesState(localFileStateRows), [localFileStateRows])
  const thumbnailStateRows = store.useQuery(queryDb(tables.thumbnailState.select()))
  const thumbnailFiles = useMemo(() => rowsToThumbnailFilesState(thumbnailStateRows), [thumbnailStateRows])
  const file = store.useQuery(tables.files.select().where({ id: fileId }).first())

  if (!file) {
    return null
  }

  const displayState = getFileDisplayState(file, localFilesState)
  const { canDisplay, isUploading } = displayState

  const selectedSize = size ?? "full"
  const thumbnailStatus = selectedSize === "full"
    ? null
    : thumbnailFiles[fileId]?.sizes?.[selectedSize]?.status ?? "pending"

  const [src, setSrc] = useState<string | null>(null)
  const [isUsingThumbnail, setIsUsingThumbnail] = useState(false)

  // Resolve URL when size or file changes
  useEffect(() => {
    let cancelled = false

    const resolveUrl = async () => {
      // If requesting full size, use file URL directly
      if (selectedSize === "full") {
        const url = await resolveFileUrl(fileId)
        if (!cancelled && url) {
          setSrc(url)
          setIsUsingThumbnail(false)
        }
        return
      }

      // Try thumbnail first if it's ready
      if (thumbnailStatus === "done") {
        const thumbnailUrl = await resolveThumbnailUrl(fileId, selectedSize)
        if (!cancelled && thumbnailUrl) {
          setSrc(thumbnailUrl)
          setIsUsingThumbnail(true)
          return
        }
      }

      // Fallback to full image
      const url = await resolveFileUrl(fileId)
      if (!cancelled && url) {
        setSrc(url)
        setIsUsingThumbnail(false)
      }
    }

    resolveUrl()

    return () => {
      cancelled = true
    }
  }, [fileId, selectedSize, thumbnailStatus, file?.updatedAt])

  // Show placeholder if not displayable or no src
  if (!canDisplay || !src) {
    return (
      <div
        className={`image-placeholder ${className ?? ""}`}
        data-testid="file-placeholder"
      >
        {isUploading ? "Uploading..." : "Waiting for file..."}
      </div>
    )
  }

  return (
    <div className="filesync-image-container" style={{ position: "relative", width: "100%", height: "100%" }}>
      <img
        src={src}
        alt={alt}
        className={className}
        style={{ objectFit: fillMode, width: "100%", height: "100%" }}
        data-testid="file-image"
        data-image-size={selectedSize}
      />
      {showThumbnailBadge && isUsingThumbnail && (
        <div className="thumbnail-badge" data-testid="thumbnail-badge">
          Thumbnail
        </div>
      )}
    </div>
  )
}
