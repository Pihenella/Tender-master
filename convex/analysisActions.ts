"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { sliceDocx, sliceXlsxSheet } from "./docxSlicer";

export const sliceForms = internalAction({
  args: {
    procurementId: v.id("procurements"),
    forms: v.array(v.object({
      name: v.string(),
      sourceFile: v.string(),
      locationType: v.string(),
      startBlock: v.optional(v.number()),
      endBlock: v.optional(v.number()),
      sheetName: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const files = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: args.procurementId,
    });

    const fileBufferMap = new Map<string, { buffer: Buffer; storageId: any }>();
    for (const file of files) {
      if (!file.url) continue;
      const response = await fetch(file.url);
      const arrayBuffer = await response.arrayBuffer();
      fileBufferMap.set(file.fileName, {
        buffer: Buffer.from(arrayBuffer),
        storageId: file.storageId,
      });
    }

    await ctx.runMutation(internal.analysisHelpers.clearExtractedForms, {
      procurementId: args.procurementId,
    });

    for (const form of args.forms) {
      const locationType = form.locationType || "whole_file";
      const fileData = fileBufferMap.get(form.sourceFile);

      if (locationType === "whole_file" && fileData) {
        await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
          procurementId: args.procurementId,
          name: form.name,
          storageId: fileData.storageId,
          fileName: form.sourceFile,
          sourceFile: form.sourceFile,
          fileType: form.sourceFile.split(".").pop()?.toLowerCase() || "docx",
          locationType: "whole_file",
        });
      } else if (locationType === "paragraph_range" && fileData) {
        const startBlock = form.startBlock || 1;
        const endBlock = form.endBlock || startBlock;
        try {
          const slicedBuffer = await sliceDocx(fileData.buffer, startBlock, endBlock);
          const blob = new Blob([new Uint8Array(slicedBuffer)], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          const storageId = await ctx.storage.store(blob);
          const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.docx`;
          await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
            procurementId: args.procurementId,
            name: form.name,
            storageId,
            fileName,
            sourceFile: form.sourceFile,
            fileType: "docx",
            locationType: "paragraph_range",
            sourceCoordinates: JSON.stringify({ startBlock, endBlock }),
          });
        } catch (e: any) {
          console.error(`Failed to slice form "${form.name}": ${e.message}`);
        }
      } else if (locationType === "sheet" && fileData && form.sheetName) {
        try {
          const slicedBuffer = await sliceXlsxSheet(fileData.buffer, form.sheetName);
          const blob = new Blob([new Uint8Array(slicedBuffer)], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          });
          const storageId = await ctx.storage.store(blob);
          const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.xlsx`;
          await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
            procurementId: args.procurementId,
            name: form.name,
            storageId,
            fileName,
            sourceFile: form.sourceFile,
            fileType: "xlsx",
            locationType: "sheet",
            sourceCoordinates: JSON.stringify({ sheetName: form.sheetName }),
          });
        } catch (e: any) {
          console.error(`Failed to slice sheet "${form.name}": ${e.message}`);
        }
      }
    }
  },
});

export const generateCalcExcel = internalAction({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    const calcData = await ctx.runQuery(api.files.getCalculationData, {
      procurementId: args.procurementId,
    });

    if (!calcData || calcData.length === 0) {
      console.warn("No calculation data found for", args.procurementId, "— skipping Excel generation");
      return;
    }

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Калькуляция");

    const headers = [
      "№ п/п",
      "Наименование",
      "1875 ПП (запрет/ограничение/преимущество)",
      "Количество",
      "НМЦК за ед.\n(заказчика)",
      "НМЦК общ.\n(заказчика)",
      "Характеристики ТЗ\n(заказчика)",
      "НАШИ ХАРАКТЕРИСТИКИ\n(нашего товара)",
      "Наша цена за Единицу",
      "Наша Сумма",
      "Ссылка На товар",
      "Примечание\n(Наименование товара\n/артикул/комментарий)",
    ];

    sheet.columns = headers.map((h, i) => ({
      header: h,
      width: [6, 40, 15, 12, 14, 14, 40, 40, 16, 14, 20, 30][i] || 15,
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9E1F2" },
    };
    headerRow.alignment = { wrapText: true, vertical: "middle" };

    const sorted = [...calcData].sort((a, b) => a.itemIndex - b.itemIndex);

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const rowNum = i + 2;
      const row = sheet.addRow([
        i + 1,
        item.itemName,
        item.pp1875 || "",
        item.quantity,
        item.nmckPrice,
        null,
        item.tzSpecs || "",
        "",
        null,
        null,
        "",
        "",
      ]);
      row.getCell(6).value = { formula: `D${rowNum}*E${rowNum}` } as any;
      row.getCell(10).value = { formula: `D${rowNum}*I${rowNum}` } as any;
      [8, 9, 12].forEach((col) => {
        row.getCell(col).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF2CC" },
        };
      });
    }

    const lastDataRow = sorted.length + 1;
    const totalsRow = sheet.addRow([
      "", "ИТОГО", "", "", "",
      { formula: `SUM(F2:F${lastDataRow})` },
      "", "", "",
      { formula: `SUM(J2:J${lastDataRow})` },
    ]);
    totalsRow.font = { bold: true };

    await ctx.runMutation(internal.analysisHelpers.clearGeneratedFiles, {
      procurementId: args.procurementId,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const calcStorageId = await ctx.storage.store(blob);

    await ctx.runMutation(api.files.saveGeneratedFile, {
      procurementId: args.procurementId,
      profileId: procurement?.profileId || "pikhenek",
      storageId: calcStorageId,
      fileName: `Калькуляция_${procurement?.number || "draft"}.xlsx`,
      formType: "calculation",
    });
  },
});
