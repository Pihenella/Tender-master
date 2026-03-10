"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface FileDropzoneProps {
  procurementId: Id<"procurements">;
  label: string;
  accept?: string;
  onUploadComplete?: (storageId: Id<"_storage">) => void;
}

export function FileDropzone({
  procurementId,
  label,
  accept,
  onUploadComplete,
}: FileDropzoneProps) {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const uploadFiles = useCallback(
    async (fileList: FileList) => {
      setUploading(true);
      let lastStorageId: Id<"_storage"> | null = null;
      try {
        for (const file of Array.from(fileList)) {
          const uploadUrl = await generateUploadUrl();
          const result = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": file.type },
            body: file,
          });
          const { storageId } = await result.json();
          lastStorageId = storageId;
          await saveFile({
            procurementId,
            storageId,
            fileName: file.name,
            fileType: file.type,
          });
        }
        if (lastStorageId && onUploadComplete) {
          onUploadComplete(lastStorageId);
        }
      } finally {
        setUploading(false);
      }
    },
    [procurementId, generateUploadUrl, saveFile, onUploadComplete]
  );

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
      }}
    >
      <p className="text-sm text-muted-foreground mb-2">{label}</p>
      <label className="cursor-pointer text-blue-600 hover:text-blue-700 text-sm">
        {uploading ? "Загрузка..." : "Выберите файлы"}
        <input
          type="file"
          multiple
          accept={accept}
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              uploadFiles(e.target.files);
            }
          }}
        />
      </label>
    </div>
  );
}
