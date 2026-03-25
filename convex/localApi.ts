import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const clearProcurementData = mutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("extractedItems")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const item of items) await ctx.db.delete(item._id);

    const calc = await ctx.db
      .query("calculationData")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const c of calc) await ctx.db.delete(c._id);

    const genFiles = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const gf of genFiles) {
      try { await ctx.storage.delete(gf.storageId); } catch {}
      await ctx.db.delete(gf._id);
    }

    const forms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const form of forms) {
      try { await ctx.storage.delete(form.storageId); } catch {}
      await ctx.db.delete(form._id);
    }
  },
});

export const clearGeneratedFilesExceptCalculation = mutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const f of files) {
      if (f.formType !== "calculation") {
        try { await ctx.storage.delete(f.storageId); } catch {}
        await ctx.db.delete(f._id);
      }
    }
  },
});

export const saveExtractedItemsBatch = mutation({
  args: {
    items: v.array(
      v.object({
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
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) await ctx.db.insert("extractedItems", item);
  },
});

export const saveExtractedForm = mutation({
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

export const saveCalculationItemsBatch = mutation({
  args: {
    items: v.array(
      v.object({
        procurementId: v.id("procurements"),
        itemIndex: v.number(),
        itemName: v.string(),
        pp1875: v.optional(v.string()),
        quantity: v.number(),
        nmckPrice: v.number(),
        tzSpecs: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) await ctx.db.insert("calculationData", item);
  },
});

export const clearGeneratedFilesByFormTypes = mutation({
  args: {
    procurementId: v.id("procurements"),
    formTypes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const f of files) {
      if (args.formTypes.includes(f.formType)) {
        try { await ctx.storage.delete(f.storageId); } catch {}
        await ctx.db.delete(f._id);
      }
    }
  },
});

export const clearGeneratedFiles = mutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    for (const f of files) {
      try { await ctx.storage.delete(f.storageId); } catch {}
      await ctx.db.delete(f._id);
    }
  },
});
