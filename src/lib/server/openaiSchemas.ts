import type { AiMapping } from "./fillV2";
import type { StructuredOutputSchema } from "./openaiModel";

type ScalarValue = string | number | null;

export type PackageSection =
  | "first_part"
  | "second_part"
  | "price_offer"
  | "required_docs"
  | "platform_actions";

export type SourceReference = {
  sourceFile: string;
  locationType: "block_range" | "page" | "sheet" | "row" | "whole_file" | "unknown";
  startBlock: number | null;
  endBlock: number | null;
  page: number | null;
  sheetName: string | null;
  row: number | null;
  textQuote: string;
};

export type TenderCard = {
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
  lots: Array<{
    number: string;
    name: string;
    nmck: number | null;
  }>;
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

export type ApplicationRequirement = {
  section: PackageSection;
  requirementText: string;
  requiredDocumentName: string;
  obligation: "required" | "optional" | "not_applicable" | "unknown";
  status: "planned" | "prepared" | "missing" | "not_applicable" | "risk";
  riskNote: string;
  sourceReferences: SourceReference[];
};

export type MissingItem = {
  section: PackageSection;
  title: string;
  reason: string;
  blocking: boolean;
  sourceReferences: SourceReference[];
};

export type RiskNote = {
  section: PackageSection;
  severity: "low" | "medium" | "high" | "blocking";
  text: string;
  mitigation: string;
  sourceReferences: SourceReference[];
};

export type BidPackagePlan = {
  tenderCard: TenderCard;
  applicationRequirements: ApplicationRequirement[];
  missingItems: MissingItem[];
  riskNotes: RiskNote[];
};

export type ExtractionResult = {
  procurementNumber: string;
  procurementName: string;
  nmck: number;
  deliveryDeadline: string;
  deliveryAddresses: Array<{ name: string; address: string }>;
  items: Array<{
    name: string;
    quantity: number;
    unit: string;
    nmckPrice: number;
    tzSpecs: string;
    pp1875: string;
    quarter: string;
    estimatedWeight: number;
    estimatedDimensions: string;
    deliveryAllocations: Array<{ address: string; quantity: number }>;
  }>;
  forms: Array<{
    name: string;
    sourceFile: string;
    locationType: "paragraph_range" | "whole_file" | "sheet";
    startBlock: number;
    endBlock: number;
    sheetName: string;
  }>;
};

export type CalculationResult = {
  rows: Array<{
    itemName: string;
    pp1875: string;
    quantity: number;
    nmckPrice: number;
    tzSpecs: string;
  }>;
};

export type FillInstruction = {
  type: "replace" | "fillTable" | "cell" | "fillRows";
  search: string | null;
  value: ScalarValue;
  markerText: string | null;
  columns: string[];
  rows: Array<{
    values: ScalarValue[];
    cells: Array<{ column: string; value: ScalarValue }>;
  }>;
  row: number | null;
  col: number | null;
  startRow: number | null;
};

export type FillInstructionsResult = {
  instructions: FillInstruction[];
};

export type CorrectionsResult = {
  corrections: FillInstruction[];
};

export type UnresolvedCellsResult = {
  cells: Array<{ cell: string; value: ScalarValue }>;
};

const scalarValueSchema = {
  type: ["string", "number", "null"],
};

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

function arraySchema(items: unknown) {
  return { type: "array", items };
}

const deliveryAddressSchema = objectSchema({
  name: { type: "string" },
  address: { type: "string" },
});

const packageSectionSchema = {
  type: "string",
  enum: ["first_part", "second_part", "price_offer", "required_docs", "platform_actions"],
};

const sourceReferenceSchema = objectSchema({
  sourceFile: { type: "string" },
  locationType: { type: "string", enum: ["block_range", "page", "sheet", "row", "whole_file", "unknown"] },
  startBlock: { type: ["number", "null"] },
  endBlock: { type: ["number", "null"] },
  page: { type: ["number", "null"] },
  sheetName: { type: ["string", "null"] },
  row: { type: ["number", "null"] },
  textQuote: { type: "string" },
});

const tenderLotSchema = objectSchema({
  number: { type: "string" },
  name: { type: "string" },
  nmck: { type: ["number", "null"] },
});

const tenderCardSchema = objectSchema({
  customerName: { type: "string" },
  procurementNumber: { type: "string" },
  subject: { type: "string" },
  platformName: { type: "string" },
  platformUrl: { type: "string" },
  publicationDate: { type: "string" },
  submissionDeadline: { type: "string" },
  submissionDeadlineTimezone: { type: "string" },
  resultDate: { type: "string" },
  lawRegime: { type: "string", enum: ["44-FZ", "223-FZ", "commercial", "unknown"] },
  lots: arraySchema(tenderLotSchema),
  nmck: { type: ["number", "null"] },
  currency: { type: "string" },
  paymentTerms: { type: "string" },
  deliveryPeriod: { type: "string" },
  guarantees: { type: "string" },
  applicationSecurity: { type: "string" },
  contractSecurity: { type: "string" },
  smpSmeFlag: { type: "string" },
  evaluationCriteria: arraySchema({ type: "string" }),
  keyRisks: arraySchema({ type: "string" }),
});

const applicationRequirementSchema = objectSchema({
  section: packageSectionSchema,
  requirementText: { type: "string" },
  requiredDocumentName: { type: "string" },
  obligation: { type: "string", enum: ["required", "optional", "not_applicable", "unknown"] },
  status: { type: "string", enum: ["planned", "prepared", "missing", "not_applicable", "risk"] },
  riskNote: { type: "string" },
  sourceReferences: arraySchema(sourceReferenceSchema),
});

const missingItemSchema = objectSchema({
  section: packageSectionSchema,
  title: { type: "string" },
  reason: { type: "string" },
  blocking: { type: "boolean" },
  sourceReferences: arraySchema(sourceReferenceSchema),
});

const riskNoteSchema = objectSchema({
  section: packageSectionSchema,
  severity: { type: "string", enum: ["low", "medium", "high", "blocking"] },
  text: { type: "string" },
  mitigation: { type: "string" },
  sourceReferences: arraySchema(sourceReferenceSchema),
});

const deliveryAllocationSchema = objectSchema({
  address: { type: "string" },
  quantity: { type: "number" },
});

const extractedItemSchema = objectSchema({
  name: { type: "string" },
  quantity: { type: "number" },
  unit: { type: "string" },
  nmckPrice: { type: "number" },
  tzSpecs: { type: "string" },
  pp1875: { type: "string" },
  quarter: { type: "string" },
  estimatedWeight: { type: "number" },
  estimatedDimensions: { type: "string" },
  deliveryAllocations: arraySchema(deliveryAllocationSchema),
});

const extractedFormSchema = objectSchema({
  name: { type: "string" },
  sourceFile: { type: "string" },
  locationType: { type: "string", enum: ["paragraph_range", "whole_file", "sheet"] },
  startBlock: { type: "number" },
  endBlock: { type: "number" },
  sheetName: { type: "string" },
});

const calculationRowSchema = objectSchema({
  itemName: { type: "string" },
  pp1875: { type: "string" },
  quantity: { type: "number" },
  nmckPrice: { type: "number" },
  tzSpecs: { type: "string" },
});

const mappingEntrySchema = objectSchema({
  cell: { type: "string" },
  dataPath: { type: "string" },
  confidence: { type: "string", enum: ["high", "medium", "low"] },
});

const tableColumnSchema = objectSchema({
  column: { type: "string" },
  dataPath: { type: "string" },
});

const tableMappingSchema = objectSchema({
  dataStartRow: { type: "number" },
  columns: arraySchema(tableColumnSchema),
});

const computedFieldSchema = objectSchema({
  cell: { type: "string" },
  expression: { type: "string" },
  label: { type: "string" },
});

const instructionCellSchema = objectSchema({
  column: { type: "string" },
  value: scalarValueSchema,
});

const instructionRowSchema = objectSchema({
  values: arraySchema(scalarValueSchema),
  cells: arraySchema(instructionCellSchema),
});

const fillInstructionSchema = objectSchema({
  type: { type: "string", enum: ["replace", "fillTable", "cell", "fillRows"] },
  search: { type: ["string", "null"] },
  value: scalarValueSchema,
  markerText: { type: ["string", "null"] },
  columns: arraySchema({ type: "string" }),
  rows: arraySchema(instructionRowSchema),
  row: { type: ["number", "null"] },
  col: { type: ["number", "null"] },
  startRow: { type: ["number", "null"] },
});

const cellValueSchema = objectSchema({
  cell: { type: "string" },
  value: scalarValueSchema,
});

export const EXTRACTION_OUTPUT_SCHEMA: StructuredOutputSchema<ExtractionResult> = {
  name: "procurement_extraction",
  schema: objectSchema({
    procurementNumber: { type: "string" },
    procurementName: { type: "string" },
    nmck: { type: "number" },
    deliveryDeadline: { type: "string" },
    deliveryAddresses: arraySchema(deliveryAddressSchema),
    items: arraySchema(extractedItemSchema),
    forms: arraySchema(extractedFormSchema),
  }),
};

export const BID_PACKAGE_ANALYSIS_OUTPUT_SCHEMA: StructuredOutputSchema<BidPackagePlan> = {
  name: "bid_package_analysis",
  schema: objectSchema({
    tenderCard: tenderCardSchema,
    applicationRequirements: arraySchema(applicationRequirementSchema),
    missingItems: arraySchema(missingItemSchema),
    riskNotes: arraySchema(riskNoteSchema),
  }),
};

export const CALCULATION_OUTPUT_SCHEMA: StructuredOutputSchema<CalculationResult> = {
  name: "procurement_calculation_rows",
  schema: objectSchema({
    rows: arraySchema(calculationRowSchema),
  }),
};

export const FORM_MAP_OUTPUT_SCHEMA: StructuredOutputSchema<AiMapping> = {
  name: "form_cell_mapping",
  schema: objectSchema({
    mappings: arraySchema(mappingEntrySchema),
    tables: arraySchema(tableMappingSchema),
    unmapped: arraySchema({ type: "string" }),
    computed: arraySchema(computedFieldSchema),
  }),
};

export const UNRESOLVED_CELLS_OUTPUT_SCHEMA: StructuredOutputSchema<UnresolvedCellsResult> = {
  name: "unresolved_form_cells",
  schema: objectSchema({
    cells: arraySchema(cellValueSchema),
  }),
};

export const FILL_INSTRUCTIONS_OUTPUT_SCHEMA: StructuredOutputSchema<FillInstructionsResult> = {
  name: "form_fill_instructions",
  schema: objectSchema({
    instructions: arraySchema(fillInstructionSchema),
  }),
};

export const CORRECTIONS_OUTPUT_SCHEMA: StructuredOutputSchema<CorrectionsResult> = {
  name: "form_fill_corrections",
  schema: objectSchema({
    corrections: arraySchema(fillInstructionSchema),
  }),
};

export function normalizeFillInstructions(instructions: FillInstruction[]) {
  return instructions
    .map((instruction) => {
      if (instruction.type === "replace") {
        return {
          type: "replace",
          search: instruction.search || "",
          value: instruction.value ?? "",
        };
      }

      if (instruction.type === "cell") {
        return {
          type: "cell",
          row: instruction.row || 0,
          col: instruction.col || 0,
          value: instruction.value ?? "",
        };
      }

      if (instruction.type === "fillRows") {
        return {
          type: "fillRows",
          startRow: instruction.startRow || 0,
          rows: instruction.rows.map((row) => row.values),
        };
      }

      return {
        type: "fillTable",
        markerText: instruction.markerText || "",
        columns: instruction.columns,
        rows: instruction.rows.map((row) => {
          const byColumn: Record<string, ScalarValue> = {};
          for (const cell of row.cells) byColumn[cell.column] = cell.value;
          if (row.cells.length === 0 && row.values.length > 0) {
            instruction.columns.forEach((column, index) => {
              byColumn[column] = row.values[index] ?? "";
            });
          }
          return byColumn;
        }),
      };
    })
    .filter((instruction) => {
      if (instruction.type === "replace") return Boolean(instruction.search);
      if (instruction.type === "cell") return Boolean(instruction.row && instruction.col);
      if (instruction.type === "fillRows") return Boolean(instruction.startRow);
      return Boolean(instruction.markerText);
    });
}
