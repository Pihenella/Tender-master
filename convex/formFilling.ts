"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { callOpus, extractJson } from "./opusApi";
import { parseFile } from "../src/lib/parsers";
import { profiles } from "../src/lib/profiles";
import JSZip from "jszip";
import ExcelJS from "exceljs";

// --- Prompts ---

const FORM_ANALYSIS_PROMPT = `You are an expert at filling Russian procurement (тендер/закупка) forms for ИП participants.

You will receive:
1. The text content of a form that needs to be filled
2. Calculation data with OUR prices (not NMCK!) for each item
3. Complete company profile (all requisites, passport, bank, registration, ownership chain)
4. Procurement metadata (number, name, deadline, addresses)
5. Pricing summary with our total price, НДС amount and rate

CRITICAL RULES:
- "Итоговая стоимость заявки" = pricing.ourTotalPrice (OUR price from calculation), NEVER use НМЦК!
- НДС is calculated from our total price: pricing.ndsAmount at pricing.ndsRate%
- Use profile data EXACTLY as provided — do not reformat addresses, names, or numbers
- For ИП: КПП is empty (ИП не имеет КПП), leave blank or write "нет"
- Where "(Наименование Участника)" placeholder appears, replace with profile.shortName
- Where full name is needed, use profile.fullName
- Where signature line says "(подпись уполномоченного представителя)", leave as-is (physical signature)
- Where it says "(фамилия, имя, отчество подписавшего, должность)", replace with director.fio

FORM-SPECIFIC RULES:

**ФОРМА 1 (Письмо о подаче оферты):**
- Fill: date, addressee (from procurement docs), participant name, address, procurement subject
- "Итоговая стоимость заявки, с НДС, руб." = pricing.ourTotalPrice
- "в том числе НДС, руб." = pricing.ndsAmount, "размер ставки НДС, в %" = pricing.ndsRate
- Replace all "(Наименование Участника)" with shortName
- Fill the document list table at the end

**ФОРМА 2 (Анкета участника):**
- Fill ALL numbered rows with profile data
- Row 1: fullName, Row 2: shortName, Row 3: okved, Row 6: ogrn, Row 8: inn
- Row 10-12: addresses, Row 14: full bank details, Row 15: phone, Row 17: email
- Rows marked * are optional for ИП

**ФОРМА ТЕХНИЧЕСКОЕ ПРЕДЛОЖЕНИЕ:**
- Header: fullName + passport data (series, number, issueDate, departmentCode, issuedBy, address)
- Table: for each ТЗ requirement number, put "да" in Выполнение column, "-" in Пояснения

**Согласие на обработку персональных данных:**
- Fill: date, fullName, address, registration (ogrnRecord + ogrnDate), inn, ogrn
- "в лице" section: director.fio + address + passport (series number issueDate issuedBy)
- "действующего на основании": registration data

**Справка о цепочке собственников:**
- Use ownershipChain data from profile
- Fill table: inn, ogrn, shortName, okved, director fio, passport, then chain details

INSTRUCTION TYPES:

For DOCX forms, return:
{
  "instructions": [
    {"type": "replace", "search": "exact placeholder text from document", "value": "filled value"},
    {"type": "fillTable", "markerText": "unique text from table header like '№ п/п' or '№ п.п. ТЗ'", "columns": ["col1","col2","col3","col4"], "rows": [{"col1":"1","col2":"1","col3":"да","col4":"-"}, ...]}
  ],
  "formType": "brief description"
}

For XLSX forms, return:
{
  "instructions": [
    {"type": "cell", "row": 5, "col": 3, "value": "filled value"},
    {"type": "fillRows", "startRow": 3, "rows": [[1, "Item name", 10, "шт", 100.50], ...]}
  ],
  "formType": "brief description"
}

CRITICAL INSTRUCTIONS:
- Use "replace" for simple text substitutions — search string must match EXACTLY what appears in the document
- Use "fillTable" when a DOCX table has few template rows but needs many data rows (e.g., ТЗ table with 5 example rows but 100+ actual items). The system will CLONE the template row and fill ALL items automatically.
- Use "fillRows" for XLSX tables — specify startRow and provide ALL row data
- ALWAYS fill ALL placeholders — never leave brackets like [Указать], underscores ___, or template hints
- ALWAYS generate rows for ALL items from the calculation data, not just the first few
- Do NOT invent data — only use what's provided
- Return ONLY valid JSON`;

