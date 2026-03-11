"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getProfile } from "../src/lib/profiles";
import type { CompanyProfile } from "../src/lib/profiles";
import ExcelJS from "exceljs";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
} from "docx";
import {
  openDocx,
  saveDocx,
  fillTableField,
  replaceText,
  replaceCellContent,
  extractAllCellTexts,
} from "./docxHelpers";

// ============================================================
// Helpers
// ============================================================

const HIGHLIGHT_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFFF00" },
};

/** Fetch a form template buffer from Convex storage by name */
async function fetchTemplate(ctx: any, name: string): Promise<ArrayBuffer> {
  const template = await ctx.runQuery(api.files.getFormTemplate, { name });
  if (!template)
    throw new Error(
      `Template '${name}' not found. Run: CONVEX_URL=... npx tsx scripts/uploadTemplates.ts`
    );
  const url = await ctx.storage.getUrl(template.storageId);
  if (!url) throw new Error(`Template '${name}' storage URL not found`);
  const resp = await fetch(url);
  return await resp.arrayBuffer();
}

/** Set XLSX cell value; highlight yellow if missing */
function setCell(
  sheet: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: string | number | undefined,
  missingDescription?: string
) {
  const cell = sheet.getRow(row).getCell(col);
  if (value !== undefined && value !== null && value !== "") {
    cell.value = value;
  } else {
    cell.value = `[ЗАПОЛНИТЬ: ${missingDescription || "данные"}]`;
    cell.fill = HIGHLIGHT_FILL;
  }
}

function makeTableRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 40, type: WidthType.PERCENTAGE },
        children: [
          new Paragraph({
            children: [new TextRun({ text: label, bold: true })],
          }),
        ],
      }),
      new TableCell({
        width: { size: 60, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun(value)] })],
      }),
    ],
  });
}

function getMonthName(month: number): string {
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  return months[month];
}

// ============================================================
// Form 2 — Письмо о подаче оферты (generated from scratch via docx lib)
// ============================================================

async function generateForm2Docx(
  profile: CompanyProfile,
  procurement: { name: string; number: string; nmck: number },
  totalOurPrice: number
): Promise<Buffer> {
  const today = new Date();
  const dateStr = `«${today.getDate()}» ${getMonthName(today.getMonth())} ${today.getFullYear()} года`;
  const vatInfo = "НДС не облагается";

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `${dateStr} №______`, size: 22 })],
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({
                text: "Председателю закупочной комиссии",
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Изучив Извещение о запросе предложений в электронной форме на право заключения Договора ",
                size: 22,
              }),
              new TextRun({
                text: procurement.name,
                size: 22,
                bold: true,
              }),
              new TextRun({
                text: ", опубликованное на официальном сайте и документацию о закупке, и принимая установленные в них требования и условия закупки,",
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: profile.fullName,
                size: 22,
                bold: true,
              }),
              new TextRun({ text: ",", size: 22 }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `зарегистрированное по адресу: ${profile.legalAddress},`,
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: `предлагает заключить Договор на: ${procurement.name}`,
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: "на условиях и в соответствии с документами, являющимися неотъемлемыми приложениями к настоящему письму и составляющими вместе с настоящим письмом заявку, на общую сумму:",
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              makeTableRow(
                "Итоговая стоимость заявки, руб.",
                totalOurPrice > 0
                  ? totalOurPrice.toFixed(2)
                  : "[ЗАПОЛНИТЬ: итоговая стоимость]"
              ),
              makeTableRow("в том числе НДС", vatInfo),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Настоящая заявка имеет правовой статус оферты и действует в течение 90 календарных дней с момента срока окончания подачи Заявок.",
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Я, нижеподписавшийся, настоящим удостоверяю, что на момент подписания настоящей заявки ${profile.shortName} полностью удовлетворяет требованиям к Участникам закупки.`,
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${profile.director.position}    ________________    ${profile.director.fio}`,
                size: 22,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "М.П.", italics: true, size: 18 }),
            ],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}

