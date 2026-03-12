# Two-Model AI Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded form generation with a two-model pipeline: Flash extracts forms from docs, Sonnet fills them.

**Architecture:** Gemini Flash 2.5 analyzes documents and finds form locations. Code slices forms from originals. Claude Sonnet 4.6 (via Polza.ai) generates calculation Excel and fills extracted forms with self-verification.

**Tech Stack:** Convex (Node actions), ExcelJS, JSZip, Gemini API, Polza.ai (OpenAI-compatible), mammoth

**Spec:** `docs/superpowers/specs/2026-03-12-two-stage-ai-pipeline-design.md`

---

## Chunk 1: Schema + API Helper + Cleanup

### Task 1: Update Convex Schema

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Update schema**

Replace the entire `convex/schema.ts` with the new schema:

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  procurements: defineTable({
    number: v.string(),
    name: v.string(),
    nmck: v.number(),
    deliveryDeadline: v.string(),
    deliveryAddresses: v.array(
      v.object({
        name: v.string(),
        address: v.string(),
      })
    ),
    status: v.union(
      v.literal("uploaded"),
      v.literal("analyzing"),
      v.literal("analyzed"),
      v.literal("calculation_uploaded"),
      v.literal("filling_forms"),
      v.literal("completed"),
      v.literal("error")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
  }),

  procurementFiles: defineTable({
    procurementId: v.id("procurements"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
  }).index("by_procurement", ["procurementId"]),

  extractedItems: defineTable({
    procurementId: v.id("procurements"),
    name: v.string(),
    quantity: v.number(),
    unit: v.string(),
    nmckPrice: v.number(),
    tzSpecs: v.string(),
    quarter: v.string(),
    estimatedWeight: v.number(),
    estimatedDimensions: v.string(),
    deliveryAllocations: v.array(
      v.object({
        address: v.string(),
        quantity: v.number(),
      })
    ),
    deliveryCost: v.number(),
    deliveryCostEstimated: v.boolean(),
  }).index("by_procurement", ["procurementId"]),

  extractedForms: defineTable({
    procurementId: v.id("procurements"),
    name: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    sourceFile: v.string(),
    fileType: v.string(),
    locationType: v.string(),
    sourceCoordinates: v.optional(v.string()),
  }).index("by_procurement", ["procurementId"]),

  calculationData: defineTable({
    procurementId: v.id("procurements"),
    itemIndex: v.number(),
    itemName: v.string(),
    pp1875: v.optional(v.string()),
    quantity: v.number(),
    nmckPrice: v.number(),
    tzSpecs: v.optional(v.string()),
    ourSpecs: v.optional(v.string()),
    ourUnitPrice: v.optional(v.number()),
    ourTotal: v.optional(v.number()),
    notes: v.optional(v.string()),
  }).index("by_procurement", ["procurementId"]),

  generatedFiles: defineTable({
    procurementId: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    storageId: v.id("_storage"),
    fileName: v.string(),
    formType: v.string(),
  }).index("by_procurement", ["procurementId"]),
});
```

- [ ] **Step 2: Run codegen to verify schema compiles**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success, no errors

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/schema.ts
git commit -m "feat: update schema for two-model pipeline

Add extractedForms table, update calculationData fields, remove
formTemplates table, update status union and generatedFiles.formType"
```

### Task 2: Update procurements.ts (new status values)

**Files:**
- Modify: `convex/procurements.ts`

- [ ] **Step 1: Update updateStatus mutation**

In `convex/procurements.ts`, replace the `status` union in `updateStatus.args` (lines 38-48) with:

```typescript
    status: v.union(
      v.literal("uploaded"),
      v.literal("analyzing"),
      v.literal("analyzed"),
      v.literal("calculation_uploaded"),
      v.literal("filling_forms"),
      v.literal("completed"),
      v.literal("error")
    ),
```

- [ ] **Step 2: Fix updateFromAnalysis to not set status**

In `convex/procurements.ts`, modify `updateFromAnalysis` handler (line 76-78) to NOT set status:

```typescript
  handler: async (ctx, args) => {
    const { id, ...data } = args;
    await ctx.db.patch(id, data); // removed: status: "analyzed"
  },
```

- [ ] **Step 3: Update remove mutation to also delete extractedForms**

In `convex/procurements.ts`, in the `remove` handler, add after the `extractedItems` deletion block (after line 99) and before the `calcData` block:

```typescript
    const extractedForms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) => q.eq("procurementId", args.id))
      .collect();
    for (const form of extractedForms) {
      await ctx.storage.delete(form.storageId);
      await ctx.db.delete(form._id);
    }
```

