#!/usr/bin/env npx tsx

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { spawn } from "child_process";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const api = anyApi as any;

// --- Inline parsers (avoid import issues) ---
async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function parseDocxWithBlocks(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "[No document.xml found]";
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return "[No body found]";
  const bodyContent = bodyMatch[1];
  const blockRegex = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  const blocks: string[] = [];
  let match;
  while ((match = blockRegex.exec(bodyContent)) !== null) {
    const element = match[0];
    const tagName = match[1];
    if (tagName === "w:tbl") {
      const rows: string[] = [];
      const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(element)) !== null) {
        const cells: string[] = [];
        const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
          const cellText = cellMatch[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
          cells.push(cellText);
        }
        rows.push("| " + cells.join(" | ") + " |");
      }
      blocks.push(rows.join("\n"));
    } else {
      const text = element.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      blocks.push(text || "");
    }
  }
  return blocks.map((text, i) => `[Block ${i + 1}] ${text}`).join("\n");
}

async function parseXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [`=== Sheet: ${sheet.name} ===`];
    sheet.eachRow((row, rowNumber) => {
      const cells = (row.values as any[]).slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "object" && "result" in v) return String(v.result);
        if (typeof v === "object" && "text" in v) return String(v.text);
        return String(v);
      });
      rows.push(`Row ${rowNumber}: ${cells.join(" | ")}`);
    });
    sheets.push(rows.join("\n"));
  });
  return sheets.join("\n\n");
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  return result.text;
}

async function parseFile(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "docx" || mimeType.includes("wordprocessingml")) return parseDocx(buffer);
  if (ext === "xlsx" || mimeType.includes("spreadsheetml")) return parseXlsx(buffer);
  if (ext === "pdf" || mimeType === "application/pdf") return parsePdf(buffer);
  return `[Unsupported file type: ${ext}]`;
}

// --- Inline DOCX slicer ---
async function sliceDocx(docxBuffer: Buffer, startBlock: number, endBlock: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No word/document.xml found");
  const bodyMatch = docXml.match(/(<w:body[^>]*>)([\s\S]*)(<\/w:body>)/);
  if (!bodyMatch) throw new Error("No <w:body> found");
  const sectPrMatch = bodyMatch[2].match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : "";
  const blockRegex = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  const allBlocks: string[] = [];
  let m;
  while ((m = blockRegex.exec(bodyMatch[2])) !== null) allBlocks.push(m[0]);
  const start = Math.max(1, startBlock) - 1;
  const end = Math.min(allBlocks.length, endBlock);
  const selectedBlocks = allBlocks.slice(start, end);
  if (selectedBlocks.length === 0) throw new Error(`No blocks in range ${startBlock}-${endBlock}`);
  const preamble = docXml.substring(0, docXml.indexOf("<w:body"));
  const newBody = `${bodyMatch[1]}${selectedBlocks.join("")}${sectPr}${bodyMatch[3]}`;
  const postamble = docXml.substring(docXml.indexOf("</w:body>") + "</w:body>".length);
  const newZip = new JSZip();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) { newZip.folder(path); continue; }
    if (path === "word/document.xml") { newZip.file(path, preamble + newBody + postamble); }
    else { newZip.file(path, await file.async("uint8array")); }
  }
  return Buffer.from(await newZip.generateAsync({ type: "nodebuffer" }));
}

async function sliceXlsxSheet(xlsxBuffer: Buffer, sheetName: string): Promise<Buffer> {
  const srcWorkbook = new ExcelJS.Workbook();
  await srcWorkbook.xlsx.load(xlsxBuffer as unknown as ArrayBuffer);
  const srcSheet = srcWorkbook.getWorksheet(sheetName);
  if (!srcSheet) throw new Error(`Sheet "${sheetName}" not found`);
  const dstWorkbook = new ExcelJS.Workbook();
  const dstSheet = dstWorkbook.addWorksheet(sheetName);
  srcSheet.columns.forEach((col, i) => { if (col.width) dstSheet.getColumn(i + 1).width = col.width; });
  srcSheet.eachRow({ includeEmpty: true }, (srcRow, rowNumber) => {
    const dstRow = dstSheet.getRow(rowNumber);
    srcRow.eachCell({ includeEmpty: true }, (srcCell, colNumber) => {
      const dstCell = dstRow.getCell(colNumber);
      if (srcCell.formula) { dstCell.value = { formula: srcCell.formula } as any; }
      else { dstCell.value = srcCell.value; }
      dstCell.style = { ...srcCell.style };
    });
    dstRow.height = srcRow.height;
    dstRow.commit();
  });
  srcSheet.model.merges?.forEach((merge: string) => { dstSheet.mergeCells(merge); });
  return Buffer.from(await dstWorkbook.xlsx.writeBuffer());
}

