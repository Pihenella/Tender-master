import ExcelJS from "exceljs";

export async function parseDocx(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return "";
  return docXml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

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

export async function parseXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

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
  // Dynamic import to avoid pdf-parse loading test files at module init
  const pdfParse = (await import("pdf-parse")).default;
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
    return parseDocxWithBlocks(buffer);
  }
  if (ext === "xlsx" || mimeType.includes("spreadsheetml")) {
    return parseXlsx(buffer);
  }
  if (ext === "pdf" || mimeType === "application/pdf") {
    return parsePdf(buffer);
  }

  return `[Unsupported file type: ${ext}]`;
}
