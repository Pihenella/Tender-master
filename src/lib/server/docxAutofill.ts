import JSZip from "jszip";

type ContextData = {
  procurement?: {
    name?: string;
    deliveryDeadline?: string;
    deliveryAddresses?: Array<{ name?: string; address?: string }>;
  };
  pricing?: {
    ourTotalPrice?: number;
    ndsRate?: number;
  };
  profile?: {
    fullName?: string;
    shortName?: string;
    inn?: string;
    ogrn?: string;
    kpp?: string;
    okpo?: string;
    oktmo?: string;
    okved?: string;
    legalAddress?: string;
    mailingAddress?: string;
    actualAddress?: string;
    director?: { fio?: string; fioShort?: string; position?: string; phone?: string; email?: string };
    passport?: {
      series?: string;
      number?: string;
      issueDate?: string;
      issuedBy?: string;
      departmentCode?: string;
    };
    tax?: {
      ndsRate?: number;
    };
  };
  items?: Array<{
    itemName?: string;
    name?: string;
    quantity?: number;
    unit?: string;
    tzSpecs?: string;
    ourSpecs?: string;
    pp1875?: string;
    country?: string;
    countryOfOrigin?: string;
    originCountry?: string;
  }>;
};

function safeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textFromXml(xml: string) {
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function findBalancedElements(xml: string, tag: string) {
  const results: Array<{ start: number; end: number; text: string }> = [];
  const openRe = new RegExp(`<${tag}\\b`, "g");
  const closeStr = `</${tag}>`;
  let match: RegExpExecArray | null;
  const findNextOpen = (from: number) => {
    let index = from;
    while (true) {
      index = xml.indexOf(`<${tag}`, index);
      if (index === -1) return -1;
      const nextChar = xml[index + tag.length + 1];
      if (!nextChar || nextChar === ">" || nextChar === " " || nextChar === "/" || nextChar === "\n" || nextChar === "\r" || nextChar === "\t") {
        return index;
      }
      index += tag.length + 1;
    }
  };

  while ((match = openRe.exec(xml)) !== null) {
    let depth = 1;
    let pos = match.index + match[0].length;
    while (depth > 0 && pos < xml.length) {
      const nextOpen = findNextOpen(pos);
      const nextClose = xml.indexOf(closeStr, pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + tag.length + 1;
      } else {
        depth--;
        pos = nextClose + closeStr.length;
      }
    }
    if (depth === 0) {
      results.push({ start: match.index, end: pos, text: xml.slice(match.index, pos) });
      openRe.lastIndex = pos;
    }
  }

  return results;
}

function replaceCellText(cellXml: string, value: string) {
  const open = cellXml.match(/^<w:tc\b[^>]*>/)?.[0] || "<w:tc>";
  const props = cellXml.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  return `${open}${props}<w:p><w:r><w:t xml:space="preserve">${safeXml(value)}</w:t></w:r></w:p></w:tc>`;
}

function rowWithCellValues(rowXml: string, values: string[]) {
  const cells = findBalancedElements(rowXml, "w:tc");
  let nextRow = rowXml;

  for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex--) {
    const value = values[cellIndex] ?? "";
    const newCell = replaceCellText(cells[cellIndex].text, value);
    nextRow = nextRow.slice(0, cells[cellIndex].start) + newCell + nextRow.slice(cells[cellIndex].end);
  }

  return nextRow;
}

function replaceParagraphText(paragraphXml: string, value: string) {
  const open = paragraphXml.match(/^<w:p\b[^>]*>/)?.[0] || "<w:p>";
  const props = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || "";
  return `${open}${props}<w:r><w:t xml:space="preserve">${safeXml(value)}</w:t></w:r></w:p>`;
}

