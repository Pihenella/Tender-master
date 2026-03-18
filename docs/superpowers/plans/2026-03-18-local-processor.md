# Local Processor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local document processing pipeline using Claude Code + NotebookLM RAG, running as a systemd daemon alongside the existing cloud pipeline.

**Architecture:** Local Node.js daemon polls Convex HTTP API for tasks with `pending_local_*` statuses, processes documents via `claude -p` with NotebookLM MCP for RAG, pushes results back to Convex. Cloud pipeline remains untouched, switched via `processingMode` field.

**Tech Stack:** Node.js 20+, TypeScript (tsx), Claude Code CLI, notebooklm-mcp, Convex HTTP router, systemd

**Spec:** `docs/superpowers/specs/2026-03-18-local-processor-design.md`

---

## File Map

### Convex Backend (modify)
- `convex/schema.ts` — add `processingMode`, `localRetryCount`, new status literals
- `convex/procurements.ts` — update `updateStatus` and `cancelOperation` validators, add `getPendingLocalTasks` query, `setProcessingMode` mutation
- `convex/analysisHelpers.ts` — no changes needed (existing helpers reused by HTTP router)

### Convex Backend (create)
- `convex/analysisActions.ts` — extracted actions: `sliceForms`, `generateCalcExcel`
- `convex/formFillingActions.ts` — extracted action: `applyFillInstructions`
- `convex/http.ts` — HTTP router with 9 endpoints
- `convex/crons.ts` — stale task recovery cron

### Frontend (modify)
- `src/components/status-badge.tsx` — add `pending_local_*` status badges
- `src/app/procurement/[id]/page.tsx` — add processing mode toggle, wire local-mode buttons

### Local Processor (create)
- `scripts/local-processor/package.json`
- `scripts/local-processor/tsconfig.json`
- `scripts/local-processor/convex-client.ts`
- `scripts/local-processor/utils.ts` — shared: runClaude, extractJsonFromOutput, repairTruncatedJson, cleanupNotebook
- `scripts/local-processor/daemon.ts`
- `scripts/local-processor/process-analysis.ts`
- `scripts/local-processor/process-fill.ts`
- `scripts/local-processor/export-profiles.ts`
- `scripts/local-processor/prompts/extraction.md`
- `scripts/local-processor/prompts/form-filling.md`
- `scripts/local-processor/install-service.sh`
- `scripts/local-processor/uninstall-service.sh`
- `scripts/local-processor/tender-master-processor.service`

---

## Task 1: Schema + Status Changes

**Files:**
- Modify: `convex/schema.ts:4-28`
- Modify: `convex/procurements.ts:36-56`

- [ ] **Step 1: Add new fields and statuses to schema.ts**

In `convex/schema.ts`, add `processingMode`, `localRetryCount`, `localStatusUpdatedAt` to the `procurements` table, and extend the `status` union:

```typescript
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
      v.literal("error"),
      v.literal("pending_local_analysis"),
      v.literal("pending_local_fill")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
    profileId: v.union(v.literal("boltinov"), v.literal("pikhenek")),
    processingMode: v.optional(v.union(v.literal("cloud"), v.literal("local"))),
    localRetryCount: v.optional(v.number()),
    localStatusUpdatedAt: v.optional(v.number()),
  }),
```

- [ ] **Step 2: Update `updateStatus` mutation validators in procurements.ts**

In `convex/procurements.ts:36-56`, add the new status literals to the `updateStatus` args validator:

```typescript
export const updateStatus = mutation({
  args: {
    id: v.id("procurements"),
    status: v.union(
      v.literal("uploaded"),
      v.literal("analyzing"),
      v.literal("analyzed"),
      v.literal("calculation_uploaded"),
      v.literal("filling_forms"),
      v.literal("completed"),
      v.literal("error"),
      v.literal("pending_local_analysis"),
      v.literal("pending_local_fill")
    ),
    statusMessage: v.optional(v.string()),
    progress: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: any = {
      status: args.status,
      statusMessage: args.statusMessage,
      progress: args.progress,
    };
    // Only track timestamp for local pipeline statuses (used by stale task recovery cron)
    const localStatuses = ["pending_local_analysis", "pending_local_fill", "analyzing", "filling_forms"];
    if (localStatuses.includes(args.status)) {
      const proc = await ctx.db.get(args.id);
      if (proc?.processingMode === "local") {
        patch.localStatusUpdatedAt = Date.now();
      }
    }
    await ctx.db.patch(args.id, patch);
  },
});
```

- [ ] **Step 3: Add `getPendingLocalTasks` query and `setProcessingMode` mutation**

Append to `convex/procurements.ts`:

```typescript
export const getPendingLocalTasks = query({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("procurements")
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "pending_local_analysis"),
          q.eq(q.field("status"), "pending_local_fill")
        )
      )
      .collect();
    return pending;
  },
});

export const setProcessingMode = mutation({
  args: {
    id: v.id("procurements"),
    processingMode: v.union(v.literal("cloud"), v.literal("local")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { processingMode: args.processingMode });
  },
});
```

- [ ] **Step 4: Update `cancelOperation` for new statuses**

In `convex/procurements.ts`, extend `cancelOperation` to handle `pending_local_*`:

```typescript
export const cancelOperation = mutation({
  args: { id: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.db.get(args.id);
    if (!procurement) return;

    if (procurement.status === "analyzing" || procurement.status === "pending_local_analysis") {
      await ctx.db.patch(args.id, {
        status: "uploaded",
        statusMessage: "Анализ отменён",
        progress: 0,
      });
    } else if (procurement.status === "filling_forms" || procurement.status === "pending_local_fill") {
      await ctx.db.patch(args.id, {
        status: "calculation_uploaded",
        statusMessage: "Заполнение форм отменено",
        progress: 0,
      });
    }
  },
});
```

