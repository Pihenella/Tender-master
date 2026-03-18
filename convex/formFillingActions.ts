"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import JSZip from "jszip";
import ExcelJS from "exceljs";

export const applyFillInstructions = internalAction({
  args: {
    procurementId: v.id("procurements"),
    fillResults: v.array(v.object({
      formId: v.id("extractedForms"),
      instructions: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    if (!procurement) throw new Error("Procurement not found");

    await ctx.runMutation(internal.analysisHelpers.clearGeneratedFilesExceptCalculation, {
      procurementId: args.procurementId,
    });

    for (const { formId, instructions: instructionsJson } of args.fillResults) {
      const forms = await ctx.runQuery(api.files.getExtractedForms, {
        procurementId: args.procurementId,
      });
      const form = forms.find((f) => f._id === formId);
      if (!form || !form.url) continue;

      const instructions = JSON.parse(instructionsJson);
      const response = await fetch(form.url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      let filledBuffer: Buffer;
      if (form.fileType === "xlsx") {
        filledBuffer = await applyXlsxInstructions(buffer, instructions);
      } else {
        filledBuffer = await applyDocxInstructions(buffer, instructions);
      }

      const mimeType = form.fileType === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      const blob = new Blob([new Uint8Array(filledBuffer)], { type: mimeType });
      const storageId = await ctx.storage.store(blob);
      const fileName = `Заполн_${form.fileName}`;

      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId,
        fileName,
        formType: form.name,
      });
    }
  },
});

async function applyDocxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No document.xml in DOCX");

  for (const instr of instructions) {
    if (instr.type === "replace" && instr.search && instr.value !== undefined) {
      const searchEscaped = instr.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(searchEscaped, "g");
      docXml = docXml.replace(regex, String(instr.value));
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

async function applyXlsxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet in XLSX");

  for (const instr of instructions) {
    if (instr.type === "cell" && instr.row && instr.col) {
      sheet.getRow(instr.row).getCell(instr.col).value = instr.value;
    } else if (instr.type === "fillRows" && instr.startRow && instr.rows) {
      for (let i = 0; i < instr.rows.length; i++) {
        const row = sheet.getRow(instr.startRow + i);
        const values = instr.rows[i];
        for (let col = 0; col < values.length; col++) {
          row.getCell(col + 1).value = values[col];
        }
      }
    }
  }

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}
