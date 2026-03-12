# Two-Model AI Pipeline: Flash Extraction + Sonnet Form Filling

## Overview

Replace the current single-model Gemini analysis + hardcoded form generation with a two-model AI pipeline:

1. **Gemini Flash 2.5** — document analysis, item extraction, form discovery (coordinates)
2. **Claude Sonnet 4.6 (via Polza.ai)** — calculation generation, form filling, self-verification

"Two-model" refers to the two AI models used. The pipeline itself has five sequential stages described below.

Forms are extracted directly from procurement documentation (not from pre-made templates).

Polza.ai is used as the API proxy for Claude Sonnet 4.6 (Russian billing, no VPN required, OpenAI-compatible format).

## Pipeline Flow

```
Upload documents
    |
[Stage 1] Flash 2.5 - Analysis (Convex action: analyzeDocuments)
  - Extract items: number, name, NMCK, deadline, addresses, line items
  - Find forms in documents: return coordinates (file + block range / sheet / whole file)
  Status: uploaded → analyzing (progress 0-60%)
    |
[Stage 2] Programmatic slicing (same Convex action, continues)
  - Cut forms from DOCX by block ranges (preserving formatting, tables, styles)
  - XLSX: take specified sheets
  - Whole files: use as-is
  - Save each form to Convex storage + extractedForms table
  Status: analyzing (progress 60-70%)
    |
[Stage 3] Sonnet 4.6 - Calculation generation (same Convex action, continues)
  - Hardcoded template (headers + formulas only)
  - Fill columns A-G from extracted items
  - Formulas in F (=D*E) and J (=D*I) inserted by code
  - Columns H, I, K, L left empty for user
  Status: analyzing (progress 70-95%) → analyzed (progress 100%)
    |
User downloads calculation, fills H, I, J, L, uploads back
  Status: analyzed → calculation_uploaded
    |
[Stage 4] Sonnet 4.6 - Form filling (Convex action: fillForms)
  - Takes extracted forms + calculation data + company profile
  - Analyzes each form, determines which fields to fill
  - Returns fill instructions (block/cell coordinates + values)
  - Code applies instructions to original files preserving formatting
  Status: calculation_uploaded → filling_forms (progress 0-80%)
    |
[Stage 5] Sonnet 4.6 - Self-verification (same action, continues)
  - Re-reads filled result, verifies against source data, fixes errors (max 2 iterations)
  - Generates confidence report per form
  Status: filling_forms (progress 80-95%) → completed (progress 100%)
    |
User downloads filled forms + confidence report
```

## Status Machine

```typescript
status: v.union(
  v.literal("uploaded"),
  v.literal("analyzing"),      // Stages 1-3 running
  v.literal("analyzed"),        // Calculation ready for download
  v.literal("calculation_uploaded"), // User uploaded filled calculation
  v.literal("filling_forms"),   // Stages 4-5 running
  v.literal("completed"),       // All forms filled, ready for download
  v.literal("error")
)
```

Removed statuses: `reviewed`, `template_downloaded`, `generating`

Note: `analyzed` replaces the old `calculation_ready` concept — when status is `analyzed`, the calculation Excel is already generated and available for download.

## Stage 1: Flash 2.5 — Analysis + Form Discovery

Single Flash API call, two results in one JSON response.

### 1.1 Item Extraction (existing)

Same as current: procurement number, name, NMCK, deadline, delivery addresses, line items with specs, quantities, prices, 1875 PP restrictions.

### 1.2 Form Discovery (new)

Flash receives file text with numbered blocks and returns form coordinates:

```json
{
  "items": [...],
  "forms": [
    {
      "name": "Форма 2 - Письмо о подаче оферты",
      "sourceFile": "документация.docx",
      "locationType": "paragraph_range",
      "startBlock": 145,
      "endBlock": 210
    },
    {
      "name": "Приложение 3.1 - Техническое предложение",
      "sourceFile": "приложение_3_1.xlsx",
      "locationType": "whole_file"
    },
    {
      "name": "Форма 3 - Анкета участника",
      "sourceFile": "документация.docx",
      "locationType": "paragraph_range",
      "startBlock": 212,
      "endBlock": 280
    }
  ]
}
```

Location types:
- `paragraph_range` — fragment of DOCX (block N to block M)
- `whole_file` — entire file is a form
- `sheet` — specific sheet in XLSX (by name, via `sheetName` field)

### Block numbering scheme

When parsing DOCX `word/document.xml`, all direct children of `<w:body>` are numbered sequentially:
- `<w:p>` (paragraph) — gets one block number
- `<w:tbl>` (table) — gets one block number (entire table counts as single block)
- Other body-level elements — each gets one block number

Flash sees text with block numbers like:
```
[Block 1] Извещение о проведении закупки...
[Block 2] 1. Общие сведения
...
[Block 145] Форма 2 - Письмо о подаче оферты
[Block 146] | № | Наименование | Количество | ...  (table)
...
```

