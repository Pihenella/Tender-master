"use client";

import { use, useState, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Header } from "@/components/header";
import { FileDropzone } from "@/components/file-dropzone";
import { ExtractedItemsTable } from "@/components/extracted-items-table";
import { GeneratedFilesList } from "@/components/generated-files-list";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/progress-bar";
import Link from "next/link";
import type { Id } from "../../../../convex/_generated/dataModel";

type ProfileId = "boltinov" | "pikhenek";

export default function ProcurementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const procurementId = id as Id<"procurements">;

  const procurement = useQuery(api.procurements.get, { id: procurementId });
  const uploadedFiles = useQuery(api.files.listByProcurement, {
    procurementId,
  });
  const extractedItems = useQuery(api.files.getExtractedItems, {
    procurementId,
  });
  const extractedForms = useQuery(api.files.getExtractedForms, {
    procurementId,
  });
  const generatedFiles = useQuery(api.files.getGeneratedFiles, {
    procurementId,
  });

  const analyzeDocuments = useAction(api.analysis.analyzeDocuments);
  const parseCalculation = useAction(api.calculationUpload.parseCalculation);
  const fillForms = useAction(api.formFilling.fillForms);
  const cancelOperation = useMutation(api.procurements.cancelOperation);

  const [profileId, setProfileId] = useState<ProfileId>("pikhenek");
  const [analyzing, setAnalyzing] = useState(false);
  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      await analyzeDocuments({ procurementId });
    } finally {
      setAnalyzing(false);
    }
  }, [analyzeDocuments, procurementId]);

  const handleCalculationUpload = useCallback(
    async (storageId: Id<"_storage">) => {
      await parseCalculation({ procurementId, storageId });
    },
    [parseCalculation, procurementId]
  );

  const handleFillForms = useCallback(async () => {
    await fillForms({ procurementId });
  }, [fillForms, procurementId]);

  const handleCancel = useCallback(async () => {
    await cancelOperation({ id: procurementId });
  }, [cancelOperation, procurementId]);

  if (procurement === undefined)
    return (
      <div className="min-h-screen">
        <Header profileId={profileId} onProfileChange={setProfileId} />
        <main className="max-w-4xl mx-auto p-6">Загрузка...</main>
      </div>
    );

  if (procurement === null)
    return (
      <div className="min-h-screen">
        <Header profileId={profileId} onProfileChange={setProfileId} />
        <main className="max-w-4xl mx-auto p-6">Закупка не найдена</main>
      </div>
    );

  const isAnalyzing = procurement.status === "analyzing" || analyzing;
  const isAnalyzed = [
    "analyzed",
    "calculation_uploaded",
    "filling_forms",
    "completed",
  ].includes(procurement.status);
  const isFilling = procurement.status === "filling_forms";
  const isCompleted = procurement.status === "completed";
  const hasCalculation = [
    "calculation_uploaded",
    "filling_forms",
    "completed",
  ].includes(procurement.status);

  const calculationFile = generatedFiles?.find(
    (f) => f.formType === "calculation"
  );
  const confidenceReport = generatedFiles?.find(
    (f) => f.formType === "confidenceReport"
  );
  const filledForms = generatedFiles?.filter(
    (f) => f.formType !== "calculation" && f.formType !== "confidenceReport"
  );

  return (
    <div className="min-h-screen">
      <Header profileId={profileId} onProfileChange={setProfileId} />
      <main className="max-w-4xl mx-auto p-6">
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            &larr; Назад
          </Link>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">
              {procurement.name || "Новая закупка"}
            </h2>
            {procurement.number && (
              <p className="text-sm text-muted-foreground">
                &numero; {procurement.number}
              </p>
            )}
          </div>
          <StatusBadge status={procurement.status} />
        </div>

        {procurement.statusMessage && procurement.statusMessage.startsWith("Ошибка") && (
          <div className="mb-4 p-3 rounded text-sm bg-red-50 text-red-700">
            {procurement.statusMessage}
          </div>
        )}

        {procurement.statusMessage && procurement.statusMessage.includes("отменен") && (
          <div className="mb-4 p-3 rounded text-sm bg-yellow-50 text-yellow-700">
            {procurement.statusMessage}
          </div>
        )}

        {(isAnalyzing || isFilling) && (
          <div className="mb-4 p-4 bg-blue-50 rounded-lg">
            <ProgressBar
              progress={procurement.progress ?? 0}
              message={procurement.statusMessage}
            />
            <button
              onClick={handleCancel}
              className="mt-3 bg-red-500 text-white px-4 py-1.5 rounded-lg text-sm hover:bg-red-600"
            >
              Остановить
            </button>
          </div>
        )}

        {!isAnalyzing &&
          !isFilling &&
          procurement.status !== "error" &&
          procurement.statusMessage && (
            <div className="mb-4 p-3 rounded text-sm bg-blue-50 text-blue-700">
              {procurement.statusMessage}
            </div>
          )}

        {/* Stage 1: Upload & Analysis */}
        <div className="bg-white rounded-lg border p-6 mb-6">
          <h3 className="font-semibold mb-4">
            Этап 1: Загрузка и анализ документации
          </h3>

          <FileDropzone
            procurementId={procurementId}
            label="Перетащите файлы закупки (docx, xlsx, pdf) или нажмите для выбора"
            accept=".docx,.xlsx,.pdf"
          />

          {uploadedFiles && uploadedFiles.length > 0 && (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">
                Загружено файлов: {uploadedFiles.length}
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                {uploadedFiles.map((f) => (
                  <li key={f._id}>&#128196; {f.fileName}</li>
                ))}
              </ul>
            </div>
          )}

          {uploadedFiles && uploadedFiles.length > 0 && (
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {isAnalyzing ? "Анализ..." : isAnalyzed ? "Переанализировать" : "Анализировать"}
            </button>
          )}

          {isAnalyzed && extractedItems && extractedItems.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium mb-2">
                Извлечённые позиции ({extractedItems.length}):
              </h4>
              <ExtractedItemsTable items={extractedItems} />
            </div>
          )}

          {isAnalyzed && extractedForms && extractedForms.length > 0 && (
            <div className="mt-4 p-3 bg-gray-50 rounded">
              <h4 className="text-sm font-medium mb-2">
                Найденные формы ({extractedForms.length}):
              </h4>
              <ul className="text-xs text-muted-foreground space-y-1">
                {extractedForms.map((f) => (
                  <li key={f._id}>
                    &#128203; {f.name}
                    <span className="ml-2 text-gray-400">
                      ({f.sourceFile}, {f.locationType})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Stage 2: Calculation */}
        {isAnalyzed && (
          <div className="bg-white rounded-lg border p-6 mb-6">
            <h3 className="font-semibold mb-4">Этап 2: Калькуляция</h3>

            {calculationFile && calculationFile.url && (
              <div className="mb-4">
                <button
                  onClick={async () => {
                    const res = await fetch(calculationFile.url!);
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = calculationFile.fileName;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700"
                >
                  &#128229; Скачать калькуляцию
                </button>
              </div>
            )}

            <p className="text-sm text-muted-foreground mb-4">
              Заполните колонки H (Наши характеристики), I (Наша цена), L
              (Примечание) и загрузите обратно.
            </p>
            <FileDropzone
              procurementId={procurementId}
              label={hasCalculation ? "Перезагрузить калькуляцию (.xlsx)" : "Загрузите заполненную калькуляцию (.xlsx)"}
              accept=".xlsx"
              onUploadComplete={handleCalculationUpload}
            />
          </div>
        )}

        {/* Stage 3: Form Filling */}
        {hasCalculation && (
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Этап 3: Заполнение форм</h3>

            <button
              onClick={handleFillForms}
              disabled={isFilling}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {isFilling ? "Заполнение..." : isCompleted ? "Перезаполнить формы" : "Заполнить формы"}
            </button>

            {filledForms && filledForms.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-medium mb-2">
                  Заполненные формы:
                </h4>
                <GeneratedFilesList files={filledForms} />
              </div>
            )}

            {confidenceReport && (
              <ConfidenceReportCard url={confidenceReport.url} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// --- Confidence Report Component ---

function ConfidenceReportCard({ url }: { url: string | null }) {
  const [report, setReport] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    if (!url || report) return;
    setLoading(true);
    try {
      const res = await fetch(url);
      const data = await res.json();
      setReport(data);
    } finally {
      setLoading(false);
    }
  }, [url, report]);

  if (!url) return null;

  return (
    <div className="mt-6 p-4 bg-gray-50 rounded-lg border">
      <h4 className="text-sm font-medium mb-3">Отчёт проверки</h4>
      {!report && (
        <button
          onClick={loadReport}
          disabled={loading}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          {loading ? "Загрузка..." : "Показать отчёт"}
        </button>
      )}
      {report &&
        report.map((formReport: any, idx: number) => (
          <div key={idx} className="mb-4 last:mb-0">
            <p className="text-sm font-medium">{formReport.formName}</p>
            {formReport.fields?.map((field: any, fi: number) => (
              <div key={fi} className="flex items-center gap-2 text-xs mt-1">
                <span
                  className={`w-2 h-2 rounded-full ${
                    field.confidence === "high"
                      ? "bg-green-500"
                      : field.confidence === "medium"
                        ? "bg-yellow-500"
                        : "bg-red-500"
                  }`}
                />
                <span className="text-gray-600">{field.field}:</span>
                <span>{field.value}</span>
                {field.note && (
                  <span className="text-gray-400">({field.note})</span>
                )}
              </div>
            ))}
            {formReport.warnings?.length > 0 && (
              <div className="mt-2">
                {formReport.warnings.map((w: string, wi: number) => (
                  <p key={wi} className="text-xs text-orange-600">
                    &#9888;&#65039; {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