- [ ] **Step 4: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 5: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/procurements.ts
git commit -m "feat: update procurements for new status values and extractedForms cleanup"
```

### Task 3: Update files.ts (remove formTemplates, update generatedFiles)

**Files:**
- Modify: `convex/files.ts`

- [ ] **Step 1: Update saveGeneratedFile and add extractedForms queries**

Replace `saveGeneratedFile` mutation (lines 92-110) — change `formType` from union to `v.string()`:

```typescript
export const saveGeneratedFile = mutation({
  args: {
    procurementId: v.id("procurements"),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    storageId: v.id("_storage"),
    fileName: v.string(),
    formType: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("generatedFiles", args);
  },
});
```

Remove `getFormTemplate` and `saveFormTemplate` functions (lines 112-139).

Add new query for extracted forms:

```typescript
export const getExtractedForms = query({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const forms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();

    return Promise.all(
      forms.map(async (form) => ({
        ...form,
        url: await ctx.storage.getUrl(form.storageId),
      }))
    );
  },
});
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/files.ts
git commit -m "feat: update files.ts - free string formType, add extractedForms query, remove formTemplates"
```

### Task 4: Update analysisHelpers.ts

**Files:**
- Modify: `convex/analysisHelpers.ts`

- [ ] **Step 1: Update saveCalculationItem and add extractedForms helpers**

Replace `saveCalculationItem` (lines 111-124) with new signature:

```typescript
export const saveCalculationItem = internalMutation({
  args: {
    procurementId: v.id("procurements"),
    itemIndex: v.number(),
    itemName: v.string(),
    pp1875: v.optional(v.string()),
    quantity: v.number(),
    nmckPrice: v.number(),
    tzSpecs: v.optional(v.string()),
    ourSpecs: v.optional(v.string()),
    ourUnitPrice: v.optional(v.number()),
    ourTotal: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("calculationData", args);
  },
});
```

Add new mutations for extractedForms:

```typescript
export const saveExtractedForm = internalMutation({
  args: {
    procurementId: v.id("procurements"),
    name: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    sourceFile: v.string(),
    fileType: v.string(),
    locationType: v.string(),
    sourceCoordinates: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("extractedForms", args);
  },
});

export const clearExtractedForms = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const forms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const form of forms) {
      await ctx.storage.delete(form.storageId);
      await ctx.db.delete(form._id);
    }
  },
});
```

Add `clearGeneratedFilesExceptCalculation` mutation:

```typescript
export const clearGeneratedFilesExceptCalculation = internalMutation({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("generatedFiles")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const f of files) {
      if (f.formType !== "calculation") {
        await ctx.storage.delete(f.storageId);
        await ctx.db.delete(f._id);
      }
    }
  },
});
```

Update `clearProcurementData` (line 50-80) to also clear extractedForms:

After the `genFiles` cleanup block, add:

```typescript
    const extractedForms = await ctx.db
      .query("extractedForms")
      .withIndex("by_procurement", (q) =>
        q.eq("procurementId", args.procurementId)
      )
      .collect();
    for (const form of extractedForms) {
      await ctx.storage.delete(form.storageId);
      await ctx.db.delete(form._id);
    }
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/analysisHelpers.ts
git commit -m "feat: update analysisHelpers - new calculationData schema, extractedForms mutations"
```

### Task 5: Create Sonnet API helper

**Files:**
- Create: `convex/sonnetApi.ts`

- [ ] **Step 1: Create the helper file**

```typescript
const POLZA_BASE_URL = "https://polza.ai/api/v1";
const SONNET_MODEL = "anthropic/claude-sonnet-4.6";

export async function callSonnet(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 16384,
        temperature: 0.1,
      }),
    });

    if (res.status === 429) {
      const waitMs = 30000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Polza API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("Empty response from Sonnet");
    return content;
  }
  throw new Error("Polza API: max retries exceeded");
}

export function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ||
      text.match(/```\s*([\s\S]*?)\s*```/) ||
      text.match(/(\[[\s\S]*\])/) ||
      text.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1] || jsonMatch[0]);
    }
    throw new Error("Failed to extract JSON from Sonnet response");
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/sonnetApi.ts
git commit -m "feat: add Polza.ai/Sonnet API helper with retry and JSON extraction"
```

### Task 6: Delete old files

**Files:**
- Delete: `convex/generation.ts`
- Delete: `convex/docxHelpers.ts`
- Delete: `scripts/uploadTemplates.ts` (if exists)

- [ ] **Step 1: Delete files**

```bash
cd /home/Iurii/Projects/tender-master
rm -f convex/generation.ts convex/docxHelpers.ts scripts/uploadTemplates.ts
```

- [ ] **Step 2: Verify codegen still works**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success (no references to deleted files remain in convex/ exports)

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add -A convex/generation.ts convex/docxHelpers.ts scripts/uploadTemplates.ts
git commit -m "chore: remove old hardcoded form generation files

Delete generation.ts, docxHelpers.ts, and uploadTemplates.ts -
replaced by new two-model pipeline"
```

---

## Chunk 2: Block-Numbered Parser + DOCX Slicer

### Task 7: Add block-numbered DOCX parser

**Files:**
- Modify: `src/lib/parsers.ts`

- [ ] **Step 1: Add parseDocxWithBlocks function**

Add this new function to `src/lib/parsers.ts` after the existing `parseDocx` function (after line 7):

```typescript
export async function parseDocxWithBlocks(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "[No document.xml found]";

  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return "[No body found]";
  const bodyContent = bodyMatch[1];

  // Split body into top-level elements (w:p, w:tbl, etc.)
  const blockRegex = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  const blocks: string[] = [];
  let match;

  while ((match = blockRegex.exec(bodyContent)) !== null) {
    const element = match[0];
    const tagName = match[1];

    if (tagName === "w:tbl") {
      // Extract all text from table cells, format as rows
      const rows: string[] = [];
      const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(element)) !== null) {
        const cells: string[] = [];
        const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
          const cellText = cellMatch[0]
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim();
          cells.push(cellText);
        }
        rows.push("| " + cells.join(" | ") + " |");
      }
      blocks.push(rows.join("\n"));
    } else {
      // Paragraph: extract text
      const text = element
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        blocks.push(text);
      } else {
        blocks.push(""); // empty paragraph still gets a block number
      }
    }
  }

  return blocks
    .map((text, i) => `[Block ${i + 1}] ${text}`)
    .join("\n");
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /home/Iurii/Projects/tender-master && npx tsc --noEmit src/lib/parsers.ts` or just check with codegen.

