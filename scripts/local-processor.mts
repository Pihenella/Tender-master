#!/usr/bin/env npx tsx

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { spawn } from "child_process";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import formMapModule from "../src/lib/server/formMap";
import fillV2Module from "../src/lib/server/fillV2";
const { buildFormMap } = formMapModule as any;
const { resolveMapping, applyXlsxV2, selfCheck } = fillV2Module as any;
type ClaudeMapping = import("../src/lib/server/fillV2").ClaudeMapping;

const api = anyApi as any;

// --- Inline parsers (avoid import issues) ---
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
  if (ext === "docx" || mimeType.includes("wordprocessingml")) return parseDocxWithBlocks(buffer);
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
  return Buffer.from(await newZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
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
    passport: { series: "6521", number: "330759", issueDate: "09.07.2021", issuedBy: "ГУ МВД России по Свердловской области", departmentCode: "660-006" },
    registration: { ogrnDate: "22.02.2024", ogrnRecord: "324665800041941" },
    tax: { system: "УСН", ndsRate: 5, ndsLabel: "НДС 5%" },
    ownershipChain: [{ fio: "Пихенек Юрий Дмитриевич", inn: "662306468179", ogrn: "324665800041941", role: "руководитель", share: "100%", address: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32", passport: "6521 330759" }],
  },
};

// --- Config ---
const CONVEX_URL = process.env.CONVEX_URL || "https://intent-toad-141.convex.cloud";
const POLL_INTERVAL = 5000;

const client = new ConvexHttpClient(CONVEX_URL);

// --- Claude CLI helper ---
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per call

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const proc = spawn("claude", ["-p", "--system-prompt", systemPrompt], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      settle(() => {
        try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
        try { proc.kill("SIGKILL"); } catch {}
        reject(new Error(`claude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      });
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      settle(() => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });

    proc.on("error", (err) => { clearTimeout(timer); settle(() => reject(err)); });

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
      // Try to extract valid JSON by finding balanced structure
      for (const startChar of ["{", "["]) {
        const idx = jsonStr.indexOf(startChar);
        if (idx === -1) continue;
        const endChar = startChar === "{" ? "}" : "]";
        let depth = 0, inStr = false, esc = false;
        for (let i = idx; i < jsonStr.length; i++) {
          const ch = jsonStr[i];
          if (esc) { esc = false; continue; }
          if (ch === "\\") { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === startChar) depth++;
          else if (ch === endChar) {
            depth--;
            if (depth === 0) {
              try { return JSON.parse(jsonStr.substring(idx, i + 1)); } catch { break; }
            }
          }
        }
      }
      try {
        return JSON.parse(repairTruncatedJson(jsonStr));
      } catch (e) {
        throw new Error(`Failed to extract JSON from response: ${(e as Error).message}\nOriginal text (first 500 chars): ${text.substring(0, 500)}`);
      }
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

const FORM_ANALYSIS_PROMPT = `You are an expert at filling Russian procurement forms for ИП (individual entrepreneur) participants.

You will receive:
1. The text content of a form that needs to be filled
2. Calculation data with OUR prices (not NMCK!) for each item
3. Complete company profile
4. Procurement metadata
5. Pricing summary

=== CRITICAL GENERAL RULES ===
- "Итоговая стоимость заявки" = pricing.ourTotalPrice (OUR price), NEVER use НМЦК!
- НДС is calculated from our total price. Our tax system is УСН with 5% НДС.
- Use profile data EXACTLY as provided
- For ИП: КПП is empty, write "нет"
- Wherever the template says "ОГРН" for ИП, replace with "ОГРНИП"
- ФИО руководителя, ответственного лица, контактного лица = the same ИП data (duplicate it)
- Факс: у нас нет, оставляем пустым или прочерк
- Страна происхождения товара по умолчанию: Китай
- DO NOT change document structure. Only fill in values.
- Tables must fit on one page — do not add extra rows or make content overflow.

=== FORM-SPECIFIC RULES ===

**Форма 1 (Письмо о подаче оферты):**
- "Полное наименование Участника" → profile.fullName (e.g. "Индивидуальный предприниматель Болтинов Данил Александрович")
- "Зарегистрированное по адресу" → profile.legalAddress
- "Предлагает заключить договор на" → procurement.name (the subject of procurement, e.g. "поставку запчастей для общепромышленного оборудования")
- Итоговая стоимость → pricing.ourTotalPrice

**Форма 2 (Анкета участника закупки):**
- The TABLE MUST be fully filled!
- The table has TWO columns: "Наименование" (left) and "Сведения об участнике закупки" (right)
- DO NOT put data into the "Наименование" column — it already has labels
- Put ALL data into the RIGHT column ("Сведения об участнике закупки")
- REMOVE placeholder text like "указать код", "почтовый индекс" etc and REPLACE with actual data
- Use "replace" instructions to replace placeholder text in the right column cells with real data
- Полное наименование: profile.fullName
- Сокращённое наименование: profile.shortName
- Виды деятельности (ОКВЭД): profile.okved and any additional codes
- Юридический адрес = фактический адрес = profile.legalAddress (they are the same for ИП)
- Телефон: profile.director.phone, Факс: нет
- Email: profile.director.email
- ФИО руководителя = profile.director.fio
- ФИО и контакты ответственного лица = same as руководитель (duplicate)

**Форма 3 (Справка о цепочке собственников):**
- Keep ONLY 1 row in the ownership table (ИП is the sole owner)
- The table has MULTIPLE columns (ФИО, ИНН, ОГРНИП, доля, адрес, паспорт, etc.)
- Fill EACH column with the corresponding data from profile.ownershipChain[0]
- DO NOT put all data into one column — spread across all columns matching their headers
- Use fillTable with correct column mapping matching the table headers
- ОГРН → ОГРНИП everywhere
- Table MUST fit on 1 page

**Форма 3.1 (Согласие на обработку персональных данных):**
- Fill all personal data fields from profile
- ОГРН → ОГРНИП

**Приложение 2.1 (Техническое предложение участника):**
- This form has a TABLE that MUST be filled with ALL items from the items array!
- Use fillTable instruction to populate the table. Generate rows for EVERY item.
- If the template has fewer rows than items, that is OK — fillTable will create new rows from the template.
- Column mapping for fillTable (use these exact column keys):
  - "№" → sequential number: 1, 2, 3...
  - "№ п.п. ТЗ" → same sequential number
  - "Требуемое Заказчиком" → items[i].name (product name from procurement)
  - "Предлагаемое Участником" → items[i].ourSpecs or items[i].name (our product from calculation)
  - "Выполнение" → always "да"
  - "Пояснения" → always "---"
  - "Страна происхождения" → "Китай"
  - "Наименование производителя" → leave empty or from calculation notes
  - "Цена ед. изм. по оценке Участника, руб. с НДС" → items[i].ourUnitPrice
  - "Общая сумма по оценке Участника, руб. с НДС" → items[i].ourTotal
- Do NOT fill "без НДС" columns — only fill "с НДС" columns
- IMPORTANT: Generate a row for EVERY item, even if there are 60+ items!

=== INSTRUCTION TYPES ===

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

- search string must match EXACTLY what appears in the document text
- ALWAYS fill ALL placeholders and table cells
- ALWAYS generate rows for ALL items
- Do NOT invent data — use only provided profile, pricing, and items data
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

const FORM_MAP_PROMPT = `You analyze Russian procurement form structures and map data fields to cells.

You receive:
1. A structured form map with regions (headers, fields with label+input cells, tables, static text)
2. Available data: profile (company info), pricing (totals), items (procurement items)

Your task: determine which data field goes into each input cell.

=== CRITICAL RULES ===
- "Итоговая стоимость" = pricing.ourTotalPrice (OUR price), NEVER НМЦК!
- For ИП: КПП = "нет (ИП)"
- Use profile data EXACTLY
- ОГРН → ОГРНИП for ИП

=== DATA PATHS ===
Profile fields: profile.fullName, profile.shortName, profile.inn, profile.ogrn, profile.okpo, profile.kpp, profile.oktmo, profile.okved, profile.legalAddress, profile.mailingAddress, profile.actualAddress
Bank: profile.bank.name, profile.bank.bic, profile.bank.account, profile.bank.corrAccount
Director: profile.director.fio, profile.director.fioShort, profile.director.position, profile.director.phone, profile.director.email
Passport: profile.passport.series, profile.passport.number, profile.passport.issueDate, profile.passport.issuedBy, profile.passport.departmentCode
Registration: profile.registration.ogrnDate, profile.registration.ogrnRecord
Tax: profile.tax.system, profile.tax.ndsRate, profile.tax.ndsLabel
Procurement: procurement.number, procurement.name, procurement.nmck, procurement.deliveryDeadline
Pricing: pricing.ourTotalPrice, pricing.ndsRate, pricing.ndsAmount, pricing.ndsLabel
Items array: items[].name, items[].quantity, items[].nmckPrice, items[].ourUnitPrice, items[].ourTotal, items[].ourSpecs, items[].notes

Return ONLY valid JSON:
{
  "mappings": [
    {"cell": "B5", "dataPath": "profile.inn", "confidence": "high"}
  ],
  "tables": [
    {
      "dataStartRow": 11,
      "columnMap": {
        "A": "rowNumber",
        "B": "items[].name",
        "C": "items[].quantity"
      }
    }
  ],
  "unmapped": ["D15"],
  "computed": [
    {"cell": "E20", "expression": "SUM", "label": "Итого"}
  ]
}

Confidence: high = exact match, medium = likely but ambiguous, low = uncertain.`;

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

/**
 * Safe replace inside DOCX XML — only modifies text within <w:t> elements, never touches XML structure.
 * Handles text split across multiple runs by working at the paragraph level.
 */
/**
 * Safe replace inside DOCX XML — only modifies text within <w:t> elements.
 * Replaces ALL occurrences in a single pass. Handles text split across runs.
 * Only modifies the specific <w:t> nodes that overlap with a match.
 */
function safeReplaceInXml(docXml: string, search: string, value: string): string {
  const safeValue = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const searchXml = search.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return docXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const textNodes: { start: number; end: number; text: string }[] = [];
    const tRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = tRe.exec(paragraph)) !== null) {
      textNodes.push({
        start: m.index + m[0].indexOf(">") + 1,
        end: m.index + m[0].lastIndexOf("<"),
        text: m[1],
      });
    }
    if (textNodes.length === 0) return paragraph;

    const concatenated = textNodes.map(n => n.text).join("");
    const useXml = concatenated.indexOf(searchXml) !== -1;
    const needle = useXml ? searchXml : search;

    // Try exact match first
    let replaced = concatenated;
    if (concatenated.indexOf(needle) !== -1) {
      replaced = concatenated.split(needle).join(safeValue);
    } else if (/_{3,}/.test(needle)) {
      // Normalize underscore sequences and try again
      const normConcat = concatenated.replace(/_{3,}/g, "\x00");
      const normNeedle = needle.replace(/_{3,}/g, "\x00");
      if (normConcat.indexOf(normNeedle) === -1) return paragraph;
      // Debug: log when underscore match is found
      if (concatenated.includes("____")) console.log(`      🔍 Underscore match in paragraph: "${concatenated.substring(0, 60)}..."`);

      // Build regex from needle where underscore sequences match any number of underscores
      const regexStr = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_{3,}/g, "_{1,}");
      replaced = concatenated.replace(new RegExp(regexStr, "g"), safeValue);
    } else {
      return paragraph;
    }

    if (replaced === concatenated) return paragraph;

    // For underscore-normalized replacements, put all in first node (placeholders are simple)
    // For exact matches, redistribute preserving node structure
    const newNodeTexts: string[] = textNodes.map(n => n.text);
    if (textNodes.length === 1 || /_{3,}/.test(needle)) {
      // Simple: all text in first node
      newNodeTexts[0] = replaced;
      for (let i = 1; i < newNodeTexts.length; i++) newNodeTexts[i] = "";
    } else {
      // Exact match: find which nodes overlap with the match and only modify those
      let matchIdx = concatenated.indexOf(needle);
      while (matchIdx !== -1) {
        let charPos = 0;
        let placed = false;
        for (let ni = 0; ni < textNodes.length; ni++) {
          const ns = charPos, ne = charPos + textNodes[ni].text.length;
          if (ne > matchIdx && ns < matchIdx + needle.length) {
            const cs = Math.max(0, matchIdx - ns);
            const ce = Math.min(newNodeTexts[ni].length, matchIdx + needle.length - ns);
            const before = newNodeTexts[ni].substring(0, cs), after = newNodeTexts[ni].substring(ce);
            newNodeTexts[ni] = !placed ? before + safeValue + after : before + after;
            if (!placed) placed = true;
          }
          charPos = ne;
        }
        // Find next occurrence after this one (in the original concatenated text)
        matchIdx = concatenated.indexOf(needle, matchIdx + needle.length);
      }
    }

    // Apply changes only to nodes whose text actually changed
    let result = paragraph;
    let offset = 0;
    for (let i = 0; i < textNodes.length; i++) {
      if (newNodeTexts[i] !== textNodes[i].text) {
        const origStart = textNodes[i].start + offset;
        const origEnd = textNodes[i].end + offset;
        result = result.substring(0, origStart) + newNodeTexts[i] + result.substring(origEnd);
        offset += newNodeTexts[i].length - textNodes[i].text.length;
      }
    }

    return result;
  });
}

async function applyDocxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  let docXml = (await zip.file("word/document.xml")?.async("string")) || "";

  for (const inst of instructions) {
    if (inst.type === "replace" && inst.search && inst.value != null) {
      // Safe replace — only modifies <w:t> content, replaces all occurrences in one pass
      const beforeLen = docXml.length;
      docXml = safeReplaceInXml(docXml, inst.search, String(inst.value));
      if (docXml.length === beforeLen) {
        // Search might span paragraphs. Try truncating to just the underscore/placeholder part.
        const lines = inst.search.split("\n");
        if (lines.length > 1) {
          // Try just the first line
          docXml = safeReplaceInXml(docXml, lines[0].trim(), String(inst.value));
        }
        if (docXml.length === beforeLen) {
          // Try extracting just the underscore part
          const underscoreMatch = inst.search.match(/_{3,}[^_]*/);
          if (underscoreMatch && underscoreMatch[0] !== inst.search) {
            docXml = safeReplaceInXml(docXml, underscoreMatch[0].trim(), String(inst.value));
          }
        }
        if (docXml.length === beforeLen) {
          // Last resort: try each sentence/line fragment separately
          const fragments = inst.search.split(/[\n\r]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 5);
          for (const frag of fragments) {
            const prev = docXml.length;
            docXml = safeReplaceInXml(docXml, frag, String(inst.value));
            if (docXml.length !== prev) break; // found one
          }
        }
        if (docXml.length === beforeLen) {
          console.log(`      ⚠️ НЕ НАЙДЕНО: "${inst.search.substring(0, 60)}..." (len:${inst.search.length})`);
        }
      }
    } else if (inst.type === "fillTable" && inst.markerText && Array.isArray(inst.rows)) {
      // Find balanced top-level elements inside XML (handles nesting)
      const findBalancedElements = (xml: string, tag: string): { start: number; end: number; text: string }[] => {
        const results: { start: number; end: number; text: string }[] = [];
        const openRe = new RegExp(`<${tag}\\b`, "g");
        const closeStr = `</${tag}>`;
        let m;
        while ((m = openRe.exec(xml)) !== null) {
          let depth = 1;
          let pos = m.index + m[0].length;
          while (depth > 0 && pos < xml.length) {
            const nextOpen = xml.indexOf(`<${tag}`, pos);
            const nextClose = xml.indexOf(closeStr, pos);
            if (nextClose === -1) break;
            if (nextOpen !== -1 && nextOpen < nextClose) {
              depth++;
              pos = nextOpen + tag.length + 1;
            } else {
              depth--;
              pos = nextClose + closeStr.length;
            }
          }
          if (depth === 0) {
            results.push({ start: m.index, end: pos, text: xml.substring(m.index, pos) });
            openRe.lastIndex = pos; // skip past this element
          }
        }
        return results;
      };

      // Find tables with balanced nesting
      const tables = findBalancedElements(docXml, "w:tbl");
      for (let ti = tables.length - 1; ti >= 0; ti--) {
        const table = tables[ti];
        if (!table.text.includes(inst.markerText)) continue;

        // Find top-level rows (not nested table rows)
        const rows = findBalancedElements(table.text, "w:tr");
        if (rows.length < 2) continue;

        const templateRow = rows[rows.length - 1].text;
        const newRowsXml = inst.rows.map((rowData: any) => {
          let newRow = templateRow;
          // Replace cell text values using balanced cell matching
          const cells = findBalancedElements(newRow, "w:tc");
          // Process cells in reverse order to preserve positions
          for (let ci = cells.length - 1; ci >= 0; ci--) {
            const colKey = inst.columns ? inst.columns[ci] : String(ci);
            const value = rowData[colKey] || "";
            const safeVal = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const cellXml = cells[ci].text;
            const newCellXml = cellXml.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/g, `<w:t xml:space="preserve">${safeVal}</w:t>`);
            newRow = newRow.substring(0, cells[ci].start) + newCellXml + newRow.substring(cells[ci].end);
          }
          return newRow;
        }).join("");

        const headerRow = rows[0].text;
        const beforeRows = table.text.substring(0, rows[0].start);
        const afterRows = table.text.substring(rows[rows.length - 1].end);
        const newTable = beforeRows + headerRow + newRowsXml + afterRows;
        docXml = docXml.substring(0, table.start) + newTable + docXml.substring(table.end);
        break; // only process first matching table
      }
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
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

/**
 * Programmatic filler for XLSX "Ценовое предложение" forms with единый коэффициент снижения.
 *
 * Structure: Col 33 = coefficient K, Cols 34-37 = calculated from K.
 * Detects coefficient column by header text "коэффициент снижения".
 * Falls back to formula-based detection.
 */
async function fillPriceProposalXlsx(buffer: Buffer, contextData: any, profile: any): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet in price proposal XLSX");

  // Find the header row with column numbers (usually row 13 with "1", "2", "3"...)
  let headerRow = 0;
  let coeffCol = 0; // Column with "коэффициент снижения" (usually 33)
  let participantNameCol = 0; // Column with "предлагаемое Участником" (usually 6)

  // Scan rows 8-15 for header with "коэффициент"
  for (let r = 8; r <= 15; r++) {
    for (let c = 1; c <= 40; c++) {
      const val = String(sheet.getRow(r).getCell(c).value || "").toLowerCase();
      if (val.includes("коэффициент") && val.includes("сниж")) {
        coeffCol = c;
        console.log(`    📌 Найден столбец коэффициента: ${c} (строка ${r})`);
      }
      if (val.includes("предлагаемое участником")) {
        participantNameCol = c;
      }
    }
  }

  // Also find "страна происхождения" and "цена участника с НДС" columns
  let countryCol = 0;
  let participantPriceNdsCol = 0; // "Цена ед. изм. по оценке Участника, руб. с НДС"
  for (let r = 8; r <= 15; r++) {
    for (let c = 1; c <= 40; c++) {
      const val = String(sheet.getRow(r).getCell(c).value || "").toLowerCase();
      if (val.includes("страна происхождения")) countryCol = c;
      if (val.includes("цена") && val.includes("участник") && val.includes("ндс") && !val.includes("без")) {
        participantPriceNdsCol = c;
      }
    }
  }

  if (!coeffCol) {
    console.log("    ⚠️ Столбец коэффициента не найден, пробую Col 33...");
    coeffCol = 33;
  }
  if (participantNameCol) console.log(`    📌 Столбец "Предлагаемое участником": ${participantNameCol}`);
  if (countryCol) console.log(`    📌 Столбец "Страна происхождения": ${countryCol}`);
  if (participantPriceNdsCol) console.log(`    📌 Столбец "Цена участника с НДС": ${participantPriceNdsCol}`);

  // Find the numbering row (row with "1", "2", "3"... column numbers)
  for (let r = 10; r <= 15; r++) {
    const c1 = sheet.getRow(r).getCell(1).value;
    const c2 = sheet.getRow(r).getCell(2).value;
    if (c1 === 1 || c1 === "1") {
      if (c2 === 2 || c2 === "2") {
        headerRow = r;
        break;
      }
    }
  }

  if (!headerRow) {
    console.log("    ⚠️ Строка нумерации не найдена, пробую 13...");
    headerRow = 13;
  }

  // Calculate coefficient K = ourTotalPrice / nmckTotalWithNds
  const ourTotalPrice = contextData.pricing.ourTotalPrice;
  const nmckWithNds = contextData.procurement.nmck;
  const ndsRate = profile.tax.ndsRate;

  // NMCK is with NDS. Our total price is with NDS.
  const K = nmckWithNds > 0 ? Math.round((ourTotalPrice / nmckWithNds) * 1000000) / 1000000 : 1;
  console.log(`    💰 Коэффициент K = ${ourTotalPrice} / ${nmckWithNds} = ${K}`);

  if (K <= 0 || K > 1) {
    console.log(`    ⚠️ Коэффициент K=${K} вне диапазона (0;1], данные калькуляции могут быть неполными`);
  }

  // Find data rows (rows where Col 1 is a positive number = item index)
  let filledCount = 0;
  const colLetter = (c: number) => {
    let s = "";
    while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); }
    return s;
  };
  const coeffLetter = colLetter(coeffCol);

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const c1 = row.getCell(1).value;

    // Data rows have numeric item index in column 1
    if (typeof c1 === "number" && c1 > 0 && c1 < 10000) {
      // Match item from contextData by index (c1 is 1-based item number)
      const itemIdx = (c1 as number) - 1;
      const item = contextData.items[itemIdx];

      // Fill "Предлагаемое участником" from calculation — match by item name to E column
      if (participantNameCol && item?.name) {
        // Use our specs if available, otherwise use our item name
        row.getCell(participantNameCol).value = item.ourSpecs || item.name;
      }

      // Fill "Страна происхождения" = Китай
      if (countryCol) {
        row.getCell(countryCol).value = "Китай";
      }

      // Fill coefficient
      row.getCell(coeffCol).value = K;

      // Calculate and fill participant price columns with VALUES (not formulas)
      // so they display immediately without Excel recalculation
      const priceNoNdsCol = coeffCol + 1;  // Цена уч. без НДС
      const priceNdsCol = coeffCol + 2;    // Цена уч. с НДС
      const totalNoNdsCol = coeffCol + 3;  // Сумма уч. без НДС
      const totalNdsCol = coeffCol + 4;    // Сумма уч. с НДС

      // Get quantity and Заказчик prices from the row itself
      const qty = Number(row.getCell(18).value) || 0; // Col R = Итого quantity
      const priceNoNds = Number(row.getCell(coeffCol - 4).value) || 0; // Col AC = Заказчик без НДС
      // Price with NDS: use formula result or calculate from priceNoNds
      let priceNds = 0;
      const adCell = row.getCell(coeffCol - 3);
      if (adCell.formula) {
        priceNds = priceNoNds * 1.2; // Typical 20% NDS markup from Заказчик
      } else {
        priceNds = Number(adCell.value) || priceNoNds * 1.2;
      }

      // Our prices = Заказчик price * K
      const ourPriceNoNds = Math.round(priceNoNds * K * 100) / 100;
      const ourPriceNds = Math.round(priceNds * K * 100) / 100;
      const ourTotalNoNds = Math.round(ourPriceNoNds * qty * 100) / 100;
      const ourTotalNds = Math.round(ourPriceNds * qty * 100) / 100;

      row.getCell(priceNoNdsCol).value = ourPriceNoNds;
      row.getCell(priceNdsCol).value = ourPriceNds;
      row.getCell(totalNoNdsCol).value = ourTotalNoNds;
      row.getCell(totalNdsCol).value = ourTotalNds;

      filledCount++;
    }
  }

  console.log(`    ✅ Заполнено ${filledCount} строк с K=${K}`);

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}

