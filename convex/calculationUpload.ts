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

    // Get existing calculation data to update with user-filled columns
    const existingCalcData = await ctx.runQuery(api.files.getCalculationData, {
      procurementId: args.procurementId,
    });

    // Clear old calc data and re-save with user values
    await ctx.runMutation(internal.analysisHelpers.clearCalculationData, {
      procurementId: args.procurementId,
    });

    // Collect rows first (eachRow callback is synchronous)
    const rowsToProcess: Array<{ rowNumber: number; row: ExcelJS.Row }> = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) rowsToProcess.push({ rowNumber, row });
    });

    for (const { rowNumber, row } of rowsToProcess) {
      const itemIndex = rowNumber - 2; // 0-based

      // Find matching existing record
      const existing = existingCalcData.find(
        (d) => d.itemIndex === itemIndex
      );
      if (!existing) continue;

      // Read user-filled columns (handle formulas: {formula, result})
      const cellValue = (cell: ExcelJS.Cell): string | number | null => {
        const v = cell.value;
        if (v === null || v === undefined) return null;
        if (typeof v === "object" && "result" in (v as any)) return (v as any).result;
        return v as string | number;
      };
      const ourSpecs = String(cellValue(row.getCell(8)) || "") || undefined; // H
      const ourUnitPrice = Number(cellValue(row.getCell(9))) || undefined;   // I
      const ourTotal = Number(cellValue(row.getCell(10))) || undefined;      // J
      const notes = String(cellValue(row.getCell(12)) || "") || undefined;   // L

      await ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
        procurementId: args.procurementId,
        itemIndex,
        itemName: existing.itemName,
        unit: existing.unit,
        pp1875: existing.pp1875,
        quantity: existing.quantity,
        nmckPrice: existing.nmckPrice,
        tzSpecs: existing.tzSpecs,
        ourSpecs,
        ourUnitPrice,
        ourTotal,
        notes,
      });
    }

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "calculation_uploaded",
      statusMessage: "Калькуляция загружена",
    });
  },
});