Actually since this is under `src/`, verify with:
Run: `cd /home/Iurii/Projects/tender-master && npx next build 2>&1 | head -20`
Expected: Build starts without import errors (can cancel after initial check)

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add src/lib/parsers.ts
git commit -m "feat: add block-numbered DOCX parser for form discovery"
```

### Task 8: Create DOCX Slicer

**Files:**
- Create: `convex/docxSlicer.ts`

- [ ] **Step 1: Create the slicer**

```typescript
"use node";

import JSZip from "jszip";

/**
 * Slices a DOCX file by extracting body-level blocks in [startBlock, endBlock] range.
 * Block numbering: each <w:p>, <w:tbl>, <w:sdt> direct child of <w:body> = 1 block.
 * Returns a new DOCX buffer containing only the selected blocks.
 */
export async function sliceDocx(
  docxBuffer: Buffer,
  startBlock: number,
  endBlock: number
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No word/document.xml found in DOCX");

  const bodyMatch = docXml.match(
    /(<w:body[^>]*>)([\s\S]*)(<\/w:body>)/
  );
  if (!bodyMatch) throw new Error("No <w:body> found in document.xml");

  const bodyOpen = bodyMatch[1];
  const bodyContent = bodyMatch[2];
  const bodyClose = bodyMatch[3];

  // Extract section properties (w:sectPr) — must be preserved at end of body
  const sectPrMatch = bodyContent.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : "";

  // Split into top-level elements
  const blockRegex = /<(w:p|w:tbl|w:sdt)\b[\s\S]*?<\/\1>/g;
  const allBlocks: string[] = [];
  let match;
  while ((match = blockRegex.exec(bodyContent)) !== null) {
    allBlocks.push(match[0]);
  }

  // Validate range (1-based)
  const start = Math.max(1, startBlock) - 1; // convert to 0-based
  const end = Math.min(allBlocks.length, endBlock); // endBlock is inclusive
  const selectedBlocks = allBlocks.slice(start, end);

  if (selectedBlocks.length === 0) {
    throw new Error(
      `No blocks found in range ${startBlock}-${endBlock} (total: ${allBlocks.length})`
    );
  }

  // Build new document.xml
  const preamble = docXml.substring(0, docXml.indexOf("<w:body"));
  const newBody = `${bodyOpen}${selectedBlocks.join("")}${sectPr}${bodyClose}`;
  const postamble = docXml.substring(
    docXml.indexOf("</w:body>") + "</w:body>".length
  );
  const newDocXml = preamble + newBody + postamble;

  // Create new ZIP with all supporting files
  const newZip = new JSZip();

  // Copy all files from original except document.xml
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) {
      newZip.folder(path);
      continue;
    }
    if (path === "word/document.xml") {
      newZip.file(path, newDocXml);
    } else {
      // Copy styles, numbering, settings, fonts, themes, rels, content types, media
      const content = await file.async("uint8array");
      newZip.file(path, content);
    }
  }

  const result = await newZip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

/**
 * Extracts a single sheet from an XLSX workbook into a new workbook.
 */
export async function sliceXlsxSheet(
  xlsxBuffer: Buffer,
  sheetName: string
): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const srcWorkbook = new ExcelJS.Workbook();
  await srcWorkbook.xlsx.load(xlsxBuffer as unknown as ExcelJS.Buffer);

  const srcSheet = srcWorkbook.getWorksheet(sheetName);
  if (!srcSheet) {
    throw new Error(`Sheet "${sheetName}" not found in XLSX`);
  }

  const dstWorkbook = new ExcelJS.Workbook();
  const dstSheet = dstWorkbook.addWorksheet(sheetName);

  // Copy column widths
  srcSheet.columns.forEach((col, i) => {
    if (col.width) {
      dstSheet.getColumn(i + 1).width = col.width;
    }
  });

  // Copy rows with values and styles
  srcSheet.eachRow({ includeEmpty: true }, (srcRow, rowNumber) => {
    const dstRow = dstSheet.getRow(rowNumber);
    srcRow.eachCell({ includeEmpty: true }, (srcCell, colNumber) => {
      const dstCell = dstRow.getCell(colNumber);
      // Copy value (or formula)
      if (srcCell.formula) {
        dstCell.value = { formula: srcCell.formula } as ExcelJS.CellFormulaValue;
      } else {
        dstCell.value = srcCell.value;
      }
      // Copy style
      dstCell.style = { ...srcCell.style };
    });
    dstRow.height = srcRow.height;
    dstRow.commit();
  });

  // Copy merged cells
  srcSheet.model.merges?.forEach((merge: string) => {
    dstSheet.mergeCells(merge);
  });

  const buffer = await dstWorkbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/docxSlicer.ts
git commit -m "feat: add DOCX/XLSX slicer for form extraction by block ranges"
```

---

## Chunk 3: Analysis Pipeline (Stages 1-3)

### Task 9: Rewrite analysis.ts — Stage 1 (Flash) + Stage 2 (Slicing) + Stage 3 (Calculation)

**Files:**
- Modify: `convex/analysis.ts`

- [ ] **Step 1: Rewrite analysis.ts**

Replace the entire file:

```typescript
"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { parseFile } from "../src/lib/parsers";
import { parseDocxWithBlocks } from "../src/lib/parsers";
import { sliceDocx, sliceXlsxSheet } from "./docxSlicer";
import { callSonnet, extractJson } from "./sonnetApi";

