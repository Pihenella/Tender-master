import mammoth from "mammoth";
import ExcelJS from "exceljs";
import pdfParse from "pdf-parse";

export async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function parseXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    rows.push(`=== Sheet: ${sheet.name} ===`);
    sheet.eachRow((row, rowNumber) => {
      const cells = (row.values as (string | number | boolean | object | null | undefined)[])
        .slice(1)
        .map((v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "object" && "result" in v)
            return String((v as { result: unknown }).result);
          if (typeof v === "object" && "text" in v)
            return String((v as { text: unknown }).text);
          return String(v);
        });
      rows.push(`Row ${rowNumber}: ${cells.join(" | ")}`);
    });
    sheets.push(rows.join("\n"));
  });

  return sheets.join("\n\n");
}

export async function parsePdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text;
}

export async function parseFile(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase();

  if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    return parseDocx(buffer);
  }
  if (ext === "xlsx" || mimeType.includes("spreadsheetml")) {
    return parseXlsx(buffer);
  }
  if (ext === "pdf" || mimeType === "application/pdf") {
    return parsePdf(buffer);
  }

  return `[Unsupported file type: ${ext}]`;
}
