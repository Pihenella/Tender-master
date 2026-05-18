import { describe, expect, it } from "vitest";
import {
  buildExtractionBatches,
  emptyBidPackagePlan,
  formatExtractionBatch,
  mergeBidPackagePlans,
  mergeExtractionResults,
} from "../src/lib/server/extractionBatches";
import type { ExtractionResult } from "../src/lib/server/openaiSchemas";

function result(partial: Partial<ExtractionResult>): ExtractionResult {
  return {
    procurementNumber: "",
    procurementName: "",
    nmck: 0,
    deliveryDeadline: "",
    deliveryAddresses: [],
    items: [],
    forms: [],
    ...partial,
  };
}

describe("extractionBatches", () => {
  it("splits large block-numbered files while preserving source file name", () => {
    const batches = buildExtractionBatches(
      [
        {
          name: "doc.docx",
          content: "[Block 1] A".repeat(20) + "\n[Block 2] B".repeat(20),
        },
      ],
      80
    );

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.files.every((file) => file.name === "doc.docx"))).toBe(true);
    expect(formatExtractionBatch(batches[0])).toContain("=== FILE: doc.docx ===");
    expect(formatExtractionBatch(batches[0])).toContain("=== PART:");
  });

  it("merges extracted results and deduplicates repeated items and forms", () => {
    const merged = mergeExtractionResults([
      result({
        procurementNumber: "123",
        procurementName: "Supply",
        nmck: 1000,
        deliveryAddresses: [{ name: "A", address: "Street 1" }],
        items: [
          {
            name: "Bolt",
            quantity: 10,
            unit: "pcs",
            nmckPrice: 5,
            tzSpecs: "short",
            pp1875: "",
            quarter: "",
            estimatedWeight: 1,
            estimatedDimensions: "",
            deliveryAllocations: [],
          },
        ],
        forms: [
          {
            name: "Form 1",
            sourceFile: "doc.docx",
            locationType: "paragraph_range",
            startBlock: 1,
            endBlock: 5,
            sheetName: "",
          },
        ],
      }),
      result({
        procurementName: "Supply duplicate",
        items: [
          {
            name: "Bolt",
            quantity: 10,
            unit: "pcs",
            nmckPrice: 5,
            tzSpecs: "longer technical specs",
            pp1875: "restriction",
            quarter: "Q1",
            estimatedWeight: 2,
            estimatedDimensions: "10x10x10",
            deliveryAllocations: [{ address: "Street 1", quantity: 10 }],
          },
        ],
        forms: [
          {
            name: "Form 1",
            sourceFile: "doc.docx",
            locationType: "paragraph_range",
            startBlock: 1,
            endBlock: 5,
            sheetName: "",
          },
        ],
      }),
    ]);

    expect(merged.procurementNumber).toBe("123");
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0].tzSpecs).toBe("longer technical specs");
    expect(merged.items[0].pp1875).toBe("restriction");
    expect(merged.forms).toHaveLength(1);
  });

  it("merges bid package plans and keeps source references", () => {
    const first = emptyBidPackagePlan();
    first.tenderCard.customerName = "Customer";
    first.tenderCard.lawRegime = "223-FZ";
    first.applicationRequirements.push({
      section: "second_part",
      requirementText: "Submit participant questionnaire",
      requiredDocumentName: "Questionnaire",
      obligation: "required",
      status: "planned",
      riskNote: "",
      sourceReferences: [{
        sourceFile: "doc.docx",
        locationType: "block_range",
        startBlock: 10,
        endBlock: 12,
        page: null,
        sheetName: null,
        row: null,
        textQuote: "questionnaire",
      }],
    });

    const second = emptyBidPackagePlan();
    second.tenderCard.customerName = "Other";
    second.tenderCard.paymentTerms = "30 days";
    second.applicationRequirements.push({
      section: "second_part",
      requirementText: "Submit participant questionnaire",
      requiredDocumentName: "Questionnaire",
      obligation: "required",
      status: "risk",
      riskNote: "Template is ambiguous",
      sourceReferences: [{
        sourceFile: "doc.docx",
        locationType: "block_range",
        startBlock: 20,
        endBlock: 21,
        page: null,
        sheetName: null,
        row: null,
        textQuote: "ambiguous template",
      }],
    });

    const merged = mergeBidPackagePlans([first, second]);

    expect(merged.tenderCard.customerName).toBe("Customer");
    expect(merged.tenderCard.paymentTerms).toBe("30 days");
    expect(merged.tenderCard.lawRegime).toBe("223-FZ");
    expect(merged.applicationRequirements).toHaveLength(1);
    expect(merged.applicationRequirements[0].status).toBe("risk");
    expect(merged.applicationRequirements[0].sourceReferences).toHaveLength(2);
  });
});
