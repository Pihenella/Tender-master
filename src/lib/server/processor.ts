import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { spawn } from "child_process";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildFormMap } from "./formMap";
import { resolveMapping, applyXlsxV2, selfCheck } from "./fillV2";
import type { ClaudeMapping } from "./fillV2";

const api = anyApi as any;

function getClient() {
  return new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
}

// --- Claude CLI ---
async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--system-prompt", systemPrompt], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
    proc.stdin.write(userMessage);
    proc.stdin.end();
  });
}

// --- JSON helpers ---
function extractJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/) || text.match(/(\[[\s\S]*\])/) || text.match(/(\{[\s\S]*\})/);
  let s = m ? (m[1] || m[0]) : text;
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\x00-\x1f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
  );
  try { return JSON.parse(s); } catch {}
  // Try to extract valid JSON by finding balanced structure
  for (const startChar of ["{", "["]) {
    const idx = s.indexOf(startChar);
    if (idx === -1) continue;
    const endChar = startChar === "{" ? "}" : "]";
    let depth = 0, inStr2 = false, esc2 = false;
    for (let i = idx; i < s.length; i++) {
      const ch = s[i];
      if (esc2) { esc2 = false; continue; }
      if (ch === "\\") { esc2 = true; continue; }
      if (ch === '"') { inStr2 = !inStr2; continue; }
      if (inStr2) continue;
      if (ch === startChar) depth++;
      else if (ch === endChar) { depth--; if (depth === 0) { try { return JSON.parse(s.substring(idx, i + 1)); } catch { break; } } }
    }
  }
  // repair truncated
  let r = s.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const ch of r) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) r += '"';
  try { return JSON.parse(r + stack.reverse().join("")); } catch (e) {
    throw new Error(`Failed to extract JSON from response: ${(e as Error).message}\nOriginal text (first 500 chars): ${text.substring(0, 500)}`);
  }
}

// --- Upload to Convex storage ---
async function uploadToStorage(client: ConvexHttpClient, buffer: Buffer, contentType: string): Promise<string> {
  const url = await client.mutation(api.files.generateUploadUrl, {});
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(buffer) });
  const { storageId } = await res.json();
  return storageId;
}

