import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { profiles } from "../src/lib/profiles";
import { autofillKnownDocxFields } from "../src/lib/server/docxAutofill";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraph(text: string) {
  return `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function cell(text: string) {
  return `<w:tc><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
}

function row(cells: string[]) {
  return `<w:tr>${cells.map(cell).join("")}</w:tr>`;
}

function table(rows: string[][]) {
  return `<w:tbl>${rows.map(row).join("")}</w:tbl>`;
}

async function makeDocx(bodyXml: string) {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>${bodyXml}</w:body>
    </w:document>`
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function documentXml(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("word/document.xml")?.async("string")) || "";
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"");
}

function textFromXml(xml: string) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function findElements(xml: string, tag: string) {
  const results: Array<{ start: number; end: number; xml: string }> = [];
  const close = `</${tag}>`;
  let index = 0;

  const findOpen = (from: number) => {
    let next = from;
    while (true) {
      next = xml.indexOf(`<${tag}`, next);
      if (next === -1) return -1;
      const nextChar = xml[next + tag.length + 1];
      if (!nextChar || /[>\s/]/.test(nextChar)) return next;
      next += tag.length + 1;
    }
  };

  while (true) {
    const start = findOpen(index);
    if (start === -1) break;
    let depth = 1;
    let position = start + tag.length + 1;
    while (depth > 0 && position < xml.length) {
      const nextOpen = findOpen(position);
      const nextClose = xml.indexOf(close, position);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        position = nextOpen + tag.length + 1;
      } else {
        depth--;
        position = nextClose + close.length;
      }
    }
    results.push({ start, end: position, xml: xml.slice(start, position) });
    index = position;
  }

  return results;
}

function tableRows(xml: string) {
  const firstTable = findElements(xml, "w:tbl")[0]?.xml || "";
  return findElements(firstTable, "w:tr").map((tableRow) =>
    findElements(tableRow.xml, "w:tc").map((tableCell) => textFromXml(tableCell.xml))
  );
}

const context = {
  procurement: {
    name: "Поставка электроинструмента",
    deliveryDeadline: "30 дней",
    deliveryAddresses: [],
  },
  pricing: { ourTotalPrice: 2790000, ndsRate: 5 },
  profile: profiles.boltinov,
  items: [
    {
      name: "Дрель-шуруповерт аккумуляторная",
      quantity: 50,
      unit: "шт",
      tzSpecs: "Емкость аккумулятора: не менее 2 Ач.",
      ourSpecs: "Емкость аккумулятора: 2 Ач.",
    },
    {
      name: "Дрель ударная",
      quantity: 9,
      unit: "шт.",
      tzSpecs: "Мощность электродвигателя: не менее 1100Вт.",
      ourSpecs: "Мощность электродвигателя: 1500Вт.",
    },
  ],
};

describe("autofillKnownDocxFields", () => {
  it("fills seven-column product offer tables like Appendix 1", async () => {
    const source = await makeDocx(table([
      [
        "№ п/п",
        "Наименование товара",
        "Количество товара",
        "Единицы измерения",
        "Технические характеристики, указанные в извещении.",
        "Технические характеристики, предлагаемые участником",
        "Страна происхождения.",
      ],
      ["", "", "", "", "", "", ""],
    ]));

    const result = await autofillKnownDocxFields(source, context);
    const rows = tableRows(await documentXml(result));

    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([
      "1",
      "Дрель-шуруповерт аккумуляторная",
      "50",
      "Шт.",
      "Емкость аккумулятора: не менее 2 Ач.",
      "Емкость аккумулятора: 2 Ач.",
      "Китайская Народная Республика",
    ]);
    expect(rows[2][1]).toBe("Дрель ударная");
    expect(rows[2][6]).toBe("Китайская Народная Республика");
  });

  it("fills Appendix 2 subject and price text", async () => {
    const source = await makeDocx([
      paragraph("Предложение участника запроса котировок о цене договора"),
      paragraph("на ____________________."),
      paragraph("(указать предмет)"),
      paragraph("Составляет ______ руб. с НДС ___ %"),
    ].join(""));

    const result = await autofillKnownDocxFields(source, context);
    const xml = await documentXml(result);

    expect(textFromXml(xml)).toContain("на поставку электроинструмента.");
    expect(textFromXml(xml)).toContain("Составляет 2790000 руб. с НДС 5 %");
  });

  it("fills three-column IP questionnaire tables like Appendix 3", async () => {
    const source = await makeDocx(table([
      ["№ п/п", "Наименование параметра", "Сведения об участнике"],
      ["", "Наименование, фирменное наименование (при наличии)", ""],
      ["", "Адрес юридического лица в пределах места нахождения юридического лица", "должно очиститься"],
      ["", "Фамилия, имя, отчество (при наличии), паспортные данные, адрес места жительства физического лица, зарегистрированного в качестве индивидуального предпринимателя, если участником конкурентной закупки с участием субъектов малого и среднего предпринимательства является индивидуальный предприниматель", ""],
      ["", "Идентификационный номер налогоплательщика участника конкурентной закупки с участием субъектов малого и среднего предпринимательства", ""],
      ["", "Идентификационный номер налогоплательщика (при наличии) учредителей, членов коллегиального исполнительного органа, лица, исполняющего функции единоличного исполнительного органа юридического лица, если участником конкурентной закупки с участием субъектов малого и среднего предпринимательства является юридическое лицо", "должно очиститься"],
      ["", "Адрес электронной почты, телефон", ""],
    ]));

    const result = await autofillKnownDocxFields(source, context);
    const rows = tableRows(await documentXml(result));

    expect(rows[1][2]).toBe("ИП Болтинов Данил Александрович");
    expect(rows[2][2]).toBe("");
    expect(rows[3][2]).toBe("Болтинов Данил Александрович, Паспорт 6519 880947 выдан 22.05.2019 ГУ МВД РОССИИ ПО СВЕРДЛОВСКОЙ ОБЛАСТИ, 426068 Республика Удмуртская г. Ижевск улица имени Сабурова А.Н. дом 47 кв. 34.");
    expect(rows[4][2]).toBe("662302062065");
    expect(rows[5][2]).toBe("");
    expect(rows[6][2]).toBe("Boltinov99@mail.ru");
  });
});
