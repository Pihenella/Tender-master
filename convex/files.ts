import { v } from "convex/values";
import { query, mutation, action } from "./_generated/server";
import { api } from "./_generated/api";
import { findOrCreateFolder, uploadFile } from "./googleDrive";

function safeDriveFolderName(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function procurementFolderName(procurement: {
  number?: string;
  name?: string;
  _id: string;
}) {
  const parts = [procurement.number, procurement.name]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return safeDriveFolderName(parts.join(" - ")) || `Закупка ${procurement._id.slice(-6)}`;
}

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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("generatedFiles", args);
  },
});

export const updateDriveFileId = mutation({
  args: {
    fileId: v.id("procurementFiles"),
    driveFileId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.fileId, { driveFileId: args.driveFileId });
  },
});

export const updateDriveFolderId = mutation({
  args: {
    procurementId: v.id("procurements"),
    driveFolderId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.procurementId, {
      driveFolderId: args.driveFolderId,
    });
  },
});

export const uploadToDrive = action({
  args: {
    procurementId: v.id("procurements"),
    fileId: v.id("procurementFiles"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
  },
  handler: async (ctx, args) => {
    const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID not set");

    // Get or create procurement folder on Google Drive
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    if (!procurement) throw new Error("Procurement not found");

    let folderId = procurement.driveFolderId;
    if (!folderId) {
      const folderName = procurementFolderName(procurement);
      folderId = await findOrCreateFolder(folderName, rootFolderId);
      await ctx.runMutation(api.files.updateDriveFolderId, {
        procurementId: args.procurementId,
        driveFolderId: folderId,
      });
    }

    // Download file from Convex storage
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) throw new Error("File not found in storage");
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Upload to Google Drive
    const driveFileId = await uploadFile(
      args.fileName,
      buffer,
      args.fileType || "application/octet-stream",
      folderId
    );

    // Save Drive file ID
    await ctx.runMutation(api.files.updateDriveFileId, {
      fileId: args.fileId,
      driveFileId,
    });

    return driveFileId;
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