// --- Parsers ---
async function parseDocxBlocks(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "[No document.xml]";
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return "[No body]";
  const blockRegex = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  const blocks: string[] = [];
  let match;
  while ((match = blockRegex.exec(bodyMatch[1])) !== null) {
    if (match[1] === "w:tbl") {
      const rows: string[] = [];
      let rm;
      const rr = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      while ((rm = rr.exec(match[0])) !== null) {
        const cells: string[] = [];
        let cm;
        const cr = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        while ((cm = cr.exec(rm[0])) !== null) cells.push(cm[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
        rows.push("| " + cells.join(" | ") + " |");
      }
      blocks.push(rows.join("\n"));
    } else {
      blocks.push(match[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || "");
    }
  }
  return blocks.map((t, i) => `[Block ${i + 1}] ${t}`).join("\n");
}

async function parseFileContent(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    return parseDocxBlocks(buffer);
  }
  if (ext === "xlsx" || mimeType.includes("spreadsheetml")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheets: string[] = [];
    wb.eachSheet((sheet) => {
      const rows = [`=== Sheet: ${sheet.name} ===`];
      sheet.eachRow((row, n) => {
        const cells = (row.values as any[]).slice(1).map((v) => {
          if (v == null) return "";
          if (typeof v === "object" && "result" in v) return String(v.result);
          if (typeof v === "object" && "text" in v) return String(v.text);
          return String(v);
        });
        rows.push(`Row ${n}: ${cells.join(" | ")}`);
      });
      sheets.push(rows.join("\n"));
    });
    return sheets.join("\n\n");
  }
  if (ext === "pdf" || mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    return (await pdfParse(buffer)).text;
  }
  return `[Unsupported: ${ext}]`;
}

// --- DOCX slicer ---
async function sliceDocx(buf: Buffer, startBlock: number, endBlock: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No document.xml");
  const bm = docXml.match(/(<w:body[^>]*>)([\s\S]*)(<\/w:body>)/);
  if (!bm) throw new Error("No w:body");
  const sectPr = bm[2].match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0] || "";
  const all: string[] = [];
  let m;
  const re = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  while ((m = re.exec(bm[2])) !== null) all.push(m[0]);
  const sel = all.slice(Math.max(0, startBlock - 1), Math.min(all.length, endBlock));
  if (!sel.length) throw new Error(`No blocks in range ${startBlock}-${endBlock}`);
  const pre = docXml.substring(0, docXml.indexOf("<w:body"));
  const post = docXml.substring(docXml.indexOf("</w:body>") + 9);
  const nz = new JSZip();
  for (const [p, f] of Object.entries(zip.files)) {
    if (f.dir) { nz.folder(p); continue; }
    nz.file(p, p === "word/document.xml" ? pre + bm[1] + sel.join("") + sectPr + bm[3] + post : await f.async("uint8array"));
  }
  return Buffer.from(await nz.generateAsync({ type: "nodebuffer" }));
}

async function sliceXlsxSheet(buf: Buffer, sheetName: string): Promise<Buffer> {
  const src = new ExcelJS.Workbook();
  await src.xlsx.load(buf as unknown as ArrayBuffer);
  const ss = src.getWorksheet(sheetName);
  if (!ss) throw new Error(`Sheet "${sheetName}" not found`);
  const dst = new ExcelJS.Workbook();
  const ds = dst.addWorksheet(sheetName);
  ss.columns.forEach((c, i) => { if (c.width) ds.getColumn(i + 1).width = c.width; });
  ss.eachRow({ includeEmpty: true }, (r, n) => {
    const dr = ds.getRow(n);
    r.eachCell({ includeEmpty: true }, (c, cn) => {
      const dc = dr.getCell(cn);
      dc.value = c.formula ? { formula: c.formula } as any : c.value;
      dc.style = { ...c.style };
    });
    dr.height = r.height;
    dr.commit();
  });
  ss.model.merges?.forEach((m: string) => ds.mergeCells(m));
  return Buffer.from(await dst.xlsx.writeBuffer());
}

// --- DOCX/XLSX instruction application ---

// Safe run-only regex: only match runs that contain ONLY rPr + w:t (no field codes, drawings, etc.)
const SAFE_RUN_RE = /<w:r\b[^>]*>(\s*(?:<w:rPr>[\s\S]*?<\/w:rPr>\s*)?<w:t[^>]*>[\s\S]*?<\/w:t>\s*)<\/w:r>/;

function isSafeRun(runXml: string): boolean {
  // A run is safe to merge if it contains only optional rPr and a single w:t — no fldChar, instrText, drawing, tab, br, etc.
  const inner = runXml.match(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/)?.[1] || "";
  const withoutRpr = inner.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "").trim();
  // Should only contain <w:t ...>...</w:t>
  const onlyText = /^<w:t[^>]*>[\s\S]*?<\/w:t>$/.test(withoutRpr);
  return onlyText;
}

function mergeDocxRunsSafe(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    return paragraph.replace(
      /(<w:r\b[^>]*>[\s\S]*?<\/w:r>)(\s*<w:r\b[^>]*>[\s\S]*?<\/w:r>)+/g,
      (runSequence) => {
        const runs = [...runSequence.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)];
        if (runs.length <= 1) return runSequence;
        // Only merge if ALL runs in the sequence are safe (contain only rPr + text)
        if (!runs.every((r) => isSafeRun(r[0]))) return runSequence;

        const parsed = runs.map((r) => {
          const inner = r[0].match(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/)?.[1] || "";
          return {
            rPr: inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[0] || "",
            text: inner.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)?.[1] || "",
          };
        });
        const merged = [parsed[0]];
        for (let i = 1; i < parsed.length; i++) {
          const last = merged[merged.length - 1];
          if (parsed[i].rPr === last.rPr) last.text += parsed[i].text;
          else merged.push(parsed[i]);
        }
        return merged.map((r) => `<w:r>${r.rPr}<w:t xml:space="preserve">${r.text}</w:t></w:r>`).join("");
      }
    );
  });
}

