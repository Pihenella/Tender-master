import type { BidPackagePlan, PackageSection, RiskNote } from "./openaiSchemas";

export type PackageInventoryFile = {
  fileName: string;
  formType: string;
  section: PackageSection | "source_docs" | "root";
  artifactType: string;
  validationStatus?: string;
};

const SECTION_TITLES: Record<PackageSection | "source_docs" | "root", string> = {
  source_docs: "Исходная документация",
  first_part: "Первая часть",
  second_part: "Вторая часть",
  price_offer: "Ценовое предложение",
  required_docs: "Подтверждающие документы",
  platform_actions: "Действия на площадке",
  root: "Корень пакета",
};

function line(label: string, value: string | number | null | undefined) {
  if (value === undefined || value === null || value === "") return "";
  return `- ${label}: ${value}`;
}

function money(value: number | null | undefined) {
  if (!value) return "";
  return `${value.toLocaleString("ru-RU")} ₽`;
}

export function packagePathFor(section: PackageSection | "source_docs" | "root", fileName: string) {
  if (section === "root") return fileName;
  return `${section}/${fileName}`;
}

export function generateTenderSummary(plan: BidPackagePlan | null | undefined, risks: RiskNote[] = []) {
  const card = plan?.tenderCard;
  const rows = [
    "# Резюме закупки",
    "",
    line("Заказчик", card?.customerName),
    line("Номер закупки", card?.procurementNumber),
    line("Предмет", card?.subject),
    line("Площадка", card?.platformName || card?.platformUrl),
    line("Дата публикации", card?.publicationDate),
    line("Срок подачи", card?.submissionDeadline),
    line("Часовой пояс", card?.submissionDeadlineTimezone),
    line("Режим", card?.lawRegime && card.lawRegime !== "unknown" ? card.lawRegime : ""),
    line("НМЦК", money(card?.nmck)),
    line("Оплата", card?.paymentTerms),
    line("Срок поставки/работ", card?.deliveryPeriod),
    line("Обеспечение заявки", card?.applicationSecurity),
    line("Обеспечение договора", card?.contractSecurity),
    line("СМП/МСП", card?.smpSmeFlag),
    "",
    "## Критерии оценки",
    ...(card?.evaluationCriteria?.length ? card.evaluationCriteria.map((item) => `- ${item}`) : ["- Не извлечены"]),
    "",
    "## Ключевые риски",
    ...(card?.keyRisks?.length ? card.keyRisks.map((item) => `- ${item}`) : []),
    ...risks.map((risk) => `- [${risk.severity}] ${risk.text}${risk.mitigation ? ` — ${risk.mitigation}` : ""}`),
    "",
  ];

  return rows.filter((item) => item !== "").join("\n");
}

export function generatePackageInventory(files: PackageInventoryFile[]) {
  const rows = ["# Опись пакета", ""];
  for (const section of ["source_docs", "first_part", "second_part", "price_offer", "required_docs", "platform_actions", "root"] as const) {
    const sectionFiles = files.filter((file) => file.section === section);
    if (sectionFiles.length === 0) continue;
    rows.push(`## ${SECTION_TITLES[section]}`, "");
    for (const file of sectionFiles) {
      rows.push(`- ${packagePathFor(section, file.fileName)} (${file.artifactType}${file.validationStatus ? `, ${file.validationStatus}` : ""})`);
    }
    rows.push("");
  }
  return rows.join("\n");
}

export function generateSubmissionMemo(plan: BidPackagePlan | null | undefined, risks: RiskNote[] = []) {
  const platformRequirements = plan?.applicationRequirements.filter((item) => item.section === "platform_actions") || [];
  const missing = plan?.missingItems || [];
  const rows = [
    "# Памятка по подаче",
    "",
    "## Что проверить на площадке",
    ...(platformRequirements.length
      ? platformRequirements.map((item) => `- ${item.requiredDocumentName || "Действие"}: ${item.requirementText}`)
      : ["- Проверить поля цены, чекбоксы деклараций, слоты загрузки и подписание ЭП."]),
    "",
    "## Не хватает перед подачей",
    ...(missing.length ? missing.map((item) => `- ${item.blocking ? "[Блокер] " : ""}${item.title}: ${item.reason}`) : ["- Явных недостающих документов не извлечено."]),
    "",
    "## Финальные риски",
    ...(risks.length ? risks.map((risk) => `- [${risk.severity}] ${risk.text}${risk.mitigation ? ` — ${risk.mitigation}` : ""}`) : ["- Автоматические блокирующие риски не найдены."]),
    "",
  ];
  return rows.join("\n");
}