// --- Inline profiles ---
const profiles: Record<string, any> = {
  boltinov: {
    id: "boltinov",
    fullName: "Индивидуальный предприниматель Болтинов Данил Александрович",
    shortName: "ИП Болтинов Д.А.",
    inn: "662302062065", ogrn: "324665800041636", okpo: "2030070106", kpp: "", oktmo: "94701000001", okved: "47.91",
    legalAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    mailingAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    actualAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    bank: { name: 'ООО "Банк Точка"', bic: "044525104", account: "40802810220000245984", corrAccount: "30101810745374525104", address: "109456, РОССИЯ, МОСКВА г. 1-Й ВЕШНЯКОВСКИЙ пр, ДОМ 1 СТР8, 1 этаж, пом.№43" },
    director: { fio: "Болтинов Данил Александрович", fioShort: "Болтинов Д.А.", position: "Индивидуальный предприниматель", phone: "+79193876713", email: "boltinov99@mail.ru" },
    passport: { series: "6519", number: "880947", issueDate: "22.05.2019", issuedBy: "ГУ МВД России по Свердловской области", departmentCode: "660-008" },
    registration: { ogrnDate: "22.02.2024", ogrnRecord: "324665800041636" },
    tax: { system: "УСН", ndsRate: 5, ndsLabel: "НДС 5%" },
    ownershipChain: [{ fio: "Болтинов Данил Александрович", inn: "662302062065", ogrn: "324665800041636", role: "руководитель", share: "100%", address: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.", passport: "6519 880947" }],
  },
  pikhenek: {
    id: "pikhenek",
    fullName: "Индивидуальный предприниматель Пихенек Юрий Дмитриевич",
    shortName: "ИП Пихенек Ю.Д.",
    inn: "662306468179", ogrn: "324665800041941", okpo: "2030070432", kpp: "", oktmo: "65701000001", okved: "47.91",
    legalAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    mailingAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    actualAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    bank: { name: 'ООО "Банк Точка"', bic: "044525104", account: "40802810320000245978", corrAccount: "30101810745374525104", address: "109456, РОССИЯ, МОСКВА г. 1-Й ВЕШНЯКОВСКИЙ пр, ДОМ 1 СТР8, 1 этаж, пом.№43" },
    director: { fio: "Пихенек Юрий Дмитриевич", fioShort: "Пихенек Ю.Д.", position: "Индивидуальный предприниматель", phone: "+79920027767", email: "rukovoditelmp@yandex.ru" },
    passport: { series: "", number: "", issueDate: "", issuedBy: "", departmentCode: "" },
    registration: { ogrnDate: "22.02.2024", ogrnRecord: "324665800041941" },
    tax: { system: "УСН", ndsRate: 5, ndsLabel: "НДС 5%" },
    ownershipChain: [{ fio: "Пихенек Юрий Дмитриевич", inn: "662306468179", ogrn: "324665800041941", role: "руководитель", share: "100%", address: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32", passport: "" }],
  },
};

// --- Config ---
const CONVEX_URL = process.env.CONVEX_URL || "https://intent-toad-141.convex.cloud";
const POLL_INTERVAL = 5000;

const client = new ConvexHttpClient(CONVEX_URL);

// --- Claude CLI helper ---
async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--system-prompt", systemPrompt], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => reject(err));

    proc.stdin.write(userMessage);
    proc.stdin.end();
  });
}

// --- JSON extraction (from opusApi.ts) ---
function repairTruncatedJson(text: string): string {
  let s = text.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) s += '"';
  return s + stack.reverse().join("");
}

function sanitizeJsonString(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/[\x00-\x1f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
  );
}