This ensures tables are never split — a `paragraph_range` that includes a table block captures the entire table.

## Stage 2: Programmatic Form Slicing

Code (not AI) extracts forms based on Flash coordinates.

### DOCX (paragraph_range)
- Open DOCX via JSZip
- Parse `word/document.xml`
- Number all body-level children (`<w:p>`, `<w:tbl>`, etc.) sequentially
- Take elements from startBlock to endBlock (inclusive)
- Create new DOCX with these elements, copying:
  - `word/styles.xml` — paragraph and table styles
  - `word/numbering.xml` — list numbering definitions
  - `word/settings.xml` — document settings
  - `word/fontTable.xml` — font definitions
  - `word/theme/` — theme files
  - `word/_rels/` — relationships
  - `[Content_Types].xml` — content type definitions
- Images/media: copy only referenced `word/media/` files based on relationship IDs in extracted elements

### XLSX (sheet)
- Open via ExcelJS
- Copy specified sheet to new workbook
- Preserve formatting, merged cells, formulas

### Whole files (whole_file)
- Reuse existing storageId — no copy needed

### Storage
Each form saved to Convex storage, record in `extractedForms` table.

## Stage 3: Sonnet 4.6 — Calculation Generation

### API
- Polza.ai: `https://polza.ai/api/v1/chat/completions`
- Model: `anthropic/claude-sonnet-4.6`
- Auth: `Bearer $POLZA_API_KEY`

### Template
Hardcoded Excel template based on "файл заполнения данных по контракту" — cleaned (data removed, only headers + formulas remain). Single sheet "Калькуляция" (no "Информационная карта" sheet).

### Columns

| Column | Header | Filled by |
|--------|--------|-----------|
| A | № п/п | Sonnet |
| B | Наименование | Sonnet |
| C | 1875 ПП (запрет/ограничение/преимущество) | Sonnet (free text: "запрет", "ограничение", "преимущество", or empty) |
| D | Количество | Sonnet |
| E | НМЦК за ед. (заказчика) | Sonnet |
| F | НМЦК общ. (заказчика) | Code (formula =D*E) |
| G | Характеристики ТЗ (заказчика) | Sonnet |
| H | НАШИ ХАРАКТЕРИСТИКИ | User |
| I | Наша цена за Единицу | User |
| J | Наша Сумма | Code (formula =D*I), user can override |
| K | Ссылка на товар | Optional, ignored |
| L | Примечание | User |

Row count = number of extracted items. Sonnet determines values for A-E, G based on procurement documentation. Code inserts formulas for F, J.

### Why Sonnet (not just code)?
- Correctly maps 1875 PP restrictions per item
- Formats TZ specs into readable form
- Handles edge cases (incomplete data, non-standard wording)

Status → `analyzed` (calculation is ready for download)

## Stage 4: Calculation Upload

User fills H, I, J, L and uploads back. Required columns for form filling:
- **H** — Наши характеристики (our specs)
- **I** — Наша цена за единицу (our unit price)
- **J** — Наша сумма (our total)
- **L** — Примечание (product name/article/comment)

Column K (link) — optional, ignored.

Code parses Excel, saves to `calculationData` table. Status → `calculation_uploaded`.

## Stage 5: Sonnet 4.6 — Form Filling + Self-Verification

### Input
- Extracted forms from `extractedForms` (original DOCX/XLSX)
- Calculation data (H, I, J, L)
- Item data (A-G)
- Company profile (Boltinov or Pikhenek)

### Step 1 — Form Analysis
Sonnet receives text content of each form, determines which fields to fill and data sources (calculation, company profile, procurement data).

### Step 2 — Fill Instructions
Sonnet returns JSON instructions (coordinates are relative to the sliced form, not original document):
- DOCX: `[{block: 15, placeholder: "___", value: "ИП Пихенек Ю.Д."}, ...]`
- XLSX: `[{row: 5, col: 3, value: "Цепь пильная 14\""}, ...]`

Code applies instructions to original files, preserving formatting.

### Step 3 — Self-Check (second pass, max 2 iterations)
Sonnet re-reads filled result (text representation) and verifies against source data:
- All fields filled?
- Numbers match (prices, totals, quantities)?
- Company details correct?
- If errors found → returns corrections, code applies again
- If errors persist after 2 iterations → proceed with warnings in confidence report

### Step 4 — Confidence Report
```json
{
  "formName": "Форма 2",
  "status": "filled",
  "fields": [
    {"field": "Цена договора", "value": "1 234 567.00", "confidence": "high"},
    {"field": "Срок поставки", "value": "45 дней", "confidence": "medium", "note": "В документации указано неоднозначно"}
  ],
  "warnings": ["Паспортные данные директора отсутствуют в профиле"]
}
```

