import { parseMultilineExcel, type RackEntry, type RackMarket } from "./rack";

export type RackSlotMeta = {
  level: number;
  layoutColumn: number;
  station: string;
  demand: number;
  type: string;
  preferredPick: boolean;
  highRunner: boolean;
};

function visualizationSheetName(market: RackMarket) {
  return market === "de" ? "Visualization Rackplan - DACH" : "Visualization Rackplan - Nordic";
}

function parseDemandValue(text: string) {
  const normalized = text.replace(/[^0-9,.-]/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

export async function parseVisualizationRackplan(file: File, market: RackMarket): Promise<Map<string, RackSlotMeta>> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const worksheet = workbook.getWorksheet(visualizationSheetName(market));
  if (!worksheet) return new Map();

  const slotMeta = new Map<string, RackSlotMeta>();
  for (let rowNumber = 13; rowNumber <= worksheet.rowCount - 2; rowNumber += 1) {
    const levelText = worksheet.getRow(rowNumber).getCell(5).text.trim();
    const demandLevelText = worksheet.getRow(rowNumber + 1).getCell(5).text.trim();
    const positionLevelText = worksheet.getRow(rowNumber + 2).getCell(5).text.trim();
    const level = Number(levelText);
    if (!Number.isFinite(level) || levelText !== demandLevelText || levelText !== positionLevelText) continue;

    for (let column = 6; column <= worksheet.columnCount; column += 1) {
      const position = worksheet.getRow(rowNumber + 2).getCell(column).text.trim();
      if (!/^F\d+$/i.test(position)) continue;
      const demand = parseDemandValue(worksheet.getRow(rowNumber + 1).getCell(column).text.trim());
      const station = worksheet.getRow(11).getCell(column).text.trim();
      const type = worksheet.getRow(9).getCell(column).text.trim();
      slotMeta.set(position.toUpperCase(), {
        level,
        layoutColumn: Number(worksheet.getRow(12).getCell(column).text.trim()) || column,
        station,
        demand,
        type,
        preferredPick: level === 2,
        highRunner: level === 2 && demand > 0,
      });
    }

    rowNumber += 2;
  }

  return slotMeta;
}

export async function parseRackWorkbook(file: File, market: RackMarket, lines?: string[]): Promise<{ entries: RackEntry[]; slotMeta: Map<string, RackSlotMeta> }> {
  const [entries, slotMeta] = await Promise.all([
    parseMultilineExcel(file, market, lines),
    parseVisualizationRackplan(file, market),
  ]);

  return { entries, slotMeta };
}