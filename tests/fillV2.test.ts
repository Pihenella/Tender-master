import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  resolveMapping,
  applyXlsxV2,
  selfCheck,
  type AiMapping,
  type CellValue,
} from "../src/lib/server/fillV2";

async function makeBuffer(
  setup: (ws: ExcelJS.Worksheet) => void
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  setup(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readCell(buffer: Buffer, cell: string): Promise<any> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb.worksheets[0].getCell(cell).value;
}

describe("resolveMapping", () => {
  it("resolves simple dataPath mappings", () => {
    const mapping: AiMapping = {
      mappings: [
        { cell: "B1", dataPath: "profile.inn", confidence: "high" },
        { cell: "B2", dataPath: "profile.fullName", confidence: "medium" },
      ],
      tables: [],
      unmapped: [],
      computed: [],
    };
    const context = {
      profile: { inn: "1234567890", fullName: "ООО Рога и Копыта" },
    };

    const result = resolveMapping(mapping, context);

    expect(result.cellValues).toEqual([
      { cell: "B1", value: "1234567890" },
      { cell: "B2", value: "ООО Рога и Копыта" },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves table rows from array data", () => {
    const mapping: AiMapping = {
      mappings: [],
      tables: [
        {
          dataStartRow: 5,
          columns: [
            { column: "A", dataPath: "items[].name" },
            { column: "B", dataPath: "items[].quantity" },
          ],
        },
      ],
      unmapped: [],
      computed: [],
    };
    const context = {
      items: [
        { name: "Болт М6", quantity: 100 },
        { name: "Гайка М6", quantity: 200 },
      ],
    };

    const result = resolveMapping(mapping, context);

    expect(result.tableData).toHaveLength(1);
    expect(result.tableData[0].startRow).toBe(5);
    expect(result.tableData[0].rows).toEqual([
      { A: "Болт М6", B: 100 },
      { A: "Гайка М6", B: 200 },
    ]);
  });

  it("marks low-confidence mappings as unresolved", () => {
    const mapping: AiMapping = {
      mappings: [
        { cell: "B1", dataPath: "profile.inn", confidence: "high" },
        { cell: "B3", dataPath: "profile.phone", confidence: "low" },
      ],
      tables: [],
      unmapped: ["C5"],
      computed: [],
    };
    const context = {
      profile: { inn: "123", phone: "+7999" },
    };

    const result = resolveMapping(mapping, context);

    expect(result.cellValues).toEqual([{ cell: "B1", value: "123" }]);
    expect(result.unresolved).toContain("B3");
    expect(result.unresolved).toContain("C5");
  });

  it("resolves rowNumber columns with sequential 1-based numbers", () => {
    const mapping: AiMapping = {
      mappings: [],
      tables: [
        {
          dataStartRow: 5,
          columns: [
            { column: "A", dataPath: "rowNumber" },
            { column: "B", dataPath: "items[].name" },
            { column: "C", dataPath: "items[].quantity" },
          ],
        },
      ],
      unmapped: [],
      computed: [],
    };
    const context = {
      items: [
        { name: "Болт М6", quantity: 100 },
        { name: "Гайка М6", quantity: 200 },
        { name: "Шайба М6", quantity: 300 },
      ],
    };

    const result = resolveMapping(mapping, context);

    expect(result.tableData).toHaveLength(1);
    expect(result.tableData[0].rows).toEqual([
      { A: 1, B: "Болт М6", C: 100 },
      { A: 2, B: "Гайка М6", C: 200 },
      { A: 3, B: "Шайба М6", C: 300 },
    ]);
  });

  it("marks mappings with missing data as unresolved", () => {
    const mapping: AiMapping = {
      mappings: [
        { cell: "B1", dataPath: "profile.missing", confidence: "high" },
      ],
      tables: [],
      unmapped: [],
      computed: [],
    };
    const context = { profile: { inn: "123" } };

    const result = resolveMapping(mapping, context);

    expect(result.cellValues).toEqual([]);
    expect(result.unresolved).toContain("B1");
  });
});

describe("applyXlsxV2", () => {
  it("writes values to correct cells", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "ИНН";
      ws.getCell("B1").value = "";
    });

    const cellValues: CellValue[] = [
      { cell: "B1", value: "1234567890" },
      { cell: "B2", value: "ООО Тест" },
    ];

    const result = await applyXlsxV2(buf, cellValues);

    expect(await readCell(result, "B1")).toBe("1234567890");
    expect(await readCell(result, "B2")).toBe("ООО Тест");
  });

  it("writes table rows starting at startRow", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A4").value = "Наименование";
      ws.getCell("B4").value = "Кол-во";
    });

    const tableData = [
      {
        startRow: 5,
        rows: [
          { A: "Болт М6", B: 100 },
          { A: "Гайка М6", B: 200 },
        ] as Record<string, string | number>[],
      },
    ];

    const result = await applyXlsxV2(buf, [], tableData);

    expect(await readCell(result, "A5")).toBe("Болт М6");
    expect(await readCell(result, "B5")).toBe(100);
    expect(await readCell(result, "A6")).toBe("Гайка М6");
    expect(await readCell(result, "B6")).toBe(200);
  });

  it("writes to master cell of merged range", async () => {
    const buf = await makeBuffer((ws) => {
      ws.mergeCells("A1:C1");
      ws.getCell("A1").value = "Header";
      ws.getCell("A2").value = "Label";
      ws.mergeCells("B2:D2");
      ws.getCell("B2").value = "";
    });

    const cellValues: CellValue[] = [{ cell: "C2", value: "Written" }];
    const result = await applyXlsxV2(buf, cellValues);

    // Should write to master cell B2 since C2 is part of merged B2:D2
    expect(await readCell(result, "B2")).toBe("Written");
  });
});