Confidence report is stored as a JSON file (.json) in Convex storage with `formType: "confidenceReport"` in `generatedFiles`. Frontend renders it as a structured card with color-coded confidence levels.

Status → `completed`

## Schema Changes

### New status union for procurements
```typescript
status: v.union(
  v.literal("uploaded"),
  v.literal("analyzing"),
  v.literal("analyzed"),
  v.literal("calculation_uploaded"),
  v.literal("filling_forms"),
  v.literal("completed"),
  v.literal("error")
)
```

### New table: extractedForms
```typescript
extractedForms: defineTable({
  procurementId: v.id("procurements"),
  name: v.string(),
  storageId: v.id("_storage"),
  fileName: v.string(),
  sourceFile: v.string(),
  fileType: v.string(), // "docx" | "xlsx"
  locationType: v.string(), // "paragraph_range" | "whole_file" | "sheet"
  sourceCoordinates: v.optional(v.string()), // JSON: {"startBlock":145,"endBlock":210} or {"sheetName":"Form"}
}).index("by_procurement", ["procurementId"])
```

### Modified: calculationData
New schema (replaces current):
```typescript
calculationData: defineTable({
  procurementId: v.id("procurements"),
  itemIndex: v.number(), // 0-based row index; display number (№ п/п) = itemIndex + 1
  // Columns A-G (from Sonnet / extraction)
  itemName: v.string(),
  pp1875: v.optional(v.string()),
  quantity: v.number(),
  nmckPrice: v.number(),
  tzSpecs: v.optional(v.string()),
  // Columns H, I, J, L (from user)
  ourSpecs: v.optional(v.string()),
  ourUnitPrice: v.optional(v.number()),
  ourTotal: v.optional(v.number()),
  notes: v.optional(v.string()), // column L (примечание)
}).index("by_procurement", ["procurementId"])
```

Removed fields: `margin`, `otherExpenses` (no longer in template).

### Modified: extractedItems
Fields `deliveryCost`, `deliveryCostEstimated` are kept but not actively used in this pipeline. `estimatedWeight`, `estimatedDimensions` are kept as they come from Flash extraction.

### Modified: generatedFiles
- `formType` becomes free string (form name from documentation or "confidenceReport")

### Removed: formTemplates table
No longer needed — forms come from documentation.

### Disposition of logistics.ts
`convex/logistics.ts` is kept as-is (not part of this pipeline change). It can be integrated later if delivery cost estimation is needed.

## Convex Action Timeout Strategy

Convex Node actions have a 10-minute timeout. The pipeline is split into two user-triggered actions:

1. **`analyzeDocuments`** (Stages 1-3): Flash analysis + slicing + Sonnet calculation. For large procurements with many items, this is the longest action. If timeout is a risk, Stage 3 (Sonnet calculation) can be split into a separate action triggered automatically after Stage 2.

2. **`fillForms`** (Stages 4-5): Sonnet form filling + self-check. Each form is processed sequentially within the action. Progress is reported per-form.

Both actions update progress incrementally so the UI shows real-time status.

## Files to Delete
- `convex/generation.ts` — hardcoded 5-form generation
- `convex/docxHelpers.ts` — XML manipulation for old templates
- `scripts/uploadTemplates.ts` — template upload script

## Files to Modify
- `convex/schema.ts` — new table, new statuses, remove formTemplates, update calculationData
- `convex/analysis.ts` — add form discovery + programmatic slicing + Sonnet calculation call
- `convex/calculationTemplate.ts` — rewrite to use Sonnet + hardcoded template instead of code-only generation
- `convex/calculationUpload.ts` — parse only H, I, J, L; new calculationData schema
- `convex/analysisHelpers.ts` — add mutations for extractedForms, update calculationData mutations
- `src/app/procurement/[id]/page.tsx` — adapt UI for new flow (extracted forms list, confidence report display)
- `src/lib/parsers.ts` — add block-numbered DOCX parsing for Flash input

## New Files
- `convex/formFilling.ts` — Sonnet form filling + self-check + confidence report
- `convex/sonnetApi.ts` — shared helper for Polza.ai API calls (retry on 429, JSON extraction)
- `convex/docxSlicer.ts` — programmatic DOCX slicing by block ranges

## Files Kept As-Is
- `convex/logistics.ts` — not part of this change
- `src/lib/profiles.ts` — unchanged

## API Configuration

### Polza.ai (Sonnet 4.6)
- Env var: `POLZA_API_KEY`
- Base URL: `https://polza.ai/api/v1`
- Model: `anthropic/claude-sonnet-4.6`
- OpenAI-compatible format (`/chat/completions`)
- Used in: calculation (stage 3), form filling (stages 4-5)

### Gemini Flash 2.5
- Env var: `GEMINI_API_KEY` (existing)
- Used in: document analysis + form discovery (stage 1)
