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
      v.literal("reviewed"),
      v.literal("template_downloaded"),
      v.literal("calculation_uploaded"),
      v.literal("generating"),
      v.literal("completed"),
      v.literal("error")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
  }),

  procurementFiles: defineTable({
    procurementId: v.id("procurements"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
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

  calculationData: defineTable({
    procurementId: v.id("procurements"),
    itemId: v.id("extractedItems"),
    ourSpecs: v.string(),
    ourUnitPrice: v.number(),
    ourTotal: v.number(),
    margin: v.number(),
    otherExpenses: v.number(),
  }).index("by_procurement", ["procurementId"]),

  generatedFiles: defineTable({
    procurementId: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    storageId: v.id("_storage"),
    fileName: v.string(),
    formType: v.union(
      v.literal("form3"),
      v.literal("form6"),
      v.literal("techProposal"),
      v.literal("priceProposal"),
      v.literal("calculation")
    ),
  }).index("by_procurement", ["procurementId"]),
});
