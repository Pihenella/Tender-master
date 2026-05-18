import type { BidPackagePlan, ExtractionResult, SourceReference, TenderCard } from "./openaiSchemas";

export type ExtractionSourceFile = {
  name: string;
  content: string;
};

export type ExtractionBatchFile = ExtractionSourceFile & {
  part?: number;
  totalParts?: number;
};

export type ExtractionBatch = {
  files: ExtractionBatchFile[];
  charCount: number;
};

const PRIORITY_KEYWORDS = ["ТЗ", "техническ", "извещение", "документация", "НМЦ", "расчет", "приложение", "форма"];
const DEFAULT_BATCH_CHARS = 180000;

export function getExtractionBatchCharLimit() {
  return Number(process.env.OPENAI_EXTRACTION_CHUNK_CHARS) || DEFAULT_BATCH_CHARS;
}

function priority(fileName: string) {
  const lower = fileName.toLowerCase();
  return PRIORITY_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase())) ? 0 : 1;
}

function splitByBlocks(content: string, maxChars: number) {
  const blocks = content.split(/(?=\n?\[Block \d+\])/g).filter(Boolean);
  if (blocks.length <= 1) return splitByChars(content, maxChars);

  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + block.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (block.length > maxChars) {
      chunks.push(...splitByChars(block, maxChars));
    } else {
      current += block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitByChars(content: string, maxChars: number) {
  const chunks: string[] = [];
  for (let start = 0; start < content.length; start += maxChars) {
    chunks.push(content.slice(start, start + maxChars));
  }
  return chunks;
}

function splitFile(file: ExtractionSourceFile, maxChars: number): ExtractionBatchFile[] {
  if (file.content.length <= maxChars) return [file];
  const parts = splitByBlocks(file.content, maxChars);
  return parts.map((content, index) => ({
    name: file.name,
    content,
    part: index + 1,
    totalParts: parts.length,
  }));
}

export function buildExtractionBatches(files: ExtractionSourceFile[], maxChars = getExtractionBatchCharLimit()) {
  const parts = [...files]
    .sort((a, b) => priority(a.name) - priority(b.name))
    .flatMap((file) => splitFile(file, maxChars));

  const batches: ExtractionBatch[] = [];
  let current: ExtractionBatch = { files: [], charCount: 0 };

  for (const part of parts) {
    if (current.files.length > 0 && current.charCount + part.content.length > maxChars) {
      batches.push(current);
      current = { files: [], charCount: 0 };
    }
    current.files.push(part);
    current.charCount += part.content.length;
  }

  if (current.files.length > 0) batches.push(current);
  return batches;
}

export function formatExtractionBatch(batch: ExtractionBatch) {
  return batch.files
    .map((file) => {
      const partLabel = file.part && file.totalParts ? `\n=== PART: ${file.part}/${file.totalParts} ===` : "";
      return `=== FILE: ${file.name} ===${partLabel}\n${file.content}`;
    })
    .join("\n\n---\n\n");
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function firstNonEmpty(values: string[]) {
  return values.find((value) => value.trim().length > 0) || "";
}

function firstMeaningful(current: string, next: string) {
  return current.trim() ? current : next || "";
}

function pushUniqueString(values: string[], value: string) {
  const normalized = normalize(value);
  if (!normalized || values.some((existing) => normalize(existing) === normalized)) return;
  values.push(value);
}

function pushUniqueReference(values: SourceReference[], value: SourceReference) {
  const key = normalize([
    value.sourceFile,
    value.locationType,
    value.startBlock ?? "",
    value.endBlock ?? "",
    value.page ?? "",
    value.sheetName ?? "",
    value.row ?? "",
    value.textQuote,
  ].join("|"));
  if (values.some((existing) => normalize([
    existing.sourceFile,
    existing.locationType,
    existing.startBlock ?? "",
    existing.endBlock ?? "",
    existing.page ?? "",
    existing.sheetName ?? "",
    existing.row ?? "",
    existing.textQuote,
  ].join("|")) === key)) return;
  values.push(value);
}

function emptyTenderCard(): TenderCard {
  return {
    customerName: "",
    procurementNumber: "",
    subject: "",
    platformName: "",
    platformUrl: "",
    publicationDate: "",
    submissionDeadline: "",
    submissionDeadlineTimezone: "",
    resultDate: "",
    lawRegime: "unknown",
    lots: [],
    nmck: null,
    currency: "",
    paymentTerms: "",
    deliveryPeriod: "",
    guarantees: "",
    applicationSecurity: "",
    contractSecurity: "",
    smpSmeFlag: "",
    evaluationCriteria: [],
    keyRisks: [],
  };
}

export function emptyExtractionResult(): ExtractionResult {
  return {
    procurementNumber: "",
    procurementName: "",
    nmck: 0,
    deliveryDeadline: "",
    deliveryAddresses: [],
    items: [],
    forms: [],
  };
}

export function emptyBidPackagePlan(): BidPackagePlan {
  return {
    tenderCard: emptyTenderCard(),
    applicationRequirements: [],
    missingItems: [],
    riskNotes: [],
  };
}

export function mergeExtractionResults(results: ExtractionResult[]): ExtractionResult {
  const merged = emptyExtractionResult();
  merged.procurementNumber = firstNonEmpty(results.map((result) => result.procurementNumber));
  merged.procurementName = firstNonEmpty(results.map((result) => result.procurementName));
  merged.deliveryDeadline = firstNonEmpty(results.map((result) => result.deliveryDeadline));
  merged.nmck = results.find((result) => result.nmck > 0)?.nmck || 0;

  const addressKeys = new Set<string>();
  for (const result of results) {
    for (const address of result.deliveryAddresses || []) {
      const key = normalize(`${address.name}|${address.address}`);
      if (addressKeys.has(key)) continue;
      addressKeys.add(key);
      merged.deliveryAddresses.push(address);
    }
  }

  const itemKeys = new Map<string, number>();
  for (const result of results) {
    for (const item of result.items || []) {
      const key = normalize(`${item.name}|${item.unit}|${item.quantity}|${item.nmckPrice}`);
      const existingIndex = itemKeys.get(key);
      if (existingIndex === undefined) {
        itemKeys.set(key, merged.items.length);
        merged.items.push(item);
        continue;
      }

      const existing = merged.items[existingIndex];
      if (item.tzSpecs.length > existing.tzSpecs.length) existing.tzSpecs = item.tzSpecs;
      if (!existing.pp1875 && item.pp1875) existing.pp1875 = item.pp1875;
      if (!existing.quarter && item.quarter) existing.quarter = item.quarter;
      if (!existing.estimatedDimensions && item.estimatedDimensions) existing.estimatedDimensions = item.estimatedDimensions;
      if (!existing.estimatedWeight && item.estimatedWeight) existing.estimatedWeight = item.estimatedWeight;
      if (existing.deliveryAllocations.length === 0 && item.deliveryAllocations.length > 0) {
        existing.deliveryAllocations = item.deliveryAllocations;
      }
    }
  }

  const formKeys = new Set<string>();
  for (const result of results) {
    for (const form of result.forms || []) {
      const key = normalize(`${form.name}|${form.sourceFile}|${form.locationType}|${form.startBlock}|${form.endBlock}|${form.sheetName}`);
      if (formKeys.has(key)) continue;
      formKeys.add(key);
      merged.forms.push(form);
    }
  }

  return merged;
}

export function mergeBidPackagePlans(results: BidPackagePlan[]): BidPackagePlan {
  const merged = emptyBidPackagePlan();

  for (const result of results) {
    const card = result.tenderCard;
    if (card) {
      merged.tenderCard.customerName = firstMeaningful(merged.tenderCard.customerName, card.customerName);
      merged.tenderCard.procurementNumber = firstMeaningful(merged.tenderCard.procurementNumber, card.procurementNumber);
      merged.tenderCard.subject = firstMeaningful(merged.tenderCard.subject, card.subject);
      merged.tenderCard.platformName = firstMeaningful(merged.tenderCard.platformName, card.platformName);
      merged.tenderCard.platformUrl = firstMeaningful(merged.tenderCard.platformUrl, card.platformUrl);
      merged.tenderCard.publicationDate = firstMeaningful(merged.tenderCard.publicationDate, card.publicationDate);
      merged.tenderCard.submissionDeadline = firstMeaningful(merged.tenderCard.submissionDeadline, card.submissionDeadline);
      merged.tenderCard.submissionDeadlineTimezone = firstMeaningful(merged.tenderCard.submissionDeadlineTimezone, card.submissionDeadlineTimezone);
      merged.tenderCard.resultDate = firstMeaningful(merged.tenderCard.resultDate, card.resultDate);
      if (merged.tenderCard.lawRegime === "unknown" && card.lawRegime !== "unknown") {
        merged.tenderCard.lawRegime = card.lawRegime;
      }
      if (merged.tenderCard.nmck === null && card.nmck !== null) merged.tenderCard.nmck = card.nmck;
      merged.tenderCard.currency = firstMeaningful(merged.tenderCard.currency, card.currency);
      merged.tenderCard.paymentTerms = firstMeaningful(merged.tenderCard.paymentTerms, card.paymentTerms);
      merged.tenderCard.deliveryPeriod = firstMeaningful(merged.tenderCard.deliveryPeriod, card.deliveryPeriod);
      merged.tenderCard.guarantees = firstMeaningful(merged.tenderCard.guarantees, card.guarantees);
      merged.tenderCard.applicationSecurity = firstMeaningful(merged.tenderCard.applicationSecurity, card.applicationSecurity);
      merged.tenderCard.contractSecurity = firstMeaningful(merged.tenderCard.contractSecurity, card.contractSecurity);
      merged.tenderCard.smpSmeFlag = firstMeaningful(merged.tenderCard.smpSmeFlag, card.smpSmeFlag);

      for (const lot of card.lots || []) {
        const key = normalize(`${lot.number}|${lot.name}|${lot.nmck ?? ""}`);
        if (!merged.tenderCard.lots.some((existing) => normalize(`${existing.number}|${existing.name}|${existing.nmck ?? ""}`) === key)) {
          merged.tenderCard.lots.push(lot);
        }
      }
      for (const criterion of card.evaluationCriteria || []) pushUniqueString(merged.tenderCard.evaluationCriteria, criterion);
      for (const risk of card.keyRisks || []) pushUniqueString(merged.tenderCard.keyRisks, risk);
    }

    for (const requirement of result.applicationRequirements || []) {
      const key = normalize(`${requirement.section}|${requirement.requiredDocumentName}|${requirement.requirementText}`);
      const existing = merged.applicationRequirements.find((item) => normalize(`${item.section}|${item.requiredDocumentName}|${item.requirementText}`) === key);
      if (!existing) {
        merged.applicationRequirements.push({
          ...requirement,
          sourceReferences: [...(requirement.sourceReferences || [])],
        });
        continue;
      }
      if (!existing.riskNote && requirement.riskNote) existing.riskNote = requirement.riskNote;
      if (existing.status === "planned" && requirement.status !== "planned") existing.status = requirement.status;
      for (const reference of requirement.sourceReferences || []) pushUniqueReference(existing.sourceReferences, reference);
    }

    for (const item of result.missingItems || []) {
      const key = normalize(`${item.section}|${item.title}|${item.reason}`);
      const existing = merged.missingItems.find((entry) => normalize(`${entry.section}|${entry.title}|${entry.reason}`) === key);
      if (!existing) {
        merged.missingItems.push({
          ...item,
          sourceReferences: [...(item.sourceReferences || [])],
        });
        continue;
      }
      existing.blocking = existing.blocking || item.blocking;
      for (const reference of item.sourceReferences || []) pushUniqueReference(existing.sourceReferences, reference);
    }

    for (const note of result.riskNotes || []) {
      const key = normalize(`${note.section}|${note.severity}|${note.text}`);
      const existing = merged.riskNotes.find((entry) => normalize(`${entry.section}|${entry.severity}|${entry.text}`) === key);
      if (!existing) {
        merged.riskNotes.push({
          ...note,
          sourceReferences: [...(note.sourceReferences || [])],
        });
        continue;
      }
      if (!existing.mitigation && note.mitigation) existing.mitigation = note.mitigation;
      for (const reference of note.sourceReferences || []) pushUniqueReference(existing.sourceReferences, reference);
    }
  }

  return merged;
}
