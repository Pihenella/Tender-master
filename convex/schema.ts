import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const packageSection = v.union(
  v.literal("first_part"),
  v.literal("second_part"),
  v.literal("price_offer"),
  v.literal("required_docs"),
  v.literal("platform_actions")
);

const sourceReference = v.object({
  sourceFile: v.string(),
  locationType: v.union(
    v.literal("block_range"),
    v.literal("page"),
    v.literal("sheet"),
    v.literal("row"),
    v.literal("whole_file"),
    v.literal("unknown")
  ),
  startBlock: v.union(v.number(), v.null()),
  endBlock: v.union(v.number(), v.null()),
  page: v.union(v.number(), v.null()),
  sheetName: v.union(v.string(), v.null()),
  row: v.union(v.number(), v.null()),
  textQuote: v.string(),
});

export default defineSchema({
  procurements: defineTable({
    number: v.string(),
    name: v.string(),
    nmck: v.number(),
    deliveryDeadline: v.string(),
    deliveryAddresses: v.array(
      v.object({
        name: v.string(),
        address: v.string(),
      })
    ),
    status: v.union(
      v.literal("uploaded"),
      v.literal("analyzing"),
      v.literal("analyzed"),
      v.literal("calculation_uploaded"),
      v.literal("filling_forms"),
      v.literal("completed"),
      v.literal("error")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    driveFolderId: v.optional(v.string()),
    // Local processor params
    fillProfileId: v.optional(v.string()),
    fillFormIds: v.optional(v.array(v.string())),
    fillEngine: v.optional(v.union(v.literal("v1"), v.literal("v2"))),
    // Legacy fields
    processingMode: v.optional(v.string()),
    localStatusUpdatedAt: v.optional(v.number()),
    localRetryCount: v.optional(v.number()),
  }),

  procurementFiles: defineTable({
    procurementId: v.id("procurements"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
    driveFileId: v.optional(v.string()),
  }).index("by_procurement", ["procurementId"]),

  extractedItems: defineTable({
    procurementId: v.id("procurements"),
    name: v.string(),
    quantity: v.number(),
    unit: v.string(),
    nmckPrice: v.number(),
    tzSpecs: v.string(),
    quarter: v.string(),
    estimatedWeight: v.number(),
    estimatedDimensions: v.string(),
    deliveryAllocations: v.array(
      v.object({
        address: v.string(),
        quantity: v.number(),
      })
    ),
    deliveryCost: v.number(),
    deliveryCostEstimated: v.boolean(),
  }).index("by_procurement", ["procurementId"]),

  extractedForms: defineTable({
    procurementId: v.id("procurements"),
    name: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    sourceFile: v.string(),
    fileType: v.string(),
    locationType: v.string(),
    sourceCoordinates: v.optional(v.string()),
  }).index("by_procurement", ["procurementId"]),

  calculationData: defineTable({
    procurementId: v.id("procurements"),
    itemIndex: v.number(),
    itemName: v.string(),
    unit: v.optional(v.string()),
    pp1875: v.optional(v.string()),
    quantity: v.number(),
    nmckPrice: v.number(),
    tzSpecs: v.optional(v.string()),
    ourSpecs: v.optional(v.string()),
    ourUnitPrice: v.optional(v.number()),
    ourTotal: v.optional(v.number()),
    notes: v.optional(v.string()),
  }).index("by_procurement", ["procurementId"]),

  generatedFiles: defineTable({
    procurementId: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    storageId: v.id("_storage"),
    fileName: v.string(),
    formType: v.string(),
    packageSection: v.optional(v.union(
      v.literal("source_docs"),
      v.literal("first_part"),
      v.literal("second_part"),
      v.literal("price_offer"),
      v.literal("required_docs"),
      v.literal("root")
    )),
    artifactType: v.optional(v.union(
      v.literal("source"),
      v.literal("filled_form"),
      v.literal("generated_doc"),
      v.literal("memo"),
      v.literal("inventory"),
      v.literal("risk_report"),
      v.literal("package_zip"),
      v.literal("calculation")
    )),
    validationStatus: v.optional(v.union(
      v.literal("not_checked"),
      v.literal("passed"),
      v.literal("risk"),
      v.literal("blocked")
    )),
  }).index("by_procurement", ["procurementId"]),

  tenderCards: defineTable({
    procurementId: v.id("procurements"),
    customerName: v.string(),
    procurementNumber: v.string(),
    subject: v.string(),
    platformName: v.string(),
    platformUrl: v.string(),
    publicationDate: v.string(),
    submissionDeadline: v.string(),
    submissionDeadlineTimezone: v.string(),
    resultDate: v.string(),
    lawRegime: v.union(
      v.literal("44-FZ"),
      v.literal("223-FZ"),
      v.literal("commercial"),
      v.literal("unknown")
    ),
    lots: v.array(v.object({
      number: v.string(),
      name: v.string(),
      nmck: v.union(v.number(), v.null()),
    })),
    nmck: v.union(v.number(), v.null()),
    currency: v.string(),
    paymentTerms: v.string(),
    deliveryPeriod: v.string(),
    guarantees: v.string(),
    applicationSecurity: v.string(),
    contractSecurity: v.string(),
    smpSmeFlag: v.string(),
    evaluationCriteria: v.array(v.string()),
    keyRisks: v.array(v.string()),
  }).index("by_procurement", ["procurementId"]),

  applicationRequirements: defineTable({
    procurementId: v.id("procurements"),
    sortOrder: v.number(),
    section: packageSection,
    requirementText: v.string(),
    requiredDocumentName: v.string(),
    obligation: v.union(
      v.literal("required"),
      v.literal("optional"),
      v.literal("not_applicable"),
      v.literal("unknown")
    ),
    status: v.union(
      v.literal("planned"),
      v.literal("prepared"),
      v.literal("missing"),
      v.literal("not_applicable"),
      v.literal("risk")
    ),
    riskNote: v.string(),
    sourceReferences: v.array(sourceReference),
  }).index("by_procurement", ["procurementId"]),

  missingItems: defineTable({
    procurementId: v.id("procurements"),
    sortOrder: v.number(),
    section: packageSection,
    title: v.string(),
    reason: v.string(),
    blocking: v.boolean(),
    sourceReferences: v.array(sourceReference),
  }).index("by_procurement", ["procurementId"]),

  riskNotes: defineTable({
    procurementId: v.id("procurements"),
    sortOrder: v.number(),
    section: packageSection,
    severity: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("blocking")
    ),
    text: v.string(),
    mitigation: v.string(),
    sourceReferences: v.array(sourceReference),
  }).index("by_procurement", ["procurementId"]),
});
