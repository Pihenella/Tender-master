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

function generateForm3Docx(profile: CompanyProfile): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "ФОРМА 3", bold: true, size: 28 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "АНКЕТА УЧАСТНИКА ЗАКУПКИ",
                bold: true,
                size: 24,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              makeTableRow("Полное наименование", profile.fullName),
              makeTableRow("Сокращенное наименование", profile.shortName),
              makeTableRow("ОКВЭД", profile.okved),
              makeTableRow("ОКТМО", profile.oktmo),
              makeTableRow("ОГРН/ОГРНИП", profile.ogrn),
              makeTableRow("ОКПО", profile.okpo),
              makeTableRow("ИНН", profile.inn),
              makeTableRow("КПП", profile.kpp || "—"),
              makeTableRow("Юридический адрес", profile.legalAddress),
              makeTableRow("Почтовый адрес", profile.mailingAddress),
              makeTableRow("Фактический адрес", profile.actualAddress),
              makeTableRow("Филиалы", "Отсутствуют"),
              makeTableRow("Наименование банка", profile.bank.name),
              makeTableRow("БИК", profile.bank.bic),
              makeTableRow("Расчетный счет", profile.bank.account),
              makeTableRow("Корреспондентский счет", profile.bank.corrAccount),
              makeTableRow("Адрес банка", profile.bank.address),
              makeTableRow("Телефон", profile.director.phone),
              makeTableRow("E-mail", profile.director.email),
              makeTableRow("Руководитель (ФИО)", profile.director.fio),
              makeTableRow("Должность", profile.director.position),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${profile.director.position}    ________________    ${profile.director.fio}`,
              }),
            ],
          }),
          new Paragraph({
            children: [new TextRun({ text: "М.П.", italics: true, size: 18 })],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}

function generateForm6Docx(profile: CompanyProfile): Promise<Buffer> {
  const ownerRows = [
    new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: "№", bold: true })],
            }),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: "ИНН", bold: true })],
            }),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: "ОГРН", bold: true })],
            }),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: "ФИО/Наименование", bold: true }),
              ],
            }),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: "Роль", bold: true })],
            }),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: "Доля", bold: true })],
            }),
          ],
        }),
      ],
    }),
  ];

  if (profile.ownershipChain.length === 0) {
    ownerRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph("1")] }),
          new TableCell({ children: [new Paragraph(profile.inn)] }),
          new TableCell({ children: [new Paragraph(profile.ogrn)] }),
          new TableCell({
            children: [new Paragraph(profile.director.fio)],
          }),
          new TableCell({
            children: [new Paragraph("Индивидуальный предприниматель")],
          }),
          new TableCell({ children: [new Paragraph("100%")] }),
        ],
      })
    );
  } else {
    profile.ownershipChain.forEach((owner, i) => {
      ownerRows.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(String(i + 1))] }),
            new TableCell({ children: [new Paragraph(owner.inn)] }),
            new TableCell({ children: [new Paragraph("—")] }),
            new TableCell({ children: [new Paragraph(owner.fio)] }),
            new TableCell({ children: [new Paragraph(owner.role)] }),
            new TableCell({ children: [new Paragraph(owner.share)] }),
          ],
        })
      );
    });
  }

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "ФОРМА 6", bold: true, size: 28 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "СПРАВКА О ЦЕПОЧКЕ СОБСТВЕННИКОВ (БЕНЕФИЦИАРОВ)",
                bold: true,
                size: 22,
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun(`ИНН: ${profile.inn}    ОГРН: ${profile.ogrn}`),
            ],
          }),
          new Paragraph({
            children: [new TextRun(`Наименование: ${profile.shortName}`)],
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: ownerRows,
          }),
          new Paragraph({ children: [new TextRun("")] }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${profile.director.position}    ________________    ${profile.director.fio}`,
              }),
            ],
          }),
          new Paragraph({
            children: [new TextRun({ text: "М.П.", italics: true, size: 18 })],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}

async function generateTechProposal(
  items: any[],
  calcData: Map<string, any>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Техническое предложение");

  sheet.columns = [
    { header: "№ п/п", key: "num", width: 6 },
    { header: "Наименование продукции", key: "name", width: 40 },
    { header: "Ед. изм.", key: "unit", width: 8 },
    { header: "Количество", key: "quantity", width: 10 },
    { header: "Требуемое Заказчиком", key: "tzSpecs", width: 40 },
    { header: "Предлагаемое Участником", key: "ourSpecs", width: 40 },
    { header: "Квартал поставки", key: "quarter", width: 15 },
  ];

  sheet.getRow(1).font = { bold: true };

  items.forEach((item: any, i: number) => {
    const calc = calcData.get(item._id);
    sheet.addRow({
      num: i + 1,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      tzSpecs: item.tzSpecs,
      ourSpecs: calc?.ourSpecs || "",
      quarter: item.quarter,
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function generatePriceProposal(
  items: any[],
  calcData: Map<string, any>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ценовое предложение");

  sheet.columns = [
    { header: "№ п/п", key: "num", width: 6 },
    { header: "Наименование продукции", key: "name", width: 40 },
    { header: "Ед. изм.", key: "unit", width: 8 },
    { header: "Количество", key: "quantity", width: 10 },
    { header: "Цена за ед. (руб.)", key: "unitPrice", width: 16 },
    { header: "Сумма (руб.)", key: "total", width: 16 },
    { header: "Квартал поставки", key: "quarter", width: 15 },
  ];

  sheet.getRow(1).font = { bold: true };

  items.forEach((item: any, i: number) => {
    const calc = calcData.get(item._id);
    sheet.addRow({
      num: i + 1,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: calc?.ourUnitPrice || 0,
      total: calc?.ourTotal || 0,
      quarter: item.quarter,
    });
  });

  const lastRow = items.length + 1;
  const totalsRow = sheet.addRow({
    num: "",
    name: "ИТОГО",
    total: { formula: `SUM(F2:F${lastRow})` },
  });
  totalsRow.font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

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

      // Clear previous generated files
      await ctx.runMutation(internal.analysisHelpers.clearGeneratedFiles, {
        procurementId: args.procurementId,
      });

      // Form 3 (0-25%)
      await updateProgress("Генерация Формы 3 (Анкета)...", 10);
      const form3Buffer = await generateForm3Docx(profile);
      const form3StorageId = await ctx.storage.store(
        new Blob([new Uint8Array(form3Buffer)], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: form3StorageId,
        fileName: "Форма 3 - Анкета участника.docx",
        formType: "form3",
      });

      // Form 6 (25-50%)
      await updateProgress("Генерация Формы 6 (Цепочка собственников)...", 30);
      const form6Buffer = await generateForm6Docx(profile);
      const form6StorageId = await ctx.storage.store(
        new Blob([new Uint8Array(form6Buffer)], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: form6StorageId,
        fileName: "Форма 6 - Цепочка собственников.docx",
        formType: "form6",
      });

      // Tech proposal (50-75%)
      await updateProgress("Генерация Тех. предложения...", 55);
      const techBuffer = await generateTechProposal(items, calcData);
      const techStorageId = await ctx.storage.store(
        new Blob([new Uint8Array(techBuffer)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: techStorageId,
        fileName: "Тех.предложение.xlsx",
        formType: "techProposal",
      });

      // Price proposal (75-100%)
      await updateProgress("Генерация Цен. предложения...", 80);
      const priceBuffer = await generatePriceProposal(items, calcData);
      const priceStorageId = await ctx.storage.store(
        new Blob([new Uint8Array(priceBuffer)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })
      );
      await ctx.runMutation(api.files.saveGeneratedFile, {
        procurementId: args.procurementId,
        profileId: procurement.profileId,
        storageId: priceStorageId,
        fileName: "Цен.предложение.xlsx",
        formType: "priceProposal",
      });

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "completed",
        statusMessage: "Формы сгенерированы",
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
