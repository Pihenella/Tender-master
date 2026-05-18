"use client";

import { useMemo, useState } from "react";
import JSZip from "jszip";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderUp,
  Loader2,
} from "lucide-react";

type PackageSection =
  | "root"
  | "source_docs"
  | "first_part"
  | "second_part"
  | "price_offer"
  | "required_docs";

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

interface PackageFile {
  id: string;
  fileName: string;
  url: string | null;
  section: PackageSection;
  kind: "source" | "generated";
  artifactType?: string;
  validationStatus?: string;
}

interface DriveExportResult {
  folderId: string;
  folderUrl: string;
  uploadedCount: number;
}

const ROOT_FORM_TYPES = new Set([
  "packageSummary",
  "packageInventory",
  "submissionMemo",
  "confidenceReport",
]);

const SECTION_ORDER: PackageSection[] = [
  "root",
  "source_docs",
  "first_part",
  "second_part",
  "price_offer",
  "required_docs",
];

const SECTION_LABELS: Record<PackageSection, string> = {
  root: "Корень пакета",
  source_docs: "Исходные документы",
  first_part: "Первая часть",
  second_part: "Вторая часть",
  price_offer: "Ценовое предложение",
  required_docs: "Подтверждающие документы",
};

const VALIDATION_LABELS: Record<string, string> = {
  not_checked: "не проверено",
  passed: "проверено",
  risk: "риск",
  blocked: "блокер",
};

function inferSection(file: GeneratedFile): PackageSection {
  if (isPackageSection(file.packageSection)) return file.packageSection;
  const name = `${file.fileName} ${file.formType}`.toLowerCase();
  if (ROOT_FORM_TYPES.has(file.formType)) return "root";
  if (file.formType === "calculation" || name.includes("цен") || name.includes("калькуляц")) {
    return "price_offer";
  }
  if (name.includes("техническ") || name.includes("первая")) return "first_part";
  if (name.includes("выписк") || name.includes("лиценз") || name.includes("сертифик")) {
    return "required_docs";
  }
  return "second_part";
}

function isPackageSection(value: string | undefined): value is PackageSection {
  return Boolean(value && SECTION_ORDER.includes(value as PackageSection));
}

function packagePath(file: PackageFile) {
  if (file.section === "root") return file.fileName;
  return `${file.section}/${file.fileName}`;
}

function fileIcon(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return <FileSpreadsheet className="size-4 text-emerald-700" />;
  if (lower.endsWith(".zip")) return <FileArchive className="size-4 text-slate-700" />;
  return <FileText className="size-4 text-slate-600" />;
}

async function downloadFile(file: PackageFile) {
  if (!file.url) return;
  const res = await fetch(file.url);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function GeneratedFilesList({
  procurementId,
  files,
  sourceFiles = [],
  driveFolderId,
}: {
  procurementId: Id<"procurements">;
  files: GeneratedFile[];
  sourceFiles?: SourceFile[];
  driveFolderId?: string;
}) {
  const exportPackageToDrive = useAction(api.packageExport.exportPackageToDrive);
  const [zipping, setZipping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [driveResult, setDriveResult] = useState<DriveExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const packageFiles = useMemo<PackageFile[]>(() => {
    const sources = sourceFiles.map((file) => ({
      id: `source-${file._id}`,
      fileName: file.fileName,
      url: file.url,
      section: "source_docs" as const,
      kind: "source" as const,
    }));
    const generated = files.map((file) => ({
      id: `generated-${file._id}`,
      fileName: file.fileName,
      url: file.url,
      section: inferSection(file),
      kind: "generated" as const,
      artifactType: file.artifactType,
      validationStatus: file.validationStatus,
    }));
    return [...generated, ...sources];
  }, [files, sourceFiles]);

  const groupedFiles = useMemo(
    () =>
      SECTION_ORDER.map((section) => ({
        section,
        files: packageFiles.filter((file) => file.section === section),
      })).filter((group) => group.files.length > 0),
    [packageFiles]
  );

  const availableFiles = packageFiles.filter((file) => file.url);
  const driveUrl =
    driveResult?.folderUrl ||
    (driveFolderId ? `https://drive.google.com/drive/folders/${driveFolderId}` : "");

  const downloadAll = async () => {
    setError(null);
    setZipping(true);
    try {
      const zip = new JSZip();
      for (const file of availableFiles) {
        const response = await fetch(file.url!);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось собрать ZIP");
    } finally {
      setZipping(false);
    }
  };

  const exportToDrive = async () => {
    setError(null);
    setExporting(true);
    try {
      const result = await exportPackageToDrive({ procurementId });
      setDriveResult(result as DriveExportResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось выгрузить в Google Drive");
    } finally {
      setExporting(false);
    }
  };

  if (packageFiles.length === 0) {
    return (
      <div className="rounded-md border bg-white p-5 text-sm text-muted-foreground">
        Файлы пакета появятся после анализа, загрузки калькуляции или заполнения форм.
      </div>
    );
  }

  return (
    <section className="rounded-md border bg-white p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
            <FolderUp className="size-4" />
            Рабочая папка заявки
          </div>
          <h4 className="mt-1 font-semibold">Пакет документов по разделам</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {packageFiles.length} файлов, готово к выгрузке в Drive или ZIP.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportToDrive}
            disabled={exporting || availableFiles.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <FolderUp className="size-4" />}
            В Google Drive
          </button>
          <button
            onClick={downloadAll}
            disabled={zipping || availableFiles.length === 0}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {zipping ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />}
            ZIP
          </button>
          {driveUrl && (
            <a
              href={driveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-slate-50"
            >
              <ExternalLink className="size-4" />
              Открыть
            </a>
          )}
        </div>
      </div>

      {driveResult && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="size-4" />
          Выгружено файлов: {driveResult.uploadedCount}
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="size-4" />
          {error}
        </div>
      )}

      <div className="mt-5 space-y-4">
        {groupedFiles.map((group) => (
          <div key={group.section}>
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase text-slate-500">
              <span>{SECTION_LABELS[group.section]}</span>
              <span>{group.files.length}</span>
            </div>
            <div className="divide-y rounded-md border">
              {group.files.map((file) => (
                <div
                  key={file.id}
                  className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2.5 md:grid-cols-[1fr_170px_auto]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {fileIcon(file.fileName)}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{file.fileName}</p>
                      <p className="truncate text-xs text-muted-foreground">{packagePath(file)}</p>
                    </div>
                  </div>
                  <div className="hidden items-center justify-end gap-2 md:flex">
                    {file.validationStatus && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {VALIDATION_LABELS[file.validationStatus] || file.validationStatus}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => downloadFile(file)}
                    disabled={!file.url}
                    title="Скачать файл"
                    className="inline-flex size-8 items-center justify-center rounded-md border text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  >
                    <Download className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
