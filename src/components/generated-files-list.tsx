"use client";

import JSZip from "jszip";

interface GeneratedFile {
  _id: string;
  fileName: string;
  formType: string;
  url: string | null;
  packageSection?: string;
  artifactType?: string;
  validationStatus?: string;
}

interface SourceFile {
  _id: string;
  fileName: string;
  url: string | null;
}

const ROOT_FORM_TYPES = new Set(["packageSummary", "packageInventory", "submissionMemo", "confidenceReport"]);

function inferSection(file: GeneratedFile) {
  if (file.packageSection) return file.packageSection;
  const name = `${file.fileName} ${file.formType}`.toLowerCase();
  if (ROOT_FORM_TYPES.has(file.formType)) return "root";
  if (file.formType === "calculation" || name.includes("цен") || name.includes("калькуляц")) return "price_offer";
  if (name.includes("техническ") || name.includes("первая")) return "first_part";
  if (name.includes("выписк") || name.includes("лиценз") || name.includes("сертифик")) return "required_docs";
  return "second_part";
}

function packagePath(file: GeneratedFile) {
  const section = inferSection(file);
  if (section === "root") return file.fileName;
  return `${section}/${file.fileName}`;
}

export function GeneratedFilesList({
  files,
  sourceFiles = [],
}: {
  files: GeneratedFile[];
  sourceFiles?: SourceFile[];
}) {
  const downloadAll = async () => {
    const zip = new JSZip();
    for (const file of sourceFiles) {
      if (!file.url) continue;
      const response = await fetch(file.url);
      const blob = await response.blob();
      zip.file(`source_docs/${file.fileName}`, blob);
    }
    for (const file of files) {
      if (!file.url) continue;
      const response = await fetch(file.url);
      const blob = await response.blob();
      zip.file(packagePath(file), blob);
    }
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Пакет_заявки.zip";
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
            <span className="text-sm">
              {file.fileName}
              <span className="ml-2 text-xs text-gray-400">{packagePath(file)}</span>
            </span>
            {file.url && (
              <button
                onClick={async () => {
                  const res = await fetch(file.url!);
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = file.fileName;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                Скачать
              </button>
            )}
          </div>
        ))}
      </div>
      {files.length + sourceFiles.length > 1 && (
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
