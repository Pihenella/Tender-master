import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = mutation({
  args: {
    procurementId: v.id("procurements"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("procurementFiles", args);
  },
});

export const listByProcurement = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("procurementFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();

    return Promise.all(
      files.map(async (file) => ({
        ...file,
        url: await ctx.storage.getUrl(file.storageId),
      }))
    );
  },
});

export const getExtractedItems = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("extractedItems")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
  },
});

export const getCalculationData = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("calculationData")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
  },
});

export const getGeneratedFiles = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();

    return Promise.all(
      files.map(async (file) => ({
        ...file,
        url: await ctx.storage.getUrl(file.storageId),
      }))
    );
  },
});

export const getFileUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const saveGeneratedFile = mutation({
  args: {
    procurementId: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    storageId: v.id("_storage"),
    fileName: v.string(),
    formType: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("generatedFiles", args);
  },
});

export const getExtractedForms = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const forms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();

    return Promise.all(
      forms.map(async (form) => ({
        ...form,
        url: await ctx.storage.getUrl(form.storageId),
      }))
    );
  },
});
