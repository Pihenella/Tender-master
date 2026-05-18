import type { ParticipantProfile } from "../profiles";
import type { ApplicationRequirement, BidPackagePlan, PackageSection, RiskNote, SourceReference } from "./openaiSchemas";

export type PackageArtifactInput = {
  fileName: string;
  formType: string;
  text: string;
  section: PackageSection;
};

export type CalculationLineInput = {
  itemName: string;
  quantity: number;
  nmckPrice: number;
  ourUnitPrice?: number;
  ourTotal?: number;
  notes?: string;
};

const SECTION_KEYWORDS: Array<{ section: PackageSection; keywords: string[] }> = [
  { section: "price_offer", keywords: ["цен", "стоим", "коммерческ", "оферт", "калькуляц"] },
  { section: "first_part", keywords: ["перв", "техническ", "предлож", "характерист", "согласие"] },
  { section: "second_part", keywords: ["анкета", "участник", "декларац", "письмо", "персональн", "собственник"] },
  { section: "required_docs", keywords: ["выписк", "справк", "лиценз", "сертифик", "доверен", "паспорт"] },
  { section: "platform_actions", keywords: ["площадк", "эдс", "чекбокс", "галоч", "поле"] },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function emptySource(fileName: string): SourceReference {
  return {
    sourceFile: fileName,
    locationType: "unknown",
    startBlock: null,
    endBlock: null,
    page: null,
    sheetName: null,
    row: null,
    textQuote: "",
  };
}

export function inferPackageSection(name: string, requirements: ApplicationRequirement[] = []): PackageSection {
  const haystack = normalize(name);
  const matchedRequirement = requirements.find((requirement) => {
    const target = normalize(`${requirement.requiredDocumentName} ${requirement.requirementText}`);
    return target.length > 0 && (target.includes(haystack) || haystack.includes(normalize(requirement.requiredDocumentName)));
  });
  if (matchedRequirement) return matchedRequirement.section;

  for (const { section, keywords } of SECTION_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return section;
  }

  return "second_part";
}

export function isRequiredByPackagePlan(formName: string, plan: BidPackagePlan | null | undefined) {
  if (!plan || plan.applicationRequirements.length === 0) return true;
  const normalizedName = normalize(formName);
  return plan.applicationRequirements.some((requirement) => {
    if (requirement.obligation === "not_applicable" || requirement.status === "not_applicable") return false;
    if (requirement.section === "required_docs" || requirement.section === "platform_actions") return false;
    const target = normalize(`${requirement.requiredDocumentName} ${requirement.requirementText}`);
    return target.includes(normalizedName) || normalizedName.includes(normalize(requirement.requiredDocumentName));
  });
}

export function findMatchingRequirement(formName: string, plan: BidPackagePlan | null | undefined) {
  if (!plan) return null;
  const normalizedName = normalize(formName);
  return plan.applicationRequirements.find((requirement) => {
    const documentName = normalize(requirement.requiredDocumentName);
    const target = normalize(`${requirement.requiredDocumentName} ${requirement.requirementText}`);
    return target.includes(normalizedName) || (documentName.length > 0 && normalizedName.includes(documentName));
  }) || null;
}

export function buildMissingProfileItems(profile: ParticipantProfile, plan: BidPackagePlan | null | undefined) {
  if (!plan) return [];
  const requiredText = normalize(plan.applicationRequirements.map((item) => `${item.requiredDocumentName} ${item.requirementText}`).join(" "));
  return profile.sourceDocuments
    .filter((doc) => !doc.available && requiredText.includes(normalize(doc.title.split(" ")[0] || doc.title)))
    .map((doc) => ({
      section: "required_docs" as const,
      title: doc.title,
      reason: "Нет актуального исходного документа в профиле участника.",
      blocking: true,
      sourceReferences: [],
    }));
}

export function validateFirstPartAnonymity(profile: ParticipantProfile, artifacts: PackageArtifactInput[]): RiskNote[] {
  const risks: RiskNote[] = [];
  const firstPartArtifacts = artifacts.filter((artifact) => artifact.section === "first_part");

  for (const artifact of firstPartArtifacts) {
    const text = normalize(`${artifact.fileName}\n${artifact.text}`);
    const leaked = profile.identifiers.filter((identifier) => {
      const normalizedIdentifier = normalize(identifier);
      return normalizedIdentifier.length >= 5 && text.includes(normalizedIdentifier);
    });

    if (leaked.length > 0) {
      risks.push({
        section: "first_part",
        severity: "blocking",
        text: `В первой части найден идентификатор участника: ${leaked[0]}`,
        mitigation: "Уберите название, ИНН, контакты, адреса, реквизиты, подписи и другие признаки участника из первой части.",
        sourceReferences: [emptySource(artifact.fileName)],
      });
    }

    if (/(итого|стоимость|цена|руб\.?|₽)/i.test(artifact.text)) {
      risks.push({
        section: "first_part",
        severity: "high",
        text: `В первой части может быть цена или стоимость: ${artifact.fileName}`,
        mitigation: "Проверьте документацию: если первая часть анонимная, цену нужно перенести в ценовое предложение или поле площадки.",
        sourceReferences: [emptySource(artifact.fileName)],
      });
    }
  }

  return risks;
}

export function validatePriceOffer(profile: ParticipantProfile, lines: CalculationLineInput[]): RiskNote[] {
  const risks: RiskNote[] = [];

  for (const line of lines) {
    if (!line.ourUnitPrice || line.ourUnitPrice <= 0) {
      risks.push({
        section: "price_offer",
        severity: "blocking",
        text: `Не заполнена наша цена по позиции: ${line.itemName}`,
        mitigation: "Заполните цену в калькуляции перед формированием окончательного пакета.",
        sourceReferences: [],
      });
      continue;
    }
    if (line.nmckPrice > 0 && line.ourUnitPrice > line.nmckPrice) {
      risks.push({
        section: "price_offer",
        severity: "blocking",
        text: `Наша цена выше лимита заказчика по позиции: ${line.itemName}`,
        mitigation: `Снизьте цену до ${line.nmckPrice.toLocaleString("ru-RU")} ₽ или проверьте, допускает ли документация превышение.`,
        sourceReferences: [],
      });
    }
  }

  if (!profile.tax.ndsLabel) {
    risks.push({
      section: "price_offer",
      severity: "medium",
      text: "В профиле участника не задана формулировка НДС.",
      mitigation: "Заполните VAT/НДС-статус профиля перед подачей ценового предложения.",
      sourceReferences: [],
    });
  }

  return risks;
}
