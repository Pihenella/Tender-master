import ExcelJS from "exceljs";

export interface CellRef {
  cell: string;
  value: string;
}

export interface TableColumn {
  col: string;
  header: string;
}

export type Region =
  | { type: "header"; range: string; value: string }
  | { type: "field"; label: CellRef; input: CellRef }
  | {
      type: "table";
      headerRow: number;
      columns: TableColumn[];
      dataStartRow: number;
      existingRows: number;
    }
  | { type: "static"; cell: string; value: string };

export interface FormMap {
  sheet: string;
  dimensions: string;
  mergedCells: string[];
  regions: Region[];
}

function cellValue(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "result" in v) return String((v as any).result);
  if (typeof v === "object" && "text" in v) return String((v as any).text);
  if (typeof v === "object" && "richText" in v) {
    return (v as any).richText.map((r: any) => r.text).join("");
  }
  return String(v);
}

function colLetter(colNumber: number): string {
  let result = "";
  let n = colNumber;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

export async function buildFormMap(buffer: Buffer): Promise<FormMap> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheets found");

  const merges: string[] = (ws.model.merges as string[]) || [];

  const formMap: FormMap = {
    sheet: ws.name,
    dimensions: ws.dimensions?.toString() || "",
    mergedCells: merges,
    regions: [],
  };

  const classified = new Set<string>();

  // Pass 1: Detect merged cell headers
  for (const merge of merges) {
    const [start] = merge.split(":");
    const val = cellValue(ws.getCell(start));
    if (val.trim()) {
      formMap.regions.push({ type: "header", range: merge, value: val.trim() });
      const [startCell, endCell] = merge.split(":");
      const startMatch = startCell.match(/([A-Z]+)(\d+)/);
      const endMatch = endCell.match(/([A-Z]+)(\d+)/);
      if (startMatch && endMatch) {
        for (let r = parseInt(startMatch[2]); r <= parseInt(endMatch[2]); r++) {
          for (
            let c = startMatch[1].charCodeAt(0) - 64;
            c <= endMatch[1].charCodeAt(0) - 64;
            c++
          ) {
            classified.add(`${colLetter(c)}${r}`);
          }
        }
      }
    }
  }

  // Pass 2: Detect tables (3+ consecutive non-empty cells in a row)
  const rowCount = ws.rowCount;
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const nonEmptyCells: { col: number; value: string }[] = [];

    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const addr = `${colLetter(colNum)}${r}`;
      if (classified.has(addr)) return;
      const val = cellValue(cell);
      if (val.trim()) {
        nonEmptyCells.push({ col: colNum, value: val.trim() });
      }
    });

    if (nonEmptyCells.length >= 3) {
      const nextRow = ws.getRow(r + 1);
      let nextRowEmpty = true;
      nextRow.eachCell({ includeEmpty: false }, (cell) => {
        if (cellValue(cell).trim()) nextRowEmpty = false;
      });

      const columns: TableColumn[] = nonEmptyCells.map((c) => ({
        col: colLetter(c.col),
        header: c.value,
      }));

      let existingRows = 0;
      if (!nextRowEmpty) {
        for (let dr = r + 1; dr <= rowCount; dr++) {
          const dataRow = ws.getRow(dr);
          let hasData = false;
          dataRow.eachCell({ includeEmpty: false }, (cell) => {
            if (cellValue(cell).trim()) hasData = true;
          });
          if (hasData) existingRows++;
          else break;
        }
      }

      formMap.regions.push({
        type: "table",
        headerRow: r,
        columns,
        dataStartRow: r + 1,
        existingRows,
      });

      for (const c of nonEmptyCells) {
        classified.add(`${colLetter(c.col)}${r}`);
      }
      for (let dr = r + 1; dr <= r + existingRows; dr++) {
        ws.getRow(dr).eachCell({ includeEmpty: false }, (_, colNum) => {
          classified.add(`${colLetter(colNum)}${dr}`);
        });
      }
    }
  }

  // Pass 3: Detect field pairs (label + adjacent empty/placeholder input)
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const addr = `${colLetter(colNum)}${r}`;
      if (classified.has(addr)) return;

      const val = cellValue(cell);
      if (!val.trim()) return;

      const rightAddr = `${colLetter(colNum + 1)}${r}`;
      if (classified.has(rightAddr)) return;

      const rightCell = ws.getCell(rightAddr);
      const rightVal = cellValue(rightCell);

      const isInput =
        rightVal === "" ||
        /^[_\s.…-]+$/.test(rightVal) ||
        /^(указать|заполнить|ввести)/i.test(rightVal);

      if (isInput) {
        formMap.regions.push({
          type: "field",
          label: { cell: addr, value: val.trim() },
          input: { cell: rightAddr, value: rightVal },
        });
        classified.add(addr);
        classified.add(rightAddr);
      }
    });
  }

  // Pass 4: Remaining non-empty cells -> static
  for (let r = 1; r <= rowCount; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, colNum) => {
      const addr = `${colLetter(colNum)}${r}`;
      if (classified.has(addr)) return;
      const val = cellValue(cell);
      if (val.trim()) {
        formMap.regions.push({ type: "static", cell: addr, value: val.trim() });
        classified.add(addr);
      }
    });
  }

  return formMap;
}