const SELF_CHECK_PROMPT = `You previously filled a procurement form. Now verify your work.

Compare the filled form against the source data and check:
1. All fields that should be filled ARE filled
2. Numbers (prices, quantities, totals) match the source data exactly
3. Company details (name, INN, OGRN, address, bank details) are correct
4. No data was invented or hallucinated

Return JSON:
{
  "corrections": [
    {"type": "replace", "search": "wrong value", "value": "correct value"}
  ],
  "confidence": [
    {"field": "field name", "value": "filled value", "confidence": "high|medium|low", "note": "optional explanation"}
  ],
  "warnings": ["list of issues or missing data"]
}

If no corrections needed, return empty corrections array.
Return ONLY valid JSON`;

// Helper: build context data for Sonnet from procurement + calculation + profile
async function buildContextData(ctx: any, procurementId: any) {
  const procurement = await ctx.runQuery(api.procurements.get, { id: procurementId });
  if (!procurement) throw new Error("Procurement not found");

  const calcData = await ctx.runQuery(api.files.getCalculationData, { procurementId });
  const profile = profiles[procurement.profileId];
  if (!profile) throw new Error(`Profile ${procurement.profileId} not found`);

  const ourTotalPrice = calcData.reduce((sum: number, d: any) => sum + (d.ourTotal || 0), 0);
  const ndsRate = profile.tax.ndsRate;
  const ndsAmount = Math.round((ourTotalPrice * ndsRate / (100 + ndsRate)) * 100) / 100;

  return {
    procurement,
    contextData: {
      procurement: {
        number: procurement.number,
        name: procurement.name,
        nmck: procurement.nmck,
        deliveryDeadline: procurement.deliveryDeadline,
        deliveryAddresses: procurement.deliveryAddresses,
      },
      pricing: {
        ourTotalPrice,
        ndsRate,
        ndsAmount,
        ndsLabel: profile.tax.ndsLabel,
        note: "ВАЖНО: итоговая стоимость заявки = ourTotalPrice (НАША цена), НЕ НМЦК!",
      },
      profile: {
        fullName: profile.fullName,
        shortName: profile.shortName,
        inn: profile.inn,
        ogrn: profile.ogrn,
        okpo: profile.okpo,
        kpp: profile.kpp || "нет (ИП)",
        oktmo: profile.oktmo,
        okved: profile.okved,
        legalAddress: profile.legalAddress,
        mailingAddress: profile.mailingAddress,
        actualAddress: profile.actualAddress,
        bank: profile.bank,
        director: profile.director,
        passport: profile.passport,
        registration: profile.registration,
        tax: profile.tax,
        ownershipChain: profile.ownershipChain,
      },
      items: calcData.map((d: any) => ({
        name: d.itemName,
        quantity: d.quantity,
        nmckPrice: d.nmckPrice,
        ourSpecs: d.ourSpecs,
        ourUnitPrice: d.ourUnitPrice,
        ourTotal: d.ourTotal,
        notes: d.notes,
        tzSpecs: d.tzSpecs,
      })),
    },
  };
}

// ========== Public action: orchestrator ==========
export const fillForms = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "filling_forms",
        statusMessage: "Подготовка к заполнению форм...",
        progress: 0,
      });

      const extractedForms = await ctx.runQuery(api.files.getExtractedForms, {
        procurementId: args.procurementId,
      });

      if (extractedForms.length === 0) {
        throw new Error("Нет извлечённых форм для заполнения");
      }

      // Clear old generated files (except calculation)
      await ctx.runMutation(
        internal.analysisHelpers.clearGeneratedFilesExceptCalculation,
        { procurementId: args.procurementId }
      );

      // Schedule first form processing — each form runs as a separate action
      // to avoid the 10-minute Convex action timeout
      await ctx.scheduler.runAfter(0, internal.formFilling.fillSingleForm, {
        procurementId: args.procurementId,
        formIndex: 0,
        totalForms: extractedForms.length,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: `Ошибка заполнения форм: ${error.message}`,
        progress: 0,
      });
    }
  },
});

