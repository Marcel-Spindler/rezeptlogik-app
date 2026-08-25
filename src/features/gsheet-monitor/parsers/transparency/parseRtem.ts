// Transparency Plan – Tab "RTEM": RTI/Gekocht-Bestand je Subrezept.
// Spalten (0-idx) entsprechen 1:1 der Kopfzeile: 0 Slot #, 1 Menu Week,
// 2 Recipe Code (interne "REC-..."-Id), 3 Recipe Name ("FVxxxxA - Name
// [Region]" — enthält den eigentlichen FV-Code), 4 Demand, 5 Scheduled
// Portions, 6 Sub Recipe Code, 7 Sub Recipe Name, 8 Cook Methods,
// 10 Quantity Cooked, 13 Total Cooked (Portions), 14 Total Mapped,
// 15 Estimated RTI left, 16 Actual RTI left.
import type { TransparencyRtemData, TransparencyRtemRow } from "../../transparencyTypes";
import { cell, findHeaderIndex, parseFloatCell, parseIntCell, splitRecipeCodeAndName } from "./transparencyCellHelpers";

export function parseRtem(rows: string[][]): TransparencyRtemData {
  const headerIdx = findHeaderIndex(rows, 0, "Slot #");
  const parsed: TransparencyRtemRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const internalRecipeId = cell(row, 2);
      const rawRecipeName = cell(row, 3);
      if (!internalRecipeId && !rawRecipeName) continue;
      const { code, name } = splitRecipeCodeAndName(rawRecipeName);

      parsed.push({
        slot: cell(row, 0),
        menuWeek: cell(row, 1),
        recipeCode: code,
        internalRecipeId,
        recipeName: name || rawRecipeName,
        demandAmount: parseIntCell(row, 4),
        scheduledPortions: parseIntCell(row, 5),
        subRecipeCode: cell(row, 6),
        subRecipeName: cell(row, 7),
        cookMethods: cell(row, 8),
        quantityCooked: parseFloatCell(row, 10),
        totalCookedPortions: parseIntCell(row, 13),
        totalMapped: parseIntCell(row, 14),
        estimatedRtiLeft: parseIntCell(row, 15),
        actualRtiLeft: parseIntCell(row, 16),
      });
    }
  }

  const byRecipeCode = new Map<string, TransparencyRtemRow[]>();
  const bySubRecipeName = new Map<string, TransparencyRtemRow[]>();
  for (const r of parsed) {
    if (r.recipeCode) {
      if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
      byRecipeCode.get(r.recipeCode)!.push(r);
    }
    if (r.subRecipeName) {
      if (!bySubRecipeName.has(r.subRecipeName)) bySubRecipeName.set(r.subRecipeName, []);
      bySubRecipeName.get(r.subRecipeName)!.push(r);
    }
  }

  return { rows: parsed, byRecipeCode, bySubRecipeName, lastUpdated: Date.now() };
}