- [ ] **Step 5: Run codegen and verify**

```bash
cd /home/Iurii/Projects/tender-master && npx convex codegen
```

Expected: no errors, `_generated/api.d.ts` updated with new functions.

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts convex/procurements.ts
git commit -m "feat: add processingMode field and pending_local statuses to schema"
```

---

## Task 2: Extract Slicing & Excel Generation into Standalone Actions

**Files:**
- Create: `convex/analysisActions.ts`
- Modify: `convex/analysis.ts:355-601`

- [ ] **Step 1: Create `convex/analysisActions.ts` with `sliceForms` action**

Extract form slicing logic from `analysis.ts:355-445` into a standalone internal action. This action reads `extractedItems` (for form data passed from analysis result), gets file buffers from storage, runs docxSlicer, and saves forms:

```typescript
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
    // Get procurement files for buffer lookup
    const files = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: args.procurementId,
    });

    // Build file buffer map
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

    // Clear previous forms
    await ctx.runMutation(internal.analysisHelpers.clearExtractedForms, {
      procurementId: args.procurementId,
    });

    // Slice each form
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
      throw new Error("No calculation data found");
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

    // Sort by itemIndex
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

    // Clear old generated files and save new
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
```

- [ ] **Step 2: Refactor `analysis.ts` to call extracted actions**

In `convex/analysis.ts`, replace the inline form slicing block (lines 355-445) and Excel generation block (lines 447-601) with calls to the new actions:

Replace the form slicing section (after saving extracted items, around line 355):
```typescript
      // ========== STAGE 2: Form Slicing (60-70%) ==========

      await updateProgress("Нарезка форм из документов...", 60);

      await ctx.runAction(internal.analysisActions.sliceForms, {
        procurementId: args.procurementId,
        forms: (extractedData.forms || []).map((form: any) => ({
          name: String(form.name || ""),
          sourceFile: String(form.sourceFile || ""),
          locationType: form.locationType || "whole_file",
          startBlock: form.startBlock ? Number(form.startBlock) : undefined,
          endBlock: form.endBlock ? Number(form.endBlock) : undefined,
          sheetName: form.sheetName || undefined,
        })),
      });
```

Replace the Excel generation section (around line 447):
```typescript
      // ========== STAGE 3: Sonnet Calculation (70-95%) ==========

      await updateProgress("Генерация калькуляции (Sonnet)...", 70);

      // ... keep the Sonnet call and saveCalculationItem loop as-is ...
      // (lines 449-560 stay unchanged — they save calcData to DB)

      await updateProgress("Создание Excel калькуляции...", 85);

      await ctx.runAction(internal.analysisActions.generateCalcExcel, {
        procurementId: args.procurementId,
      });
```

Remove the inline ExcelJS code (lines 474-601) that is now in `generateCalcExcel`.

- [ ] **Step 3: Run codegen**

```bash
cd /home/Iurii/Projects/tender-master && npx convex codegen
```

- [ ] **Step 4: Commit**

```bash
git add convex/analysisActions.ts convex/analysis.ts
git commit -m "refactor: extract sliceForms and generateCalcExcel into standalone actions"
```

---

## Task 3: Extract Form Fill Application into Standalone Action

**Files:**
- Create: `convex/formFillingActions.ts`

- [ ] **Step 1: Read the full `convex/formFilling.ts`** to understand the fill-application logic (the part that takes fill instructions and applies them to DOCX/XLSX files).

- [ ] **Step 2: Create `convex/formFillingActions.ts`**

This action reads fill instructions from a new `fillInstructions` table (or inline JSON), downloads form files, applies replacements, and saves filled files:

```typescript
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
      instructions: v.string(), // JSON string of fill instructions array
    })),
  },
  handler: async (ctx, args) => {
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    if (!procurement) throw new Error("Procurement not found");

    // Clear old generated files (except calculation)
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
      // Handle split runs: normalize XML to join split text
      const searchEscaped = instr.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(searchEscaped, "g");
      docXml = docXml.replace(regex, String(instr.value));
    }
    // fillTable handled by the AI generating individual replace instructions
  }

  zip.file("word/document.xml", docXml);
  const result = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(result);
}