async function applyDocxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer<ArrayBuffer>> {
  const zip = await JSZip.loadAsync(buffer);
  let xml = (await zip.file("word/document.xml")?.async("string")) || "";
  // Safe merge: only merge runs that contain just text (no field codes, drawings, etc.)
  xml = mergeDocxRunsSafe(xml);
  for (const inst of instructions) {
    if (inst.type === "replace" && inst.search && inst.value != null) {
      const sv = String(inst.value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      xml = xml.replace(new RegExp(inst.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), sv);
    } else if (inst.type === "fillTable" && inst.markerText && Array.isArray(inst.rows)) {
      xml = xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
        if (!table.includes(inst.markerText)) return table;
        const rm = [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)];
        if (rm.length < 2) return table;
        const tmpl = rm[rm.length - 1][0];
        const newRows = inst.rows.map((rd: any) => { let nr = tmpl; let ci = 0; nr = nr.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell: string) => { const ck = inst.columns?.[ci] ?? String(ci); ci++; const v = String(rd[ck] || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); return cell.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/g, `<w:t xml:space="preserve">${v}</w:t>`); }); return nr; }).join("");
        const before = table.substring(0, table.indexOf(rm[0][0]));
        const after = table.substring(table.indexOf(rm[rm.length - 1][0]) + rm[rm.length - 1][0].length);
        return before + rm[0][0] + newRows + after;
      });
    }
  }
  zip.file("word/document.xml", xml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function applyXlsxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const s = wb.worksheets[0];
  if (!s) return Buffer.from(buffer) as Buffer<ArrayBuffer>;
  for (const inst of instructions) {
    if (inst.type === "cell" && inst.row && inst.col) s.getRow(inst.row).getCell(inst.col).value = inst.value;
    else if (inst.type === "fillRows" && inst.startRow && Array.isArray(inst.rows)) {
      for (let i = 0; i < inst.rows.length; i++) {
        const r = s.getRow(inst.startRow + i);
        if (Array.isArray(inst.rows[i])) inst.rows[i].forEach((v: any, ci: number) => { r.getCell(ci + 1).value = v; });
        r.commit();
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- Profiles ---
const profiles: Record<string, any> = {
  boltinov: {
    fullName: "Индивидуальный предприниматель Болтинов Данил Александрович", shortName: "ИП Болтинов Д.А.",
    inn: "662302062065", ogrn: "324665800041636", okpo: "2030070106", kpp: "", oktmo: "94701000001", okved: "47.91",
    legalAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    mailingAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    actualAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    bank: { name: 'ООО "Банк Точка"', bic: "044525104", account: "40802810220000245984", corrAccount: "30101810745374525104" },
    director: { fio: "Болтинов Данил Александрович", fioShort: "Болтинов Д.А.", position: "Индивидуальный предприниматель", phone: "+79193876713", email: "boltinov99@mail.ru" },
    passport: { series: "6519", number: "880947", issueDate: "22.05.2019", issuedBy: "ГУ МВД России по Свердловской области", departmentCode: "660-008" },
    registration: { ogrnDate: "22.02.2024", ogrnRecord: "324665800041636" },
    tax: { system: "УСН", ndsRate: 5, ndsLabel: "НДС 5%" },
    ownershipChain: [{ fio: "Болтинов Данил Александрович", inn: "662302062065", ogrn: "324665800041636", role: "руководитель", share: "100%", address: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.", passport: "6519 880947" }],
  },
  pikhenek: {
    fullName: "Индивидуальный предприниматель Пихенек Юрий Дмитриевич", shortName: "ИП Пихенек Ю.Д.",
    inn: "662306468179", ogrn: "324665800041941", okpo: "2030070432", kpp: "", oktmo: "65701000001", okved: "47.91",
    legalAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    mailingAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    actualAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    bank: { name: 'ООО "Банк Точка"', bic: "044525104", account: "40802810320000245978", corrAccount: "30101810745374525104" },
    director: { fio: "Пихенек Юрий Дмитриевич", fioShort: "Пихенек Ю.Д.", position: "Индивидуальный предприниматель", phone: "+79920027767", email: "rukovoditelmp@yandex.ru" },
    passport: { series: "", number: "", issueDate: "", issuedBy: "", departmentCode: "" },
    registration: { ogrnDate: "22.02.2024", ogrnRecord: "324665800041941" },
    tax: { system: "УСН", ndsRate: 5, ndsLabel: "НДС 5%" },
    ownershipChain: [{ fio: "Пихенек Юрий Дмитриевич", inn: "662306468179", ogrn: "324665800041941", role: "руководитель", share: "100%", address: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32", passport: "" }],
  },
};

// --- Prompts ---
const EXTRACTION_PROMPT = `You are analyzing Russian procurement (закупка) documentation files.
The documents include block numbers [Block N] for DOCX files.

Extract the following structured data as JSON:

{
  "procurementNumber": "string",
  "procurementName": "string",
  "nmck": number,
  "deliveryDeadline": "string",
  "deliveryAddresses": [{"name": "string", "address": "string"}],
  "items": [
    {
      "name": "string", "quantity": number, "unit": "string", "nmckPrice": number,
      "tzSpecs": "string", "pp1875": "string",
      "quarter": "string", "estimatedWeight": number, "estimatedDimensions": "string",
      "deliveryAllocations": [{"address": "string", "quantity": number}]
    }
  ],
  "forms": [
    {
      "name": "string", "sourceFile": "string",
      "locationType": "paragraph_range | whole_file | sheet",
      "startBlock": number, "endBlock": number, "sheetName": "string"
    }
  ]
}

IMPORTANT:
- Extract ALL items from the product list/ТЗ
- estimatedWeight: estimate by product name
- deliveryAllocations: split quantities by address if applicable
- pp1875: запрет/ограничение/преимущество or empty
- All prices in rubles
- FORMS: Only forms a PARTICIPANT must fill. Look for "Образцы форм" section.
- Do NOT include ТЗ, contracts, instructions.
- For DOCX forms specify startBlock/endBlock. For whole files use "whole_file". For XLSX sheets use "sheet" with sheetName.
- Do NOT invent forms.
- Return ONLY valid JSON`;

const CALC_PROMPT = `Return a JSON array of procurement items:
[{"itemName": "string", "pp1875": "string", "quantity": number, "nmckPrice": number, "tzSpecs": "string"}]
Copy names EXACTLY. Format tzSpecs concisely. Return ONLY valid JSON array.`;

const FORM_PROMPT = `You fill Russian procurement forms for ИП participants.
CRITICAL: "Итоговая стоимость" = pricing.ourTotalPrice (OUR price), NEVER НМЦК!
Use profile data EXACTLY. For ИП: КПП = "нет".

For DOCX: {"instructions": [{"type": "replace", "search": "exact text", "value": "filled"}, {"type": "fillTable", "markerText": "header", "columns": [...], "rows": [...]}]}
For XLSX: {"instructions": [{"type": "cell", "row": N, "col": N, "value": "..."}, {"type": "fillRows", "startRow": N, "rows": [[...]]}]}

Fill ALL placeholders. Generate ALL item rows. Return ONLY valid JSON.`;

const CHECK_PROMPT = `Verify filled form against source data. Return JSON:
{"corrections": [{"type": "replace", "search": "wrong", "value": "correct"}]}
Empty corrections if all correct. Return ONLY valid JSON.`;

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

// ========== ANALYSIS ==========
export async function processAnalysis(procurementId: string) {
  const client = getClient();
  const up = (msg: string, progress: number) =>
    client.mutation(api.procurements.updateStatus, { id: procurementId, status: "analyzing" as any, statusMessage: msg, progress });

  try {
    await up("Загрузка файлов...", 0);
    const files = await client.query(api.files.listByProcurement, { procurementId });
    if (!files.length) throw new Error("Нет файлов");

    const parsed: { name: string; content: string; buffer: Buffer; fileType: string; storageId: any }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.url) continue;
      await up(`Парсинг ${i + 1}/${files.length}: ${f.fileName}`, Math.round((i / files.length) * 15));
      const buf = Buffer.from(await (await fetch(f.url)).arrayBuffer());
      const ext = f.fileName.split(".").pop()?.toLowerCase();
      const content = ext === "docx" ? await parseDocxBlocks(buf) : await parseFileContent(buf, f.fileType, f.fileName);
      parsed.push({ name: f.fileName, content, buffer: buf, fileType: f.fileType, storageId: f.storageId });
    }

    // prioritize + truncate
    const kw = ["ТЗ", "техническ", "извещение", "документация", "НМЦ", "расчет", "приложение", "форма"];
    const sorted = [...parsed].sort((a, b) => {
      const ap = kw.some((k) => a.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
      const bp = kw.some((k) => b.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
      return ap - bp;
    });
    let total = 0;
    const incl: typeof parsed = [];
    for (const f of sorted) {
      if (total + f.content.length > 500000 && incl.length > 0) {
        const rem = 500000 - total;
        if (rem > 10000) incl.push({ ...f, content: f.content.slice(0, rem) + "\n...[ОБРЕЗАНО]" });
        break;
      }
      incl.push(f);
      total += f.content.length;
    }

    await up("Claude анализирует документы...", 20);
    const fc = incl.map((f) => `=== FILE: ${f.name} ===\n${f.content}`).join("\n\n---\n\n");
    const result = await callClaude(EXTRACTION_PROMPT, `Документы:\n\n${fc}`);
    const data = extractJson(result);
    await up("Сохранение данных...", 55);

    await client.mutation(api.procurements.updateFromAnalysis, {
      id: procurementId,
      number: data.procurementNumber || "",
      name: data.procurementName || "Без названия",
      nmck: Number(data.nmck) || 0,
      deliveryDeadline: data.deliveryDeadline || "",
      deliveryAddresses: data.deliveryAddresses || [],
    });

    await client.mutation(api.localApi.clearProcurementData, { procurementId });

    const items = data.items || [];
    if (items.length > 0) {
      await client.mutation(api.localApi.saveExtractedItemsBatch, {
        items: items.map((it: any) => ({
          procurementId, name: String(it.name || ""), quantity: Number(it.quantity) || 0,
          unit: String(it.unit || "шт"), nmckPrice: Number(it.nmckPrice) || 0,
          tzSpecs: String(it.tzSpecs || ""), quarter: String(it.quarter || ""),
          estimatedWeight: Number(it.estimatedWeight) || 0, estimatedDimensions: String(it.estimatedDimensions || ""),
          deliveryAllocations: (it.deliveryAllocations || []).map((a: any) => ({ address: String(a.address || ""), quantity: Number(a.quantity) || 0 })),
          deliveryCost: 0, deliveryCostEstimated: false,
        })),
      });
    }

    // forms
    await up("Нарезка форм...", 60);
    const forms = data.forms || [];
    const bufMap = new Map(parsed.map((f) => [f.name, { buffer: f.buffer, storageId: f.storageId }]));

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      await up(`Форма ${i + 1}/${forms.length}: ${form.name}`, 60 + Math.round((i / forms.length) * 10));
      const fd = bufMap.get(form.sourceFile || "");
      const lt = form.locationType || "whole_file";

      if (lt === "whole_file" && fd) {
        await client.mutation(api.localApi.saveExtractedForm, { procurementId, name: String(form.name), storageId: fd.storageId, fileName: form.sourceFile, sourceFile: form.sourceFile, fileType: form.sourceFile.split(".").pop()?.toLowerCase() || "docx", locationType: "whole_file" });
      } else if (lt === "paragraph_range" && fd) {
        try {
          const sb = await sliceDocx(fd.buffer, Number(form.startBlock) || 1, Number(form.endBlock) || 1);
          const sid = await uploadToStorage(client, sb, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
          await client.mutation(api.localApi.saveExtractedForm, { procurementId, name: String(form.name), storageId: sid, fileName: `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.docx`, sourceFile: form.sourceFile, fileType: "docx", locationType: "paragraph_range", sourceCoordinates: JSON.stringify({ startBlock: form.startBlock, endBlock: form.endBlock }) });
        } catch {}
      } else if (lt === "sheet" && fd && form.sheetName) {
        try {
          const sb = await sliceXlsxSheet(fd.buffer, form.sheetName);
          const sid = await uploadToStorage(client, sb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          await client.mutation(api.localApi.saveExtractedForm, { procurementId, name: String(form.name), storageId: sid, fileName: `${form.name.replace(/[^а-яА-ЯёЁa-zA-Z0-9\s\-_.]/g, "")}.xlsx`, sourceFile: form.sourceFile, fileType: "xlsx", locationType: "sheet", sourceCoordinates: JSON.stringify({ sheetName: form.sheetName }) });
        } catch {}
      }
    }

    // calculation
    await up("Генерация калькуляции...", 70);
    const calcResult = await callClaude(CALC_PROMPT, `Позиции:\n${JSON.stringify(items.map((it: any) => ({ name: it.name, quantity: it.quantity, unit: it.unit, nmckPrice: it.nmckPrice, tzSpecs: it.tzSpecs, pp1875: it.pp1875 || "" })), null, 2)}`);
    const calcRows = extractJson(calcResult);

    await up("Создание Excel...", 85);
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet("Калькуляция");
    sh.columns = ["№ п/п", "Наименование", "1875 ПП", "Количество", "НМЦК за ед.", "НМЦК общ.", "ТЗ характеристики", "НАШИ ХАРАКТЕРИСТИКИ", "Наша цена", "Наша Сумма", "Ссылка", "Примечание"].map((h, i) => ({ header: h, width: [6, 40, 15, 12, 14, 14, 40, 40, 16, 14, 20, 30][i] }));
    const hr = sh.getRow(1);
    hr.font = { bold: true };
    hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
    hr.alignment = { wrapText: true, vertical: "middle" };

    const rc = Array.isArray(calcRows) ? calcRows.length : items.length;
    const cItems: any[] = [];
    for (let i = 0; i < rc; i++) {
      const cr = Array.isArray(calcRows) ? calcRows[i] : null;
      const oi = items[i];
      const nm = cr?.itemName || oi?.name || "";
      const pp = cr?.pp1875 || oi?.pp1875 || "";
      const qt = Number(cr?.quantity || oi?.quantity) || 0;
      const np = Number(cr?.nmckPrice || oi?.nmckPrice) || 0;
      const ts = cr?.tzSpecs || oi?.tzSpecs || "";
      const rn = i + 2;
      const row = sh.addRow([i + 1, nm, pp, qt, np, null, ts, "", null, null, "", ""]);
      row.getCell(6).value = { formula: `D${rn}*E${rn}` } as any;
      row.getCell(10).value = { formula: `D${rn}*I${rn}` } as any;
      [8, 9, 12].forEach((c) => { row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }; });
      cItems.push({ procurementId, itemIndex: i, itemName: nm, pp1875: pp || undefined, quantity: qt, nmckPrice: np, tzSpecs: ts || undefined });
    }
    const tr = sh.addRow(["", "ИТОГО", "", "", "", { formula: `SUM(F2:F${rc + 1})` }, "", "", "", { formula: `SUM(J2:J${rc + 1})` }]);
    tr.font = { bold: true };

    await up("Сохранение...", 92);
    const exBuf = Buffer.from(await wb.xlsx.writeBuffer());
    const cSid = await uploadToStorage(client, exBuf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const proc = await client.query(api.procurements.get, { id: procurementId });
    await client.mutation(api.localApi.clearGeneratedFiles, { procurementId });
    await client.mutation(api.files.saveGeneratedFile, { procurementId, profileId: proc?.profileId || "pikhenek", storageId: cSid, fileName: `Калькуляция_${proc?.number || "draft"}.xlsx`, formType: "calculation" });
    if (cItems.length) await client.mutation(api.localApi.saveCalculationItemsBatch, { items: cItems });

    await client.mutation(api.procurements.updateStatus, { id: procurementId, status: "analyzed" as any, statusMessage: `Извлечено ${items.length} позиций, ${forms.length} форм`, progress: 100 });
  } catch (e: any) {
    console.error("Analysis error:", e.message);
    await client.mutation(api.procurements.updateStatus, { id: procurementId, status: "uploaded" as any, statusMessage: `Ошибка: ${e.message}`, progress: 0 }).catch(() => {});
  }
}

// ========== FORM FILLING ==========
export async function processFormFilling(
  procurementId: string,
  options?: { profileId?: string; formIds?: string[]; fillEngine?: "v1" | "v2" }
) {
  const client = getClient();
  const up = (msg: string, progress: number) =>
    client.mutation(api.procurements.updateStatus, { id: procurementId, status: "filling_forms" as any, statusMessage: msg, progress });

  try {
    const proc = await client.query(api.procurements.get, { id: procurementId });
    if (!proc) throw new Error("Закупка не найдена");
    const calcData = await client.query(api.files.getCalculationData, { procurementId });

    // Use provided profileId or fall back to procurement's profileId
    const activeProfileId = options?.profileId || proc.profileId;
    const profile = profiles[activeProfileId];
    if (!profile) throw new Error("Профиль не найден");

    const ourTotal = calcData.reduce((s: number, d: any) => s + (d.ourTotal || 0), 0);
    const ndsRate = profile.tax.ndsRate;
    const ctx = {
      procurement: { number: proc.number, name: proc.name, nmck: proc.nmck, deliveryDeadline: proc.deliveryDeadline, deliveryAddresses: proc.deliveryAddresses },
      pricing: { ourTotalPrice: ourTotal, ndsRate, ndsAmount: Math.round((ourTotal * ndsRate / (100 + ndsRate)) * 100) / 100, ndsLabel: profile.tax.ndsLabel },
      profile: { ...profile, kpp: profile.kpp || "нет (ИП)" },
      items: calcData.map((d: any) => ({ name: d.itemName, quantity: d.quantity, nmckPrice: d.nmckPrice, ourSpecs: d.ourSpecs, ourUnitPrice: d.ourUnitPrice, ourTotal: d.ourTotal, notes: d.notes, tzSpecs: d.tzSpecs })),
    };

    const allForms = await client.query(api.files.getExtractedForms, { procurementId });
    if (!allForms.length) throw new Error("Нет форм");

    // Filter to selected forms if specified
    const formsToFill = options?.formIds
      ? allForms.filter((f: any) => options.formIds!.includes(f._id))
      : allForms;

    if (!formsToFill.length) throw new Error("Нет выбранных форм");

    // Clear only the forms being re-filled (not all)
    if (options?.formIds) {
      const formTypes = formsToFill.map((f: any) => f.name);
      await client.mutation(api.localApi.clearGeneratedFilesByFormTypes, { procurementId, formTypes });
    } else {
      await client.mutation(api.localApi.clearGeneratedFilesExceptCalculation, { procurementId });
    }

    for (let i = 0; i < formsToFill.length; i++) {
      const form = formsToFill[i];
      if (!form.url) continue;
      await up(`Форма ${i + 1}/${formsToFill.length}: ${form.name}`, Math.round((i / formsToFill.length) * 80));

      let buf = Buffer.from(await (await fetch(form.url)).arrayBuffer());
      const mime = form.fileType === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      // V2 XLSX pipeline
      if (form.fileType === "xlsx" && options?.fillEngine === "v2") {
        const formMap = await buildFormMap(buf);
        const mapPrompt = `Форма: "${form.name}"\n\nСтруктура формы:\n${JSON.stringify(formMap, null, 2)}\n\nДанные:\n${JSON.stringify(ctx, null, 2)}`;
        const mapResult = await callClaude(FORM_MAP_PROMPT, mapPrompt);
        const mapping = extractJson(mapResult) as ClaudeMapping;
        const safeMapping: ClaudeMapping = {
          mappings: mapping.mappings || [],
          tables: mapping.tables || [],
          unmapped: mapping.unmapped || [],
          computed: mapping.computed || [],
        };
        const resolved = resolveMapping(safeMapping, ctx);
        buf = await applyXlsxV2(buf, resolved.cellValues, resolved.tableData);
        const check = await selfCheck(buf, resolved.cellValues, formMap);
        if (check.failed > 0) {
          const retryValues = check.details
            .filter(d => d.reason === "merged_cell" || d.reason === "write_failed")
            .map(d => ({ cell: d.cell, value: d.expected }));
          if (retryValues.length > 0) {
            buf = await applyXlsxV2(buf, retryValues);
          }
        }
      } else {
        // V1 pipeline (original)
        const txt = await parseFileContent(buf, mime, form.fileName);
        const fillResult = await callClaude(FORM_PROMPT, `Форма: "${form.name}"\n\nТекст:\n${txt}\n\nДанные:\n${JSON.stringify(ctx, null, 2)}`);
        const instr = extractJson(fillResult).instructions || [];

        if (form.fileType === "docx") buf = await applyDocxInstructions(buf, instr);
        else if (form.fileType === "xlsx") buf = await applyXlsxInstructions(buf, instr);

        // V1 self-check
        const filledTxt = await parseFileContent(buf, mime, form.fileName);
        const checkResult = await callClaude(CHECK_PROMPT, `Данные:\n${JSON.stringify(ctx, null, 2)}\n\nФорма "${form.name}":\n${filledTxt}`);
        const corr = extractJson(checkResult).corrections || [];
        if (corr.length) {
          if (form.fileType === "docx") buf = await applyDocxInstructions(buf, corr);
          else if (form.fileType === "xlsx") buf = await applyXlsxInstructions(buf, corr);
        }
      }

      const sid = await uploadToStorage(client, buf, mime);
      await client.mutation(api.files.saveGeneratedFile, { procurementId, profileId: activeProfileId, storageId: sid, fileName: `Заполнено_${form.fileName}`, formType: form.name });
    }

    await client.mutation(api.procurements.updateStatus, { id: procurementId, status: "completed" as any, statusMessage: `Заполнено ${formsToFill.length} форм`, progress: 100 });
  } catch (e: any) {
    console.error("Form fill error:", e.message);
    await client.mutation(api.procurements.updateStatus, { id: procurementId, status: "calculation_uploaded" as any, statusMessage: `Ошибка: ${e.message}`, progress: 0 }).catch(() => {});
  }
}
