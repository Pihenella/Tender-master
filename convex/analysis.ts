"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { parseFile } from "../src/lib/parsers";
import { parseDocxWithBlocks } from "../src/lib/parsers";
import { sliceDocx, sliceXlsxSheet } from "./docxSlicer";
import { callOpus, extractJson } from "./opusApi";

// --- Stage 1: Opus extraction prompt ---

const EXTRACTION_PROMPT = `You are analyzing Russian procurement (закупка) documentation files.
The documents include block numbers [Block N] for DOCX files.

Extract the following structured data as JSON:

{
  "procurementNumber": "string - номер закупки",
  "procurementName": "string - название закупки",
  "nmck": number - общая НМЦК (начальная максимальная цена контракта) в рублях,
  "deliveryDeadline": "string - срок поставки",
  "deliveryAddresses": [{"name": "string - название грузополучателя", "address": "string - адрес"}],
  "items": [
    {
      "name": "string - наименование товара",
      "quantity": number,
      "unit": "string - единица измерения",
      "nmckPrice": number - НМЦК за единицу,
      "tzSpecs": "string - технические характеристики из ТЗ",
      "pp1875": "string - ограничение по ПП 1875: запрет/ограничение/преимущество или пустая строка",
      "quarter": "string - квартал поставки",
      "estimatedWeight": number - примерный вес в кг (оцени по наименованию),
      "estimatedDimensions": "string - примерные габариты ДxШxВ см",
      "deliveryAllocations": [{"address": "string", "quantity": number}]
    }
  ],
  "forms": [
    {
      "name": "string - название формы (например 'Форма 2 - Письмо о подаче оферты')",
      "sourceFile": "string - имя файла где найдена форма",
      "locationType": "paragraph_range | whole_file | sheet",
      "startBlock": number (only for paragraph_range),
      "endBlock": number (only for paragraph_range),
      "sheetName": "string (only for sheet type)"
    }
  ]
}

IMPORTANT:
- Extract ALL items from the product list/ТЗ
- For estimatedWeight: estimate based on typical weight of the product by its name
- For deliveryAllocations: if items go to multiple addresses, split quantities accordingly
- For pp1875: check if the item has restrictions under ПП 1875 (запрет/ограничение/преимущество)
- All prices in rubles, no formatting
- FORMS: Find ONLY forms that a PARTICIPANT (участник закупки) must fill and submit. Look for a section called "Образцы форм" or "Формы для заполнения участниками" inside files like "извещение", "закупочная документация" or similar.
- Typical form names: "Форма 1", "Форма 2", "Образец ...", "Анкета участника", "Опись документов", "Письмо о подаче оферты", "Согласие на обработку данных" etc.
- Do NOT include: приложения с требованиями для заказчика, технические задания (ТЗ), спецификации, проекты договоров/контрактов, инструкции по подаче, разъяснения — these are NOT participant forms.
- For each form found INSIDE a DOCX document, specify the startBlock and endBlock numbers. For whole files that ARE forms, use locationType "whole_file". For XLSX sheets that are forms, use locationType "sheet" with sheetName.
- Do NOT invent forms. Only include forms actually present in the documents.
- Return ONLY valid JSON, no markdown or comments`;

// --- Stage 3: Calculation prompt ---

const CALCULATION_SYSTEM_PROMPT = `You are filling a procurement calculation spreadsheet.
Given the extracted items from procurement documentation, return a JSON array where each element represents one row:

[
  {
    "itemName": "string - наименование товара из документации",
    "pp1875": "string - запрет/ограничение/преимущество или пустая строка",
    "quantity": number,
    "nmckPrice": number - НМЦК за единицу,
    "tzSpecs": "string - характеристики из ТЗ заказчика, в читаемом виде"
  }
]

IMPORTANT:
- Copy item names EXACTLY as they appear in the procurement documentation
- Format tzSpecs clearly and concisely - remove redundant text, keep key specifications
- pp1875 should reflect any restrictions under ПП 1875 for this item category
- Return ONLY valid JSON array, no markdown or comments`;