// ============================================================
// Form 3 — Анкета участника (template-based DOCX)
// ============================================================

async function generateForm3Docx(
  ctx: any,
  profile: CompanyProfile,
  procurement: { name: string; number: string }
): Promise<Buffer> {
  const templateBuf = await fetchTemplate(ctx, "form3");
  let { zip, xml } = await openDocx(templateBuf);

  // Fill header fields
  xml = replaceText(xml, "____________________", procurement.name);
  xml = replaceText(xml, "________________________________", profile.shortName);

  // Bank details as combined string
  const bankInfo = [
    `Наименование: ${profile.bank.name}`,
    `БИК: ${profile.bank.bic}`,
    `Р/с: ${profile.bank.account}`,
    `К/с: ${profile.bank.corrAccount}`,
    `Адрес: ${profile.bank.address}`,
  ].join("; ");

  const directorInfo = `${profile.director.fio}, ${profile.director.position}, тел.: ${profile.director.phone}`;

  // Fill table fields by label text
  const fields: Array<[string, string | undefined, string?]> = [
    ["Полное наименование", profile.fullName],
    ["Сокращенное наименование", profile.shortName],
    ["Виды деятельности", profile.okved, "код ОКВЭД"],
    ["Код субъекта РФ", undefined, "код субъекта РФ"],
    ["ОКТМО", profile.oktmo],
    ["ОГРН", profile.ogrn],
    ["ОКПО", profile.okpo],
    ["ИНН", profile.inn],
    ["КПП", profile.kpp || "—"],
    ["Юридический адрес", profile.legalAddress],
    ["Почтовый адрес", profile.mailingAddress],
    ["Фактическое местоположение", profile.actualAddress],
    ["Филиалы", "Отсутствуют"],
    ["Банковские реквизиты", bankInfo],
    ["Телефоны", profile.director.phone],
    ["Факс", "—"],
    ["Адрес электронной почты", profile.director.email],
    ["руководителя", directorInfo],
    ["ответственного лица", directorInfo],
  ];

  for (const [label, value, missingDesc] of fields) {
    xml = fillTableField(xml, label, value, missingDesc);
  }

  return saveDocx(zip, xml);
}

// ============================================================
// Form 6 — Цепочка собственников (template-based DOCX)
// ============================================================

async function generateForm6Docx(
  ctx: any,
  profile: CompanyProfile
): Promise<Buffer> {
  const templateBuf = await fetchTemplate(ctx, "form6");
  let { zip, xml } = await openDocx(templateBuf);

  // Fill company name in header (replace placeholder text)
  xml = replaceText(
    xml,
    "полное наименование организации с расшифровкой организационно-правовой формы, ИП",
    profile.fullName
  );

  // Find the numbered header row (1, 2, 3, ..., 16) then fill the data row after it
  const rowRegex = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
  const rows = [...xml.matchAll(rowRegex)];

  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cellTexts = extractAllCellTexts(rows[i][0]);
    if (
      cellTexts.length >= 14 &&
      cellTexts[0].trim() === "1" &&
      cellTexts[1].trim() === "2" &&
      cellTexts[2].trim() === "3"
    ) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx !== -1 && headerRowIdx + 1 < rows.length) {
    const dataRow = rows[headerRowIdx + 1];
    const cellRegex = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
    const cells = [...dataRow[0].matchAll(cellRegex)];

    const missing = (desc: string) => ({
      text: `[ЗАПОЛНИТЬ: ${desc}]`,
      highlight: true,
    });

    // Column mapping based on Form 6 structure (16 columns):
    // 0=№, 1=ИНН, 2=ОГРН, 3=Наименование, 4=ОКВЭД,
    // 5=ФИО рук., 6=Серия паспорта, 7=ИНН(бен), 8=ОГРН(бен),
    // 9=ФИО(бен), 10=Адрес, 11=Паспорт(бен), 12=Роль, 13=Доля, 14=Документы
    const values: Array<{ text: string; highlight: boolean }> = [
      { text: "1", highlight: false },
      { text: profile.inn, highlight: false },
      { text: profile.ogrn, highlight: false },
      { text: profile.shortName, highlight: false },
      {
        text: profile.okved || "[ЗАПОЛНИТЬ: ОКВЭД]",
        highlight: !profile.okved,
      },
      { text: profile.director.fio, highlight: false },
      missing("серия и номер паспорта"),
      { text: profile.inn, highlight: false },
      { text: profile.ogrn, highlight: false },
      { text: profile.director.fio, highlight: false },
      { text: profile.actualAddress, highlight: false },
      missing("серия и номер паспорта"),
      { text: "Индивидуальный предприниматель", highlight: false },
      { text: "100%", highlight: false },
      missing("реквизиты подтверждающих документов"),
    ];

    let newDataRow = dataRow[0];
    const dataCells = [...newDataRow.matchAll(cellRegex)];
    for (let c = 0; c < Math.min(values.length, dataCells.length); c++) {
      const newCell = replaceCellContent(
        dataCells[c][0],
        values[c].text,
        values[c].highlight
      );
      newDataRow = newDataRow.replace(dataCells[c][0], newCell);
    }

    xml = xml.replace(dataRow[0], newDataRow);
  }

  return saveDocx(zip, xml);
}

