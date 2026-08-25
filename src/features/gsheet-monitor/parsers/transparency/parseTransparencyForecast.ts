// Transparency Plan – Tab "[Import] Forecast": Bedarf je Recipe/Region.
// Spalten (0-idx): 1 Recipe Code, 2 Meal Pref, 3 Recipe Name, 12-14 BENL/DKSE/
// DE Volume + Buffer (die relevanteste "Ziel"-Zahl je Region).
import type { TransparencyForecastData, TransparencyForecastRow } from "../../transparencyTypes";
import { cell, findHeaderIndex, parseFloatCell } from "./transparencyCellHelpers";

export function parseTransparencyForecast(rows: string[][]): TransparencyForecastData {
  const headerIdx = findHeaderIndex(rows, 1, "Recipe Code");
  const parsed: TransparencyForecastRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const recipeCode = cell(row, 1);
      if (!recipeCode) continue;

      parsed.push({
        hfWeek: cell(row, 0),
        recipeCode,
        mealPref: cell(row, 2),
        recipeName: cell(row, 3),
        benlVolumeBuffer: parseFloatCell(row, 12),
        dkseVolumeBuffer: parseFloatCell(row, 13),
        deVolumeBuffer: parseFloatCell(row, 14),
      });
    }
  }

  const byRecipeCode = new Map(parsed.map((r) => [r.recipeCode, r] as const));
  return { rows: parsed, byRecipeCode, lastUpdated: Date.now() };
}
