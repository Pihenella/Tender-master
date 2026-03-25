"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { extractJson } from "./opusApi";

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

      const instructions = extractJson(instructionsJson);
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

function safeReplaceInXmlConvex(docXml: string, search: string, value: string): string {
  const safeValue = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const searchXml = search.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return docXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const textNodes: { start: number; end: number; text: string }[] = [];
    const tRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = tRe.exec(paragraph)) !== null) {
      textNodes.push({ start: m.index + m[0].indexOf(">") + 1, end: m.index + m[0].lastIndexOf("<"), text: m[1] });
    }
    if (textNodes.length === 0) return paragraph;

    const concatenated = textNodes.map(n => n.text).join("");
    const useXml = concatenated.indexOf(searchXml) !== -1;
    const needle = useXml ? searchXml : search;

    const matches: number[] = [];
    let sf = 0;
    while (true) { const idx = concatenated.indexOf(needle, sf); if (idx === -1) break; matches.push(idx); sf = idx + needle.length; }
    if (matches.length === 0) return paragraph;

    const newNodeTexts: string[] = textNodes.map(n => n.text);
    for (let mi = matches.length - 1; mi >= 0; mi--) {
      const matchStart = matches[mi], matchEnd = matchStart + needle.length;
      let charPos = 0, placed = false;
      for (let ni = 0; ni < textNodes.length; ni++) {
        const nodeStart = charPos, nodeEnd = charPos + textNodes[ni].text.length;
        if (nodeEnd > matchStart && nodeStart < matchEnd) {
          const cutStart = Math.max(0, matchStart - nodeStart);
          const cutEnd = Math.min(newNodeTexts[ni].length, matchEnd - nodeStart);
          const before = newNodeTexts[ni].substring(0, cutStart), after = newNodeTexts[ni].substring(cutEnd);
          newNodeTexts[ni] = !placed ? before + safeValue + after : before + after;
          if (!placed) placed = true;
        }
        charPos = nodeEnd;
      }
    }

    let result = paragraph, offset = 0;
    for (let i = 0; i < textNodes.length; i++) {
      if (newNodeTexts[i] !== textNodes[i].text) {
        const origStart = textNodes[i].start + offset, origEnd = textNodes[i].end + offset;
        result = result.substring(0, origStart) + newNodeTexts[i] + result.substring(origEnd);
        offset += newNodeTexts[i].length - textNodes[i].text.length;
      }
    }
    return result;
  });
}

async function applyDocxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No document.xml in DOCX");

  for (const instr of instructions) {
    if (instr.type === "replace" && instr.search && instr.value !== undefined) {
      docXml = safeReplaceInXmlConvex(docXml, instr.search, String(instr.value));
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
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