describe("selfCheck", () => {
  it("reports all applied when values match", async () => {
    const buf = await makeBuffer(() => {});
    const cellValues: CellValue[] = [
      { cell: "B1", value: "123" },
      { cell: "B2", value: "ABC" },
    ];
    const filled = await applyXlsxV2(buf, cellValues);

    const formMap = {
      sheet: "Sheet1",
      dimensions: "A1:D10",
      mergedCells: [],
      regions: [],
    };

    const check = await selfCheck(filled, cellValues, formMap);
    expect(check.applied).toBe(2);
    expect(check.failed).toBe(0);
  });

  it("detects unfilled input fields as missing", async () => {
    const buf = await makeBuffer((ws) => {
      ws.getCell("A1").value = "ИНН";
      ws.getCell("B1").value = "";
      ws.getCell("A2").value = "КПП";
      ws.getCell("B2").value = "";
    });

    // Only fill one field
    const cellValues: CellValue[] = [{ cell: "B1", value: "123" }];
    const filled = await applyXlsxV2(buf, cellValues);

    const formMap = {
      sheet: "Sheet1",
      dimensions: "A1:D10",
      mergedCells: [],
      regions: [
        {
          type: "field" as const,
          label: { cell: "A1", value: "ИНН" },
          input: { cell: "B1", value: "" },
        },
        {
          type: "field" as const,
          label: { cell: "A2", value: "КПП" },
          input: { cell: "B2", value: "" },
        },
      ],
    };

    const check = await selfCheck(filled, cellValues, formMap);
    expect(check.applied).toBe(1);
    expect(check.missing).toBeGreaterThan(0);
    expect(check.details.some((d) => d.cell === "B2" && d.reason === "unmapped")).toBe(true);
  });

  it("correctly checks values in merged cells", async () => {
    const buf = await makeBuffer((ws) => {
      ws.mergeCells("B1:D1");
      ws.getCell("A1").value = "ИНН";
      ws.getCell("B1").value = "";
    });

    const cellValues: CellValue[] = [{ cell: "B1", value: "662302062065" }];
    const filled = await applyXlsxV2(buf, cellValues);

    const { buildFormMap } = await import("../src/lib/server/formMap");
    const formMap = await buildFormMap(buf);

    // Check with the exact cell address that was targeted
    const check = await selfCheck(filled, cellValues, formMap);
    expect(check.applied).toBe(1);
    expect(check.failed).toBe(0);

    // Also check with a cell address inside the merged range
    const check2 = await selfCheck(filled, [{ cell: "C1", value: "662302062065" }], formMap);
    expect(check2.applied).toBe(1);
    expect(check2.failed).toBe(0);
  });
});
