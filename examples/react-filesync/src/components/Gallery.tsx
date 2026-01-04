import React from "react";
import { queryDb } from "@livestore/livestore";
import { useStore } from "@livestore/react";
import { isOnline, saveFile } from "@livestore-filesync/core";
import { tables } from "../livestore/schema.ts";
import { ImageCard } from "./ImageCard.tsx";
import { reactStoreOptions } from "../App.tsx";
export const Gallery: React.FC = () => {
  const store = useStore(reactStoreOptions);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const files = store.useQuery(
    queryDb(tables.files.where({ deletedAt: null }))
  );

  const handleUploadClick = () => {
    inputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    try {
      const savePromises = Array.from(selectedFiles).map((file) => saveFile(file));
      const results = await Promise.all(savePromises);
      console.log("Files saved:", results);
    } catch (error) {
      console.error("Failed to save files:", error);
    }

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  return (
    <div className="container" data-testid="gallery">
      <div className="toolbar">
        <button
          type="button"
          onClick={handleUploadClick}
          data-testid="upload-button"
        >
          + Upload Image
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
          data-testid="file-input"
        />
        <div className="status" data-testid="status-indicator">
          <span
            className={`status-dot${isOnline() ? " online" : ""}`}
          />
          {isOnline() ? "Online" : "Offline"}
        </div>
      </div>

      {!files || files.length === 0 ? (
        <div className="empty" data-testid="empty-state">
          <p>No images yet. Upload one to get started!</p>
        </div>
      ) : (
        <div className="layout">
          {files.map((file) => (
            <ImageCard key={file.id} file={file} />
          ))}
        </div>
      )}
    </div>
  );
};
