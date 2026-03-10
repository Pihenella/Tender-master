"use client";

import JSZip from "jszip";

interface GeneratedFile {
  _id: string;
  fileName: string;
  formType: string;
  url: string | null;
}

export function GeneratedFilesList({ files }: { files: GeneratedFile[] }) {
  const downloadAll = async () => {
    const zip = new JSZip();
    for (const file of files) {
      if (!file.url) continue;
      const response = await fetch(file.url);
      const blob = await response.blob();
      zip.file(file.fileName, blob);
    }
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Заявка.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="space-y-2">
        {files.map((file) => (
          <div
            key={file._id}
            className="flex items-center justify-between bg-gray-50 rounded p-3"
          >
            <span className="text-sm">{file.fileName}</span>
            {file.url && (
              <a
                href={file.url}
                download={file.fileName}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                Скачать
              </a>
            )}
          </div>
        ))}
      </div>
      {files.length > 1 && (
        <button
          onClick={downloadAll}
          className="mt-4 w-full bg-green-600 text-white py-2 rounded-lg text-sm hover:bg-green-700"
        >
          Скачать всё (ZIP)
        </button>
      )}
    </div>
  );
}
