import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const saveExtractedItem = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("extractedItems", args);
  },
});

export const deleteExtractedItem = internalMutation({
  args: { id: v.id("extractedItems") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const updateItemDelivery = internalMutation({
  args: {
    id: v.id("extractedItems"),
    deliveryCost: v.number(),
    deliveryCostEstimated: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      deliveryCost: args.deliveryCost,
      deliveryCostEstimated: args.deliveryCostEstimated,
    });
  },
});

export const clearProcurementData = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("extractedItems")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const item of items) await ctx.db.delete(item._id);

    const calcData = await ctx.db
      .query("calculationData")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const calc of calcData) await ctx.db.delete(calc._id);

    const genFiles = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const gf of genFiles) {
      await ctx.storage.delete(gf.storageId);
      await ctx.db.delete(gf._id);
    }

    const extractedForms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const form of extractedForms) {
      await ctx.storage.delete(form.storageId);
      await ctx.db.delete(form._id);
    }
  },
});

export const clearGeneratedFiles = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const f of files) {
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
  },
});

export const clearCalculationData = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const data = await ctx.db
      .query("calculationData")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const d of data) await ctx.db.delete(d._id);
  },
});

export const saveCalculationItem = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("calculationData", args);
  },
});

export const saveExtractedForm = internalMutation({
  args: {
    procurementId: v.id("procurements"),
    name: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    sourceFile: v.string(),
    fileType: v.string(),
    locationType: v.string(),
    sourceCoordinates: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("extractedForms", args);
  },
});

export const clearExtractedForms = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const forms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const form of forms) {
      await ctx.storage.delete(form.storageId);
      await ctx.db.delete(form._id);
    }
  },
});

export const saveExtractedItemsBatch = internalMutation({
  args: {
    items: v.array(v.object({
      procurementId: v.id("procurements"),
      name: v.string(),
      quantity: v.number(),
      unit: v.string(),
      nmckPrice: v.number(),
      tzSpecs: v.string(),
      quarter: v.string(),
      estimatedWeight: v.number(),
      estimatedDimensions: v.string(),
      deliveryAllocations: v.array(v.object({ address: v.string(), quantity: v.number() })),
      deliveryCost: v.number(),
      deliveryCostEstimated: v.boolean(),
    })),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) {
      await ctx.db.insert("extractedItems", item);
    }
  },
});

export const saveCalculationItemsBatch = internalMutation({
  args: {
    items: v.array(v.object({
      procurementId: v.id("procurements"),
      itemIndex: v.number(),
      itemName: v.string(),
      pp1875: v.optional(v.string()),
      quantity: v.number(),
      nmckPrice: v.number(),
      tzSpecs: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) {
      await ctx.db.insert("calculationData", item);
    }
  },
});

export const clearGeneratedFilesExceptCalculation = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const f of files) {
      if (f.formType !== "calculation") {
        await ctx.storage.delete(f.storageId);
        await ctx.db.delete(f._id);
      }
    }
  },
});