// ========== Internal action: process one form, then schedule next ==========
export const fillSingleForm = internalAction({
  args: {
    procurementId: v.id("procurements"),
    formIndex: v.number(),
    totalForms: v.number(),
  },
  handler: async (ctx, args) => {
    const { procurementId, formIndex, totalForms } = args;

    const updateProgress = async (msg: string, progress: number) => {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: procurementId,
        status: "filling_forms",
        statusMessage: msg,
        progress,
      });
    };

    try {
      // Check if operation was cancelled before processing
      const currentStatus = await ctx.runQuery(api.procurements.get, { id: procurementId });
      if (!currentStatus || currentStatus.status !== "filling_forms") return;

      const { procurement, contextData } = await buildContextData(ctx, procurementId);

      const extractedForms = await ctx.runQuery(api.files.getExtractedForms, {
        procurementId,
      });
      const form = extractedForms[formIndex];
      if (!form) {
        // No more forms — finalize
        await ctx.scheduler.runAfter(0, internal.formFilling.finalizeFillForms, {
          procurementId,
          totalForms,
        });
        return;
      }

      const formProgress = Math.round((formIndex / totalForms) * 80);
      await updateProgress(
        `Заполнение формы ${formIndex + 1}/${totalForms}: ${form.name}`,
        formProgress
      );

      if (!form.url) {
        // Skip form without URL, schedule next
        await ctx.scheduler.runAfter(0, internal.formFilling.fillSingleForm, {
          procurementId,
          formIndex: formIndex + 1,
          totalForms,
        });
        return;
      }

      // Fetch form file
      const formResponse = await fetch(form.url);
      const formArrayBuffer = await formResponse.arrayBuffer();
      let formBuffer: Buffer = Buffer.from(formArrayBuffer);

      // Parse form content for Sonnet
      const formText = await parseFile(
        formBuffer,
        form.fileType === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        form.fileName
      );

      // Get fill instructions from Opus
      const fillResult = await callOpus(
        FORM_ANALYSIS_PROMPT,
        `Форма для заполнения: "${form.name}"\n\nТекст формы:\n${formText}\n\nДанные для заполнения:\n${JSON.stringify(contextData, null, 2)}`
      );

      const fillData = extractJson(fillResult);
      const instructions = fillData.instructions || [];

      // Apply instructions
      if (form.fileType === "docx") {
        formBuffer = await applyDocxInstructions(formBuffer, instructions);
      } else if (form.fileType === "xlsx") {
        formBuffer = await applyXlsxInstructions(formBuffer, instructions);
      }

      // Self-check (1 iteration to save time)
      const filledText = await parseFile(
        formBuffer,
        form.fileType === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        form.fileName
      );

      const checkResult = await callOpus(
        SELF_CHECK_PROMPT,
        `Исходные данные:\n${JSON.stringify(contextData, null, 2)}\n\nЗаполненная форма "${form.name}":\n${filledText}`
      );

      const checkData = extractJson(checkResult);
      const corrections = checkData.corrections || [];
      if (corrections.length > 0) {
        if (form.fileType === "docx") {
          formBuffer = await applyDocxInstructions(formBuffer, corrections);
        } else if (form.fileType === "xlsx") {
          formBuffer = await applyXlsxInstructions(formBuffer, corrections);
        }
      }

      // Save filled form
      const mimeType =
        form.fileType === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      const blob = new Blob([new Uint8Array(formBuffer)], { type: mimeType });
      const storageId = await ctx.storage.store(blob);

      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId,
        profileId: procurement.profileId,
        storageId,
        fileName: `Заполнено_${form.fileName}`,
        formType: form.name,
      });

      // Schedule next form or finalize
      if (formIndex + 1 < totalForms) {
        await ctx.scheduler.runAfter(0, internal.formFilling.fillSingleForm, {
          procurementId,
          formIndex: formIndex + 1,
          totalForms,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.formFilling.finalizeFillForms, {
          procurementId,
          totalForms,
        });
      }
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: procurementId,
        status: "calculation_uploaded",
        statusMessage: `Ошибка заполнения формы ${formIndex + 1}/${totalForms}: ${error.message}`,
        progress: 0,
      });
    }
  },
});

// ========== Internal action: finalize after all forms filled ==========
export const finalizeFillForms = internalAction({
  args: {
    procurementId: v.id("procurements"),
    totalForms: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "filling_forms",
        statusMessage: "Сохранение отчёта проверки...",
        progress: 90,
      });

      // Done
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "completed",
        statusMessage: `Заполнено ${args.totalForms} форм`,
        progress: 100,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: `Ошибка финализации: ${error.message}`,
        progress: 0,
      });
    }
  },
});

// --- Helpers to apply fill instructions ---

/**
 * Merges adjacent <w:r> runs with identical formatting within each <w:p>.
 * This prevents search failures caused by Word splitting text across runs.
 */
