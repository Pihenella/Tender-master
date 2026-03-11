"use node";

// Helpers for manipulating DOCX files via JSZip + XML string operations.
// DOCX is a ZIP containing word/document.xml with the main content.

import JSZip from "jszip";

/** Open a DOCX buffer and return zip + document XML string */
export async function openDocx(
  buffer: ArrayBuffer
): Promise<{ zip: JSZip; xml: string }> {
  const zip = await JSZip.loadAsync(buffer);
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) throw new Error("No word/document.xml in DOCX");
  const xml = await xmlFile.async("string");
  return { zip, xml };
}

/** Save modified XML back to DOCX and return buffer */
export async function saveDocx(zip: JSZip, xml: string): Promise<Buffer> {
  zip.file("word/document.xml", xml);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
}

/** Extract all text from a <w:tc> element string */
function extractCellText(cellXml: string): string {
  const texts: string[] = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(cellXml)) !== null) {
    texts.push(m[1]);
  }
  return texts.join("");
}

/** Extract text from each cell in a table row */
export function extractAllCellTexts(rowXml: string): string[] {
  const cellRegex = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
  const cells = [...rowXml.matchAll(cellRegex)];
  return cells.map((c) => extractCellText(c[0]));
}

/**
 * Replace the text content of a table cell while preserving formatting.
 * Finds the first <w:r>, replaces its <w:t>, removes extra runs.
 * If `highlight` is true, adds yellow highlight.
 */
export function replaceCellContent(
  cellXml: string,
  newText: string,
  highlight: boolean = false
): string {
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  const runs = [...cellXml.matchAll(runRegex)];

  if (runs.length === 0) {
    // No runs - create one
    const insertPoint = cellXml.lastIndexOf("</w:p>");
    if (insertPoint === -1) return cellXml;
    const highlightXml = highlight
      ? '<w:rPr><w:highlight w:val="yellow"/></w:rPr>'
      : "";
    const newRun = `<w:r>${highlightXml}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r>`;
    return (
      cellXml.substring(0, insertPoint) +
      newRun +
      cellXml.substring(insertPoint)
    );
  }

  // Extract rPr from first run
  const firstRun = runs[0][0];
  const rPrMatch = firstRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  let rPr = rPrMatch ? rPrMatch[0] : "";

  if (highlight) {
    if (rPr) {
      rPr = rPr.replace(/<w:highlight[^/]*\/>/g, "");
      rPr = rPr.replace(
        "</w:rPr>",
        '<w:highlight w:val="yellow"/></w:rPr>'
      );
    } else {
      rPr = '<w:rPr><w:highlight w:val="yellow"/></w:rPr>';
    }
  }

  const newRun = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r>`;

  // Remove all runs, insert new one before closing </w:p>
  let result = cellXml;
  result = result.replace(runRegex, "");
  const lastP = result.lastIndexOf("</w:p>");
  if (lastP !== -1) {
    result = result.substring(0, lastP) + newRun + result.substring(lastP);
  }

  return result;
}

/**
 * Find a table row containing `labelText` in its first cell,
 * and replace the content of the value cell (last cell in the row).
 */
export function fillTableField(
  xml: string,
  labelText: string,
  value: string | undefined,
  missingDescription?: string
): string {
  const rowRegex = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
  let match;

  while ((match = rowRegex.exec(xml)) !== null) {
    const rowXml = match[0];
    const cellRegex = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
    const cells = [...rowXml.matchAll(cellRegex)];
    if (cells.length < 2) continue;

    const firstCellText = extractCellText(cells[0][0]);
    if (!firstCellText.includes(labelText)) continue;

    const valueCell = cells[cells.length - 1];
    const isMissing = !value || value.trim() === "";
    const displayValue = isMissing
      ? `[ЗАПОЛНИТЬ: ${missingDescription || labelText}]`
      : value;

    const newCell = replaceCellContent(valueCell[0], displayValue, isMissing);

    const rowStart = match.index;
    const rowEnd = rowStart + rowXml.length;
    const newRow = rowXml.replace(valueCell[0], newCell);
    xml = xml.substring(0, rowStart) + newRow + xml.substring(rowEnd);

    // Reset regex since string was modified
    rowRegex.lastIndex = rowStart + newRow.length;
  }

  return xml;
}

/**
 * Replace first occurrence of `searchText` in any <w:t> with `newText`.
 */
export function replaceText(
  xml: string,
  searchText: string,
  newText: string,
  highlight: boolean = false
): string {
  const escaped = escapeRegex(searchText);
  const re = new RegExp(
    `(<w:t[^>]*>)([^<]*?)(${escaped})([^<]*?)(</w:t>)`
  );
  const match = xml.match(re);
  if (!match) return xml;

  if (highlight) {
    const tPos = xml.indexOf(match[0]);
    const rStart = xml.lastIndexOf("<w:r", tPos);
    const rEnd = xml.indexOf("</w:r>", tPos) + 6;
    if (rStart !== -1 && rEnd > 6) {
      let runXml = xml.substring(rStart, rEnd);
      // Add highlight to run properties
      if (runXml.includes("<w:rPr>")) {
        runXml = runXml.replace(
          "<w:rPr>",
          '<w:rPr><w:highlight w:val="yellow"/>'
        );
      } else if (runXml.includes("<w:r>")) {
        runXml = runXml.replace(
          "<w:r>",
          '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr>'
        );
      } else {
        // <w:r w:rsidR="..."> — has attributes
        runXml = runXml.replace(
          /(<w:r\b[^>]*>)/,
          '$1<w:rPr><w:highlight w:val="yellow"/></w:rPr>'
        );
      }
      runXml = runXml.replace(searchText, escapeXml(newText));
      xml = xml.substring(0, rStart) + runXml + xml.substring(rEnd);
      return xml;
    }
  }

  xml = xml.replace(
    match[0],
    match[1] + match[2] + escapeXml(newText) + match[4] + match[5]
  );
  return xml;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
