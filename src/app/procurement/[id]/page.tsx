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
import { isCollectiveParticipantForm } from "@/lib/formRules";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  FileText,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import type { Id } from "../../../../convex/_generated/dataModel";

type ProfileId = "boltinov" | "pikhenek";
type PackageSection =
  | "first_part"
  | "second_part"
  | "price_offer"
  | "required_docs"
  | "platform_actions";
type RequirementStatus = "planned" | "prepared" | "missing" | "not_applicable" | "risk";
type RiskSeverity = "low" | "medium" | "high" | "blocking";
type SourceReference = {
  sourceFile: string;
  locationType: "block_range" | "page" | "sheet" | "row" | "whole_file" | "unknown";
  startBlock: number | null;
  endBlock: number | null;
  page: number | null;
  sheetName: string | null;
  row: number | null;
  textQuote: string;
};
type TenderCardPlan = {
  customerName: string;
  procurementNumber: string;
  subject: string;
  platformName: string;
  platformUrl: string;
  publicationDate: string;
  submissionDeadline: string;
  submissionDeadlineTimezone: string;
  resultDate: string;
  lawRegime: "44-FZ" | "223-FZ" | "commercial" | "unknown";
  lots: Array<{ number: string; name: string; nmck: number | null }>;
  nmck: number | null;
  currency: string;
  paymentTerms: string;
  deliveryPeriod: string;
  guarantees: string;
  applicationSecurity: string;
  contractSecurity: string;
  smpSmeFlag: string;
  evaluationCriteria: string[];
  keyRisks: string[];
};
type ApplicationRequirementPlan = {
  section: PackageSection;
  requirementText: string;
  requiredDocumentName: string;
  obligation: "required" | "optional" | "not_applicable" | "unknown";
  status: RequirementStatus;
  riskNote: string;
  sourceReferences: SourceReference[];
};
type MissingItemPlan = {
  section: PackageSection;
  title: string;
  reason: string;
  blocking: boolean;
  sourceReferences: SourceReference[];
};
type RiskNotePlan = {
  section: PackageSection;
  severity: RiskSeverity;
  text: string;
  mitigation: string;
  sourceReferences: SourceReference[];
};
type BidPackagePlan = {
  tenderCard: TenderCardPlan | null;
  applicationRequirements: ApplicationRequirementPlan[];
  missingItems: MissingItemPlan[];
  riskNotes: RiskNotePlan[];
};
type ConfidenceField = {
  field: string;
  value: string;
  confidence: string;
  note?: string;
};
type ConfidenceFormReport = {
  formName: string;
  fields?: ConfidenceField[];
  warnings?: string[];
};

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
  const bidPackagePlan = useQuery(api.procurements.getBidPackagePlan, {
    procurementId,
  }) as BidPackagePlan | undefined;

  const analyzeDocuments = useAction(api.analysis.analyzeDocuments);
  const parseCalculation = useAction(api.calculationUpload.parseCalculation);
  const fillFormsAction = useAction(api.formFilling.fillForms);
  const cancelOperation = useMutation(api.procurements.cancelOperation);

  const [profileId, setProfileId] = useState<ProfileId>("pikhenek");
  const [fillEngine, setFillEngine] = useState<"v1" | "v2">("v1");
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

  const [selectedFormIds, setSelectedFormIds] = useState<Set<string>>(new Set());

  const handleFillForms = useCallback(async (formIds?: string[]) => {
    await fillFormsAction({ procurementId, profileId, formIds, fillEngine });
  }, [fillFormsAction, procurementId, profileId, fillEngine]);

  const handleFillSelected = useCallback(async () => {
    const formIds = Array.from(selectedFormIds);
    if (formIds.length === 0) return;
    await handleFillForms(formIds);
    setSelectedFormIds(new Set());
  }, [selectedFormIds, handleFillForms]);

  const handleFillAll = useCallback(async () => {
    await handleFillForms();
    setSelectedFormIds(new Set());
  }, [handleFillForms]);

  const toggleFormSelection = useCallback((formId: string) => {
    setSelectedFormIds((prev) => {
      const next = new Set(prev);
      if (next.has(formId)) next.delete(formId);
      else next.add(formId);
      return next;
    });
  }, []);

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
      <main className="max-w-6xl mx-auto p-6">
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

        {/* Stage 2: Bid Package Plan */}
        {isAnalyzed && (
          <BidPackagePlanPanel
            plan={bidPackagePlan}
            procurement={{
              number: procurement.number,
              name: procurement.name,
              nmck: procurement.nmck,
              deliveryDeadline: procurement.deliveryDeadline,
            }}
          />
        )}

        {/* Stage 3: Calculation */}
        {isAnalyzed && (
          <div className="bg-white rounded-lg border p-6 mb-6">
            <h3 className="font-semibold mb-4">Этап 3: Калькуляция</h3>

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

        {/* Stage 4: Form Filling */}
        {hasCalculation && (
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Этап 4: Заполнение форм</h3>

            <div className="flex items-center gap-3 mb-3 text-sm">
              <span className="text-gray-500">Движок:</span>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="fillEngine"
                  value="v1"
                  checked={fillEngine === "v1"}
                  onChange={() => setFillEngine("v1")}
                  className="accent-blue-600"
                />
                V1
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="fillEngine"
                  value="v2"
                  checked={fillEngine === "v2"}
                  onChange={() => setFillEngine("v2")}
                  className="accent-blue-600"
                />
                V2 (эксп.)
              </label>
            </div>

            <div className="flex gap-2 mb-4">
              <button
                onClick={selectedFormIds.size > 0 ? handleFillSelected : handleFillAll}
                disabled={isFilling}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {isFilling
                  ? "Заполнение..."
                  : selectedFormIds.size > 0
                    ? `Заполнить выбранные (${selectedFormIds.size})`
                    : isCompleted
                      ? "Перезаполнить все"
                      : "Заполнить формы"}
              </button>
              {selectedFormIds.size > 0 && !isFilling && (
                <button
                  onClick={handleFillAll}
                  className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm hover:bg-gray-200"
                >
                  Заполнить все
                </button>
              )}
            </div>

            <p className="text-xs text-muted-foreground mb-3">
              Профиль: <span className="font-medium">{profileId === "boltinov" ? "ИП Болтинов Д.А." : "ИП Пихенек Ю.Д."}</span> (смена в шапке)
            </p>

            {extractedForms && extractedForms.length > 0 && (
              <div className="mb-4">
                <h4 className="text-sm font-medium mb-2">Формы для заполнения:</h4>
                <div className="space-y-1">
                  {extractedForms.map((form) => {
                    const filled = filledForms?.find((f) => f.formType === form.name);
                    const isCollectiveForm = isCollectiveParticipantForm(form.name);
                    return (
                      <label
                        key={form._id}
                        className={`flex items-center gap-2 p-2 rounded ${
                          isCollectiveForm
                            ? "bg-gray-50 text-gray-400 cursor-not-allowed"
                            : "hover:bg-gray-50 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!isCollectiveForm && selectedFormIds.has(form._id)}
                          disabled={isCollectiveForm}
                          onChange={() => toggleFormSelection(form._id)}
                          className="rounded"
                        />
                        <span className="text-sm flex-1">{form.name}</span>
                        {isCollectiveForm && (
                          <span className="text-xs text-gray-500">
                            не заполняем
                          </span>
                        )}
                        {filled && (
                          <span className="text-xs text-green-600">
                            {filled.profileId === "boltinov" ? "Болтинов" : "Пихенек"}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {filledForms && filledForms.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-medium mb-2">
                  Файлы пакета:
                </h4>
                <GeneratedFilesList files={filledForms} sourceFiles={uploadedFiles || []} />
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

// --- Bid Package Plan Components ---

const SECTION_ORDER: PackageSection[] = [
  "first_part",
  "second_part",
  "price_offer",
  "required_docs",
  "platform_actions",
];

const SECTION_LABELS: Record<PackageSection, string> = {
  first_part: "Первая часть",
  second_part: "Вторая часть",
  price_offer: "Ценовое предложение",
  required_docs: "Подтверждающие документы",
  platform_actions: "Действия на площадке",
};

const STATUS_LABELS: Record<RequirementStatus, string> = {
  planned: "Запланировано",
  prepared: "Готово",
  missing: "Не хватает",
  not_applicable: "Не требуется",
  risk: "Риск",
};

const STATUS_STYLES: Record<RequirementStatus, string> = {
  planned: "border-slate-200 bg-slate-50 text-slate-700",
  prepared: "border-emerald-200 bg-emerald-50 text-emerald-700",
  missing: "border-red-200 bg-red-50 text-red-700",
  not_applicable: "border-zinc-200 bg-zinc-50 text-zinc-500",
  risk: "border-amber-200 bg-amber-50 text-amber-700",
};

const SEVERITY_LABELS: Record<RiskSeverity, string> = {
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  blocking: "Блокер",
};

const SEVERITY_STYLES: Record<RiskSeverity, string> = {
  low: "border-slate-200 bg-slate-50 text-slate-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  high: "border-orange-200 bg-orange-50 text-orange-700",
  blocking: "border-red-200 bg-red-50 text-red-700",
};

function BidPackagePlanPanel({
  plan,
  procurement,
}: {
  plan: BidPackagePlan | undefined;
  procurement: {
    number: string;
    name: string;
    nmck: number;
    deliveryDeadline: string;
  };
}) {
  if (plan === undefined) {
    return (
      <div className="bg-white rounded-md border p-6 mb-6">
        <h3 className="font-semibold mb-2">Этап 2: План заявки</h3>
        <p className="text-sm text-muted-foreground">Загрузка плана заявки...</p>
      </div>
    );
  }

  const hasPlan =
    Boolean(plan.tenderCard) ||
    plan.applicationRequirements.length > 0 ||
    plan.missingItems.length > 0 ||
    plan.riskNotes.length > 0;

  if (!hasPlan) {
    return (
      <div className="bg-white rounded-md border p-6 mb-6">
        <h3 className="font-semibold mb-2">Этап 2: План заявки</h3>
        <p className="text-sm text-muted-foreground">
          План заявки пока не сохранён. Запустите анализ заново, чтобы извлечь карточку закупки, состав заявки и риски.
        </p>
      </div>
    );
  }

  return (
    <section className="mb-6 space-y-4">
      <div className="flex flex-col gap-3 rounded-md border bg-white p-6 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
            <ClipboardList className="size-4" />
            Этап 2: План заявки
          </div>
          <h3 className="mt-1 text-lg font-semibold">Карточка закупки и состав подачи</h3>
        </div>
        <ReadinessState plan={plan} />
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <PlanCounter label="Требований" value={plan.applicationRequirements.length} />
          <PlanCounter label="Не хватает" value={plan.missingItems.length} urgent={plan.missingItems.length > 0} />
          <PlanCounter label="Рисков" value={plan.riskNotes.length} urgent={plan.riskNotes.length > 0} />
        </div>
      </div>

      {plan.missingItems.length > 0 && (
        <MissingItemsPanel items={plan.missingItems} />
      )}

      <TenderCardPanel card={plan.tenderCard} procurement={procurement} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <ApplicationPlan requirements={plan.applicationRequirements} />
        <RiskNotesPanel risks={plan.riskNotes} cardRisks={plan.tenderCard?.keyRisks || []} />
      </div>
    </section>
  );
}

function ReadinessState({ plan }: { plan: BidPackagePlan }) {
  const blockingMissing = plan.missingItems.filter((item) => item.blocking).length;
  const blockingRisks = plan.riskNotes.filter((risk) => risk.severity === "blocking").length;
  const highRisks = plan.riskNotes.filter((risk) => risk.severity === "high").length;
  const state =
    blockingMissing || blockingRisks
      ? { label: "Подача заблокирована", className: "border-red-200 bg-red-50 text-red-800" }
      : highRisks || plan.missingItems.length || plan.riskNotes.length
        ? { label: "Готово с рисками", className: "border-amber-200 bg-amber-50 text-amber-800" }
        : { label: "Готово к подаче", className: "border-emerald-200 bg-emerald-50 text-emerald-800" };

  return (
    <div className={`rounded-md border px-3 py-2 text-sm font-medium ${state.className}`}>
      {state.label}
    </div>
  );
}

function PlanCounter({
  label,
  value,
  urgent = false,
}: {
  label: string;
  value: number;
  urgent?: boolean;
}) {
  return (
    <div className={`rounded-md border px-3 py-2 ${urgent ? "border-amber-200 bg-amber-50" : "bg-slate-50"}`}>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}

function TenderCardPanel({
  card,
  procurement,
}: {
  card: TenderCardPlan | null;
  procurement: {
    number: string;
    name: string;
    nmck: number;
    deliveryDeadline: string;
  };
}) {
  const values = [
    ["Заказчик", card?.customerName],
    ["№ закупки", card?.procurementNumber || procurement.number],
    ["Предмет", card?.subject || procurement.name],
    ["Режим", formatLawRegime(card?.lawRegime)],
    ["Срок подачи", formatDeadline(card?.submissionDeadline, card?.submissionDeadlineTimezone)],
    ["НМЦК", formatMoney(card?.nmck ?? procurement.nmck)],
    ["Оплата", card?.paymentTerms],
    ["Поставка/работы", card?.deliveryPeriod || procurement.deliveryDeadline],
    ["Обеспечение заявки", card?.applicationSecurity],
    ["Обеспечение договора", card?.contractSecurity],
    ["СМП/МСП", card?.smpSmeFlag],
    ["Валюта", card?.currency],
  ].filter(([, value]) => Boolean(value));

  return (
    <div className="rounded-md border bg-white p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-slate-500" />
          <h4 className="font-semibold">Карточка закупки</h4>
        </div>
        {card?.platformUrl && (
          <a
            href={card.platformUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-800"
          >
            {card.platformName || "Площадка"}
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {values.map(([label, value]) => (
          <div key={label} className="rounded-md bg-slate-50 px-3 py-2">
            <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      {card?.evaluationCriteria && card.evaluationCriteria.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">Критерии оценки</p>
          <ul className="mt-2 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
            {card.evaluationCriteria.map((criterion, index) => (
              <li key={`${criterion}-${index}`} className="rounded-md border bg-white px-3 py-2">
                {criterion}
              </li>
            ))}
          </ul>
        </div>
      )}

      {card?.lots && card.lots.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">Лоты</p>
          <div className="mt-2 divide-y rounded-md border text-sm">
            {card.lots.map((lot, index) => (
              <div key={`${lot.number}-${index}`} className="grid gap-1 p-3 md:grid-cols-[80px_1fr_140px]">
                <span className="text-slate-500">{lot.number || `Лот ${index + 1}`}</span>
                <span>{lot.name}</span>
                <span className="font-medium">{formatMoney(lot.nmck)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MissingItemsPanel({ items }: { items: MissingItemPlan[] }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-5">
      <div className="mb-3 flex items-center gap-2 text-red-800">
        <AlertTriangle className="size-4" />
        <h4 className="font-semibold">Не хватает перед подачей</h4>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item, index) => (
          <div key={`${item.title}-${index}`} className="rounded-md border border-red-100 bg-white p-3">
            <div className="mb-1 flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-red-950">{item.title}</p>
              {item.blocking && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  Блокер
                </span>
              )}
            </div>
            <p className="text-sm text-red-800">{item.reason}</p>
            <SourceReferences references={item.sourceReferences} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ApplicationPlan({ requirements }: { requirements: ApplicationRequirementPlan[] }) {
  const grouped = SECTION_ORDER.map((section) => ({
    section,
    items: requirements.filter((item) => item.section === section),
  }));

  return (
    <div className="rounded-md border bg-white p-6">
      <div className="mb-4 flex items-center gap-2">
        <ClipboardList className="size-4 text-slate-500" />
        <h4 className="font-semibold">Состав заявки</h4>
      </div>
      <div className="space-y-4">
        {grouped.map(({ section, items }) => (
          <div key={section} className="rounded-md border">
            <div className="flex items-center justify-between gap-3 border-b bg-slate-50 px-4 py-3">
              <p className="text-sm font-semibold">{SECTION_LABELS[section]}</p>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">Требования не найдены.</p>
            ) : (
              <div className="divide-y">
                {items.map((item, index) => (
                  <RequirementRow key={`${item.requiredDocumentName}-${index}`} item={item} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RequirementRow({ item }: { item: ApplicationRequirementPlan }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {item.requiredDocumentName || "Требование заявки"}
          </p>
          <p className="mt-1 text-sm text-slate-600">{item.requirementText}</p>
        </div>
        <StatusChip status={item.status} />
      </div>
      {item.riskNote && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {item.riskNote}
        </p>
      )}
      <SourceReferences references={item.sourceReferences} />
    </div>
  );
}

function RiskNotesPanel({
  risks,
  cardRisks,
}: {
  risks: RiskNotePlan[];
  cardRisks: string[];
}) {
  return (
    <div className="rounded-md border bg-white p-6">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="size-4 text-slate-500" />
        <h4 className="font-semibold">Риски и проверки</h4>
      </div>
      {risks.length === 0 && cardRisks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Явные риски не извлечены.</p>
      ) : (
        <div className="space-y-3">
          {risks.map((risk, index) => (
            <div key={`${risk.text}-${index}`} className="rounded-md border p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[risk.severity]}`}>
                  {SEVERITY_LABELS[risk.severity]}
                </span>
                <span className="text-xs text-muted-foreground">{SECTION_LABELS[risk.section]}</span>
              </div>
              <p className="text-sm font-medium">{risk.text}</p>
              {risk.mitigation && (
                <p className="mt-1 text-sm text-slate-600">{risk.mitigation}</p>
              )}
              <SourceReferences references={risk.sourceReferences} />
            </div>
          ))}
          {cardRisks.map((risk, index) => (
            <div key={`${risk}-${index}`} className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
              {risk}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: RequirementStatus }) {
  const Icon =
    status === "prepared"
      ? CheckCircle2
      : status === "risk" || status === "missing"
        ? AlertTriangle
        : CircleDashed;

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      <Icon className="size-3" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function SourceReferences({ references }: { references: SourceReference[] }) {
  if (!references.length) return null;

  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Источники ({references.length})</summary>
      <div className="mt-2 space-y-2">
        {references.map((reference, index) => (
          <div key={`${reference.sourceFile}-${index}`} className="rounded-md bg-slate-50 px-3 py-2">
            <p className="font-medium text-slate-700">
              {reference.sourceFile}
              {formatReferenceLocation(reference)}
            </p>
            {reference.textQuote && (
              <p className="mt-1 text-slate-600">{reference.textQuote}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function formatReferenceLocation(reference: SourceReference) {
  if (reference.locationType === "block_range" && reference.startBlock) {
    return `, блоки ${reference.startBlock}${reference.endBlock ? `-${reference.endBlock}` : ""}`;
  }
  if (reference.locationType === "page" && reference.page) return `, стр. ${reference.page}`;
  if (reference.locationType === "sheet" && reference.sheetName) return `, лист ${reference.sheetName}`;
  if (reference.locationType === "row" && reference.row) return `, строка ${reference.row}`;
  return "";
}

function formatMoney(value: number | null | undefined) {
  if (!value || value <= 0) return "";
  return `${value.toLocaleString("ru-RU")} ₽`;
}

function formatDeadline(deadline: string | undefined, timezone: string | undefined) {
  if (!deadline) return "";
  return timezone ? `${deadline} ${timezone}` : deadline;
}

function formatLawRegime(value: TenderCardPlan["lawRegime"] | undefined) {
  if (!value || value === "unknown") return "";
  return value;
}

// --- Confidence Report Component ---

function ConfidenceReportCard({ url }: { url: string | null }) {
  const [report, setReport] = useState<ConfidenceFormReport[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    if (!url || report) return;
    setLoading(true);
    try {
      const res = await fetch(url);
      const data = await res.json();
      setReport(Array.isArray(data) ? data as ConfidenceFormReport[] : []);
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
        report.map((formReport, idx) => (
          <div key={idx} className="mb-4 last:mb-0">
            <p className="text-sm font-medium">{formReport.formName}</p>
            {formReport.fields?.map((field, fi) => (
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
            {(formReport.warnings?.length ?? 0) > 0 && (
              <div className="mt-2">
                {formReport.warnings?.map((w, wi) => (
                  <p key={wi} className="flex items-center gap-1 text-xs text-orange-600">
                    <AlertTriangle className="size-3" />
                    {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