function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ||
      text.match(/```\s*([\s\S]*?)\s*```/) ||
      text.match(/(\[[\s\S]*\])/) ||
      text.match(/(\{[\s\S]*\})/);
    let jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;
    jsonStr = sanitizeJsonString(jsonStr);
    try {
      return JSON.parse(jsonStr);
    } catch {
      return JSON.parse(repairTruncatedJson(jsonStr));
    }
  }
}

// --- Upload file to Convex storage ---
async function uploadToStorage(buffer: Buffer, contentType: string): Promise<string> {
  const uploadUrl = await client.mutation(api.files.generateUploadUrl, {});
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  const { storageId } = await res.json();
  return storageId;
}

// --- Update progress ---
async function updateProgress(procurementId: string, status: string, msg: string, progress: number) {
  await client.mutation(api.procurements.updateStatus, {
    id: procurementId,
    status: status as any,
    statusMessage: msg,
    progress,
  });
}

// --- Prompts ---
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
      "name": "string - название формы",
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
- For pp1875: check if the item has restrictions under ПП 1875
- All prices in rubles, no formatting
- FORMS: Find ONLY forms that a PARTICIPANT must fill and submit.
- Typical form names: "Форма 1", "Форма 2", "Анкета участника", "Опись документов", "Письмо о подаче оферты", "Согласие на обработку данных" etc.
- Do NOT include: приложения с требованиями для заказчика, ТЗ, спецификации, проекты договоров.
- For each form found INSIDE a DOCX, specify startBlock and endBlock. For whole files use "whole_file". For XLSX sheets use "sheet" with sheetName.
- Do NOT invent forms. Only include forms actually present.
- Return ONLY valid JSON, no markdown or comments`;

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
- Format tzSpecs clearly and concisely
- pp1875 should reflect any restrictions under ПП 1875 for this item category
- Return ONLY valid JSON array, no markdown or comments`;

const FORM_ANALYSIS_PROMPT = `You are an expert at filling Russian procurement forms for ИП participants.

You will receive:
1. The text content of a form that needs to be filled
2. Calculation data with OUR prices (not NMCK!) for each item
3. Complete company profile
4. Procurement metadata
5. Pricing summary

CRITICAL RULES:
- "Итоговая стоимость заявки" = pricing.ourTotalPrice (OUR price), NEVER use НМЦК!
- НДС is calculated from our total price
- Use profile data EXACTLY as provided
- For ИП: КПП is empty, write "нет"
- Replace "(Наименование Участника)" with profile.shortName

INSTRUCTION TYPES:

For DOCX forms:
{
  "instructions": [
    {"type": "replace", "search": "exact placeholder text", "value": "filled value"},
    {"type": "fillTable", "markerText": "unique table header text", "columns": ["col1","col2"], "rows": [{"col1":"1","col2":"val"}]}
  ]
}

For XLSX forms:
{
  "instructions": [
    {"type": "cell", "row": 5, "col": 3, "value": "filled value"},
    {"type": "fillRows", "startRow": 3, "rows": [[1, "Item", 10, "шт", 100.50]]}
  ]
}

- search string must match EXACTLY what appears in the document
- ALWAYS fill ALL placeholders
- ALWAYS generate rows for ALL items
- Do NOT invent data
- Return ONLY valid JSON`;

const SELF_CHECK_PROMPT = `You previously filled a procurement form. Now verify your work.

Compare the filled form against the source data and check:
1. All fields that should be filled ARE filled
2. Numbers match the source data exactly
3. Company details are correct
4. No data was invented

Return JSON:
{
  "corrections": [
    {"type": "replace", "search": "wrong value", "value": "correct value"}
  ]
}

If no corrections needed, return empty corrections array.
Return ONLY valid JSON`;

// ========== ANALYSIS PROCESSOR ==========

