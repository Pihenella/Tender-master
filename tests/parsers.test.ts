import { describe, it, expect } from "vitest";
import { parseDocx, parseXlsx, parsePdf, parseFile } from "../convex/parsers";
import { readFileSync } from "fs";
import { join } from "path";

const DOCS_DIR = "/home/Iurii/docs";

describe("parsers", () => {
  it("parseDocx extracts text from docx", async () => {
    const buffer = readFileSync(join(DOCS_DIR, "форма 3.docx"));
    const result = await parseDocx(buffer);
    expect(result.length).toBeGreaterThan(100);
  });

  it("parseXlsx extracts structured data from xlsx", async () => {
    const buffer = readFileSync(
      join(DOCS_DIR, "Приложение №1.1 к ТЗ-Расчет НМЦ.xlsx")
    );
    const result = await parseXlsx(buffer);
    expect(result.length).toBeGreaterThan(100);
  });

  it("parsePdf extracts text from pdf", async () => {
    const buffer = readFileSync(join(DOCS_DIR, "форма 3.pdf"));
    const result = await parsePdf(buffer);
    expect(result.length).toBeGreaterThan(50);
  });

  it("parseFile routes by mime type", async () => {
    const docxBuf = readFileSync(join(DOCS_DIR, "форма 3.docx"));
    const result = await parseFile(
      docxBuf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "форма 3.docx"
    );
    expect(result.length).toBeGreaterThan(100);
  });
});
