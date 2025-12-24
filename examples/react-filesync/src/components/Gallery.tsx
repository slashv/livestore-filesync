import React from "react";
import { queryDb } from "@livestore/livestore";
import { useStore } from "@livestore/react";
import { useFileSync } from "@livestore-filesync/react";
import { tables } from "../livestore/schema.ts";
import { ImageCard } from "./ImageCard.tsx";

export const Gallery: React.FC = () => {
  const { store } = useStore();
  const fileSync = useFileSync();
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
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const result = await fileSync.saveFile(file);
      console.log("File saved:", result);
    } catch (error) {
      console.error("Failed to save file:", error);
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
          onChange={handleFileChange}
          className="hidden"
          data-testid="file-input"
        />
        <div className="status" data-testid="status-indicator">
          <span
            className={`status-dot${fileSync.isOnline() ? " online" : ""}`}
          />
          {fileSync.isOnline() ? "Online" : "Offline"}
        </div>
      </div>

      {!files || files.length === 0 ? (
        <div className="empty" data-testid="empty-state">
          <p>No images yet. Upload one to get started!</p>
        </div>
      ) : (
        <div className="grid">
          {files.map((file) => (
            <ImageCard key={file.id} file={file} />
          ))}
        </div>
      )}
    </div>
  );
};