// --- Stage 1: Flash prompts ---

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
- FORMS: Find all forms/templates (named "Форма", "Образец заполнения", "Приложение" with form-like structure) that a participant must fill and submit. For each form found INSIDE a DOCX document, specify the startBlock and endBlock numbers. For whole files that ARE forms, use locationType "whole_file". For XLSX sheets that are forms, use locationType "sheet" with sheetName.
- Do NOT invent forms. Only include forms actually present in the documents.
- Return ONLY valid JSON, no markdown or comments`;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(
  apiKey: string,
  prompt: string,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 65536,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (res.status === 429) {
      const waitMs = 60000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text)
        .join("") || "";

    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }
  throw new Error("Gemini API: max retries exceeded");
}

// --- Stage 3: Sonnet calculation prompt ---

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
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzing",
        statusMessage: msg,
        progress,
      });
    };

    try {
      // ========== STAGE 1: Flash Analysis (0-60%) ==========

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

        // For DOCX: use block-numbered parser so Flash can specify form locations
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

      // Prioritize and truncate
      await updateProgress(
        `Отправка ${parsedFiles.length} файлов в ИИ...`,
        15
      );

      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");

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

      const fullPrompt = `${EXTRACTION_PROMPT}\n\nДокументы:\n\n${fileContents}`;

      await updateProgress("ИИ анализирует документы...", 20);

      const result = await callGemini(geminiKey, fullPrompt);

      await updateProgress("Обработка ответа ИИ...", 50);

      let extractedData: any;
      try {
        extractedData = JSON.parse(result);
      } catch {
        const jsonMatch =
          result.match(/```json\s*([\s\S]*?)\s*```/) ||
          result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } else {
          throw new Error("Failed to parse AI response as JSON");
        }
      }

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
      // Build a lookup of file buffers by name
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
          // Whole file — reuse storageId
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
            const blob = new Blob([slicedBuffer], {
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
            const blob = new Blob([slicedBuffer], {
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

      // ========== STAGE 3: Sonnet Calculation (70-95%) ==========

      await updateProgress("Генерация калькуляции (Sonnet)...", 70);

      const polzaKey = process.env.POLZA_API_KEY;
      if (!polzaKey) throw new Error("POLZA_API_KEY is not set");

      // Prepare items data for Sonnet
      const itemsForSonnet = items.map((item: any) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        nmckPrice: item.nmckPrice,
        tzSpecs: item.tzSpecs,
        pp1875: item.pp1875 || "",
      }));

      const sonnetResult = await callSonnet(
        polzaKey,
        CALCULATION_SYSTEM_PROMPT,
        `Позиции из документации закупки:\n\n${JSON.stringify(itemsForSonnet, null, 2)}`
      );

      const calcRows = extractJson(sonnetResult);

      await updateProgress("Создание Excel калькуляции...", 85);

      // Build calculation Excel
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Калькуляция");

      // Headers matching the template
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

      // Fill data rows from Sonnet response
      const rowCount = Array.isArray(calcRows) ? calcRows.length : items.length;
      for (let i = 0; i < rowCount; i++) {
        const calcRow = Array.isArray(calcRows) ? calcRows[i] : null;
        const origItem = items[i];

        const itemName = calcRow?.itemName || origItem?.name || "";
        const pp1875 = calcRow?.pp1875 || origItem?.pp1875 || "";
        const quantity = Number(calcRow?.quantity || origItem?.quantity) || 0;
        const nmckPrice = Number(calcRow?.nmckPrice || origItem?.nmckPrice) || 0;
        const tzSpecs = calcRow?.tzSpecs || origItem?.tzSpecs || "";

        const rowNum = i + 2; // 1-based, row 1 is header
        const row = sheet.addRow([
          i + 1,         // A: № п/п
          itemName,      // B: Наименование
          pp1875,        // C: 1875 ПП
          quantity,       // D: Количество
          nmckPrice,      // E: НМЦК за ед.
          null,           // F: formula
          tzSpecs,        // G: Характеристики ТЗ
          "",             // H: user fills
          null,           // I: user fills
          null,           // J: formula
          "",             // K: optional
          "",             // L: user fills
        ]);

        // Formulas for F and J
        row.getCell(6).value = { formula: `D${rowNum}*E${rowNum}` } as ExcelJS.CellFormulaValue;
        row.getCell(10).value = { formula: `D${rowNum}*I${rowNum}` } as ExcelJS.CellFormulaValue;

        // Highlight user-fill columns (H, I, L) in yellow
        [8, 9, 12].forEach((col) => {
          row.getCell(col).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFF2CC" },
          };
        });

        // Save calculation data (columns A-G from Sonnet)
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

      // Totals row
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

      // Clear old generated files before saving new ones
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
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "error",
        statusMessage: `Ошибка анализа: ${error.message}`,
        progress: 0,
      });
    }
  },
});
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/analysis.ts
git commit -m "feat: rewrite analysis.ts with 3-stage pipeline

Stage 1: Flash with block-numbered DOCX for form discovery
Stage 2: Programmatic form slicing (DOCX/XLSX)
Stage 3: Sonnet calculation generation via Polza.ai"
```

---

## Chunk 4: Calculation Upload + Form Filling

### Task 10: Rewrite calculationUpload.ts

**Files:**
- Modify: `convex/calculationUpload.ts`

- [ ] **Step 1: Rewrite to parse H, I, J, L with new schema**

