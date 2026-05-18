import ExcelJS from "exceljs";

type ContextData = {
  procurement?: {
    name?: string;
  };
  items?: Array<{
    itemName?: string;
    name?: string;
    tzSpecs?: string;
    ourSpecs?: string;
    country?: string;
    countryOfOrigin?: string;
    originCountry?: string;
  }>;
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(value: ExcelJS.CellValue) {
  if (value == null) return "";
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  if (typeof value === "object" && "text" in value) return String(value.text ?? "");
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((item) => item.text).join("");
  }
  return String(value);
}

function countryOfOrigin(item: NonNullable<ContextData["items"]>[number]) {
  return item.countryOfOrigin || item.originCountry || item.country || "Китайская Народная Республика";
}

function findHeaderColumn(row: ExcelJS.Row, predicate: (value: string) => boolean) {
  for (let col = 1; col <= Math.max(row.cellCount, 10); col++) {
    const value = normalize(cellText(row.getCell(col).value));
    if (predicate(value)) return col;
  }
  return 0;
}

function findProductOfferTable(sheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const nameCol = findHeaderColumn(row, (value) => value.includes("наименование товара"));
    const countryCol = findHeaderColumn(row, (value) => value.includes("страна происхождения"));
    if (!nameCol || !countryCol) continue;

    const specsCol = findHeaderColumn(row, (value) =>
      value.includes("конкретные показатели") ||
      value.includes("соответствующие значениям") ||
      value.includes("характеристики")
    );

    return {
      headerRow: rowNumber,
      numberCol: Math.max(1, nameCol - 1),
      nameCol,
      specsCol: specsCol || nameCol + 1,
      countryCol,
    };
  }

  return null;
}

function colNumber(letters: string) {
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function parseCellAddress(address: string) {
  const match = address.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { col: colNumber(match[1]), row: Number(match[2]) };
}

function parseRange(range: string) {
  const [start, end] = range.split(":");
  const startCell = parseCellAddress(start);
  const endCell = parseCellAddress(end || start);
  if (!startCell || !endCell) return null;
  return {
    startRow: Math.min(startCell.row, endCell.row),
    endRow: Math.max(startCell.row, endCell.row),
    startCol: Math.min(startCell.col, endCell.col),
    endCol: Math.max(startCell.col, endCell.col),
  };
}

function rangesIntersect(
  a: { startRow: number; endRow: number; startCol: number; endCol: number },
  b: { startRow: number; endRow: number; startCol: number; endCol: number }
) {
  return a.startRow <= b.endRow &&
    a.endRow >= b.startRow &&
    a.startCol <= b.endCol &&
    a.endCol >= b.startCol;
}

function unmergeDataRows(
  sheet: ExcelJS.Worksheet,
  dataRange: { startRow: number; endRow: number; startCol: number; endCol: number }
) {
  const merges = [...((sheet.model.merges as string[]) || [])];
  for (const merge of merges) {
    const mergeRange = parseRange(merge);
    if (!mergeRange || !rangesIntersect(mergeRange, dataRange)) continue;
    sheet.unMergeCells(merge);
  }
}

function fillProcurementSubject(sheet: ExcelJS.Worksheet, contextData: ContextData) {
  const procurementName = contextData.procurement?.name;
  if (!procurementName) return;

  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    for (let col = 1; col <= Math.max(row.cellCount, 10); col++) {
      const value = normalize(cellText(row.getCell(col).value));
      if (!value.includes("указывается участником закупки")) continue;

      for (let prevRowNumber = rowNumber - 1; prevRowNumber >= 1; prevRowNumber--) {
        const prevRow = sheet.getRow(prevRowNumber);
        for (let prevCol = 1; prevCol <= Math.max(prevRow.cellCount, 10); prevCol++) {
          const prevCell = prevRow.getCell(prevCol);
          if (!cellText(prevCell.value).trim()) continue;
          prevCell.value = procurementName;
          return;
        }
      }
    }
  }
}

export async function autofillKnownXlsxFields(buffer: Buffer, contextData: ContextData) {
  const items = contextData.items || [];
  if (!items.length && !contextData.procurement?.name) return buffer;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  let changed = false;
  for (const sheet of workbook.worksheets) {
    fillProcurementSubject(sheet, contextData);

    const table = findProductOfferTable(sheet);
    if (!table || !items.length) continue;

    const startRow = table.headerRow + 1;
    unmergeDataRows(sheet, {
      startRow,
      endRow: startRow + items.length - 1,
      startCol: table.numberCol,
      endCol: table.countryCol,
    });

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const row = sheet.getRow(startRow + index);

      row.getCell(table.numberCol).value = index + 1;
      row.getCell(table.nameCol).value = item.itemName || item.name || "";
      row.getCell(table.specsCol).value = item.ourSpecs || item.tzSpecs || item.name || "";
      row.getCell(table.countryCol).value = countryOfOrigin(item);

      for (const col of [table.nameCol, table.specsCol, table.countryCol]) {
        row.getCell(col).alignment = { ...row.getCell(col).alignment, wrapText: true, vertical: "top" };
      }
    }

    for (let rowNumber = startRow + items.length; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const numberText = normalize(cellText(row.getCell(table.numberCol).value));
      const nameText = normalize(cellText(row.getCell(table.nameCol).value));
      const specsText = normalize(cellText(row.getCell(table.specsCol).value));
      const countryText = normalize(cellText(row.getCell(table.countryCol).value));
      const looksLikeGeneratedRow =
        /^\d+$/.test(numberText) ||
        countryText === normalize("Китайская Народная Республика") ||
        nameText === specsText;
      if (!looksLikeGeneratedRow) break;

      row.getCell(table.numberCol).value = "";
      row.getCell(table.nameCol).value = "";
      row.getCell(table.specsCol).value = "";
      row.getCell(table.countryCol).value = "";
    }

    changed = true;
  }

  if (!changed) return buffer;
  return Buffer.from(await workbook.xlsx.writeBuffer()) as Buffer<ArrayBuffer>;
}