function cleanText(value: string | undefined) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function ensurePeriod(value: string) {
  const trimmed = cleanText(value);
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function trimTrailingPeriod(value: string) {
  return cleanText(value).replace(/[.\s]+$/g, "");
}

function lowerFirst(value: string) {
  const trimmed = cleanText(value);
  if (!trimmed) return "";
  return trimmed[0].toLowerCase() + trimmed.slice(1);
}

function subjectAfterPreposition(value: string) {
  const subject = lowerFirst(value).replace(/^на\s+/i, "");
  if (subject.startsWith("поставка ")) return subject.replace(/^поставка(?=\s|$)/, "поставку");
  return subject;
}

function formatNumber(value: number | undefined) {
  if (value == null || Number.isNaN(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(value).replace(".", ",");
}

function formatMoney(value: number | undefined) {
  if (value == null || Number.isNaN(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(".", ",");
}

function formatUnit(value: string | undefined) {
  const unit = cleanText(value);
  const normalized = normalize(unit);
  if (!unit || normalized === "шт" || normalized === "шт.") return "Шт.";
  return unit;
}

function countryOfOrigin(item: NonNullable<ContextData["items"]>[number]) {
  return cleanText(item.countryOfOrigin || item.originCountry || item.country) || "Китайская Народная Республика";
}

function isIpProfile(profile: NonNullable<ContextData["profile"]>) {
  return normalize([profile.fullName, profile.shortName, profile.director?.position].filter(Boolean).join(" "))
    .includes("индивидуальн");
}

function ipParticipantName(profile: NonNullable<ContextData["profile"]>) {
  const fio = cleanText(profile.director?.fio) ||
    cleanText(profile.fullName).replace(/^Индивидуальный предприниматель\s+/i, "");
  if (fio) return `ИП ${fio}`;
  return profile.shortName || profile.fullName || "";
}

function shortFio(profile: NonNullable<ContextData["profile"]>) {
  const fio = profile.director?.fio || "";
  const parts = fio.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 3) return `${parts[0]} ${parts[1][0]}.${parts[2][0]}.`;
  return fio || profile.fullName || "";
}

function passportText(profile: NonNullable<ContextData["profile"]>) {
  const passport = profile.passport || {};
  return [
    [passport.series, passport.number].filter(Boolean).join(" "),
    passport.issueDate ? `выдан ${passport.issueDate}` : "",
    passport.issuedBy || "",
    passport.departmentCode ? `код подразделения ${passport.departmentCode}` : "",
  ].filter(Boolean).join(", ");
}

function passportForQuestionnaire(profile: NonNullable<ContextData["profile"]>) {
  const passport = profile.passport || {};
  return [
    "Паспорт",
    [passport.series, passport.number].filter(Boolean).join(" "),
    passport.issueDate ? `выдан ${passport.issueDate}` : "",
    passport.issuedBy ? passport.issuedBy.toUpperCase() : "",
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function ipPersonalDetails(profile: NonNullable<ContextData["profile"]>) {
  return ensurePeriod([
    cleanText(profile.director?.fio) || cleanText(profile.fullName).replace(/^Индивидуальный предприниматель\s+/i, ""),
    passportForQuestionnaire(profile),
    trimTrailingPeriod(profile.actualAddress || profile.legalAddress || ""),
  ].filter(Boolean).join(", "));
}

function participantValue(label: string, contextData: ContextData): string | undefined {
  const profile = contextData.profile;
  if (!profile) return undefined;

  const normalized = normalize(label);
  if (normalized.includes("наименование, фирменное наименование")) {
    return isIpProfile(profile) ? ipParticipantName(profile) : profile.fullName || "";
  }
  if (normalized.includes("полное наименование")) {
    return profile.fullName || "";
  }
  if (normalized.includes("сокращ") && normalized.includes("наименование")) {
    return profile.shortName || ipParticipantName(profile) || profile.fullName || "";
  }
  if (normalized.includes("адрес юридического лица в пределах места нахождения юридического лица")) {
    return isIpProfile(profile) ? "" : profile.legalAddress || "";
  }
  if (normalized.includes("фамилия, имя, отчество")) {
    if (normalized.includes("паспортные данные") && normalized.includes("адрес места жительства")) {
      return ipPersonalDetails(profile);
    }
    return profile.director?.fio || profile.fullName || "";
  }
  if (normalized.includes("паспортные данные")) {
    return passportText(profile);
  }
  if (normalized.includes("адрес места жительства")) {
    return profile.actualAddress || profile.legalAddress || "";
  }
  if (normalized.includes("почтовый адрес")) {
    return profile.mailingAddress || profile.legalAddress || "";
  }
  if (normalized.includes("фактический адрес")) {
    return profile.actualAddress || profile.legalAddress || "";
  }
  if (normalized.includes("юридический адрес")) {
    return profile.legalAddress || "";
  }
  if (
    normalized.includes("идентификационный номер налогоплательщика") &&
    normalized.includes("учредител")
  ) {
    return isIpProfile(profile) ? "" : undefined;
  }
  if (
    normalized.includes("идентификационный номер налогоплательщика") &&
    (normalized.includes("участника закупки") || !normalized.includes("учредител"))
  ) {
    return profile.inn || "";
  }
  if (normalized.includes("адрес электронной почты") && normalized.includes("телефон")) {
    return profile.director?.email || profile.director?.phone || "";
  }
  if (normalized.includes("адрес электронной почты") || normalized.includes("e-mail") || normalized.includes("email")) {
    return profile.director?.email || "";
  }
  if (normalized.includes("телефон")) {
    return profile.director?.phone || "";
  }
  if (normalized.includes("огрн")) {
    return profile.ogrn || "";
  }
  if (normalized.includes("кпп")) {
    return profile.kpp || (isIpProfile(profile) ? "нет (ИП)" : "");
  }
  if (normalized.includes("окпо")) {
    return profile.okpo || "";
  }
  if (normalized.includes("октмо")) {
    return profile.oktmo || "";
  }
  if (normalized.includes("оквэд") || normalized.includes("виды деятельности")) {
    return profile.okved || "";
  }

  return undefined;
}

function fillTwoColumnParticipantTables(docXml: string, contextData: ContextData) {
  let xml = docXml;
  const tables = findBalancedElements(xml, "w:tbl");

  for (let tableIndex = tables.length - 1; tableIndex >= 0; tableIndex--) {
    const table = tables[tableIndex];
    const rows = findBalancedElements(table.text, "w:tr");
    let tableText = table.text;
    let changed = false;

    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
      const row = rows[rowIndex];
      const cells = findBalancedElements(row.text, "w:tc");
      if (cells.length < 2) continue;

      const labelCellIndex = cells.length >= 3 ? 1 : 0;
      const valueCellIndex = cells.length - 1;
      const value = participantValue(textFromXml(cells[labelCellIndex].text), contextData);
      if (value === undefined) continue;

      const newCell = replaceCellText(cells[valueCellIndex].text, value);
      const newRow = row.text.slice(0, cells[valueCellIndex].start) + newCell + row.text.slice(cells[valueCellIndex].end);
      tableText = tableText.slice(0, row.start) + newRow + tableText.slice(row.end);
      changed = true;
    }

    if (changed) {
      xml = xml.slice(0, table.start) + tableText + xml.slice(table.end);
    }
  }

  return xml;
}

function deliveryAddress(contextData: ContextData) {
  return (contextData.procurement?.deliveryAddresses || [])
    .map((item) => [item.name, item.address].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
}

function pp1875Value(value: string | undefined) {
  const normalized = normalize(value || "");
  if (!normalized) return "-";
  if (normalized.includes("перечень")) return value || "-";
  if (normalized.includes("исключ")) return value || "-";
  if (normalized.includes("преимуществ")) return "перечень № 1";
  return value || "-";
}

function fillProductOfferTable(docXml: string, contextData: ContextData) {
  const items = contextData.items || [];
  if (!items.length) return docXml;

  let xml = docXml;
  const tables = findBalancedElements(xml, "w:tbl");

  for (let tableIndex = tables.length - 1; tableIndex >= 0; tableIndex--) {
    const table = tables[tableIndex];
    const tableLabel = normalize(textFromXml(table.text));
    if (
      !tableLabel.includes("наименование товара") ||
      !tableLabel.includes("количество товара") ||
      !tableLabel.includes("технические характеристики, указанные") ||
      !tableLabel.includes("технические характеристики, предлагаемые") ||
      !tableLabel.includes("страна происхождения")
    ) {
      continue;
    }

    const rows = findBalancedElements(table.text, "w:tr");
    if (rows.length < 1) continue;

    const headerRow = rows[0].text;
    const templateRow = rows[1]?.text || rows[0].text;
    const templateCellCount = findBalancedElements(templateRow, "w:tc").length;
    if (templateCellCount < 7) continue;

    const newRows = items.map((item, index) => {
      const specs = item.tzSpecs || item.ourSpecs || "";
      return rowWithCellValues(templateRow, [
        String(index + 1),
        item.itemName || item.name || "",
        formatNumber(item.quantity),
        formatUnit(item.unit),
        specs,
        item.ourSpecs || specs || "соответствует требованиям ТЗ",
        countryOfOrigin(item),
      ]);
    }).join("");

    const beforeRows = table.text.slice(0, rows[0].start);
    const afterRows = table.text.slice(rows[rows.length - 1].end);
    const newTable = beforeRows + headerRow + newRows + afterRows;
    xml = xml.slice(0, table.start) + newTable + xml.slice(table.end);
    break;
  }

  return xml;
}

function fillTechnicalProposalTable(docXml: string, contextData: ContextData) {
  const items = contextData.items || [];
  if (!items.length) return docXml;

  let xml = docXml;
  const tables = findBalancedElements(xml, "w:tbl");

  for (let tableIndex = tables.length - 1; tableIndex >= 0; tableIndex--) {
    const table = tables[tableIndex];
    const tableLabel = normalize(textFromXml(table.text));
    if (
      !tableLabel.includes("наименование параметра по тз") ||
      !tableLabel.includes("предлагаемое участником") ||
      !tableLabel.includes("страна происхождения")
    ) {
      continue;
    }

    const rows = findBalancedElements(table.text, "w:tr");
    if (rows.length < 2) continue;

    const headerRow = rows[0].text;
    const templateRow = rows[1].text;
    const templateCellCount = findBalancedElements(templateRow, "w:tc").length;
    if (templateCellCount < 10) continue;

    const address = deliveryAddress(contextData);
    const deadline = contextData.procurement?.deliveryDeadline || "";
    const newRows = items.map((item, index) => {
      const specs = item.tzSpecs || item.ourSpecs || "";
      return rowWithCellValues(templateRow, [
        String(index + 1),
        item.itemName || item.name || "",
        specs,
        item.ourSpecs || specs || "соответствует требованиям ТЗ",
        countryOfOrigin(item),
        formatUnit(item.unit),
        item.quantity != null ? String(item.quantity) : "",
        deadline,
        address,
        pp1875Value(item.pp1875),
        "-",
        "-",
      ]);
    }).join("");

    const beforeRows = table.text.slice(0, rows[0].start);
    const afterRows = table.text.slice(rows[rows.length - 1].end);
    const newTable = beforeRows + headerRow + newRows + afterRows;
    xml = xml.slice(0, table.start) + newTable + xml.slice(table.end);
    break;
  }

  return xml;
}

function fillPriceOfferText(docXml: string, contextData: ContextData) {
  const total = contextData.pricing?.ourTotalPrice;
  if (total == null || Number.isNaN(total)) return docXml;

  const ndsRate = contextData.pricing?.ndsRate ?? contextData.profile?.tax?.ndsRate;
  const priceText = [
    `Составляет ${formatMoney(total)} руб.`,
    ndsRate != null && !Number.isNaN(ndsRate) ? `с НДС ${formatMoney(ndsRate)} %` : "",
  ].filter(Boolean).join(" ");

  let xml = docXml;
  const paragraphs = findBalancedElements(xml, "w:p");
  for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
    const paragraph = paragraphs[paragraphIndex];
    const normalized = normalize(textFromXml(paragraph.text));
    if (!normalized.includes("составляет") || !normalized.includes("руб")) continue;

    const newParagraph = replaceParagraphText(paragraph.text, priceText);
    xml = xml.slice(0, paragraph.start) + newParagraph + xml.slice(paragraph.end);
    break;
  }

  return xml;
}

function findPreviousTextParagraphIndex(paragraphTexts: string[], fromIndex: number) {
  for (let index = fromIndex - 1; index >= 0; index--) {
    if (cleanText(paragraphTexts[index])) return index;
  }
  return -1;
}

function fillProcurementSubjectText(docXml: string, contextData: ContextData) {
  const procurementName = cleanText(contextData.procurement?.name);
  if (!procurementName) return docXml;

  let xml = docXml;
  const paragraphs = findBalancedElements(xml, "w:p");
  const paragraphTexts = paragraphs.map((paragraph) => textFromXml(paragraph.text));
  const replacements = new Map<number, string>();

  for (let index = 0; index < paragraphTexts.length; index++) {
    const normalized = normalize(paragraphTexts[index]);
    if (normalized.includes("(указать предмет)")) {
      const previousIndex = findPreviousTextParagraphIndex(paragraphTexts, index);
      if (previousIndex !== -1) {
        const subject = subjectAfterPreposition(procurementName);
        replacements.set(previousIndex, `на ${ensurePeriod(subject)}`);
      }
    }
    if (normalized.includes("(указывается участником закупки)")) {
      const previousIndex = findPreviousTextParagraphIndex(paragraphTexts, index);
      if (previousIndex !== -1) {
        replacements.set(previousIndex, procurementName);
      }
    }
  }

  const indexes = [...replacements.keys()].sort((a, b) => b - a);
  for (const index of indexes) {
    const paragraph = paragraphs[index];
    const newParagraph = replaceParagraphText(paragraph.text, replacements.get(index) || "");
    xml = xml.slice(0, paragraph.start) + newParagraph + xml.slice(paragraph.end);
  }

  return xml;
}

function fillSignaturePlaceholders(docXml: string, contextData: ContextData) {
  const profile = contextData.profile;
  if (!profile) return docXml;

  let xml = docXml;
  const paragraphs = findBalancedElements(xml, "w:p");
  const signature = `___________________________ ${shortFio(profile)} ______________________ (Подпись) (Ф.И.О. подписавшего)`;
  const profileText = normalize([profile.director?.fio, profile.fullName].filter(Boolean).join(" "));

  for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
    const paragraph = paragraphs[paragraphIndex];
    const paragraphText = textFromXml(paragraph.text);
    const normalized = normalize(paragraphText);
    if (!normalized.includes("(ф.и.о. подписавшего)") && !normalized.includes("ф.и.о. подписавшего")) continue;
    if (profileText && profileText.split(" ")[0] && normalized.includes(profileText.split(" ")[0])) continue;

    const newParagraph = replaceParagraphText(paragraph.text, signature);
    xml = xml.slice(0, paragraph.start) + newParagraph + xml.slice(paragraph.end);
  }

  return xml;
}

export async function autofillKnownDocxFields(buffer: Buffer, contextData: ContextData) {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) return buffer;

  let filledXml = fillTwoColumnParticipantTables(docXml, contextData);
  filledXml = fillProcurementSubjectText(filledXml, contextData);
  filledXml = fillPriceOfferText(filledXml, contextData);
  filledXml = fillProductOfferTable(filledXml, contextData);
  filledXml = fillTechnicalProposalTable(filledXml, contextData);
  filledXml = fillSignaturePlaceholders(filledXml, contextData);
  if (filledXml === docXml) return buffer;

  zip.file("word/document.xml", filledXml);
  return Buffer.from(await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  }));
}