Replace the entire file:

```typescript
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

      // Read user-filled columns
      const ourSpecs = String(row.getCell(8).value || "") || undefined; // H
      const ourUnitPrice = Number(row.getCell(9).value) || undefined;   // I
      const ourTotal = Number(row.getCell(10).value) || undefined;      // J
      const notes = String(row.getCell(12).value || "") || undefined;   // L

      await ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
        procurementId: args.procurementId,
        itemIndex,
        itemName: existing.itemName,
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
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/calculationUpload.ts
git commit -m "feat: rewrite calculationUpload for new schema - parse H, I, J, L columns"
```

### Task 11: Remove old calculationTemplate.ts (now merged into analysis.ts)

**Files:**
- Delete: `convex/calculationTemplate.ts`

- [ ] **Step 1: Delete the file**

Calculation generation is now part of Stage 3 in `analysis.ts`. The old file is no longer needed.

```bash
cd /home/Iurii/Projects/tender-master
rm convex/calculationTemplate.ts
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/calculationTemplate.ts
git commit -m "chore: remove calculationTemplate.ts - calculation now in analysis.ts Stage 3"
```

### Task 12: Create formFilling.ts (Stages 4-5)

**Files:**
- Create: `convex/formFilling.ts`

- [ ] **Step 1: Create the form filling action**

```typescript
"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { callSonnet, extractJson } from "./sonnetApi";
import { parseFile } from "../src/lib/parsers";
import { profiles } from "../src/lib/profiles";
import JSZip from "jszip";
import ExcelJS from "exceljs";

// --- Prompts ---

const FORM_ANALYSIS_PROMPT = `You are filling procurement forms for a Russian tender.
You will receive:
1. The text content of a form that needs to be filled
2. Calculation data (item names, specs, prices, quantities)
3. Company profile data (legal entity details)
4. Procurement metadata (number, name, deadline, addresses)

Analyze the form and return JSON fill instructions.

For DOCX forms, return:
{
  "instructions": [
    {"type": "replace", "search": "placeholder text or ___", "value": "filled value"},
    {"type": "replace", "search": "another placeholder", "value": "filled value"}
  ],
  "formType": "brief description of form purpose"
}

For XLSX forms, return:
{
  "instructions": [
    {"type": "cell", "row": 5, "col": 3, "value": "filled value"},
    {"type": "cell", "row": 6, "col": 3, "value": "filled value"}
  ],
  "formType": "brief description of form purpose"
}

IMPORTANT:
- Fill ALL fields you can identify from the available data
- For company details, use the provided profile data exactly
- For prices and quantities, use the calculation data
- Use "replace" type for DOCX: search for the placeholder text (underscores, brackets, empty lines after labels) and replace with actual values
- Do NOT invent data that isn't available
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

