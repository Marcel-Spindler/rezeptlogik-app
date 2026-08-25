// Transparency Plan – Tab "Transperancy Total Overview": eine Zeile je (Run,
// Work Order, Subrezept), Status durch Staging -> Kitchen -> Post. Das ist die
// zentrale "durch die Stationen"-Tabelle, auf der die Produzierbarkeits-Engine
// aufbaut (siehe transparencyProducibility.ts).
//
// Spalten (0-idx): 0 Run, 3 Planned Kitchen day, 4 WO, 5 Comment, 6 Recipe
// ("Code - Name [Region]"), 7 Sub recipe, 8 Planned Meals, 9 Planned Staging
// kg, 10 Kitchen kg, 11 Planned Post kg, 12 Yield, 13 Logistic Staged (bool),
// 15 Kitchen Cooked (bool), 22 Status, 23 Owner.
import type { TransparencyFlowData, TransparencyFlowRow } from "../../transparencyTypes";
import { cell, findHeaderIndex, parseBoolCell, parseFloatCell, parseIntCell, splitRecipeCodeAndName } from "./transparencyCellHelpers";

export function parseTotalOverview(rows: string[][]): TransparencyFlowData {
  const headerIdx = findHeaderIndex(rows, 0, "Run");
  const parsed: TransparencyFlowRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 4);
      if (!workOrder) continue;

      const { code, name } = splitRecipeCodeAndName(cell(row, 6));
      parsed.push({
        run: cell(row, 0),
        plannedKitchenDay: cell(row, 3),
        workOrder,
        comment: cell(row, 5),
        recipeCode: code,
        recipeName: name,
        subRecipeName: cell(row, 7),
        plannedMeals: parseIntCell(row, 8),
        plannedStagingKg: parseFloatCell(row, 9),
        kitchenKg: parseFloatCell(row, 10),
        plannedPostKg: parseFloatCell(row, 11),
        yieldPct: parseFloatCell(row, 12),
        logisticStaged: parseBoolCell(row, 13),
        kitchenCooked: parseBoolCell(row, 15),
        logisticStatus: cell(row, 22),
        logisticOwner: cell(row, 23),
      });
    }
  }

  const byWorkOrder = new Map<string, TransparencyFlowRow[]>();
  const byRecipeCode = new Map<string, TransparencyFlowRow[]>();
  for (const r of parsed) {
    if (!byWorkOrder.has(r.workOrder)) byWorkOrder.set(r.workOrder, []);
    byWorkOrder.get(r.workOrder)!.push(r);
    if (r.recipeCode) {
      if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
      byRecipeCode.get(r.recipeCode)!.push(r);
    }
  }

  return { rows: parsed, byWorkOrder, byRecipeCode, lastUpdated: Date.now() };
}