async function processAnalysis(procurementId: string) {
  console.log(`\n📋 Начинаю анализ закупки ${procurementId}...`);

  try {
    await updateProgress(procurementId, "analyzing", "Загрузка файлов...", 0);

    // 1. Get files
    const files = await client.query(api.files.listByProcurement, { procurementId });
    if (files.length === 0) throw new Error("Нет загруженных файлов");

    // 2. Download and parse files
    const parsedFiles: Array<{ name: string; content: string; buffer: Buffer; fileType: string; storageId: any }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.url) continue;

      await updateProgress(procurementId, "analyzing", `Парсинг файла ${i + 1}/${files.length}: ${file.fileName}`, Math.round((i / files.length) * 15));

      const response = await fetch(file.url);
      const buffer = Buffer.from(await response.arrayBuffer());

      const ext = file.fileName.split(".").pop()?.toLowerCase();
      let content: string;
      if (ext === "docx") {
        content = await parseDocxWithBlocks(buffer);
      } else {
        content = await parseFile(buffer, file.fileType, file.fileName);
      }

      parsedFiles.push({ name: file.fileName, content, buffer, fileType: file.fileType, storageId: file.storageId });
    }

    // 3. Prioritize and truncate
    await updateProgress(procurementId, "analyzing", `Подготовка ${parsedFiles.length} файлов для Claude...`, 15);

    const MAX_CHARS = 500000;
    const priorityKeywords = ["ТЗ", "техническ", "извещение", "документация", "НМЦ", "расчет", "приложение", "форма"];
    const sortedFiles = [...parsedFiles].sort((a, b) => {
      const aP = priorityKeywords.some((k) => a.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
      const bP = priorityKeywords.some((k) => b.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
      return aP - bP;
    });

    let totalChars = 0;
    const includedFiles: typeof parsedFiles = [];
    for (const f of sortedFiles) {
      if (totalChars + f.content.length > MAX_CHARS && includedFiles.length > 0) {
        const remaining = MAX_CHARS - totalChars;
        if (remaining > 10000) {
          includedFiles.push({ ...f, content: f.content.slice(0, remaining) + "\n...[ОБРЕЗАНО]" });
        }
        break;
      }
      includedFiles.push(f);
      totalChars += f.content.length;
    }

    const fileContents = includedFiles.map((f) => `=== FILE: ${f.name} ===\n${f.content}`).join("\n\n---\n\n");

    // 4. Call Claude for extraction
    await updateProgress(procurementId, "analyzing", "Claude анализирует документы...", 20);
    console.log("  🤖 Вызов Claude для извлечения данных...");

    const result = await callClaude(EXTRACTION_PROMPT, `Документы:\n\n${fileContents}`);
    const extractedData = extractJson(result);

    console.log(`  ✅ Извлечено: ${extractedData.items?.length || 0} позиций, ${extractedData.forms?.length || 0} форм`);

    // 5. Save procurement metadata
    await updateProgress(procurementId, "analyzing", "Сохранение данных...", 55);

    await client.mutation(api.procurements.updateFromAnalysis, {
      id: procurementId,
      number: extractedData.procurementNumber || "",
      name: extractedData.procurementName || "Без названия",
      nmck: Number(extractedData.nmck) || 0,
      deliveryDeadline: extractedData.deliveryDeadline || "",
      deliveryAddresses: extractedData.deliveryAddresses || [],
    });

    // 6. Clear old data and save items
    await client.mutation(api.localApi.clearProcurementData, { procurementId });

    const items = extractedData.items || [];
    if (items.length > 0) {
      await client.mutation(api.localApi.saveExtractedItemsBatch, {
        items: items.map((item: any) => ({
          procurementId,
          name: String(item.name || ""),
          quantity: Number(item.quantity) || 0,
          unit: String(item.unit || "шт"),
          nmckPrice: Number(item.nmckPrice) || 0,
          tzSpecs: String(item.tzSpecs || ""),
          quarter: String(item.quarter || ""),
          estimatedWeight: Number(item.estimatedWeight) || 0,
          estimatedDimensions: String(item.estimatedDimensions || ""),
          deliveryAllocations: (item.deliveryAllocations || []).map((a: any) => ({
            address: String(a.address || ""),
            quantity: Number(a.quantity) || 0,
          })),
          deliveryCost: 0,
          deliveryCostEstimated: false,
        })),
      });
    }

    // 7. Slice forms
    await updateProgress(procurementId, "analyzing", "Нарезка форм из документов...", 60);

    const forms = extractedData.forms || [];
    const fileBufferMap = new Map<string, { buffer: Buffer; storageId: any }>();
    for (const f of parsedFiles) {
      fileBufferMap.set(f.name, { buffer: f.buffer, storageId: f.storageId });
    }

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      await updateProgress(procurementId, "analyzing", `Извлечение формы ${i + 1}/${forms.length}: ${form.name}`, 60 + Math.round((i / forms.length) * 10));

      const locationType = form.locationType || "whole_file";
      const sourceFile = form.sourceFile || "";
      const fileData = fileBufferMap.get(sourceFile);

      if (locationType === "whole_file" && fileData) {
        await client.mutation(api.localApi.saveExtractedForm, {
          procurementId,
          name: String(form.name),
          storageId: fileData.storageId,
          fileName: sourceFile,
          sourceFile,
          fileType: sourceFile.split(".").pop()?.toLowerCase() || "docx",
          locationType: "whole_file",
        });
      } else if (locationType === "paragraph_range" && fileData) {
        try {
          const slicedBuffer = await sliceDocx(fileData.buffer, Number(form.startBlock) || 1, Number(form.endBlock) || 1);
          const storageId = await uploadToStorage(slicedBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
          const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.docx`;
          await client.mutation(api.localApi.saveExtractedForm, {
            procurementId,
            name: String(form.name),
            storageId,
            fileName,
            sourceFile,
            fileType: "docx",
            locationType: "paragraph_range",
            sourceCoordinates: JSON.stringify({ startBlock: form.startBlock, endBlock: form.endBlock }),
          });
        } catch (e: any) {
          console.error(`  ⚠️ Не удалось нарезать форму "${form.name}": ${e.message}`);
        }
      } else if (locationType === "sheet" && fileData && form.sheetName) {
        try {
          const slicedBuffer = await sliceXlsxSheet(fileData.buffer, form.sheetName);
          const storageId = await uploadToStorage(slicedBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          const fileName = `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.xlsx`;
          await client.mutation(api.localApi.saveExtractedForm, {
            procurementId,
            name: String(form.name),
            storageId,
            fileName,
            sourceFile,
            fileType: "xlsx",
            locationType: "sheet",
            sourceCoordinates: JSON.stringify({ sheetName: form.sheetName }),
          });
        } catch (e: any) {
          console.error(`  ⚠️ Не удалось извлечь лист "${form.name}": ${e.message}`);
        }
      }
    }

    // 8. Calculation
    await updateProgress(procurementId, "analyzing", "Генерация калькуляции (Claude)...", 70);
    console.log("  🤖 Вызов Claude для калькуляции...");

    const itemsForCalc = items.map((item: any) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      nmckPrice: item.nmckPrice,
      tzSpecs: item.tzSpecs,
      pp1875: item.pp1875 || "",
    }));

    const calcResult = await callClaude(
      CALCULATION_SYSTEM_PROMPT,
      `Позиции из документации закупки:\n\n${JSON.stringify(itemsForCalc, null, 2)}`
    );
    const calcRows = extractJson(calcResult);

    // 9. Build Excel
    await updateProgress(procurementId, "analyzing", "Создание Excel калькуляции...", 85);

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Калькуляция");

    const headers = [
      "№ п/п", "Наименование", "1875 ПП (запрет/ограничение/преимущество)",
      "Количество", "НМЦК за ед.\n(заказчика)", "НМЦК общ.\n(заказчика)",
      "Характеристики ТЗ\n(заказчика)", "НАШИ ХАРАКТЕРИСТИКИ\n(нашего товара)",
      "Наша цена за Единицу", "Наша Сумма", "Ссылка На товар",
      "Примечание\n(Наименование товара\n/артикул/комментарий)",
    ];

    sheet.columns = headers.map((h, i) => ({
      header: h,
      width: [6, 40, 15, 12, 14, 14, 40, 40, 16, 14, 20, 30][i] || 15,
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
    headerRow.alignment = { wrapText: true, vertical: "middle" };

    const rowCount = Array.isArray(calcRows) ? calcRows.length : items.length;
    const calcItemsToSave: any[] = [];

    for (let i = 0; i < rowCount; i++) {
      const calcRow = Array.isArray(calcRows) ? calcRows[i] : null;
      const origItem = items[i];

      const itemName = calcRow?.itemName || origItem?.name || "";
      const pp1875 = calcRow?.pp1875 || origItem?.pp1875 || "";
      const quantity = Number(calcRow?.quantity || origItem?.quantity) || 0;
      const nmckPrice = Number(calcRow?.nmckPrice || origItem?.nmckPrice) || 0;
      const tzSpecs = calcRow?.tzSpecs || origItem?.tzSpecs || "";

      const rowNum = i + 2;
      const row = sheet.addRow([i + 1, itemName, pp1875, quantity, nmckPrice, null, tzSpecs, "", null, null, "", ""]);
      row.getCell(6).value = { formula: `D${rowNum}*E${rowNum}` } as any;
      row.getCell(10).value = { formula: `D${rowNum}*I${rowNum}` } as any;

      [8, 9, 12].forEach((col) => {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      });

      calcItemsToSave.push({
        procurementId,
        itemIndex: i,
        itemName,
        pp1875: pp1875 || undefined,
        quantity,
        nmckPrice,
        tzSpecs: tzSpecs || undefined,
      });
    }

    const lastDataRow = rowCount + 1;
    const totalsRow = sheet.addRow(["", "ИТОГО", "", "", "", { formula: `SUM(F2:F${lastDataRow})` }, "", "", "", { formula: `SUM(J2:J${lastDataRow})` }]);
    totalsRow.font = { bold: true };

    // 10. Upload Excel
    await updateProgress(procurementId, "analyzing", "Сохранение калькуляции...", 92);

    const excelBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const calcStorageId = await uploadToStorage(excelBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const procurement = await client.query(api.procurements.get, { id: procurementId });

    await client.mutation(api.localApi.clearGeneratedFiles, { procurementId });
    await client.mutation(api.files.saveGeneratedFile, {
      procurementId,
      profileId: procurement?.profileId || "pikhenek",
      storageId: calcStorageId,
      fileName: `Калькуляция_${procurement?.number || "draft"}.xlsx`,
      formType: "calculation",
    });

    // Save calculation items
    if (calcItemsToSave.length > 0) {
      await client.mutation(api.localApi.saveCalculationItemsBatch, { items: calcItemsToSave });
    }

    // 11. Done!
    await updateProgress(procurementId, "analyzed", `Извлечено ${items.length} позиций, ${forms.length} форм`, 100);
    console.log(`  ✅ Анализ завершён!`);

  } catch (error: any) {
    console.error(`  ❌ Ошибка анализа: ${error.message}`);
    await updateProgress(procurementId, "uploaded", `Ошибка анализа: ${error.message}`, 0);
  }
}

// ========== FORM FILLING PROCESSOR ==========

// DOCX manipulation helpers
async function applyDocxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  let docXml = (await zip.file("word/document.xml")?.async("string")) || "";

  // Merge adjacent runs
  docXml = docXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    return paragraph.replace(
      /(<w:r\b[^>]*>[\s\S]*?<\/w:r>)(\s*<w:r\b[^>]*>[\s\S]*?<\/w:r>)+/g,
      (runSequence) => {
        const runs = [...runSequence.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)];
        if (runs.length <= 1) return runSequence;
        const parsed = runs.map((r) => {
          const rPr = r[1].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[0] || "";
          const text = r[1].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)?.[1] || "";
          return { rPr, text };
        });
        const merged: typeof parsed = [parsed[0]];
        for (let i = 1; i < parsed.length; i++) {
          const last = merged[merged.length - 1];
          if (parsed[i].rPr === last.rPr) {
            last.text += parsed[i].text;
          } else {
            merged.push(parsed[i]);
          }
        }
        return merged.map((r) => `<w:r>${r.rPr}<w:t xml:space="preserve">${r.text}</w:t></w:r>`).join("");
      }
    );
  });

  for (const inst of instructions) {
    if (inst.type === "replace" && inst.search && inst.value != null) {
      const safeValue = String(inst.value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const escaped = inst.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      docXml = docXml.replace(new RegExp(escaped, "g"), safeValue);
    } else if (inst.type === "fillTable" && inst.markerText && Array.isArray(inst.rows)) {
      docXml = docXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
        if (!table.includes(inst.markerText)) return table;
        const rowMatches = [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)];
        if (rowMatches.length < 2) return table;
        const templateRow = rowMatches[rowMatches.length - 1][0];
        const newRowsXml = inst.rows.map((rowData: any) => {
          let newRow = templateRow;
          let cellIndex = 0;
          newRow = newRow.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell: string) => {
            const colKey = inst.columns ? inst.columns[cellIndex] : String(cellIndex);
            cellIndex++;
            const value = rowData[colKey] || "";
            const safeVal = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            return cell.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/g, `<w:t xml:space="preserve">${safeVal}</w:t>`);
          });
          return newRow;
        }).join("");
        const headerRow = rowMatches[0][0];
        const beforeRows = table.substring(0, table.indexOf(rowMatches[0][0]));
        const afterRows = table.substring(table.indexOf(rowMatches[rowMatches.length - 1][0]) + rowMatches[rowMatches.length - 1][0].length);
        return beforeRows + headerRow + newRowsXml + afterRows;
      });
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

async function applyXlsxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return buffer;

  for (const inst of instructions) {
    if (inst.type === "cell" && inst.row && inst.col) {
      sheet.getRow(inst.row).getCell(inst.col).value = inst.value;
    } else if (inst.type === "fillRows" && inst.startRow && Array.isArray(inst.rows)) {
      for (let i = 0; i < inst.rows.length; i++) {
        const rowNum = inst.startRow + i;
        const rowData = inst.rows[i];
        const xlsRow = sheet.getRow(rowNum);
        if (Array.isArray(rowData)) {
          rowData.forEach((val: any, colIdx: number) => { xlsRow.getCell(colIdx + 1).value = val; });
        }
        xlsRow.commit();
      }
    }
  }

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}

async function processFormFilling(procurementId: string, options?: { profileId?: string; formIds?: string[] }) {
  console.log(`\n📝 Начинаю заполнение форм для закупки ${procurementId}...`);

  try {
    const procurement = await client.query(api.procurements.get, { id: procurementId });
    if (!procurement) throw new Error("Закупка не найдена");

    const calcData = await client.query(api.files.getCalculationData, { procurementId });
    const activeProfileId = options?.profileId || procurement.profileId;
    const profile = profiles[activeProfileId];
    if (!profile) throw new Error(`Профиль ${activeProfileId} не найден`);

    console.log(`  Профиль: ${profile.shortName}`);

    const ourTotalPrice = calcData.reduce((sum: number, d: any) => sum + (d.ourTotal || 0), 0);
    const ndsRate = profile.tax.ndsRate;
    const ndsAmount = Math.round((ourTotalPrice * ndsRate / (100 + ndsRate)) * 100) / 100;

    const contextData = {
      procurement: {
        number: procurement.number, name: procurement.name, nmck: procurement.nmck,
        deliveryDeadline: procurement.deliveryDeadline, deliveryAddresses: procurement.deliveryAddresses,
      },
      pricing: { ourTotalPrice, ndsRate, ndsAmount, ndsLabel: profile.tax.ndsLabel },
      profile: {
        fullName: profile.fullName, shortName: profile.shortName,
        inn: profile.inn, ogrn: profile.ogrn, okpo: profile.okpo,
        kpp: profile.kpp || "нет (ИП)", oktmo: profile.oktmo, okved: profile.okved,
        legalAddress: profile.legalAddress, mailingAddress: profile.mailingAddress,
        actualAddress: profile.actualAddress, bank: profile.bank,
        director: profile.director, passport: profile.passport,
        registration: profile.registration, tax: profile.tax,
        ownershipChain: profile.ownershipChain,
      },
      items: calcData.map((d: any) => ({
        name: d.itemName, quantity: d.quantity, nmckPrice: d.nmckPrice,
        ourSpecs: d.ourSpecs, ourUnitPrice: d.ourUnitPrice,
        ourTotal: d.ourTotal, notes: d.notes, tzSpecs: d.tzSpecs,
      })),
    };

    const allForms = await client.query(api.files.getExtractedForms, { procurementId });
    if (allForms.length === 0) throw new Error("Нет форм для заполнения");

    const formsToFill = options?.formIds
      ? allForms.filter((f: any) => options.formIds!.includes(f._id))
      : allForms;

    if (!formsToFill.length) throw new Error("Нет выбранных форм");

    // Clear only re-filled forms or all
    if (options?.formIds) {
      const formTypes = formsToFill.map((f: any) => f.name);
      await client.mutation(api.localApi.clearGeneratedFilesByFormTypes, { procurementId, formTypes });
    } else {
      await client.mutation(api.localApi.clearGeneratedFilesExceptCalculation, { procurementId });
    }

    for (let i = 0; i < formsToFill.length; i++) {
      const form = formsToFill[i];
      if (!form.url) continue;

      const formProgress = Math.round((i / formsToFill.length) * 80);
      await updateProgress(procurementId, "filling_forms", `Заполнение формы ${i + 1}/${formsToFill.length}: ${form.name}`, formProgress);
      console.log(`  📄 Форма ${i + 1}/${formsToFill.length}: ${form.name}`);

      const formResponse = await fetch(form.url);
      let formBuffer = Buffer.from(await formResponse.arrayBuffer());
      const mimeType = form.fileType === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const formText = await parseFile(formBuffer, mimeType, form.fileName);

      console.log("    🤖 Получение инструкций заполнения...");
      const fillResult = await callClaude(
        FORM_ANALYSIS_PROMPT,
        `Форма: "${form.name}"\n\nТекст формы:\n${formText}\n\nДанные:\n${JSON.stringify(contextData, null, 2)}`
      );
      const fillData = extractJson(fillResult);
      const instructions = fillData.instructions || [];

      if (form.fileType === "docx") formBuffer = await applyDocxInstructions(formBuffer, instructions);
      else if (form.fileType === "xlsx") formBuffer = await applyXlsxInstructions(formBuffer, instructions);

      console.log("    🔍 Проверка заполнения...");
      const filledText = await parseFile(formBuffer, mimeType, form.fileName);
      const checkResult = await callClaude(
        SELF_CHECK_PROMPT,
        `Исходные данные:\n${JSON.stringify(contextData, null, 2)}\n\nЗаполненная форма "${form.name}":\n${filledText}`
      );
      const checkData = extractJson(checkResult);
      const corrections = checkData.corrections || [];
      if (corrections.length > 0) {
        console.log(`    🔧 Применяю ${corrections.length} исправлений...`);
        if (form.fileType === "docx") formBuffer = await applyDocxInstructions(formBuffer, corrections);
        else if (form.fileType === "xlsx") formBuffer = await applyXlsxInstructions(formBuffer, corrections);
      }

      const storageId = await uploadToStorage(formBuffer, mimeType);
      await client.mutation(api.files.saveGeneratedFile, {
        procurementId,
        profileId: activeProfileId,
        storageId,
        fileName: `Заполнено_${form.fileName}`,
        formType: form.name,
      });

      console.log(`    ✅ Форма заполнена!`);
    }

    await updateProgress(procurementId, "completed", `Заполнено ${formsToFill.length} форм`, 100);
    console.log(`  ✅ Все формы заполнены!`);

  } catch (error: any) {
    console.error(`  ❌ Ошибка заполнения форм: ${error.message}`);
    await updateProgress(procurementId, "calculation_uploaded", `Ошибка заполнения форм: ${error.message}`, 0);
  }
}

// ========== MAIN LOOP ==========

async function poll() {
  const procurements = await client.query(api.procurements.list, {});

  for (const p of procurements) {
    if (p.status === "analyzing") {
      await processAnalysis(p._id as string);
    }
    if (p.status === "filling_forms") {
      await processFormFilling(p._id as string, {
        profileId: p.fillProfileId || undefined,
        formIds: p.fillFormIds || undefined,
      });
    }
  }
}

async function main() {
  console.log("🚀 Локальный обработчик Tender Master запущен");
  console.log(`   Convex: ${CONVEX_URL}`);
  console.log(`   Опрос каждые ${POLL_INTERVAL / 1000}с`);
  console.log("   Ctrl+C для остановки\n");

  while (true) {
    try {
      await poll();
    } catch (error: any) {
      console.error(`Ошибка опроса: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

main();