export const analyzeDocuments = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const updateProgress = async (msg: string, progress: number) => {
      const current = await ctx.runQuery(api.procurements.get, {
        id: args.procurementId,
      });
      if (current && current.status !== "analyzing") {
        throw new Error("__CANCELLED__");
      }
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzing",
        statusMessage: msg,
        progress,
      });
    };

    try {
      // ========== STAGE 1: Opus Analysis (0-60%) ==========

      await updateProgress("Загрузка файлов...", 0);

      const files = await ctx.runQuery(api.files.listByProcurement, {
        procurementId: args.procurementId,
      });

      if (files.length === 0) {
        throw new Error("Нет загруженных файлов");
      }

      // Parse files — DOCX gets block-numbered version for form discovery
      const parsedFiles: Array<{
        name: string;
        content: string;
        buffer: Buffer;
        fileType: string;
        storageId: any;
      }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.url) continue;
        await updateProgress(
          `Парсинг файла ${i + 1}/${files.length}: ${file.fileName}`,
          Math.round((i / files.length) * 15)
        );
        const response = await fetch(file.url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const ext = file.fileName.split(".").pop()?.toLowerCase();
        let content: string;
        if (ext === "docx") {
          content = await parseDocxWithBlocks(buffer);
        } else {
          content = await parseFile(buffer, file.fileType, file.fileName);
        }

        parsedFiles.push({
          name: file.fileName,
          content,
          buffer,
          fileType: file.fileType,
          storageId: file.storageId,
        });
      }

      // Prioritize and truncate for Opus context
      await updateProgress(
        `Отправка ${parsedFiles.length} файлов в Opus...`,
        15
      );

      const MAX_CHARS = 500000;
      const priorityKeywords = [
        "ТЗ",
        "техническ",
        "извещение",
        "документация",
        "НМЦ",
        "расчет",
        "приложение",
        "форма",
      ];
      const sortedFiles = [...parsedFiles].sort((a, b) => {
        const aP = priorityKeywords.some((k) =>
          a.name.toLowerCase().includes(k.toLowerCase())
        )
          ? 0
          : 1;
        const bP = priorityKeywords.some((k) =>
          b.name.toLowerCase().includes(k.toLowerCase())
        )
          ? 0
          : 1;
        return aP - bP;
      });

      let totalChars = 0;
      const includedFiles: typeof parsedFiles = [];
      for (const f of sortedFiles) {
        if (totalChars + f.content.length > MAX_CHARS && includedFiles.length > 0) {
          const remaining = MAX_CHARS - totalChars;
          if (remaining > 10000) {
            includedFiles.push({
              ...f,
              content: f.content.slice(0, remaining) + "\n...[ОБРЕЗАНО]",
            });
          }
          break;
        }
        includedFiles.push(f);
        totalChars += f.content.length;
      }

      const fileContents = includedFiles
        .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
        .join("\n\n---\n\n");

      await updateProgress("Opus анализирует документы...", 20);

      const result = await callOpus(
        EXTRACTION_PROMPT,
        `Документы:\n\n${fileContents}`,
        65536
      );

      await updateProgress("Обработка ответа Opus...", 50);

      const extractedData = extractJson(result);

      // Save procurement metadata
      await updateProgress("Сохранение метаданных закупки...", 55);

      await ctx.runMutation(api.procurements.updateFromAnalysis, {
        id: args.procurementId,
        number: extractedData.procurementNumber || "",
        name: extractedData.procurementName || "Без названия",
        nmck: Number(extractedData.nmck) || 0,
        deliveryDeadline: extractedData.deliveryDeadline || "",
        deliveryAddresses: extractedData.deliveryAddresses || [],
      });

      await updateProgress("Сохранение позиций...", 56);

      // Clear previous data
      const oldItems = await ctx.runQuery(api.files.getExtractedItems, {
        procurementId: args.procurementId,
      });
      for (const item of oldItems) {
        await ctx.runMutation(internal.analysisHelpers.deleteExtractedItem, {
          id: item._id,
        });
      }
      await ctx.runMutation(internal.analysisHelpers.clearExtractedForms, {
        procurementId: args.procurementId,
      });
      await ctx.runMutation(internal.analysisHelpers.clearCalculationData, {
        procurementId: args.procurementId,
      });

      // Save extracted items
      const items = extractedData.items || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await ctx.runMutation(internal.analysisHelpers.saveExtractedItem, {
          procurementId: args.procurementId,
          name: String(item.name || ""),
          quantity: Number(item.quantity) || 0,
          unit: String(item.unit || "шт"),
          nmckPrice: Number(item.nmckPrice) || 0,
          tzSpecs: String(item.tzSpecs || ""),
          quarter: String(item.quarter || ""),
          estimatedWeight: Number(item.estimatedWeight) || 0,
          estimatedDimensions: String(item.estimatedDimensions || ""),
          deliveryAllocations: (item.deliveryAllocations || []).map(
            (a: any) => ({
              address: String(a.address || ""),
              quantity: Number(a.quantity) || 0,
            })
          ),
          deliveryCost: 0,
          deliveryCostEstimated: false,
        });
      }

      // ========== STAGE 2: Form Slicing (60-70%) ==========

      await updateProgress("Нарезка форм из документов...", 60);

      const forms = extractedData.forms || [];
      const fileBufferMap = new Map<string, { buffer: Buffer; storageId: any }>();
      for (const f of parsedFiles) {
        fileBufferMap.set(f.name, { buffer: f.buffer, storageId: f.storageId });
      }

      for (let i = 0; i < forms.length; i++) {
        const form = forms[i];
        await updateProgress(
          `Извлечение формы ${i + 1}/${forms.length}: ${form.name}`,
          60 + Math.round((i / forms.length) * 10)
        );

        const locationType = form.locationType || "whole_file";
        const sourceFile = form.sourceFile || "";
        const fileData = fileBufferMap.get(sourceFile);

        if (locationType === "whole_file" && fileData) {
          await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
            procurementId: args.procurementId,
            name: String(form.name),
            storageId: fileData.storageId,
            fileName: sourceFile,
            sourceFile,
            fileType: sourceFile.split(".").pop()?.toLowerCase() || "docx",
            locationType: "whole_file",
          });
        } else if (locationType === "paragraph_range" && fileData) {
          const startBlock = Number(form.startBlock) || 1;
          const endBlock = Number(form.endBlock) || startBlock;

          try {
            const slicedBuffer = await sliceDocx(
              fileData.buffer,
              startBlock,
              endBlock
            );
            const blob = new Blob([new Uint8Array(slicedBuffer)], {
              type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            const storageId = await ctx.storage.store(blob);
            const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.docx`;

            await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
              procurementId: args.procurementId,
              name: String(form.name),
              storageId,
              fileName,
              sourceFile,
              fileType: "docx",
              locationType: "paragraph_range",
              sourceCoordinates: JSON.stringify({ startBlock, endBlock }),
            });
          } catch (e: any) {
            console.error(`Failed to slice form "${form.name}": ${e.message}`);
          }
        } else if (locationType === "sheet" && fileData && form.sheetName) {
          try {
            const slicedBuffer = await sliceXlsxSheet(
              fileData.buffer,
              form.sheetName
            );
            const blob = new Blob([new Uint8Array(slicedBuffer)], {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });
            const storageId = await ctx.storage.store(blob);
            const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.xlsx`;

            await ctx.runMutation(internal.analysisHelpers.saveExtractedForm, {
              procurementId: args.procurementId,
              name: String(form.name),
              storageId,
              fileName,
              sourceFile,
              fileType: "xlsx",
              locationType: "sheet",
              sourceCoordinates: JSON.stringify({
                sheetName: form.sheetName,
              }),
            });
          } catch (e: any) {
            console.error(`Failed to slice sheet "${form.name}": ${e.message}`);
          }
        }
      }

      // ========== STAGE 3: Opus Calculation (70-95%) ==========

      await updateProgress("Генерация калькуляции (Opus)...", 70);

      const itemsForCalc = items.map((item: any) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        nmckPrice: item.nmckPrice,
        tzSpecs: item.tzSpecs,
        pp1875: item.pp1875 || "",
      }));

      const calcResult = await callOpus(
        CALCULATION_SYSTEM_PROMPT,
        `Позиции из документации закупки:\n\n${JSON.stringify(itemsForCalc, null, 2)}`
      );

      const calcRows = extractJson(calcResult);

      await updateProgress("Создание Excel калькуляции...", 85);

      // Build calculation Excel
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

      const rowCount = Array.isArray(calcRows) ? calcRows.length : items.length;
      for (let i = 0; i < rowCount; i++) {
        const calcRow = Array.isArray(calcRows) ? calcRows[i] : null;
        const origItem = items[i];

        const itemName = calcRow?.itemName || origItem?.name || "";
        const pp1875 = calcRow?.pp1875 || origItem?.pp1875 || "";
        const quantity = Number(calcRow?.quantity || origItem?.quantity) || 0;
        const nmckPrice = Number(calcRow?.nmckPrice || origItem?.nmckPrice) || 0;
        const tzSpecs = calcRow?.tzSpecs || origItem?.tzSpecs || "";

        const rowNum = i + 2;
        const row = sheet.addRow([
          i + 1,
          itemName,
          pp1875,
          quantity,
          nmckPrice,
          null,
          tzSpecs,
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

        await ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
          procurementId: args.procurementId,
          itemIndex: i,
          itemName,
          pp1875: pp1875 || undefined,
          quantity,
          nmckPrice,
          tzSpecs: tzSpecs || undefined,
        });
      }

      const lastDataRow = rowCount + 1;
      const totalsRow = sheet.addRow([
        "",
        "ИТОГО",
        "",
        "",
        "",
        { formula: `SUM(F2:F${lastDataRow})` },
        "",
        "",
        "",
        { formula: `SUM(J2:J${lastDataRow})` },
      ]);
      totalsRow.font = { bold: true };

      await updateProgress("Сохранение калькуляции...", 92);

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const calcStorageId = await ctx.storage.store(blob);

      const procurement = await ctx.runQuery(api.procurements.get, {
        id: args.procurementId,
      });

      await ctx.runMutation(internal.analysisHelpers.clearGeneratedFiles, {
        procurementId: args.procurementId,
      });

      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement?.profileId || "pikhenek",
        storageId: calcStorageId,
        fileName: `Калькуляция_${procurement?.number || "draft"}.xlsx`,
        formType: "calculation",
      });

      // ========== DONE ==========

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzed",
        statusMessage: `Извлечено ${items.length} позиций, ${forms.length} форм`,
        progress: 100,
      });
    } catch (error: any) {
      if (error.message === "__CANCELLED__") return;
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "uploaded",
        statusMessage: `Ошибка анализа: ${error.message}`,
        progress: 0,
      });
    }
  },
});
