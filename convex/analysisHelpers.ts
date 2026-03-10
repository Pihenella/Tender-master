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
    itemId: v.id("extractedItems"),
    ourSpecs: v.string(),
    ourUnitPrice: v.number(),
    ourTotal: v.number(),
    margin: v.number(),
    otherExpenses: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("calculationData", args);
  },
});
