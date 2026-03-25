"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

// Analysis is now handled by the local processor (scripts/local-processor.mts).
// This action only sets the status to "analyzing" so the local processor picks it up.

export const analyzeDocuments = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: args.procurementId,
    });

    if (files.length === 0) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "uploaded",
        statusMessage: "Нет загруженных файлов",
        progress: 0,
      });
      return;
    }

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "analyzing",
      statusMessage: "Ожидание локального обработчика...",
      progress: 0,
    });
  },
});
