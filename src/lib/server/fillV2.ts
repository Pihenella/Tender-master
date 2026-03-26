import ExcelJS from "exceljs";
import type { FormMap } from "./formMap";

// ─── Types ───────────────────────────────────────────────────────────

export interface MappingEntry {
  cell: string;
  dataPath: string;
  confidence: "high" | "medium" | "low";
}

export interface ComputedField {
  cell: string;
  expression: string;
  label: string;
}

export interface ClaudeMapping {
  mappings: MappingEntry[];
  tables: Array<{
    dataStartRow: number;
    columnMap: Record<string, string>;
  }>;
  unmapped: string[];
  computed: ComputedField[];
}

export interface CellValue {
  cell: string;
  value: string | number;
}

export interface ResolveResult {
  cellValues: CellValue[];
  tableData: Array<{
    startRow: number;
    rows: Record<string, string | number>[];
  }>;
  unresolved: string[];
}

export interface CheckResult {
  applied: number;
  failed: number;
  missing: number;
  details: Array<{
    cell: string;
    expected: string;
    actual: string;
    reason: "merged_cell" | "write_failed" | "protected" | "unmapped";
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Access nested property by dot-separated path, e.g. "profile.inn" */
export function getByPath(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Resolve an array path like "items[].name" to an array of field values.
 * Supports a single [] in the path.
 */
export function resolveArrayPath(obj: any, path: string): any[] {
  const bracketIdx = path.indexOf("[]");
  if (bracketIdx === -1) {
    const val = getByPath(obj, path);
    return Array.isArray(val) ? val : [val];
  }

  const arrayPath = path.substring(0, bracketIdx);
  const fieldPath = path.substring(bracketIdx + 3); // skip "[]."

  const arr = getByPath(obj, arrayPath);
  if (!Array.isArray(arr)) return [];

  if (!fieldPath) return arr;

  return arr.map((item) => getByPath(item, fieldPath));
}

function colNumber(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result;
}

/**
 * Given merged ranges and a cell address, return the master cell if the
 * address falls inside a merged range. Otherwise return the address itself.
 */
function masterCell(merges: string[], cellAddr: string): string {
  const match = cellAddr.match(/^([A-Z]+)(\d+)$/);
  if (!match) return cellAddr;

  const col = colNumber(match[1]);
  const row = parseInt(match[2], 10);

  for (const merge of merges) {
    const [start, end] = merge.split(":");
    const sMatch = start.match(/^([A-Z]+)(\d+)$/);
    const eMatch = end.match(/^([A-Z]+)(\d+)$/);
    if (!sMatch || !eMatch) continue;

    const sCol = colNumber(sMatch[1]);
    const sRow = parseInt(sMatch[2], 10);
    const eCol = colNumber(eMatch[1]);
    const eRow = parseInt(eMatch[2], 10);

    if (col >= sCol && col <= eCol && row >= sRow && row <= eRow) {
      return start; // master = first cell
    }
  }

  return cellAddr;
}

// ─── resolveMapping ──────────────────────────────────────────────────

export function resolveMapping(
  mapping: ClaudeMapping,
  context: any
): ResolveResult {
  const cellValues: CellValue[] = [];
  const unresolved: string[] = [];

  // Process simple mappings
  for (const entry of mapping.mappings) {
    if (entry.confidence === "low") {
      unresolved.push(entry.cell);
      continue;
    }

    const value = getByPath(context, entry.dataPath);
    if (value === undefined || value === null) {
      unresolved.push(entry.cell);
      continue;
    }

    cellValues.push({ cell: entry.cell, value });
  }

  // Process tables
  const tableData: ResolveResult["tableData"] = [];
  for (const table of mapping.tables) {
    const columns = Object.entries(table.columnMap);
    if (columns.length === 0) continue;

    // Resolve all column arrays
    const resolved: Record<string, any[]> = {};
    let maxLen = 0;
    for (const [col, path] of columns) {
      const values = resolveArrayPath(context, path);
      resolved[col] = values;
      if (values.length > maxLen) maxLen = values.length;
    }

    const rows: Record<string, string | number>[] = [];
    for (let i = 0; i < maxLen; i++) {
      const row: Record<string, string | number> = {};
      for (const [col] of columns) {
        const val = resolved[col]?.[i];
        row[col] = val !== undefined && val !== null ? val : "";
      }
      rows.push(row);
    }

    tableData.push({ startRow: table.dataStartRow, rows });
  }

  // Add unmapped cells to unresolved
  for (const cell of mapping.unmapped) {
    unresolved.push(cell);
  }

  return { cellValues, tableData, unresolved };
}

// ─── applyXlsxV2 ────────────────────────────────────────────────────

export async function applyXlsxV2(
  buffer: Buffer,
  cellValues: CellValue[],
  tableData?: ResolveResult["tableData"]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheets found");

  const merges: string[] = (ws.model.merges as string[]) || [];

  // Write cell values (handling merged cells)
  for (const { cell, value } of cellValues) {
    const target = masterCell(merges, cell);
    ws.getCell(target).value = value as ExcelJS.CellValue;
  }

  // Write table rows
  if (tableData) {
    for (const table of tableData) {
      for (let i = 0; i < table.rows.length; i++) {
        const rowNum = table.startRow + i;
        const rowData = table.rows[i];
        for (const [colLetter, value] of Object.entries(rowData)) {
          ws.getCell(`${colLetter}${rowNum}`).value =
            value as ExcelJS.CellValue;
        }
      }
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── selfCheck ───────────────────────────────────────────────────────

function cellValueToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "result" in v) return String(v.result);
  if (typeof v === "object" && "text" in v) return String(v.text);
  if (typeof v === "object" && "richText" in v) {
    return v.richText.map((r: any) => r.text).join("");
  }
  return String(v);
}

export async function selfCheck(
  filledBuffer: Buffer,
  expectedValues: CellValue[],
  formMap: FormMap
): Promise<CheckResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(filledBuffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheets found");

  let applied = 0;
  let failed = 0;
  const details: CheckResult["details"] = [];

  // Check expected values
  const filledCells = new Set<string>();
  for (const { cell, value } of expectedValues) {
    filledCells.add(cell);
    const actual = cellValueToString(ws.getCell(cell).value);
    const expected = String(value);

    if (actual === expected) {
      applied++;
    } else {
      failed++;
      details.push({
        cell,
        expected,
        actual,
        reason: "write_failed",
      });
    }
  }

  // Check for unfilled input fields from formMap
  let missing = 0;
  for (const region of formMap.regions) {
    if (region.type === "field") {
      const inputCell = region.input.cell;
      if (filledCells.has(inputCell)) continue;

      const actual = cellValueToString(ws.getCell(inputCell).value);
      if (!actual || /^[_\s.…-]*$/.test(actual)) {
        missing++;
        details.push({
          cell: inputCell,
          expected: "(value)",
          actual,
          reason: "unmapped",
        });
      }
    }
  }

  return { applied, failed, missing, details };
}
