import { mutation } from "./_generated/server";
import { v } from "convex/values";

const packageSection = v.union(
  v.literal("first_part"),
  v.literal("second_part"),
  v.literal("price_offer"),
  v.literal("required_docs"),
  v.literal("platform_actions")
);

const sourceReference = v.object({
  sourceFile: v.string(),
  locationType: v.union(
    v.literal("block_range"),
    v.literal("page"),
    v.literal("sheet"),
    v.literal("row"),
    v.literal("whole_file"),
    v.literal("unknown")
  ),
  startBlock: v.union(v.number(), v.null()),
  endBlock: v.union(v.number(), v.null()),
  page: v.union(v.number(), v.null()),
  sheetName: v.union(v.string(), v.null()),
  row: v.union(v.number(), v.null()),
  textQuote: v.string(),
});

const tenderCard = v.object({
  customerName: v.string(),
  procurementNumber: v.string(),
  subject: v.string(),
  platformName: v.string(),
  platformUrl: v.string(),
  publicationDate: v.string(),
  submissionDeadline: v.string(),
  submissionDeadlineTimezone: v.string(),
  resultDate: v.string(),
  lawRegime: v.union(
    v.literal("44-FZ"),
    v.literal("223-FZ"),
    v.literal("commercial"),
    v.literal("unknown")
  ),
  lots: v.array(v.object({
    number: v.string(),
    name: v.string(),
    nmck: v.union(v.number(), v.null()),
  })),
  nmck: v.union(v.number(), v.null()),
  currency: v.string(),
  paymentTerms: v.string(),
  deliveryPeriod: v.string(),
  guarantees: v.string(),
  applicationSecurity: v.string(),
  contractSecurity: v.string(),
  smpSmeFlag: v.string(),
  evaluationCriteria: v.array(v.string()),
  keyRisks: v.array(v.string()),
});

const applicationRequirement = v.object({
  section: packageSection,
  requirementText: v.string(),
  requiredDocumentName: v.string(),
  obligation: v.union(
    v.literal("required"),
    v.literal("optional"),
    v.literal("not_applicable"),
    v.literal("unknown")
  ),
  status: v.union(
    v.literal("planned"),
    v.literal("prepared"),
    v.literal("missing"),
    v.literal("not_applicable"),
    v.literal("risk")
  ),
  riskNote: v.string(),
  sourceReferences: v.array(sourceReference),
});

const missingItem = v.object({
  section: packageSection,
  title: v.string(),
  reason: v.string(),
  blocking: v.boolean(),
  sourceReferences: v.array(sourceReference),
});

const riskNote = v.object({
  section: packageSection,
  severity: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
    v.literal("blocking")
  ),
  text: v.string(),
  mitigation: v.string(),
  sourceReferences: v.array(sourceReference),
});

const packagePlanTables = [
  "tenderCards",
  "applicationRequirements",
  "missingItems",
  "riskNotes",
] as const;

export const clearProcurementData = mutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    for (const table of packagePlanTables) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }

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

export const clearBidPackagePlan = mutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    for (const table of packagePlanTables) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
  },
});

export const saveBidPackagePlan = mutation({
  args: {
    procurementId: v.id("procurements"),
    tenderCard,
    applicationRequirements: v.array(applicationRequirement),
    missingItems: v.array(missingItem),
    riskNotes: v.array(riskNote),
  },
  handler: async (ctx, args) => {
    for (const table of packagePlanTables) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }

    await ctx.db.insert("tenderCards", {
      procurementId: args.procurementId,
      ...args.tenderCard,
    });

    for (let index = 0; index < args.applicationRequirements.length; index++) {
      await ctx.db.insert("applicationRequirements", {
        procurementId: args.procurementId,
        sortOrder: index,
        ...args.applicationRequirements[index],
      });
    }

    for (let index = 0; index < args.missingItems.length; index++) {
      await ctx.db.insert("missingItems", {
        procurementId: args.procurementId,
        sortOrder: index,
        ...args.missingItems[index],
      });
    }

    for (let index = 0; index < args.riskNotes.length; index++) {
      await ctx.db.insert("riskNotes", {
        procurementId: args.procurementId,
        sortOrder: index,
        ...args.riskNotes[index],
      });
    }
  },
});

export const appendRiskNotesBatch = mutation({
  args: {
    procurementId: v.id("procurements"),
    risks: v.array(riskNote),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("riskNotes")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();
    const keys = new Set(existing.map((risk) => `${risk.section}|${risk.severity}|${risk.text}`));
    let sortOrder = existing.length;
    for (const risk of args.risks) {
      const key = `${risk.section}|${risk.severity}|${risk.text}`;
      if (keys.has(key)) continue;
      keys.add(key);
      await ctx.db.insert("riskNotes", {
        procurementId: args.procurementId,
        sortOrder,
        ...risk,
      });
      sortOrder++;
    }
  },
});

export const updateRequirementStatusesBatch = mutation({
  args: {
    procurementId: v.id("procurements"),
    updates: v.array(v.object({
      section: packageSection,
      requiredDocumentName: v.string(),
      status: v.union(
        v.literal("planned"),
        v.literal("prepared"),
        v.literal("missing"),
        v.literal("not_applicable"),
        v.literal("risk")
      ),
      riskNote: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const requirements = await ctx.db
      .query("applicationRequirements")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.procurementId))
      .collect();

    for (const update of args.updates) {
      const row = requirements.find((requirement) =>
        requirement.section === update.section &&
        requirement.requiredDocumentName.toLowerCase() === update.requiredDocumentName.toLowerCase()
      );
      if (!row) continue;
      await ctx.db.patch(row._id, {
        status: update.status,
        riskNote: update.riskNote ?? row.riskNote,
      });
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
        unit: v.optional(v.string()),
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
