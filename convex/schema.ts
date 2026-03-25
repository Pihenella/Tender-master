import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
  }).index("by_procurement", ["procurementId"]),
});
