// Transparency Plan – Logistik/Downstream-Tabs: Sleeving (Output +
// Requirements), Printing (Output + Requirements), BENL Outbound.
import type {
  TransparencySleevingData, TransparencySleevingOutputRow, TransparencySleevingRequirementRow,
  TransparencyPrintingData, TransparencyPrintingRow,
  TransparencyBenlOutboundData, TransparencyBenlOutboundRow, TransparencyBenlOutboundDayBlock,
} from "../../transparencyTypes";
import { cell, findHeaderIndex, parseBoolCell, parseFloatCell, parseIntCell } from "./transparencyCellHelpers";

// "Tag","Meal","Meal Name","Von","Zu","Anzahl an Kisten","Meals","Comment"
export function parseSleevingOutput(rows: string[][]): TransparencySleevingOutputRow[] {
  const headerIdx = findHeaderIndex(rows, 0, "Tag");
  const parsed: TransparencySleevingOutputRow[] = [];
  if (headerIdx === -1) return parsed;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const recipeCode = cell(row, 1);
    if (!recipeCode) continue;
    parsed.push({
      day: cell(row, 0),
      recipeCode,
      recipeName: cell(row, 2),
      from: cell(row, 3),
      to: cell(row, 4),
      boxCount: parseIntCell(row, 5),
      meals: parseIntCell(row, 6),
      comment: cell(row, 7),
    });
  }
  return parsed;
}

// "SLOT","Recipe Code","Recipe Name", dann mehrere Ziel-Blöcke (Von NO
// Sleeve/Zu BENL/Zu DE/Zu DKSE), jeweils mit "Needs Thu/Fri/Sat"-Spalten. Die
// Blockgrenzen verschieben sich (nicht alle Ziele haben immer alle drei
// Tage befüllt) — statt fester Offsets werden alle "Needs Thu/Fri/Sat"-
// Spalten über ihr Label gefunden und aufsummiert.
export function parseSleevingRequirements(rows: string[][]): TransparencySleevingRequirementRow[] {
  const headerIdx = findHeaderIndex(rows, 0, "SLOT");
  const parsed: TransparencySleevingRequirementRow[] = [];
  if (headerIdx === -1) return parsed;
  const header = rows[headerIdx] ?? [];
  const thuCols: number[] = [], friCols: number[] = [], satCols: number[] = [];
  header.forEach((h, i) => {
    const label = (h ?? "").trim();
    if (label === "Needs Thu") thuCols.push(i);
    else if (label === "Needs Fri") friCols.push(i);
    else if (label === "Needs Sat") satCols.push(i);
  });

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const recipeCode = cell(row, 1);
    if (!recipeCode) continue;
    const sum = (cols: number[]) => {
      const vals = cols.map((c) => parseFloatCell(row, c)).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
    };
    parsed.push({
      slot: cell(row, 0),
      recipeCode,
      recipeName: cell(row, 2),
      needsThuTotal: sum(thuCols),
      needsFriTotal: sum(friCols),
      needsSatTotal: sum(satCols),
    });
  }
  return parsed;
}

export function parseSleeving(outputRows: string[][], requirementRows: string[][]): TransparencySleevingData {
  return { output: parseSleevingOutput(outputRows), requirements: parseSleevingRequirements(requirementRows), lastUpdated: Date.now() };
}

// Output: "#","Meal Code","Meal Name","Printing Day","Region","Menge","Comment"
// Requirements: "#","Meal Code","Meal Name","Farbe","Plating Day","Printing
// Day","DC","Region","Menge","Done","Comment" -- Region/Menge/Done/Comment
// stehen an anderen Spaltenpositionen, deshalb zwei kleine Varianten.
function parsePrintingRows(rows: string[][], regionCol: number, quantityCol: number, doneCol: number | null, commentCol: number): TransparencyPrintingRow[] {
  const headerIdx = findHeaderIndex(rows, 1, "Meal Code");
  const parsed: TransparencyPrintingRow[] = [];
  if (headerIdx === -1) return parsed;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const mealCode = cell(row, 1);
    if (!mealCode) continue;
    parsed.push({
      mealCode,
      mealName: cell(row, 2),
      region: cell(row, regionCol),
      quantity: parseIntCell(row, quantityCol),
      done: doneCol != null && parseBoolCell(row, doneCol),
      comment: cell(row, commentCol),
    });
  }
  return parsed;
}

export function parsePrinting(outputRows: string[][], requirementRows: string[][]): TransparencyPrintingData {
  return {
    output: parsePrintingRows(outputRows, 4, 5, null, 6),
    requirements: parsePrintingRows(requirementRows, 7, 8, 9, 10),
    lastUpdated: Date.now(),
  };
}

// "","Slot","Recipe Code","Recipe Name","Total","","Ready","Recipe Code",
// "Minimum","Outbound","Minimum Delta","Over Min" -- dieser 6er-Block
// wiederholt sich ab Spalte 6 dreimal (Do/Fr/Sa), je 6 Spalten weiter.
const BENL_DAY_BLOCK_START = 6;
const BENL_DAY_BLOCK_WIDTH = 6;
const BENL_DAYS: readonly ("thu" | "fri" | "sat")[] = ["thu", "fri", "sat"];

export function parseBenlOutbound(rows: string[][]): TransparencyBenlOutboundData {
  const headerIdx = findHeaderIndex(rows, 1, "Slot");
  const parsed: TransparencyBenlOutboundRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const recipeCode = cell(row, 2);
      if (!recipeCode) continue;

      const byDay = {} as Record<"thu" | "fri" | "sat", TransparencyBenlOutboundDayBlock>;
      BENL_DAYS.forEach((day, di) => {
        const base = BENL_DAY_BLOCK_START + di * BENL_DAY_BLOCK_WIDTH;
        byDay[day] = {
          day,
          ready: parseIntCell(row, base),
          minimum: parseFloatCell(row, base + 2),
          outbound: parseFloatCell(row, base + 3),
          minimumDelta: parseFloatCell(row, base + 4),
          overMin: parseFloatCell(row, base + 5),
        };
      });

      parsed.push({ slot: cell(row, 1), recipeCode, recipeName: cell(row, 3), total: parseIntCell(row, 4), byDay });
    }
  }

  return { rows: parsed, byRecipeCode: new Map(parsed.map((r) => [r.recipeCode, r] as const)), lastUpdated: Date.now() };
}
