// Transparency Plan – Tab "Planning Check": Meal-Ebene, Plan vs. Forecast vs.
// Actuals je Tag. Strukturell nah am bestehenden Production-Plan-Tab
// (parseProductionPlan.ts), aber eigenes Spaltenlayout und eigenes Sheet.
//
// Spalten (0-idx): 1 Recipe Code, 2 Recipe Name, 3 Slot, 4 Total, 5-7 Planned
// 1-3, 8 Planned vs. Forecast, 9 Planned Remaining to Plate, 11-16 Actuals
// Mon-Sat (Spalte 12/15 im Sample leer -> Sheet befüllt nur die tatsächlich
// gelaufenen Tage), 18 forecast delta (total).
import type { TransparencyPlanningCheckData, TransparencyPlanningCheckRow } from "../../transparencyTypes";
import { cell, findHeaderIndex, looksLikeRecipeCode, parseFloatCell, parseIntCell } from "./transparencyCellHelpers";

const ACTUAL_DAY_COLS = { mon: 11, tue: 12, wed: 13, thu: 14, fri: 15, sat: 16 } as const;

export function parsePlanningCheck(rows: string[][]): TransparencyPlanningCheckData {
  const week = (rows[0]?.[2] ?? "").trim();
  const headerIdx = findHeaderIndex(rows, 1, "Recipe Code");
  const parsed: TransparencyPlanningCheckRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const recipeCode = cell(row, 1);
      if (!recipeCode || !looksLikeRecipeCode(recipeCode)) continue;

      parsed.push({
        recipeCode,
        recipeName: cell(row, 2),
        slot: cell(row, 3),
        total: parseIntCell(row, 4),
        planned1: parseIntCell(row, 5),
        planned2: parseIntCell(row, 6),
        planned3: parseIntCell(row, 7),
        plannedVsForecast: parseIntCell(row, 8),
        plannedRemainingToPlate: parseIntCell(row, 9),
        actualsByDay: {
          mon: parseIntCell(row, ACTUAL_DAY_COLS.mon),
          tue: parseIntCell(row, ACTUAL_DAY_COLS.tue),
          wed: parseIntCell(row, ACTUAL_DAY_COLS.wed),
          thu: parseIntCell(row, ACTUAL_DAY_COLS.thu),
          fri: parseIntCell(row, ACTUAL_DAY_COLS.fri),
          sat: parseIntCell(row, ACTUAL_DAY_COLS.sat),
        },
        forecastDeltaTotal: parseFloatCell(row, 18),
      });
    }
  }

  const byRecipeCode = new Map(parsed.map((r) => [r.recipeCode, r] as const));
  return { week, rows: parsed, byRecipeCode, lastUpdated: Date.now() };
}
