"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import ExcelJS from "exceljs";

export const generateTemplate = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    if (!procurement) throw new Error("Procurement not found");

    const items = await ctx.runQuery(api.files.getExtractedItems, {
      procurementId: args.procurementId,
    });

    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Калькуляция
    const calcSheet = workbook.addWorksheet("Калькуляция");

    calcSheet.columns = [
      { header: "№ п/п", key: "num", width: 6 },
      { header: "Наименование", key: "name", width: 40 },
      { header: "Ед. изм.", key: "unit", width: 8 },
      { header: "Количество", key: "quantity", width: 12 },
      { header: "НМЦК за ед.", key: "nmckPrice", width: 14 },
      { header: "Итого НМЦК", key: "nmckTotal", width: 14 },
      { header: "Характеристики ТЗ", key: "tzSpecs", width: 40 },
      { header: "Наши характеристики", key: "ourSpecs", width: 40 },
      { header: "Наша цена за ед.", key: "ourPrice", width: 16 },
      { header: "Наша сумма", key: "ourTotal", width: 14 },
      { header: "Маржа %", key: "margin", width: 10 },
      { header: "Доставка", key: "delivery", width: 14 },
      { header: "Прочие расходы", key: "otherExpenses", width: 16 },
      { header: "Примерный вес (кг)", key: "weight", width: 16 },
      { header: "Квартал", key: "quarter", width: 10 },
    ];

    const headerRow = calcSheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9E1F2" },
    };

    items.forEach((item, index) => {
      const row = calcSheet.addRow({
        num: index + 1,
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        nmckPrice: item.nmckPrice,
        nmckTotal: item.nmckPrice * item.quantity,
        tzSpecs: item.tzSpecs,
        ourSpecs: "",
        ourPrice: "",
        ourTotal: "",
        margin: "",
        delivery: item.deliveryCostEstimated
          ? `${item.deliveryCost} (проверить!)`
          : item.deliveryCost,
        otherExpenses: "",
        weight: item.estimatedWeight,
        quarter: item.quarter,
      });

      // Highlight columns user needs to fill (ourSpecs, ourPrice)
      [8, 9].forEach((col) => {
        row.getCell(col).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF2CC" },
        };
      });
    });

    // Totals row
    const lastDataRow = items.length + 1;
    const totalsRow = calcSheet.addRow({
      num: "",
      name: "ИТОГО",
      nmckTotal: { formula: `SUM(F2:F${lastDataRow})` },
      ourTotal: { formula: `SUM(J2:J${lastDataRow})` },
    });
    totalsRow.font = { bold: true };

    // Sheet 2: Информация о закупке
    const infoSheet = workbook.addWorksheet("Информация");
    infoSheet.addRow(["Номер закупки", procurement.number]);
    infoSheet.addRow(["Название", procurement.name]);
    infoSheet.addRow(["НМЦК", procurement.nmck]);
    infoSheet.addRow(["Срок поставки", procurement.deliveryDeadline]);
    infoSheet.addRow([""]);
    infoSheet.addRow(["Адреса доставки:"]);
    procurement.deliveryAddresses.forEach((addr) => {
      infoSheet.addRow([addr.name, addr.address]);
    });
    infoSheet.getColumn(1).width = 25;
    infoSheet.getColumn(2).width = 60;

    // Save to storage
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const storageId = await ctx.storage.store(blob);

    await ctx.runMutation(api.files.saveGeneratedFile, {
      procurementId: args.procurementId,
      profileId: procurement.profileId,
      storageId,
      fileName: `Калькуляция_${procurement.number || "draft"}.xlsx`,
      formType: "calculation",
    });

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "template_downloaded",
    });

    return storageId;
  },
});
