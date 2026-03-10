"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import ExcelJS from "exceljs";

export const parseCalculation = action({
  args: {
    procurementId: v.id("procurements"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const url = await ctx.runQuery(api.files.getFileUrl, {
      storageId: args.storageId,
    });
    if (!url) throw new Error("File not found");

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    const sheet = workbook.getWorksheet("Калькуляция");
    if (!sheet) throw new Error("Sheet 'Калькуляция' not found");

    const items = await ctx.runQuery(api.files.getExtractedItems, {
      procurementId: args.procurementId,
    });

    // Clear old calculation data
    await ctx.runMutation(internal.analysisHelpers.clearCalculationData, {
      procurementId: args.procurementId,
    });

    // Parse rows (skip header at row 1)
    const rows: Array<{
      itemId: any;
      ourSpecs: string;
      ourUnitPrice: number;
      quantity: number;
      nmckPrice: number;
    }> = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 1) return;
      const itemIndex = rowNumber - 2;
      if (itemIndex >= items.length) return;

      const item = items[itemIndex];
      const ourSpecs = String(row.getCell(8).value || "");
      const ourPrice = Number(row.getCell(9).value) || 0;
      const otherExpenses = Number(row.getCell(13).value) || 0;

      rows.push({
        itemId: item._id,
        ourSpecs,
        ourUnitPrice: ourPrice,
        quantity: item.quantity,
        nmckPrice: item.nmckPrice,
      });

      if (ourSpecs || ourPrice) {
        ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
          procurementId: args.procurementId,
          itemId: item._id,
          ourSpecs,
          ourUnitPrice: ourPrice,
          ourTotal: ourPrice * item.quantity,
          margin:
            item.nmckPrice > 0
              ? Math.round(
                  ((item.nmckPrice - ourPrice) / item.nmckPrice) * 100
                )
              : 0,
          otherExpenses,
        });
      }
    });

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "calculation_uploaded",
      statusMessage: "Калькуляция загружена",
    });
  },
});
