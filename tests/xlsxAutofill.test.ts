import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { autofillKnownXlsxFields } from "../src/lib/server/xlsxAutofill";

async function makeBuffer(setup: (sheet: ExcelJS.Worksheet) => void) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Приложение № 1");
  setup(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function readSheet(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook.worksheets[0];
}

describe("autofillKnownXlsxFields", () => {
  it("fills product offer XLSX tables with all items and full specs", async () => {
    const source = await makeBuffer((sheet) => {
      sheet.getCell("C8").value = "________________";
      sheet.getCell("C9").value = "(указывается Участником закупки)";
      sheet.getCell("B14").value = "Наименование товара";
      sheet.getCell("C14").value = "Указать конкретные показатели товара, соответствующие значениям";
      sheet.getCell("D14").value = "Страна происхождения поставляемого товара";
      sheet.getCell("A15").value = "Китайская Народная Республика";
      sheet.getCell("B15").value = "Китайская Народная Республика";
      sheet.getCell("C15").value = "Китайская Народная Республика";
      sheet.getCell("D15").value = "Китайская Народная Республика";
      sheet.mergeCells("A16:D16");
      sheet.getCell("A16").value = "Китайская Народная Республика";
    });

    const result = await autofillKnownXlsxFields(source, {
      procurement: { name: "Поставка электроинструмента" },
      items: [
        {
          name: "Дрель-шуруповерт аккумуляторная",
          ourSpecs: "Емкость аккумулятора: 2 Ач.",
        },
        {
          name: "Дрель ударная",
          ourSpecs: "Мощность электродвигателя: 1500Вт.",
        },
      ],
    });
    const sheet = await readSheet(result);

    expect(sheet.getCell("C8").value).toBe("Поставка электроинструмента");
    expect(sheet.getCell("A15").value).toBe(1);
    expect(sheet.getCell("B15").value).toBe("Дрель-шуруповерт аккумуляторная");
    expect(sheet.getCell("C15").value).toBe("Емкость аккумулятора: 2 Ач.");
    expect(sheet.getCell("D15").value).toBe("Китайская Народная Республика");
    expect(sheet.getCell("A16").value).toBe(2);
    expect(sheet.getCell("B16").value).toBe("Дрель ударная");
    expect(sheet.getCell("C16").value).toBe("Мощность электродвигателя: 1500Вт.");
    expect(sheet.getCell("D16").value).toBe("Китайская Народная Республика");
  });
});
