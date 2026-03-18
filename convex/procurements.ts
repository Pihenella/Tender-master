import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

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
      v.literal("error"),
      v.literal("pending_local_analysis"),
      v.literal("pending_local_fill")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      status: args.status,
      statusMessage: args.statusMessage,
      progress: args.progress,
    };
    const localStatuses = ["pending_local_analysis", "pending_local_fill", "analyzing", "filling_forms"];
    if (localStatuses.includes(args.status)) {
      const proc = await ctx.db.get(args.id);
      if (proc?.processingMode === "local") {
        patch.localStatusUpdatedAt = Date.now();
      }
    }
    await ctx.db.patch(args.id, patch);
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
      await ctx.storage.delete(file.storageId);
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
      await ctx.storage.delete(form.storageId);
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
      await ctx.storage.delete(gf.storageId);
      await ctx.db.delete(gf._id);
    }

    await ctx.db.delete(args.id);
  },
});

export const cancelOperation = mutation({
  args: { id: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.db.get(args.id);
    if (!procurement) return;

    if (procurement.status === "analyzing" || procurement.status === "pending_local_analysis") {
      await ctx.db.patch(args.id, {
        status: "uploaded",
        statusMessage: "Анализ отменён",
        progress: 0,
      });
    } else if (procurement.status === "filling_forms" || procurement.status === "pending_local_fill") {
      await ctx.db.patch(args.id, {
        status: "calculation_uploaded",
        statusMessage: "Заполнение форм отменено",
        progress: 0,
      });
    }
  },
});

export const getPendingLocalTasks = query({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("procurements")
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "pending_local_analysis"),
          q.eq(q.field("status"), "pending_local_fill")
        )
      )
      .collect();
    return pending;
  },
});

export const setProcessingMode = mutation({
  args: {
    id: v.id("procurements"),
    processingMode: v.union(v.literal("cloud"), v.literal("local")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { processingMode: args.processingMode });
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
