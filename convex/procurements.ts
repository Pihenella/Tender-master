import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

const packagePlanTables = [
  "tenderCards",
  "applicationRequirements",
  "missingItems",
  "riskNotes",
] as const;

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("procurements").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("procurements") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const create = mutation({
  args: {
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("procurements", {
      number: "",
      name: "Новая закупка",
      nmck: 0,
      deliveryDeadline: "",
      deliveryAddresses: [],
      status: "uploaded",
      profileId: args.profileId,
    });
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("procurements"),
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
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.status,
      statusMessage: args.statusMessage,
      progress: args.progress,
    });
  },
});

export const updateFromAnalysis = mutation({
  args: {
    id: v.id("procurements"),
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
  },
  handler: async (ctx, args) => {
    const { id, ...data } = args;
    await ctx.db.patch(id, data);
  },
});

export const remove = mutation({
  args: { id: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("procurementFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const file of files) {
      try { await ctx.storage.delete(file.storageId); } catch {}
      await ctx.db.delete(file._id);
    }

    const items = await ctx.db
      .query("extractedItems")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const item of items) {
      await ctx.db.delete(item._id);
    }

    const extractedForms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const form of extractedForms) {
      try { await ctx.storage.delete(form.storageId); } catch {}
      await ctx.db.delete(form._id);
    }

    const calcData = await ctx.db
      .query("calculationData")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const calc of calcData) {
      await ctx.db.delete(calc._id);
    }

    const genFiles = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const gf of genFiles) {
      try { await ctx.storage.delete(gf.storageId); } catch {}
      await ctx.db.delete(gf._id);
    }

    for (const table of packagePlanTables) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }

    await ctx.db.delete(args.id);
  },
});

export const getBidPackagePlan = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const tenderCards = await ctx.db
      .query("tenderCards")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    const applicationRequirements = await ctx.db
      .query("applicationRequirements")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    const missingItems = await ctx.db
      .query("missingItems")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    const riskNotes = await ctx.db
      .query("riskNotes")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();

    return {
      tenderCard: tenderCards[0] ?? null,
      applicationRequirements: applicationRequirements.sort((a, b) => a.sortOrder - b.sortOrder),
      missingItems: missingItems.sort((a, b) => a.sortOrder - b.sortOrder),
      riskNotes: riskNotes.sort((a, b) => a.sortOrder - b.sortOrder),
    };
  },
});

export const cancelOperation = mutation({
  args: { id: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.db.get(args.id);
    if (!procurement) return;

    if (procurement.status === "analyzing") {
      await ctx.db.patch(args.id, {
        status: "uploaded",
        statusMessage: "Анализ отменён",
        progress: 0,
      });
    } else if (procurement.status === "filling_forms") {
      await ctx.db.patch(args.id, {
        status: "calculation_uploaded",
        statusMessage: "Заполнение форм отменено",
        progress: 0,
      });
    }
  },
});

export const setFillParams = mutation({
  args: {
    id: v.id("procurements"),
    fillProfileId: v.optional(v.string()),
    fillFormIds: v.optional(v.array(v.string())),
    fillEngine: v.optional(v.union(v.literal("v1"), v.literal("v2"))),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      fillProfileId: args.fillProfileId,
      fillFormIds: args.fillFormIds,
      fillEngine: args.fillEngine,
    });
  },
});

export const switchProfile = mutation({
  args: {
    id: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { profileId: args.profileId });
  },
});
