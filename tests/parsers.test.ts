import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseDocx, parseXlsx, parsePdf, parseFile } from "../src/lib/parsers";

const DOCS_DIR = process.env.TENDER_MASTER_FIXTURE_DOCS_DIR || "/home/Iurii/docs";
const PDF_FIXTURE = join(DOCS_DIR, "форма 3.pdf");

async function makeDocxBuffer() {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Форма тестового документа</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>ИНН</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1234567890</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body>
    </w:document>`
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function makeXlsxBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Items");
  sheet.addRow(["Name", "Qty"]);
  sheet.addRow(["Bolt", 10]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("parsers", () => {
  it("parseDocx extracts text from docx", async () => {
    const result = await parseDocx(await makeDocxBuffer());
    expect(result).toContain("Форма тестового документа");
    expect(result).toContain("1234567890");
  });

  it("parseXlsx extracts structured data from xlsx", async () => {
    const result = await parseXlsx(await makeXlsxBuffer());
    expect(result).toContain("=== Sheet: Items ===");
    expect(result).toContain("Row 2: Bolt | 10");
  });

  const pdfIt = existsSync(PDF_FIXTURE) ? it : it.skip;
  pdfIt("parsePdf extracts text from pdf fixture", async () => {
    const result = await parsePdf(readFileSync(PDF_FIXTURE));
    expect(result.length).toBeGreaterThan(50);
  });

  it("parseFile routes by mime type", async () => {
    const result = await parseFile(
      await makeDocxBuffer(),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "форма 3.docx"
    );
    expect(result).toContain("[Block 1] Форма тестового документа");
  });
});