export const fillForms = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const updateProgress = async (msg: string, progress: number) => {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "filling_forms",
        statusMessage: msg,
        progress,
      });
    };

    try {
      await updateProgress("Подготовка к заполнению форм...", 0);

      const polzaKey = process.env.POLZA_API_KEY;
      if (!polzaKey) throw new Error("POLZA_API_KEY is not set");

      // Load all data
      const procurement = await ctx.runQuery(api.procurements.get, {
        id: args.procurementId,
      });
      if (!procurement) throw new Error("Procurement not found");

      const calcData = await ctx.runQuery(api.files.getCalculationData, {
        procurementId: args.procurementId,
      });
      const extractedForms = await ctx.runQuery(api.files.getExtractedForms, {
        procurementId: args.procurementId,
      });

      if (extractedForms.length === 0) {
        throw new Error("Нет извлечённых форм для заполнения");
      }

      const profile = profiles[procurement.profileId];
      if (!profile) throw new Error(`Profile ${procurement.profileId} not found`);

      // Prepare context data for Sonnet
      const contextData = {
        procurement: {
          number: procurement.number,
          name: procurement.name,
          nmck: procurement.nmck,
          deliveryDeadline: procurement.deliveryDeadline,
          deliveryAddresses: procurement.deliveryAddresses,
        },
        profile: {
          fullName: profile.fullName,
          shortName: profile.shortName,
          inn: profile.inn,
          ogrn: profile.ogrn,
          okpo: profile.okpo,
          kpp: profile.kpp,
          oktmo: profile.oktmo,
          okved: profile.okved,
          legalAddress: profile.legalAddress,
          mailingAddress: profile.mailingAddress,
          actualAddress: profile.actualAddress,
          bank: profile.bank,
          director: profile.director,
        },
        items: calcData.map((d) => ({
          name: d.itemName,
          quantity: d.quantity,
          nmckPrice: d.nmckPrice,
          ourSpecs: d.ourSpecs,
          ourUnitPrice: d.ourUnitPrice,
          ourTotal: d.ourTotal,
          notes: d.notes,
          tzSpecs: d.tzSpecs,
        })),
      };

      // Clear old generated files (except calculation) via internal mutation
      await ctx.runMutation(
        internal.analysisHelpers.clearGeneratedFilesExceptCalculation,
        { procurementId: args.procurementId }
      );

      const allConfidenceReports: any[] = [];

      // ========== STAGE 4: Fill each form ==========

      for (let i = 0; i < extractedForms.length; i++) {
        const form = extractedForms[i];
        const formProgress = Math.round((i / extractedForms.length) * 80);
        await updateProgress(
          `Заполнение формы ${i + 1}/${extractedForms.length}: ${form.name}`,
          formProgress
        );

        if (!form.url) continue;

        // Fetch form file
        const formResponse = await fetch(form.url);
        const formArrayBuffer = await formResponse.arrayBuffer();
        let formBuffer = Buffer.from(formArrayBuffer);

        // Parse form content for Sonnet
        const formText = await parseFile(
          formBuffer,
          form.fileType === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          form.fileName
        );

        // Step 1-2: Get fill instructions from Sonnet
        const fillResult = await callSonnet(
          polzaKey,
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

        // ========== STAGE 5: Self-check (max 2 iterations) ==========

        let confidenceReport: any = null;

        for (let checkIter = 0; checkIter < 2; checkIter++) {
          const filledText = await parseFile(
            formBuffer,
            form.fileType === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            form.fileName
          );

          const checkResult = await callSonnet(
            polzaKey,
            SELF_CHECK_PROMPT,
            `Исходные данные:\n${JSON.stringify(contextData, null, 2)}\n\nЗаполненная форма "${form.name}":\n${filledText}`
          );

          const checkData = extractJson(checkResult);
          confidenceReport = {
            formName: form.name,
            status: "filled",
            fields: checkData.confidence || [],
            warnings: checkData.warnings || [],
          };

          const corrections = checkData.corrections || [];
          if (corrections.length === 0) break;

          // Apply corrections
          if (form.fileType === "docx") {
            formBuffer = await applyDocxInstructions(formBuffer, corrections);
          } else if (form.fileType === "xlsx") {
            formBuffer = await applyXlsxInstructions(formBuffer, corrections);
          }
        }

        if (confidenceReport) {
          allConfidenceReports.push(confidenceReport);
        }

        // Save filled form
        const mimeType =
          form.fileType === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        const blob = new Blob([formBuffer], { type: mimeType });
        const storageId = await ctx.storage.store(blob);

        await ctx.runMutation(api.files.saveGeneratedFile, {
          procurementId: args.procurementId,
          profileId: procurement.profileId,
          storageId,
          fileName: `Заполнено_${form.fileName}`,
          formType: form.name,
        });
      }

      // Save confidence report
      await updateProgress("Сохранение отчёта проверки...", 90);

      const reportJson = JSON.stringify(allConfidenceReports, null, 2);
      const reportBlob = new Blob([reportJson], { type: "application/json" });
      const reportStorageId = await ctx.storage.store(reportBlob);

      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: reportStorageId,
        fileName: "Отчёт_проверки.json",
        formType: "confidenceReport",
      });

      // Done
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "completed",
        statusMessage: `Заполнено ${extractedForms.length} форм`,
        progress: 100,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "error",
        statusMessage: `Ошибка заполнения форм: ${error.message}`,
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
  instructions: Array<{ type: string; search: string; value: string }>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let docXml = (await zip.file("word/document.xml")?.async("string")) || "";

  // Merge adjacent runs to prevent search failures from Word's run splitting
  docXml = mergeDocxRuns(docXml);

  for (const inst of instructions) {
    if (inst.type === "replace" && inst.search && inst.value) {
      // Escape XML special chars in the replacement value
      const safeValue = inst.value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

      // Search in the text content within <w:t> tags
      const escaped = inst.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      docXml = docXml.replace(new RegExp(escaped, "g"), safeValue);
    }
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

async function applyXlsxInstructions(
  buffer: Buffer,
  instructions: Array<{ type: string; row: number; col: number; value: string }>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) return buffer;

  for (const inst of instructions) {
    if (inst.type === "cell" && inst.row && inst.col) {
      sheet.getRow(inst.row).getCell(inst.col).value = inst.value;
    }
  }

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}
```

- [ ] **Step 2: Verify codegen**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen`
Expected: Success

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add convex/formFilling.ts
git commit -m "feat: add formFilling.ts - Sonnet fills forms + self-check + confidence report"
```

---

## Chunk 5: Frontend Updates

### Task 13: Update StatusBadge

**Files:**
- Modify: `src/components/status-badge.tsx`

- [ ] **Step 1: Update status config**

Replace the `STATUS_CONFIG` object (lines 1-17):

```typescript
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  uploaded: { label: "Загружено", color: "bg-gray-100 text-gray-700" },
  analyzing: { label: "Анализ...", color: "bg-blue-100 text-blue-700" },
  analyzed: { label: "Калькуляция готова", color: "bg-green-100 text-green-700" },
  calculation_uploaded: {
    label: "Калькуляция загружена",
    color: "bg-orange-100 text-orange-700",
  },
  filling_forms: {
    label: "Заполнение форм...",
    color: "bg-blue-100 text-blue-700",
  },
  completed: { label: "Готово", color: "bg-emerald-100 text-emerald-700" },
  error: { label: "Ошибка", color: "bg-red-100 text-red-700" },
};
```

- [ ] **Step 2: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add src/components/status-badge.tsx
git commit -m "feat: update StatusBadge for new pipeline statuses"
```

### Task 14: Update procurement detail page

**Files:**
- Modify: `src/app/procurement/[id]/page.tsx`

- [ ] **Step 1: Rewrite the page for new pipeline flow**

Replace the entire file:

