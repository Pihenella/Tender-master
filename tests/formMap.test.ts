import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildFormMap } from "../src/lib/server/formMap";

async function makeBuffer(setup: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Лист1");
  setup(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("buildFormMap", () => {
  it("detects field regions (label + empty input)", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "ИНН";
      ws.getCell("B1").value = "";
      ws.getCell("A2").value = "Наименование";
      ws.getCell("B2").value = "";
    });

    const map = await buildFormMap(buf);
    expect(map.sheet).toBe("Лист1");
    expect(map.regions).toContainEqual(
      expect.objectContaining({
        type: "field",
        label: { cell: "A1", value: "ИНН" },
        input: { cell: "B1", value: "" },
      })
    );
    expect(map.regions).toContainEqual(
      expect.objectContaining({
        type: "field",
        label: { cell: "A2", value: "Наименование" },
        input: { cell: "B2", value: "" },
      })
    );
  });

  it("detects table regions (3+ header cells)", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "№ п/п";
      ws.getCell("B1").value = "Наименование";
      ws.getCell("C1").value = "Кол-во";
      ws.getCell("D1").value = "Цена";
    });

    const map = await buildFormMap(buf);
    const table = map.regions.find((r) => r.type === "table");
    expect(table).toBeDefined();
    expect(table).toMatchObject({
      type: "table",
      headerRow: 1,
      dataStartRow: 2,
      existingRows: 0,
    });
    if (table && table.type === "table") {
      expect(table.columns).toHaveLength(4);
      expect(table.columns[0]).toEqual({ col: "A", header: "№ п/п" });
    }
  });

  it("detects merged cell headers", async () => {
    const buf = await makeBuffer((ws) => {
      ws.mergeCells("A1:D1");
      ws.getCell("A1").value = "ФОРМА ЗАЯВКИ";
    });

    const map = await buildFormMap(buf);
    expect(map.mergedCells).toContain("A1:D1");
    expect(map.regions).toContainEqual(
      expect.objectContaining({
        type: "header",
        range: "A1:D1",
        value: "ФОРМА ЗАЯВКИ",
      })
    );
  });

  it("detects fields with underscore placeholders", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "Телефон";
      ws.getCell("B1").value = "________";
    });

    const map = await buildFormMap(buf);
    expect(map.regions).toContainEqual(
      expect.objectContaining({
        type: "field",
        label: { cell: "A1", value: "Телефон" },
        input: { cell: "B1", value: "________" },
      })
    );
  });

  it("counts existing data rows in tables", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "№";
      ws.getCell("B1").value = "Товар";
      ws.getCell("C1").value = "Цена";
      // Two data rows
      ws.getCell("A2").value = "1";
      ws.getCell("B2").value = "Товар 1";
      ws.getCell("C2").value = "100";
      ws.getCell("A3").value = "2";
      ws.getCell("B3").value = "Товар 2";
      ws.getCell("C3").value = "200";
      // Row 4 empty
    });

    const map = await buildFormMap(buf);
    const table = map.regions.find((r) => r.type === "table");
    expect(table).toBeDefined();
    if (table && table.type === "table") {
      expect(table.existingRows).toBe(2);
    }
  });

  it("returns static regions for standalone text", async () => {
    const buf = await makeBuffer((ws) => {
      // Cells with non-empty neighbors to the right are not field pairs
      ws.getCell("A1").value = "Примечание: данные актуальны";
      ws.getCell("B1").value = "some value";
      ws.getCell("A2").value = "Дата: 01.01.2026";
      ws.getCell("B2").value = "another value";
    });

    const map = await buildFormMap(buf);
    const statics = map.regions.filter((r) => r.type === "static");
    // A1 and A2 are static (right neighbor is non-empty, not a placeholder)
    // B1 and B2 become field labels (their right neighbor C is empty)
    expect(statics.length).toBeGreaterThanOrEqual(2);
    expect(statics).toContainEqual(
      expect.objectContaining({ type: "static", cell: "A1", value: "Примечание: данные актуальны" })
    );
    expect(statics).toContainEqual(
      expect.objectContaining({ type: "static", cell: "A2", value: "Дата: 01.01.2026" })
    );
  });
});