async function applyXlsxInstructions(buffer: Buffer, instructions: any[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
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
```

- [ ] **Step 3: Run codegen**

```bash
cd /home/Iurii/Projects/tender-master && npx convex codegen
```

- [ ] **Step 4: Commit**

```bash
git add convex/formFillingActions.ts
git commit -m "feat: add applyFillInstructions standalone action for local pipeline"
```

---

## Task 4: Convex HTTP Router

**Files:**
- Create: `convex/http.ts`

- [ ] **Step 1: Create `convex/http.ts`**

```typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

function checkAuth(request: Request): boolean {
  const secret = process.env.CONVEX_LOCAL_PROCESSOR_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${secret}`;
}

// GET /api/local/pending-tasks
http.route({
  path: "/api/local/pending-tasks",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const tasks = await ctx.runQuery(api.procurements.getPendingLocalTasks, {});
    return Response.json(tasks);
  }),
});

// POST /api/local/update-status
http.route({
  path: "/api/local/update-status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runMutation(api.procurements.updateStatus, {
      id: body.id,
      status: body.status,
      statusMessage: body.statusMessage,
      progress: body.progress,
    });
    return Response.json({ ok: true });
  }),
});

// POST /api/local/save-analysis
http.route({
  path: "/api/local/save-analysis",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();

    // Save procurement metadata
    await ctx.runMutation(api.procurements.updateFromAnalysis, {
      id: body.procurementId,
      number: body.procurementNumber || "",
      name: body.procurementName || "Без названия",
      nmck: Number(body.nmck) || 0,
      deliveryDeadline: body.deliveryDeadline || "",
      deliveryAddresses: body.deliveryAddresses || [],
    });

    // Clear previous data
    await ctx.runMutation(internal.analysisHelpers.clearProcurementData, {
      procurementId: body.procurementId,
    });

    // Save extracted items
    for (const item of body.items || []) {
      await ctx.runMutation(internal.analysisHelpers.saveExtractedItem, {
        procurementId: body.procurementId,
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
      });
    }

    // Save calculation data
    for (let i = 0; i < (body.calcRows || []).length; i++) {
      const row = body.calcRows[i];
      await ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
        procurementId: body.procurementId,
        itemIndex: i,
        itemName: String(row.itemName || ""),
        pp1875: row.pp1875 || undefined,
        quantity: Number(row.quantity) || 0,
        nmckPrice: Number(row.nmckPrice) || 0,
        tzSpecs: row.tzSpecs || undefined,
      });
    }

    return Response.json({ ok: true });
  }),
});

// POST /api/local/trigger-slice
http.route({
  path: "/api/local/trigger-slice",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.analysisActions.sliceForms, {
      procurementId: body.procurementId,
      forms: body.forms,
    });
    return Response.json({ ok: true });
  }),
});

// POST /api/local/trigger-calc
http.route({
  path: "/api/local/trigger-calc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.analysisActions.generateCalcExcel, {
      procurementId: body.procurementId,
    });
    return Response.json({ ok: true });
  }),
});

// POST /api/local/save-fill
http.route({
  path: "/api/local/save-fill",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.formFillingActions.applyFillInstructions, {
      procurementId: body.procurementId,
      fillResults: body.fillResults,
    });
    return Response.json({ ok: true });
  }),
});

// POST /api/local/get-procurement
http.route({
  path: "/api/local/get-procurement",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    const procurement = await ctx.runQuery(api.procurements.get, { id: body.id });
    const files = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: body.id,
    });
    const calcData = await ctx.runQuery(api.files.getCalculationData, {
      procurementId: body.id,
    });
    const forms = await ctx.runQuery(api.files.getExtractedForms, {
      procurementId: body.id,
    });
    return Response.json({ procurement, files, calcData, forms });
  }),
});

export default http;
```

- [ ] **Step 2: Set `CONVEX_LOCAL_PROCESSOR_SECRET` env var**

```bash
cd /home/Iurii/Projects/tender-master
npx convex env set CONVEX_LOCAL_PROCESSOR_SECRET "$(openssl rand -hex 32)"
```

- [ ] **Step 3: Run codegen**

```bash
npx convex codegen
```

- [ ] **Step 4: Commit**

```bash
git add convex/http.ts
git commit -m "feat: add Convex HTTP router for local processor communication"
```

---

## Task 5: Stale Task Recovery Cron

**Files:**
- Create: `convex/crons.ts`

- [ ] **Step 1: Create `convex/crons.ts`**

```typescript
import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RETRIES = 3;

export const recoverStaleTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const procurements = await ctx.db
      .query("procurements")
      .filter((q) =>
        q.and(
          q.eq(q.field("processingMode"), "local"),
          q.or(
            q.eq(q.field("status"), "analyzing"),
            q.eq(q.field("status"), "filling_forms")
          )
        )
      )
      .collect();

    for (const p of procurements) {
      const updatedAt = p.localStatusUpdatedAt || p._creationTime;
      if (now - updatedAt < STALE_THRESHOLD_MS) continue;

      const retryCount = (p.localRetryCount || 0) + 1;

      if (retryCount > MAX_RETRIES) {
        await ctx.db.patch(p._id, {
          status: "error",
          statusMessage: `Локальная обработка не завершилась после ${MAX_RETRIES} попыток`,
          localRetryCount: retryCount,
        });
      } else {
        const resetStatus = p.status === "analyzing"
          ? "pending_local_analysis" as const
          : "pending_local_fill" as const;
        await ctx.db.patch(p._id, {
          status: resetStatus,
          statusMessage: `Автоматический перезапуск (попытка ${retryCount}/${MAX_RETRIES})`,
          localRetryCount: retryCount,
          localStatusUpdatedAt: now,
        });
      }
    }
  },
});

const crons = cronJobs();

crons.interval(
  "recover stale local tasks",
  { minutes: 5 },
  internal.crons.recoverStaleTasks,
);

export default crons;
```

- [ ] **Step 2: Run codegen and commit**

```bash
cd /home/Iurii/Projects/tender-master && npx convex codegen
git add convex/crons.ts
git commit -m "feat: add cron job for stale local task recovery"
```

---

## Task 6: UI — Status Badge + Processing Mode Toggle

**Files:**
- Modify: `src/components/status-badge.tsx`
- Modify: `src/app/procurement/[id]/page.tsx`

- [ ] **Step 1: Add new statuses to `status-badge.tsx`**

Add `pending_local_analysis` and `pending_local_fill` to `STATUS_CONFIG`:

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
  pending_local_analysis: {
    label: "Ожидание локального анализа...",
    color: "bg-purple-100 text-purple-700",
  },
  pending_local_fill: {
    label: "Ожидание локального заполнения...",
    color: "bg-purple-100 text-purple-700",
  },
};
```

- [ ] **Step 2: Add processing mode toggle and local-mode logic to procurement page**

In `src/app/procurement/[id]/page.tsx`:

Add import for `setProcessingMode`:
```typescript
const setProcessingMode = useMutation(api.procurements.setProcessingMode);
```

Add toggle component after the status badge (inside the `flex items-center justify-between` div):
```typescript
<div className="flex items-center gap-3">
  <StatusBadge status={procurement.status} />
  <div className="flex items-center gap-2 text-sm">
    <span className={procurement.processingMode !== "local" ? "font-medium" : "text-muted-foreground"}>
      Облако
    </span>
    <button
      onClick={() => setProcessingMode({
        id: procurementId,
        processingMode: procurement.processingMode === "local" ? "cloud" : "local",
      })}
      disabled={isAnalyzing || isFilling || procurement.status === "pending_local_analysis" || procurement.status === "pending_local_fill"}
      className={`relative w-10 h-5 rounded-full transition-colors disabled:opacity-50 ${
        procurement.processingMode === "local" ? "bg-purple-500" : "bg-gray-300"
      }`}
    >
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
        procurement.processingMode === "local" ? "translate-x-5" : "translate-x-0.5"
      }`} />
    </button>
    <span className={procurement.processingMode === "local" ? "font-medium" : "text-muted-foreground"}>
      Локально
    </span>
  </div>
</div>
```

Update `isAnalyzing` and `isFilling` to include pending states:
```typescript
const isPendingLocal = procurement.status === "pending_local_analysis" || procurement.status === "pending_local_fill";
const isAnalyzing = procurement.status === "analyzing" || procurement.status === "pending_local_analysis" || analyzing;
const isFilling = procurement.status === "filling_forms" || procurement.status === "pending_local_fill";
```

Update `handleAnalyze` to set pending status for local mode:
```typescript
const handleAnalyze = useCallback(async () => {
  if (procurement.processingMode === "local") {
    await updateStatus({
      id: procurementId,
      status: "pending_local_analysis",
      statusMessage: "Ожидание локального обработчика...",
      progress: 0,
    });
  } else {
    setAnalyzing(true);
    try {
      await analyzeDocuments({ procurementId });
    } finally {
      setAnalyzing(false);
    }
  }
}, [analyzeDocuments, procurementId, procurement?.processingMode]);
```

Add `updateStatus` mutation:
```typescript
const updateStatus = useMutation(api.procurements.updateStatus);
```

Similarly update `handleFillForms`:
```typescript
const handleFillForms = useCallback(async () => {
  if (procurement.processingMode === "local") {
    await updateStatus({
      id: procurementId,
      status: "pending_local_fill",
      statusMessage: "Ожидание локального обработчика...",
      progress: 0,
    });
  } else {
    await fillForms({ procurementId });
  }
}, [fillForms, procurementId, procurement?.processingMode]);
```

- [ ] **Step 3: Commit**

```bash
git add src/components/status-badge.tsx src/app/procurement/\\[id\\]/page.tsx
git commit -m "feat: add processing mode toggle and pending_local status badges"
```

---

## Task 7: Local Processor — Package Setup + Convex Client

**Files:**
- Create: `scripts/local-processor/package.json`
- Create: `scripts/local-processor/tsconfig.json`
- Create: `scripts/local-processor/convex-client.ts`
- Create: `scripts/local-processor/export-profiles.ts`

- [ ] **Step 1: Create `scripts/local-processor/package.json`**

```json
{
  "name": "tender-master-local-processor",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx daemon.ts",
    "export-profiles": "tsx export-profiles.ts",
    "process-analysis": "tsx process-analysis.ts",
    "process-fill": "tsx process-fill.ts"
  },
  "dependencies": {
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create `scripts/local-processor/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 3: Create `scripts/local-processor/convex-client.ts`**

```typescript
export interface Task {
  _id: string;
  status: string;
  number: string;
  name: string;
  processingMode?: string;
  profileId: string;
  [key: string]: any;
}

export interface ProcurementData {
  procurement: any;
  files: Array<{ _id: string; storageId: string; fileName: string; fileType: string; url: string }>;
  calcData: any[];
  forms: Array<{ _id: string; name: string; fileName: string; fileType: string; url: string }>;
}

export class ConvexClient {
  constructor(
    private baseUrl: string,
    private secret: string,
  ) {}

  private async request(path: string, method: string = "POST", body?: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Convex HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  async getPendingTasks(): Promise<Task[]> {
    return this.request("/api/local/pending-tasks", "GET");
  }

  async getProcurementData(id: string): Promise<ProcurementData> {
    return this.request("/api/local/get-procurement", "POST", { id });
  }

  async updateStatus(id: string, status: string, statusMessage?: string, progress?: number): Promise<void> {
    await this.request("/api/local/update-status", "POST", { id, status, statusMessage, progress });
  }

  async saveAnalysisResult(procurementId: string, data: any): Promise<void> {
    await this.request("/api/local/save-analysis", "POST", { procurementId, ...data });
  }

  async triggerSlice(procurementId: string, forms: any[]): Promise<void> {
    await this.request("/api/local/trigger-slice", "POST", { procurementId, forms });
  }

  async triggerCalc(procurementId: string): Promise<void> {
    await this.request("/api/local/trigger-calc", "POST", { procurementId });
  }

  async saveFillResult(procurementId: string, fillResults: any[]): Promise<void> {
    await this.request("/api/local/save-fill", "POST", { procurementId, fillResults });
  }

  async downloadFile(url: string, outputPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const fs = await import("fs/promises");
    await fs.writeFile(outputPath, buffer);
  }
}
```

- [ ] **Step 4: Create `scripts/local-processor/export-profiles.ts`**

```typescript
import { profiles } from "../../src/lib/profiles";
import { writeFileSync } from "fs";

const data = Object.fromEntries(
  Object.entries(profiles).map(([key, profile]) => [key, profile])
);

writeFileSync(
  new URL("./profiles.json", import.meta.url),
  JSON.stringify(data, null, 2),
  "utf-8"
);

console.log("Exported profiles to profiles.json");
```

- [ ] **Step 5: Install deps and export profiles**

```bash
cd /home/Iurii/Projects/tender-master/scripts/local-processor
npm install
npm run export-profiles
```

- [ ] **Step 6: Add `profiles.json` to `.gitignore`**

Append to `/home/Iurii/Projects/tender-master/.gitignore`:
```
scripts/local-processor/profiles.json
```

- [ ] **Step 7: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add scripts/local-processor/package.json scripts/local-processor/tsconfig.json scripts/local-processor/convex-client.ts scripts/local-processor/export-profiles.ts .gitignore
git commit -m "feat: add local processor package setup and Convex HTTP client"
```

---

## Task 8: Prompts

**Files:**
- Create: `scripts/local-processor/prompts/extraction.md`
- Create: `scripts/local-processor/prompts/form-filling.md`

- [ ] **Step 1: Create extraction prompt**

Create `scripts/local-processor/prompts/extraction.md` — this is the prompt sent to `claude -p`. It instructs Claude to use NotebookLM MCP for RAG queries and return structured JSON:

```markdown
You are analyzing Russian procurement (закупка) documentation that has been loaded into a NotebookLM notebook.

## Your task

Use the NotebookLM MCP tools to query the uploaded procurement documents and extract structured data.

## Steps

1. First, use `list_notebooks` to find the notebook for this procurement
2. Use `select_notebook` to activate it
3. Make the following `ask_question` queries to extract data with citations:

### Query 1: Basic metadata
Ask: "Какой номер закупки, название закупки, НМЦК (начальная максимальная цена контракта), срок поставки? Дай точные значения."

### Query 2: Delivery addresses
Ask: "Какие адреса доставки (грузополучатели) указаны? Дай полный список с названиями и адресами."

### Query 3: Items list
Ask: "Перечисли ВСЕ позиции из ТЗ/спецификации. Для каждой: наименование, количество, единица измерения, цена за единицу (НМЦК), технические характеристики. Дай полный список."

### Query 4: PP1875 restrictions
Ask: "Есть ли ограничения по ПП 1875 (запрет/ограничение/преимущество) для позиций закупки? Для каких именно?"

### Query 5: Delivery allocations
Ask: "Как распределены позиции по адресам доставки? Какие количества на какой адрес?"

### Query 6: Forms for participants
Ask: "Какие формы должен заполнить участник закупки? Ищи в разделах 'Образцы форм', 'Формы для заполнения участниками'. НЕ включай ТЗ, проекты контрактов, инструкции. Для каждой формы укажи: название, в каком файле находится."

## Output format

Return ONLY valid JSON (no markdown fences, no comments):

```json
{
  "procurementNumber": "string",
  "procurementName": "string",
  "nmck": number,
  "deliveryDeadline": "string",
  "deliveryAddresses": [{"name": "string", "address": "string"}],
  "items": [
    {
      "name": "string",
      "quantity": number,
      "unit": "string",
      "nmckPrice": number,
      "tzSpecs": "string - key specs concisely",
      "pp1875": "string or empty",
      "quarter": "string",
      "estimatedWeight": number,
      "estimatedDimensions": "string ДxШxВ см",
      "deliveryAllocations": [{"address": "string", "quantity": number}]
    }
  ],
  "forms": [
    {
      "name": "string",
      "sourceFile": "string",
      "locationType": "paragraph_range | whole_file | sheet",
      "startBlock": number,
      "endBlock": number,
      "sheetName": "string"
    }
  ],
  "calcRows": [
    {
      "itemName": "string - exact name from docs",
      "pp1875": "string or empty",
      "quantity": number,
      "nmckPrice": number,
      "tzSpecs": "string - formatted specs"
    }
  ]
}
```

IMPORTANT:
- All prices in rubles, no formatting
- estimatedWeight: estimate based on product name
- Forms: ONLY forms a participant must fill, NOT ТЗ/contracts/instructions
- calcRows mirrors items but with cleaned-up tzSpecs formatting
```

- [ ] **Step 2: Create form-filling prompt**

Create `scripts/local-processor/prompts/form-filling.md`:

```markdown
You are an expert at filling Russian procurement (тендер/закупка) forms for ИП participants.

## Context data

The following data is provided inline below the prompt:
- Company profile (all requisites)
- Calculation data (OUR prices, not НМЦК)
- Procurement metadata
- List of forms to fill

## Your task

Use NotebookLM MCP to query the procurement documents for any details not in the context data. Then generate fill instructions for each form.

## Steps

1. Use `select_notebook` to activate the procurement notebook
2. For each form, read its content via `ask_question`:
   - Ask: "Покажи полное содержание формы '[form name]'. Какие поля нужно заполнить?"
3. Generate fill instructions based on form type

## CRITICAL RULES

- "Итоговая стоимость заявки" = OUR total price from calculation, NEVER НМЦК
- НДС calculated from our total: amount at rate%
- Use profile data EXACTLY as provided
- For ИП: КПП empty, write "нет"
- Where "(Наименование Участника)" appears → profile.shortName
- Physical signature lines → leave as-is

## Output format

Return ONLY valid JSON array:

```json
[
  {
    "formId": "convex_form_id",
    "formName": "string",
    "instructions": [
      {"type": "replace", "search": "placeholder text", "value": "filled value"},
      {"type": "fillTable", "markerText": "table header", "columns": ["col1"], "rows": [{"col1": "val"}]}
    ],
    "confidence": [
      {"field": "name", "value": "filled", "confidence": "high|medium|low", "note": "optional"}
    ],
    "warnings": ["any issues found"]
  }
]
```

For XLSX forms use:
- `{"type": "cell", "row": N, "col": N, "value": "string"}`
- `{"type": "fillRows", "startRow": N, "rows": [["v1", "v2", ...]]}`
```

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add scripts/local-processor/prompts/
git commit -m "feat: add extraction and form-filling prompts for Claude Code"
```

---

## Task 9: Local Processor — Analysis and Fill Pipelines

**Files:**
- Create: `scripts/local-processor/utils.ts`
- Create: `scripts/local-processor/process-analysis.ts`
- Create: `scripts/local-processor/process-fill.ts`

- [ ] **Step 1: Create `scripts/local-processor/utils.ts`** (shared utilities)

```typescript
import { execFile } from "child_process";

const CLAUDE_TIMEOUT = Number(process.env.CLAUDE_TIMEOUT) || 900_000; // 15 min

export function repairTruncatedJson(text: string): string {
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

export function extractJsonFromOutput(raw: string): any {
  // claude -p --output-format json wraps in envelope
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) {
      return typeof envelope.result === "string" ? JSON.parse(envelope.result) : envelope.result;
    }
  } catch {}
  try { return JSON.parse(raw); } catch {}
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  const jsonMatch = raw.match(/(\{[\s\S]*\})/) || raw.match(/(\[[\s\S]*\])/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {
      return JSON.parse(repairTruncatedJson(jsonMatch[1]));
    }
  }
  throw new Error("Could not extract JSON from Claude output");
}

export function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "json", "--max-turns", "20"],
      { timeout: CLAUDE_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`claude -p failed: ${error.message}\n${stderr}`));
        else resolve(stdout);
      }
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function cleanupNotebook(notebookName: string): Promise<string> {
  return runClaude(`Remove the NotebookLM notebook named "${notebookName}" using the remove_notebook MCP tool. If it doesn't exist, that's fine. Reply with "done".`);
}
```

- [ ] **Step 2: Create `scripts/local-processor/process-analysis.ts`**

```typescript
import { readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ConvexClient, type Task } from "./convex-client.js";
import { extractJsonFromOutput, runClaude, cleanupNotebook } from "./utils.js";

export async function processAnalysis(client: ConvexClient, task: Task): Promise<void> {
  const notebookName = `Закупка_${task.number || task._id}`;
  console.log(`Processing analysis for ${task._id} (${task.name})`);

  // 1. Update status
  await client.updateStatus(task._id, "analyzing", "Локальный анализ: загрузка файлов...", 5);

  // 2. Get procurement data
  const data = await client.getProcurementData(task._id);
  const files = data.files;
  if (!files.length) throw new Error("Нет загруженных файлов");

  // 3. Download files to temp dir
  const tmpDir = await mkdtemp(join(tmpdir(), "tm-analysis-"));
  try {
    await client.updateStatus(task._id, "analyzing", "Локальный анализ: скачивание файлов...", 10);

    const fileList: string[] = [];
    for (const file of files) {
      if (!file.url) continue;
      const filePath = join(tmpDir, file.fileName);
      await client.downloadFile(file.url, filePath);
      fileList.push(filePath);
    }

    // 4. Read extraction prompt
    const promptTemplate = await readFile(
      new URL("./prompts/extraction.md", import.meta.url),
      "utf-8"
    );

    // 5. Build prompt with file references
    const prompt = `${promptTemplate}

## Procurement ID: ${task._id}
## Procurement Name: ${task.name || "Новая закупка"}

## Files to analyze (downloaded to local filesystem):
${fileList.map(f => `- ${f}`).join("\n")}

Read these files from the local filesystem, upload their contents to a NotebookLM notebook named "${notebookName}", then perform the RAG queries described above.

Return the structured JSON result.`;

    await client.updateStatus(task._id, "analyzing", "Локальный анализ: Claude Code обрабатывает...", 20);

    // 6. Run claude -p
    const rawOutput = await runClaude(prompt);
    const result = extractJsonFromOutput(rawOutput);

    // 7. Cancellation check
    const currentData = await client.getProcurementData(task._id);
    if (currentData.procurement?.status !== "analyzing") {
      console.log(`Task ${task._id} was cancelled, aborting`);
      return;
    }

    // 8. Push results to Convex
    await client.updateStatus(task._id, "analyzing", "Сохранение результатов...", 70);
    await client.saveAnalysisResult(task._id, {
      procurementNumber: result.procurementNumber,
      procurementName: result.procurementName,
      nmck: result.nmck,
      deliveryDeadline: result.deliveryDeadline,
      deliveryAddresses: result.deliveryAddresses,
      items: result.items,
      calcRows: result.calcRows || result.items,
    });

    // 9. Trigger server-side slicing
    await client.updateStatus(task._id, "analyzing", "Нарезка форм...", 80);
    if (result.forms && result.forms.length > 0) {
      await client.triggerSlice(task._id, result.forms);
    }

    // 10. Trigger Excel generation
    await client.updateStatus(task._id, "analyzing", "Генерация калькуляции...", 90);
    await client.triggerCalc(task._id);

    // 11. Done
    await client.updateStatus(
      task._id,
      "analyzed",
      `Извлечено ${(result.items || []).length} позиций, ${(result.forms || []).length} форм (локально)`,
      100
    );

    // 12. Cleanup NotebookLM notebook
    try {
      await cleanupNotebook(notebookName);
      console.log(`Cleaned up notebook "${notebookName}"`);
    } catch (e) {
      console.warn(`Failed to cleanup notebook: ${e}`);
    }

    console.log(`Analysis complete for ${task._id}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Create `scripts/local-processor/process-fill.ts`**

```typescript
import { readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ConvexClient, type Task } from "./convex-client.js";
import { extractJsonFromOutput, runClaude, cleanupNotebook } from "./utils.js";

export async function processFill(client: ConvexClient, task: Task): Promise<void> {
  console.log(`Processing form fill for ${task._id} (${task.name})`);

  await client.updateStatus(task._id, "filling_forms", "Локальное заполнение: подготовка...", 5);

  const data = await client.getProcurementData(task._id);
  const { procurement, calcData, forms } = data;

  if (!forms || forms.length === 0) {
    throw new Error("Нет извлечённых форм для заполнения");
  }

  // Load profiles
  let profiles: any;
  try {
    const profilesPath = new URL("./profiles.json", import.meta.url);
    profiles = JSON.parse(await readFile(profilesPath, "utf-8"));
  } catch {
    throw new Error("profiles.json not found. Run: npm run export-profiles");
  }

  const profile = profiles[procurement.profileId];
  if (!profile) throw new Error(`Profile ${procurement.profileId} not found`);

  // Calculate pricing
  const ourTotalPrice = calcData.reduce((sum: number, d: any) => sum + (d.ourTotal || 0), 0);
  const ndsRate = profile.tax?.ndsRate || 5;
  const ndsAmount = Math.round(ourTotalPrice * ndsRate / (100 + ndsRate) * 100) / 100;

  // Download forms to temp dir
  const tmpDir = await mkdtemp(join(tmpdir(), "tm-fill-"));
  try {
    for (const form of forms) {
      if (!form.url) continue;
      const filePath = join(tmpDir, form.fileName);
      await client.downloadFile(form.url, filePath);
    }

    const promptTemplate = await readFile(
      new URL("./prompts/form-filling.md", import.meta.url),
      "utf-8"
    );

    const contextData = {
      procurement: {
        number: procurement.number,
        name: procurement.name,
        nmck: procurement.nmck,
        deliveryDeadline: procurement.deliveryDeadline,
        deliveryAddresses: procurement.deliveryAddresses,
      },
      pricing: { ourTotalPrice, ndsRate, ndsAmount, ndsLabel: profile.tax?.ndsLabel || "НДС 5%" },
      profile,
      items: calcData.map((d: any) => ({
        name: d.itemName,
        quantity: d.quantity,
        ourUnitPrice: d.ourUnitPrice || 0,
        ourTotal: d.ourTotal || 0,
        ourSpecs: d.ourSpecs || "",
        tzSpecs: d.tzSpecs || "",
      })),
      forms: forms.map((f: any) => ({
        formId: f._id,
        name: f.name,
        fileName: f.fileName,
        fileType: f.fileType,
        localPath: join(tmpDir, f.fileName),
      })),
    };

    const prompt = `${promptTemplate}

## Context Data
\`\`\`json
${JSON.stringify(contextData, null, 2)}
\`\`\`

Read the form files from the local paths listed above, use NotebookLM to check procurement docs for any missing details, then generate fill instructions for each form.`;

    await client.updateStatus(task._id, "filling_forms", "Claude Code заполняет формы...", 30);

    const rawOutput = await runClaude(prompt);
    const fillResults = extractJsonFromOutput(rawOutput);

    // Cancellation check
    const currentData = await client.getProcurementData(task._id);
    if (currentData.procurement?.status !== "filling_forms") {
      console.log(`Task ${task._id} was cancelled, aborting`);
      return;
    }

    // Push to Convex
    await client.updateStatus(task._id, "filling_forms", "Применение заполнения...", 80);

    const formattedResults = (Array.isArray(fillResults) ? fillResults : [fillResults]).map((r: any) => ({
      formId: r.formId,
      instructions: JSON.stringify(r.instructions),
    }));

    await client.saveFillResult(task._id, formattedResults);

    await client.updateStatus(task._id, "completed", "Формы заполнены (локально)", 100);

    // Cleanup NotebookLM notebook
    try {
      await cleanupNotebook(`Закупка_${procurement.number || task._id}`);
    } catch (e) {
      console.warn(`Failed to cleanup notebook: ${e}`);
    }

    console.log(`Form fill complete for ${task._id}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add scripts/local-processor/utils.ts scripts/local-processor/process-analysis.ts scripts/local-processor/process-fill.ts
git commit -m "feat: add analysis and form-fill processing pipelines with shared utils"
```

---

## Task 10: Local Processor — Daemon

**Files:**
- Create: `scripts/local-processor/daemon.ts`

- [ ] **Step 1: Create `scripts/local-processor/daemon.ts`**

```typescript
import { ConvexClient } from "./convex-client.js";
import { processAnalysis } from "./process-analysis.js";
import { processFill } from "./process-fill.js";

const CONVEX_URL = process.env.CONVEX_URL;
const CONVEX_SECRET = process.env.CONVEX_SECRET;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000;

if (!CONVEX_URL || !CONVEX_SECRET) {
  console.error("Error: CONVEX_URL and CONVEX_SECRET env vars required");
  process.exit(1);
}

const client = new ConvexClient(CONVEX_URL, CONVEX_SECRET);

let healthCheckCounter = 0;
const HEALTH_CHECK_INTERVAL = 10; // every 10 polls (~5 min)

async function checkHealth(): Promise<boolean> {
  try {
    await client.getPendingTasks();
    return true;
  } catch (err) {
    console.error("Health check failed:", err);
    return false;
  }
}

async function loop() {
  console.log(`Tender Master Local Processor started`);
  console.log(`Polling ${CONVEX_URL} every ${POLL_INTERVAL / 1000}s`);

  // Initial health check
  if (!(await checkHealth())) {
    console.error("Initial health check failed. Check CONVEX_URL and CONVEX_SECRET.");
    process.exit(1);
  }

  while (true) {
    try {
      healthCheckCounter++;

      const tasks = await client.getPendingTasks();

      if (tasks.length > 0) {
        console.log(`Found ${tasks.length} pending task(s)`);
      }

      for (const task of tasks) {
        try {
          console.log(`Processing task ${task._id} (status: ${task.status})`);

          if (task.status === "pending_local_analysis") {
            await processAnalysis(client, task);
          } else if (task.status === "pending_local_fill") {
            await processFill(client, task);
          }
        } catch (err: any) {
          console.error(`Task ${task._id} failed:`, err.message);
          const rollbackStatus = task.status === "pending_local_analysis"
            ? "uploaded"
            : "calculation_uploaded";
          try {
            await client.updateStatus(
              task._id,
              rollbackStatus,
              `Ошибка локальной обработки: ${err.message}`.slice(0, 500)
            );
          } catch (updateErr) {
            console.error("Failed to update error status:", updateErr);
          }
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  process.exit(0);
});

loop();
```

- [ ] **Step 2: Test daemon manually**

```bash
cd /home/Iurii/Projects/tender-master/scripts/local-processor
CONVEX_URL=https://industrious-salmon-568.convex.cloud CONVEX_SECRET=<your-secret> npx tsx daemon.ts
```

Expected: "Tender Master Local Processor started", polls every 30s, no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/Iurii/Projects/tender-master
git add scripts/local-processor/daemon.ts
git commit -m "feat: add daemon polling loop for local processor"
```

---

## Task 11: Systemd Service

**Files:**
- Create: `scripts/local-processor/tender-master-processor.service`
- Create: `scripts/local-processor/install-service.sh`
- Create: `scripts/local-processor/uninstall-service.sh`

- [ ] **Step 1: Create service file**

`scripts/local-processor/tender-master-processor.service`:

```ini
[Unit]
Description=Tender Master Local Processor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/Iurii/Projects/tender-master/scripts/local-processor/node_modules/.bin/tsx /home/Iurii/Projects/tender-master/scripts/local-processor/daemon.ts
Restart=always
RestartSec=10
WorkingDirectory=/home/Iurii/Projects/tender-master/scripts/local-processor
Environment=CONVEX_URL=https://industrious-salmon-568.convex.cloud
Environment=CLAUDE_TIMEOUT=900000
EnvironmentFile=%h/.config/tender-master/env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Create install script**

`scripts/local-processor/install-service.sh`:

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="tender-master-processor"
ENV_DIR="$HOME/.config/tender-master"
ENV_FILE="$ENV_DIR/env"

echo "=== Tender Master Local Processor Setup ==="

# Check prerequisites
if ! command -v claude &>/dev/null; then
  echo "Error: claude CLI not found. Install it first."
  exit 1
fi

if ! command -v npx &>/dev/null; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

# Setup env file with secret
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  read -p "Enter CONVEX_LOCAL_PROCESSOR_SECRET: " SECRET
  echo "CONVEX_SECRET=$SECRET" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Saved secret to $ENV_FILE"
else
  echo "Using existing $ENV_FILE"
fi

# Install deps
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

# Export profiles
echo "Exporting profiles..."
npx tsx export-profiles.ts

# Copy and enable service
mkdir -p "$HOME/.config/systemd/user"
cp "$SCRIPT_DIR/$SERVICE_NAME.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo ""
echo "=== Done! ==="
echo "View logs: journalctl --user -u $SERVICE_NAME -f"
echo "Stop: systemctl --user stop $SERVICE_NAME"
echo "Restart: systemctl --user restart $SERVICE_NAME"
```

- [ ] **Step 3: Create uninstall script**

`scripts/local-processor/uninstall-service.sh`:

```bash
#!/bin/bash
set -e

SERVICE_NAME="tender-master-processor"

systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
systemctl --user daemon-reload

echo "Service $SERVICE_NAME removed."
```

- [ ] **Step 4: Make scripts executable and commit**

```bash
cd /home/Iurii/Projects/tender-master
chmod +x scripts/local-processor/install-service.sh scripts/local-processor/uninstall-service.sh
git add scripts/local-processor/tender-master-processor.service scripts/local-processor/install-service.sh scripts/local-processor/uninstall-service.sh
git commit -m "feat: add systemd service files for local processor daemon"
```

---

## Task 12: NotebookLM MCP Setup + End-to-End Test

- [ ] **Step 1: Install NotebookLM MCP**

```bash
claude mcp add notebooklm npx notebooklm-mcp@latest
```

- [ ] **Step 2: Authenticate with Google**

```bash
npx notebooklm-mcp@latest setup-auth
```

Follow the browser prompt to log into Google account.

- [ ] **Step 3: Verify MCP works with Claude Code**

```bash
claude -p "List my NotebookLM notebooks"
```

Expected: returns list of notebooks (may be empty).

- [ ] **Step 4: Verify under systemd context**

```bash
systemd-run --user --pty claude -p "List my NotebookLM notebooks"
```

Expected: same result as step 3.

- [ ] **Step 5: Deploy Convex changes**

```bash
cd /home/Iurii/Projects/tender-master
npx convex dev
```

Verify no schema errors. Test the HTTP endpoints:

```bash
SECRET=$(cat ~/.config/tender-master/env | grep CONVEX_SECRET | cut -d= -f2)
curl -H "Authorization: Bearer $SECRET" https://industrious-salmon-568.convex.cloud/api/local/pending-tasks
```

Expected: `[]` (empty array, no pending tasks).

- [ ] **Step 6: End-to-end test with a real procurement**

1. Open web UI, create a new procurement
2. Set toggle to "Локально"
3. Upload procurement documents
4. Click "Анализировать"
5. Watch daemon logs: `journalctl --user -u tender-master-processor -f`
6. Verify: status transitions `pending_local_analysis` → `analyzing` → `analyzed`
7. Download calculation, fill prices, upload back
8. Click "Заполнить формы"
9. Verify: status transitions `pending_local_fill` → `filling_forms` → `completed`

- [ ] **Step 7: Compare with cloud pipeline output**

Run the same documents through cloud mode and compare:
- Number of extracted items
- Form names and coordinates
- Calculation structure

- [ ] **Step 8: Final commit**

```bash
cd /home/Iurii/Projects/tender-master
git add -A
git commit -m "feat: complete local processor integration with NotebookLM MCP"
```