function mergeDocxRuns(xml: string): string {
  // Process each paragraph
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    // Find sequences of <w:r> elements
    return paragraph.replace(
      /(<w:r\b[^>]*>[\s\S]*?<\/w:r>)(\s*<w:r\b[^>]*>[\s\S]*?<\/w:r>)+/g,
      (runSequence) => {
        // Extract individual runs
        const runs = [...runSequence.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)];
        if (runs.length <= 1) return runSequence;

        // Extract run properties (rPr) and text from each run
        const parsed = runs.map((r) => {
          const rPr = r[1].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[0] || "";
          const text = r[1].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)?.[1] || "";
          return { rPr, text };
        });

        // Merge adjacent runs with same formatting
        const merged: typeof parsed = [parsed[0]];
        for (let i = 1; i < parsed.length; i++) {
          const last = merged[merged.length - 1];
          if (parsed[i].rPr === last.rPr) {
            last.text += parsed[i].text;
          } else {
            merged.push(parsed[i]);
          }
        }

        return merged
          .map(
            (r) =>
              `<w:r>${r.rPr}<w:t xml:space="preserve">${r.text}</w:t></w:r>`
          )
          .join("");
      }
    );
  });
}

async function applyDocxInstructions(
  buffer: Buffer,
  instructions: Array<any>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let docXml = (await zip.file("word/document.xml")?.async("string")) || "";

  // Merge adjacent runs to prevent search failures from Word's run splitting
  docXml = mergeDocxRuns(docXml);

  for (const inst of instructions) {
    if (inst.type === "replace" && inst.search && inst.value != null) {
      // Escape XML special chars in the replacement value
      const safeValue = String(inst.value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      // Search in the text content within <w:t> tags
      const escaped = inst.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      docXml = docXml.replace(new RegExp(escaped, "g"), safeValue);
    } else if (inst.type === "fillTable" && inst.markerText && Array.isArray(inst.rows)) {
      // Find a table that contains markerText, clone the last data row for each item
      docXml = fillDocxTable(docXml, inst.markerText, inst.columns, inst.rows);
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

/**
 * Finds a <w:tbl> containing markerText, takes the last <w:tr> as template,
 * removes all data rows (keeping header), and inserts new rows from data.
 */
function fillDocxTable(
  xml: string,
  markerText: string,
  columns: string[] | undefined,
  rows: Array<Record<string, string>>
): string {
  // Find all tables
  const tableRegex = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;
  return xml.replace(tableRegex, (table) => {
    // Check if this table contains the marker text
    if (!table.includes(markerText)) return table;

    // Extract all rows
    const rowMatches = [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)];
    if (rowMatches.length < 2) return table; // Need at least header + 1 template row

    // First row is header, last row is template
    const templateRow = rowMatches[rowMatches.length - 1][0];

    // Extract cells from template to get formatting
    const cellMatches = [...templateRow.matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)];

    // Build new rows
    const newRowsXml = rows.map((rowData) => {
      let newRow = templateRow;
      // Replace cell contents one by one
      let cellIndex = 0;
      newRow = newRow.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell) => {
        const colKey = columns ? columns[cellIndex] : String(cellIndex);
        cellIndex++;
        const value = rowData[colKey] || "";
        const safeValue = String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        // Keep cell properties, replace text content
        return cell.replace(
          /<w:t[^>]*>[\s\S]*?<\/w:t>/g,
          `<w:t xml:space="preserve">${safeValue}</w:t>`
        );
      });
      return newRow;
    }).join("");

    // Remove all rows except header, then append new rows
    const headerRow = rowMatches[0][0];
    // Get everything before first row and after last row
    const beforeRows = table.substring(0, table.indexOf(rowMatches[0][0]));
    const afterRows = table.substring(
      table.indexOf(rowMatches[rowMatches.length - 1][0]) +
        rowMatches[rowMatches.length - 1][0].length
    );

    return beforeRows + headerRow + newRowsXml + afterRows;
  });
}

async function applyXlsxInstructions(
  buffer: Buffer,
  instructions: Array<any>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) return buffer;

  for (const inst of instructions) {
    if (inst.type === "cell" && inst.row && inst.col) {
      sheet.getRow(inst.row).getCell(inst.col).value = inst.value;
    } else if (inst.type === "fillRows" && inst.startRow && Array.isArray(inst.rows)) {
      // Insert rows of data starting at startRow
      for (let i = 0; i < inst.rows.length; i++) {
        const rowNum = inst.startRow + i;
        const rowData = inst.rows[i];
        const xlsRow = sheet.getRow(rowNum);
        if (Array.isArray(rowData)) {
          rowData.forEach((val: any, colIdx: number) => {
            xlsRow.getCell(colIdx + 1).value = val;
          });
        } else if (typeof rowData === "object") {
          for (const [colStr, val] of Object.entries(rowData)) {
            xlsRow.getCell(Number(colStr)).value = val as any;
          }
        }
        xlsRow.commit();
      }
    }
  }

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}