```typescript
"use client";

import { use, useState, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Header } from "@/components/header";
import { FileDropzone } from "@/components/file-dropzone";
import { ExtractedItemsTable } from "@/components/extracted-items-table";
import { GeneratedFilesList } from "@/components/generated-files-list";
import { StatusBadge } from "@/components/status-badge";
import { ProgressBar } from "@/components/progress-bar";
import Link from "next/link";
import type { Id } from "../../../../convex/_generated/dataModel";

type ProfileId = "boltinov" | "pikhenek";

export default function ProcurementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const procurementId = id as Id<"procurements">;

  const procurement = useQuery(api.procurements.get, { id: procurementId });
  const uploadedFiles = useQuery(api.files.listByProcurement, {
    procurementId,
  });
  const extractedItems = useQuery(api.files.getExtractedItems, {
    procurementId,
  });
  const extractedForms = useQuery(api.files.getExtractedForms, {
    procurementId,
  });
  const generatedFiles = useQuery(api.files.getGeneratedFiles, {
    procurementId,
  });

  const analyzeDocuments = useAction(api.analysis.analyzeDocuments);
  const parseCalculation = useAction(api.calculationUpload.parseCalculation);
  const fillForms = useAction(api.formFilling.fillForms);

  const [profileId, setProfileId] = useState<ProfileId>("pikhenek");
  const [analyzing, setAnalyzing] = useState(false);
  const [filling, setFilling] = useState(false);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      await analyzeDocuments({ procurementId });
    } finally {
      setAnalyzing(false);
    }
  }, [analyzeDocuments, procurementId]);

  const handleCalculationUpload = useCallback(
    async (storageId: Id<"_storage">) => {
      await parseCalculation({ procurementId, storageId });
    },
    [parseCalculation, procurementId]
  );

  const handleFillForms = useCallback(async () => {
    setFilling(true);
    try {
      await fillForms({ procurementId });
    } finally {
      setFilling(false);
    }
  }, [fillForms, procurementId]);

  if (procurement === undefined)
    return (
      <div className="min-h-screen">
        <Header profileId={profileId} onProfileChange={setProfileId} />
        <main className="max-w-4xl mx-auto p-6">Загрузка...</main>
      </div>
    );

  if (procurement === null)
    return (
      <div className="min-h-screen">
        <Header profileId={profileId} onProfileChange={setProfileId} />
        <main className="max-w-4xl mx-auto p-6">Закупка не найдена</main>
      </div>
    );

  const isAnalyzing = procurement.status === "analyzing" || analyzing;
  const isAnalyzed = [
    "analyzed",
    "calculation_uploaded",
    "filling_forms",
    "completed",
  ].includes(procurement.status);
  const isFilling = procurement.status === "filling_forms" || filling;
  const isCompleted = procurement.status === "completed";
  const hasCalculation = [
    "calculation_uploaded",
    "filling_forms",
    "completed",
  ].includes(procurement.status);

  const calculationFile = generatedFiles?.find(
    (f) => f.formType === "calculation"
  );
  const confidenceReport = generatedFiles?.find(
    (f) => f.formType === "confidenceReport"
  );
  const filledForms = generatedFiles?.filter(
    (f) => f.formType !== "calculation" && f.formType !== "confidenceReport"
  );

  return (
    <div className="min-h-screen">
      <Header profileId={profileId} onProfileChange={setProfileId} />
      <main className="max-w-4xl mx-auto p-6">
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            &larr; Назад
          </Link>
        </div>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold">
              {procurement.name || "Новая закупка"}
            </h2>
            {procurement.number && (
              <p className="text-sm text-muted-foreground">
                &numero; {procurement.number}
              </p>
            )}
          </div>
          <StatusBadge status={procurement.status} />
        </div>

        {procurement.status === "error" && procurement.statusMessage && (
          <div className="mb-4 p-3 rounded text-sm bg-red-50 text-red-700">
            {procurement.statusMessage}
          </div>
        )}

        {(isAnalyzing || isFilling) && (
          <div className="mb-4 p-4 bg-blue-50 rounded-lg">
            <ProgressBar
              progress={procurement.progress ?? 0}
              message={procurement.statusMessage}
            />
          </div>
        )}

        {!isAnalyzing &&
          !isFilling &&
          procurement.status !== "error" &&
          procurement.statusMessage && (
            <div className="mb-4 p-3 rounded text-sm bg-blue-50 text-blue-700">
              {procurement.statusMessage}
            </div>
          )}

        {/* Stage 1: Upload & Analysis */}
        <div className="bg-white rounded-lg border p-6 mb-6">
          <h3 className="font-semibold mb-4">
            Этап 1: Загрузка и анализ документации
          </h3>

          <FileDropzone
            procurementId={procurementId}
            label="Перетащите файлы закупки (docx, xlsx, pdf) или нажмите для выбора"
            accept=".docx,.xlsx,.pdf"
          />

          {uploadedFiles && uploadedFiles.length > 0 && (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">
                Загружено файлов: {uploadedFiles.length}
              </p>
              <ul className="text-xs text-muted-foreground space-y-1">
                {uploadedFiles.map((f) => (
                  <li key={f._id}>&#128196; {f.fileName}</li>
                ))}
              </ul>
            </div>
          )}

          {uploadedFiles && uploadedFiles.length > 0 && !isAnalyzed && (
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing}
              className="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {isAnalyzing ? "Анализ..." : "Анализировать"}
            </button>
          )}

          {isAnalyzed && extractedItems && extractedItems.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium mb-2">
                Извлечённые позиции ({extractedItems.length}):
              </h4>
              <ExtractedItemsTable items={extractedItems} />
            </div>
          )}

          {isAnalyzed && extractedForms && extractedForms.length > 0 && (
            <div className="mt-4 p-3 bg-gray-50 rounded">
              <h4 className="text-sm font-medium mb-2">
                Найденные формы ({extractedForms.length}):
              </h4>
              <ul className="text-xs text-muted-foreground space-y-1">
                {extractedForms.map((f) => (
                  <li key={f._id}>
                    &#128203; {f.name}
                    <span className="ml-2 text-gray-400">
                      ({f.sourceFile}, {f.locationType})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Stage 2: Calculation */}
        {isAnalyzed && (
          <div className="bg-white rounded-lg border p-6 mb-6">
            <h3 className="font-semibold mb-4">Этап 2: Калькуляция</h3>

            {calculationFile && calculationFile.url && (
              <div className="mb-4">
                <a
                  href={calculationFile.url}
                  download={calculationFile.fileName}
                  className="inline-flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700"
                >
                  &#128229; Скачать калькуляцию
                </a>
              </div>
            )}

            {!hasCalculation && (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  Заполните колонки H (Наши характеристики), I (Наша цена), L
                  (Примечание) и загрузите обратно.
                </p>
                <FileDropzone
                  procurementId={procurementId}
                  label="Загрузите заполненную калькуляцию (.xlsx)"
                  accept=".xlsx"
                  onUploadComplete={handleCalculationUpload}
                />
              </>
            )}
          </div>
        )}

        {/* Stage 3: Form Filling */}
        {hasCalculation && (
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-4">Этап 3: Заполнение форм</h3>

            {!isCompleted && (
              <button
                onClick={handleFillForms}
                disabled={isFilling}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {isFilling ? "Заполнение..." : "Заполнить формы"}
              </button>
            )}

            {isCompleted && filledForms && filledForms.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-medium mb-2">
                  Заполненные формы:
                </h4>
                <GeneratedFilesList files={filledForms} />
              </div>
            )}

            {isCompleted && confidenceReport && (
              <ConfidenceReportCard url={confidenceReport.url} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// --- Confidence Report Component ---

function ConfidenceReportCard({ url }: { url: string | null }) {
  const [report, setReport] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    if (!url || report) return;
    setLoading(true);
    try {
      const res = await fetch(url);
      const data = await res.json();
      setReport(data);
    } finally {
      setLoading(false);
    }
  }, [url, report]);

  if (!url) return null;

  return (
    <div className="mt-6 p-4 bg-gray-50 rounded-lg border">
      <h4 className="text-sm font-medium mb-3">Отчёт проверки</h4>
      {!report && (
        <button
          onClick={loadReport}
          disabled={loading}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          {loading ? "Загрузка..." : "Показать отчёт"}
        </button>
      )}
      {report &&
        report.map((formReport: any, idx: number) => (
          <div key={idx} className="mb-4 last:mb-0">
            <p className="text-sm font-medium">{formReport.formName}</p>
            {formReport.fields?.map((field: any, fi: number) => (
              <div key={fi} className="flex items-center gap-2 text-xs mt-1">
                <span
                  className={`w-2 h-2 rounded-full ${
                    field.confidence === "high"
                      ? "bg-green-500"
                      : field.confidence === "medium"
                        ? "bg-yellow-500"
                        : "bg-red-500"
                  }`}
                />
                <span className="text-gray-600">{field.field}:</span>
                <span>{field.value}</span>
                {field.note && (
                  <span className="text-gray-400">({field.note})</span>
                )}
              </div>
            ))}
            {formReport.warnings?.length > 0 && (
              <div className="mt-2">
                {formReport.warnings.map((w: string, wi: number) => (
                  <p key={wi} className="text-xs text-orange-600">
                    &#9888;&#65039; {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /home/Iurii/Projects/tender-master && npx convex codegen && npx next build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add src/app/procurement/[id]/page.tsx src/components/status-badge.tsx
git commit -m "feat: update frontend for two-model pipeline

- New 3-stage UI: Analysis → Calculation → Form Filling
- Show extracted forms list
- Confidence report display with color-coded fields
- Remove old generateForms/generateTemplate references"
```

