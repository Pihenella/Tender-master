"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

export const fillForms = action({
  args: {
    procurementId: v.id("procurements"),
    profileId: v.optional(v.string()),
    formIds: v.optional(v.array(v.string())),
    fillEngine: v.optional(v.union(v.literal("v1"), v.literal("v2"))),
  },
  handler: async (ctx, args) => {
    const extractedForms = await ctx.runQuery(api.files.getExtractedForms, {
      procurementId: args.procurementId,
    });

    if (extractedForms.length === 0) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: "Нет извлечённых форм для заполнения",
        progress: 0,
      });
      return;
    }

    // Store params for local processor to pick up
    await ctx.runMutation(api.procurements.setFillParams, {
      id: args.procurementId,
      fillProfileId: args.profileId,
      fillFormIds: args.formIds,
      fillEngine: args.fillEngine,
    });

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "filling_forms",
      statusMessage: "Ожидание обработчика...",
      progress: 0,
    });
  },
});
