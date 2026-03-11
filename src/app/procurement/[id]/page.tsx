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
  const generatedFiles = useQuery(api.files.getGeneratedFiles, {
    procurementId,
  });

  const analyzeDocuments = useAction(api.analysis.analyzeDocuments);
  const generateTemplate = useAction(api.calculationTemplate.generateTemplate);
  const parseCalculation = useAction(api.calculationUpload.parseCalculation);
  const generateForms = useAction(api.generation.generateForms);

  const [profileId, setProfileId] = useState<ProfileId>("pikhenek");
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      await analyzeDocuments({ procurementId });
    } finally {
      setAnalyzing(false);
    }
  }, [analyzeDocuments, procurementId]);

  const handleGenerateTemplate = useCallback(async () => {
    await generateTemplate({ procurementId });
    // File appears in generated files list automatically via Convex reactivity
  }, [generateTemplate, procurementId]);

  const handleCalculationUpload = useCallback(
    async (storageId: Id<"_storage">) => {
      await parseCalculation({ procurementId, storageId });
    },
    [parseCalculation, procurementId]
  );

  const handleGenerateForms = useCallback(async () => {
    setGenerating(true);
    try {
      await generateForms({ procurementId });
    } finally {
      setGenerating(false);
    }
  }, [generateForms, procurementId]);

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

  const isAnalyzing =
    procurement.status === "analyzing" || analyzing;
  const isAnalyzed = [
    "analyzed",
    "reviewed",
    "template_downloaded",
    "calculation_uploaded",
    "generating",
    "completed",
  ].includes(procurement.status);
  const isGenerating =
    procurement.status === "generating" || generating;
  const isCompleted = procurement.status === "completed";
  const hasCalculation = [
    "calculation_uploaded",
    "generating",
    "completed",
  ].includes(procurement.status);

  return (
    <div className="min-h-screen">
      <Header profileId={profileId} onProfileChange={setProfileId} />
      <main className="max-w-4xl mx-auto p-6">
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            ← Назад
          </Link>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">
              {procurement.name || "Новая закупка"}
            </h2>
            {procurement.number && (
              <p className="text-sm text-muted-foreground">
                № {procurement.number}
              </p>
            )}
          </div>
          <StatusBadge status={procurement.status} />
        </div>

        {procurement.status === "error" && procurement.statusMessage && (
          <div className="mb-4 p-3 rounded text-sm bg-red-50 text-red-700">
            {procurement.statusMessage}
          </div>
        )}

        {(isAnalyzing || isGenerating) && (
          <div className="mb-4 p-4 bg-blue-50 rounded-lg">
            <ProgressBar
              progress={procurement.progress ?? 0}
              message={procurement.statusMessage}
            />
          </div>
        )}

        {!isAnalyzing && !isGenerating && procurement.status !== "error" && procurement.statusMessage && (
          <div className="mb-4 p-3 rounded text-sm bg-blue-50 text-blue-700">
            {procurement.statusMessage}
          </div>
        )}

        {/* Stage 1: Analysis */}
        <div className="bg-white rounded-lg border p-6 mb-6">
          <h3 className="font-semibold mb-4">Этап 1: Анализ документации</h3>

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
                  <li key={f._id}>📄 {f.fileName}</li>
                ))}
              </ul>
            </div>
          )}

          {uploadedFiles && uploadedFiles.length > 0 && !isAnalyzed && (
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {isAnalyzing ? "Анализ..." : "Анализировать"}
            </button>
          )}

          {isAnalyzed && extractedItems && extractedItems.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium mb-2">
                Извлечённые позиции ({extractedItems.length}):
              </h4>
              <ExtractedItemsTable items={extractedItems} />

              <button
                onClick={handleGenerateTemplate}
                className="mt-4 bg-green-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-green-700"
              >
                Скачать калькуляцию
              </button>

              {generatedFiles && generatedFiles.filter(f => f.formType === "calculation").map(f => (
                f.url && (
                  <a
                    key={f._id}
                    href={f.url}
                    download={f.fileName}
                    className="mt-2 inline-block text-sm text-blue-600 hover:text-blue-700"
                  >
                    📥 {f.fileName}
                  </a>
                )
              ))}
            </div>
          )}
        </div>

        {/* Stage 2: Generation */}
        {isAnalyzed && (
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Этап 2: Генерация форм</h3>

            {!hasCalculation && (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  Заполните калькуляцию (колонки &quot;Наши характеристики&quot;
                  и &quot;Наша цена&quot;) и загрузите обратно.
                </p>
                <FileDropzone
                  procurementId={procurementId}
                  label="Загрузите заполненную калькуляцию (.xlsx)"
                  accept=".xlsx"
                  onUploadComplete={handleCalculationUpload}
                />
              </>
            )}

            {hasCalculation && !isCompleted && (
              <button
                onClick={handleGenerateForms}
                disabled={isGenerating}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {isGenerating ? "Генерация..." : "Сгенерировать формы"}
              </button>
            )}

            {isCompleted && generatedFiles && generatedFiles.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-medium mb-2">Готовые файлы:</h4>
                <GeneratedFilesList files={generatedFiles} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
