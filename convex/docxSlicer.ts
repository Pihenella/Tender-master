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
  await srcWorkbook.xlsx.load(xlsxBuffer as unknown as ArrayBuffer);

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
        dstCell.value = { formula: srcCell.formula } as any;
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