async function processFormFilling(procurementId: string, options?: { profileId?: string; formIds?: string[]; fillEngine?: "v1" | "v2" }) {
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

    // Collect V2 check results for confidence report
    const v2Reports: Array<{ formName: string; fields: any[]; warnings: string[] }> = [];

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

      // --- Programmatic fill for XLSX "Ценовое предложение" with единый коэффициент ---
      const isPriceProposal = form.fileType === "xlsx" && (
        form.name.includes("Ценовое предложение") || form.name.includes("ценовое предложение")
      );

      if (isPriceProposal) {
        console.log("    ⚡ Программное заполнение ценового предложения (без AI)...");
        formBuffer = await fillPriceProposalXlsx(formBuffer, contextData, profile);
      } else if (options?.fillEngine === "v2" && form.fileType === "xlsx") {
        // === V2 PIPELINE ===
        console.log("    🆕 V2: Построение карты формы...");
        const formMap = await buildFormMap(formBuffer);
        console.log(`    📊 V2: ${formMap.regions.length} регионов (${formMap.regions.filter((r: any) => r.type === "field").length} полей, ${formMap.regions.filter((r: any) => r.type === "table").length} таблиц)`);

        console.log("    🤖 V2: Маппинг полей...");
        const mapPrompt = `Форма: "${form.name}"\n\nСтруктура формы:\n${JSON.stringify(formMap, null, 2)}\n\nДанные:\n${JSON.stringify(contextData, null, 2)}`;
        const mapResult = await callClaude(FORM_MAP_PROMPT, mapPrompt);
        const mapping = extractJson(mapResult) as ClaudeMapping;
        console.log(`    📋 V2: ${mapping.mappings?.length || 0} маппингов, ${mapping.tables?.length || 0} таблиц, ${mapping.unmapped?.length || 0} без маппинга`);

        const safeMapping: ClaudeMapping = {
          mappings: mapping.mappings || [],
          tables: mapping.tables || [],
          unmapped: mapping.unmapped || [],
          computed: mapping.computed || [],
        };

        console.log("    ⚙️ V2: Подстановка значений...");
        const resolved = resolveMapping(safeMapping, contextData);
        console.log(`    ✏️ V2: ${resolved.cellValues.length} ячеек, ${resolved.tableData.reduce((s: number, t: any) => s + t.rows.length, 0)} строк таблиц, ${resolved.unresolved.length} не разрешено`);

        if (resolved.unresolved.length > 0) {
          console.log(`    🤖 V2: Разрешение ${resolved.unresolved.length} неизвестных полей...`);
          const unresolvedPrompt = `Эти ячейки формы "${form.name}" остались без данных: ${resolved.unresolved.join(", ")}.\n\nКарта формы:\n${JSON.stringify(formMap.regions.filter((r: any) => r.type === "field" && resolved.unresolved.includes(r.input?.cell)), null, 2)}\n\nДанные:\n${JSON.stringify(contextData, null, 2)}\n\nВерни JSON: {"cells": [{"cell": "B5", "value": "значение"}]}`;
          try {
            const unresolvedResult = await callClaude(FORM_MAP_PROMPT, unresolvedPrompt);
            const extra = extractJson(unresolvedResult);
            if (extra.cells && Array.isArray(extra.cells)) {
              for (const c of extra.cells) {
                if (c.cell && c.value !== undefined) {
                  resolved.cellValues.push({ cell: c.cell, value: c.value });
                }
              }
            }
          } catch (e: any) {
            console.log(`    ⚠️ V2: Не удалось разрешить: ${e.message}`);
          }
        }

        formBuffer = await applyXlsxV2(formBuffer, resolved.cellValues, resolved.tableData);

        console.log("    🔍 V2: Проверка заполнения...");
        const checkResult = await selfCheck(formBuffer, resolved.cellValues, formMap);
        console.log(`    📊 V2: Заполнено ${checkResult.applied}/${checkResult.applied + checkResult.failed}, пропущено ${checkResult.missing}`);

        if (checkResult.failed > 0) {
          console.log(`    🔧 V2: Retry для ${checkResult.failed} ошибок...`);
          const retryValues: Array<{ cell: string; value: string | number }> = [];
          for (const detail of checkResult.details) {
            if (detail.reason === "merged_cell" || detail.reason === "write_failed") {
              retryValues.push({ cell: detail.cell, value: detail.expected });
            }
          }
          if (retryValues.length > 0) {
            formBuffer = await applyXlsxV2(formBuffer, retryValues);
          }
        }

        console.log(`    ✅ V2: Итог — ${checkResult.applied} ок, ${checkResult.failed} ошибок, ${checkResult.missing} пропущено`);

        // Collect V2 report for UI
        const formFields = resolved.cellValues.map(cv => {
          const region = formMap.regions.find((r: any) => r.type === "field" && r.input?.cell === cv.cell);
          const label = region && region.type === "field" ? region.label.value : cv.cell;
          const failed = checkResult.details.find(d => d.cell === cv.cell);
          return {
            field: label,
            value: String(cv.value),
            confidence: failed ? "low" : "high",
            note: failed ? `${failed.reason}: получено "${failed.actual}"` : undefined,
          };
        });
        const warnings: string[] = [];
        for (const d of checkResult.details.filter(d => d.reason === "unmapped")) {
          const region = formMap.regions.find((r: any) => r.type === "field" && r.input?.cell === d.cell);
          const label = region && region.type === "field" ? region.label.value : d.cell;
          warnings.push(`Поле "${label}" (${d.cell}) не заполнено`);
        }
        v2Reports.push({ formName: form.name, fields: formFields, warnings });

      } else {
        // === V1 PIPELINE (original) ===
        const formText = await parseFile(formBuffer, mimeType, form.fileName);

        // Trim context for large forms to reduce Claude input size
        let formContextData = contextData;
        if (form.fileType === "xlsx" && contextData.items.length > 20) {
          formContextData = {
            ...contextData,
            items: contextData.items.map((item: any) => ({
              name: item.name, quantity: item.quantity, nmckPrice: item.nmckPrice,
              ourUnitPrice: item.ourUnitPrice, ourTotal: item.ourTotal,
            })),
          };
        }

        console.log("    🤖 Получение инструкций заполнения...");
        const userMsg = `Форма: "${form.name}"\n\nТекст формы:\n${formText}\n\nДанные:\n${JSON.stringify(formContextData, null, 2)}`;
        console.log(`    📊 Размер запроса: ${Math.round(userMsg.length / 1024)}KB`);
        const fillResult = await callClaude(
          FORM_ANALYSIS_PROMPT,
          userMsg
        );
        const fillData = extractJson(fillResult);
        const instructions = fillData.instructions || [];
        console.log(`    📋 ${instructions.length} инструкций: ${instructions.map((i: any) => i.type + (i.search ? ':"' + i.search.substring(0, 40) + '"' : '')).join(', ')}`);

        if (form.fileType === "docx") formBuffer = await applyDocxInstructions(formBuffer, instructions);
        else if (form.fileType === "xlsx") formBuffer = await applyXlsxInstructions(formBuffer, instructions);

        console.log("    🔍 Проверка заполнения...");
        try {
          const filledText = await parseFile(formBuffer, mimeType, form.fileName);
          const checkResult = await callClaude(
            SELF_CHECK_PROMPT,
            `Исходные данные:\n${JSON.stringify(formContextData, null, 2)}\n\nЗаполненная форма "${form.name}":\n${filledText}`
          );
          const checkData = extractJson(checkResult);
          const corrections = checkData.corrections || [];
          if (corrections.length > 0) {
            console.log(`    🔧 Применяю ${corrections.length} исправлений...`);
            if (form.fileType === "docx") formBuffer = await applyDocxInstructions(formBuffer, corrections);
            else if (form.fileType === "xlsx") formBuffer = await applyXlsxInstructions(formBuffer, corrections);
          }
        } catch (checkErr: any) {
          console.log(`    ⚠️ Проверка пропущена: ${checkErr.message}`);
        }
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

    // Save V2 confidence report if we have any
    if (v2Reports.length > 0) {
      const reportJson = JSON.stringify(v2Reports);
      const reportBuffer = Buffer.from(reportJson, "utf-8");
      const reportStorageId = await uploadToStorage(reportBuffer, "application/json");
      await client.mutation(api.files.saveGeneratedFile, {
        procurementId,
        profileId: activeProfileId,
        storageId: reportStorageId,
        fileName: "v2-confidence-report.json",
        formType: "confidenceReport",
      });
      console.log(`  📊 V2: Отчёт проверки сохранён (${v2Reports.length} форм)`);
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
        fillEngine: (p.fillEngine as "v1" | "v2") || "v1",
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