// ============================================================
// Tech Proposal — Приложение 3.1 (template-based XLSX)
// ============================================================

async function generateTechProposal(
  ctx: any,
  items: any[],
  calcData: Map<string, any>
): Promise<Buffer> {
  const templateBuf = await fetchTemplate(ctx, "techProposal");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuf as any);
  const sheet = workbook.worksheets[0];

  // Template has data starting at row 28 (verified via ExcelJS inspection).
  // Rows 10-13 are headers, 14-27 are section headers.
  // Template cols: 1=№, 2=номенкл., 3=код, 4=наименование Заказчиком,
  // 5=предлагаемое Участником, 6=аттестация, 7=№ аттестации,
  // 8=производитель, 9=страна, 10=ГОСТ, 11=срок, 12=квартал, 13=ист.фин., 14=ед.изм.

  for (let i = 0; i < items.length; i++) {
    const rowNum = 28 + i;
    if (rowNum > sheet.rowCount) break;

    const calc = calcData.get(items[i]._id);

    // Col 5: предлагаемое Участником
    setCell(
      sheet,
      rowNum,
      5,
      calc?.ourSpecs,
      "предлагаемое наименование"
    );

    // Col 8: Наименование производителя
    setCell(sheet, rowNum, 8, undefined, "наименование производителя, ИНН");

    // Col 9: Страна происхождения
    setCell(sheet, rowNum, 9, undefined, "страна происхождения");
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// Price Proposal — Приложение 3.2 (template-based XLSX)
// ============================================================

async function generatePriceProposal(
  ctx: any,
  items: any[],
  calcData: Map<string, any>
): Promise<Buffer> {
  const templateBuf = await fetchTemplate(ctx, "priceProposal");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuf as any);
  const sheet = workbook.worksheets[0];

  // Template structure (verified via inspection):
  // Col 6: предлагаемое Участником
  // Col 9: наименование производителя
  // Col 10: страна происхождения
  // Col 30: единый коэффициент — OUR INPUT
  // Cols 31-34: participant prices (formulas based on col 30)

  for (let i = 0; i < items.length; i++) {
    const rowNum = 28 + i;
    if (rowNum > sheet.rowCount) break;

    const item = items[i];
    const calc = calcData.get(item._id);

    // Col 6: предлагаемое Участником
    setCell(sheet, rowNum, 6, calc?.ourSpecs, "предлагаемое наименование");

    // Col 9: Наименование производителя
    setCell(
      sheet,
      rowNum,
      9,
      undefined,
      "наименование производителя, ИНН"
    );

    // Col 10: Страна происхождения
    setCell(sheet, rowNum, 10, undefined, "страна происхождения");

    // Col 30: Единый коэффициент
    if (calc?.ourUnitPrice && item.nmckPrice > 0) {
      const coefficient = calc.ourUnitPrice / item.nmckPrice;
      sheet.getRow(rowNum).getCell(30).value =
        Math.round(coefficient * 100) / 100;
    } else {
      setCell(sheet, rowNum, 30, undefined, "коэффициент снижения");
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// Main generation action
// ============================================================

export const generateForms = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const updateProgress = async (msg: string, progress: number) => {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "generating",
        statusMessage: msg,
        progress,
      });
    };

    try {
      await updateProgress("Подготовка данных...", 0);

      const procurement = await ctx.runQuery(api.procurements.get, {
        id: args.procurementId,
      });
      if (!procurement) throw new Error("Procurement not found");

      const profile = getProfile(procurement.profileId);
      const items = await ctx.runQuery(api.files.getExtractedItems, {
        procurementId: args.procurementId,
      });

      const calcDataRaw = await ctx.runQuery(api.files.getCalculationData, {
        procurementId: args.procurementId,
      });
      const calcData = new Map(calcDataRaw.map((c: any) => [c.itemId, c]));
      const totalOurPrice = calcDataRaw.reduce(
        (sum: number, c: any) => sum + (c.ourTotal || 0),
        0
      );

      // Clear previous generated files
      await ctx.runMutation(internal.analysisHelpers.clearGeneratedFiles, {
        procurementId: args.procurementId,
      });

      const docxMime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const xlsxMime =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

      // --- Form 2: Письмо о подаче оферты (0-15%) ---
      await updateProgress("Генерация Формы 2 (Письмо)...", 5);
      const form2Buf = await generateForm2Docx(
        profile,
        procurement,
        totalOurPrice
      );
      const form2Id = await ctx.storage.store(
        new Blob([new Uint8Array(form2Buf)], { type: docxMime })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: form2Id,
        fileName: "Форма 2 - Письмо о подаче оферты.docx",
        formType: "form2",
      });

      // --- Form 3: Анкета участника (15-35%) ---
      await updateProgress("Генерация Формы 3 (Анкета)...", 15);
      const form3Buf = await generateForm3Docx(ctx, profile, procurement);
      const form3Id = await ctx.storage.store(
        new Blob([new Uint8Array(form3Buf)], { type: docxMime })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: form3Id,
        fileName: "Форма 3 - Анкета участника.docx",
        formType: "form3",
      });

      // --- Form 6: Цепочка собственников (35-55%) ---
      await updateProgress(
        "Генерация Формы 6 (Цепочка собственников)...",
        35
      );
      const form6Buf = await generateForm6Docx(ctx, profile);
      const form6Id = await ctx.storage.store(
        new Blob([new Uint8Array(form6Buf)], { type: docxMime })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: form6Id,
        fileName: "Форма 6 - Цепочка собственников.docx",
        formType: "form6",
      });

      // --- Tech proposal: Приложение 3.1 (55-75%) ---
      await updateProgress(
        "Генерация Тех.предложения (Приложение 3.1)...",
        55
      );
      const techBuf = await generateTechProposal(ctx, items, calcData);
      const techId = await ctx.storage.store(
        new Blob([new Uint8Array(techBuf)], { type: xlsxMime })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: techId,
        fileName: "Приложение 3.1 - Тех.предложение.xlsx",
        formType: "techProposal",
      });

      // --- Price proposal: Приложение 3.2 (75-95%) ---
      await updateProgress(
        "Генерация Цен.предложения (Приложение 3.2)...",
        75
      );
      const priceBuf = await generatePriceProposal(ctx, items, calcData);
      const priceId = await ctx.storage.store(
        new Blob([new Uint8Array(priceBuf)], { type: xlsxMime })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: priceId,
        fileName: "Приложение 3.2 - Цен.предложение.xlsx",
        formType: "priceProposal",
      });

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "completed",
        statusMessage: "Формы сгенерированы (5 файлов)",
        progress: 100,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "error",
        statusMessage: `Ошибка генерации: ${error.message}`,
        progress: 0,
      });
    }
  },
});