---

## Chunk 6: Environment Setup + Verification

### Task 15: Set POLZA_API_KEY in Convex

- [ ] **Step 1: Set the API key**

```bash
cd /home/Iurii/Projects/tender-master && npx convex env set POLZA_API_KEY "<your-polza-api-key>"
```

- [ ] **Step 2: Verify it's set**

```bash
cd /home/Iurii/Projects/tender-master && npx convex env list
```
Expected: `POLZA_API_KEY` appears in the list

### Task 16: Deploy and verify

- [ ] **Step 1: Deploy backend**

```bash
cd /home/Iurii/Projects/tender-master && npx convex deploy --yes
```
Expected: Successful deployment with no errors

- [ ] **Step 2: Build frontend**

```bash
cd /home/Iurii/Projects/tender-master && npx next build
```
Expected: Build succeeds

- [ ] **Step 3: Deploy frontend (if needed)**

```bash
cd /home/Iurii/Projects/tender-master && vercel --yes --prod
```

- [ ] **Step 4: End-to-end test**

1. Open the app
2. Create a new procurement
3. Upload procurement documents from `/home/Iurii/docs/`
4. Click "Анализировать" — verify Flash extracts items AND finds forms
5. Download calculation Excel — verify columns A-G are filled by Sonnet
6. Fill columns H, I, L with test data, upload back
7. Click "Заполнить формы" — verify forms are filled
8. Check confidence report

- [ ] **Step 5: Commit any fixes**

```bash
cd /home/Iurii/Projects/tender-master
git add -A
git commit -m "fix: post-deployment fixes from E2E testing"
```
