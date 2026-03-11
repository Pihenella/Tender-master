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
      v.literal("reviewed"),
      v.literal("template_downloaded"),
      v.literal("calculation_uploaded"),
      v.literal("generating"),
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
    await ctx.db.patch(id, { ...data, status: "analyzed" });
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

export const switchProfile = mutation({
  args: {
    id: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { profileId: args.profileId });
  },
});
