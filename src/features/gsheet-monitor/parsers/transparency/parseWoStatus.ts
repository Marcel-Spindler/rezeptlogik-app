// Transparency Plan – WO-/Stations-Status-Tabs: "WMS WO", "ET", "Input
// Kitchen". Alle drei sind flache 1:1-Spalten-zu-Feld-Tabellen, deshalb in
// einer Datei statt drei fast identischen. Wichtig für die Produktionsanalyse
// als Statusquelle (Post Blast/Pre Blast/Released/Partially Allocated etc.),
// nicht Teil der Produzierbarkeits-Kernkette (die hängt an Total
// Overview/Importrange Weights/RTEM).
import type {
  TransparencyWmsWoData, TransparencyWmsWoRow,
  TransparencyEtData, TransparencyEtRow,
  TransparencyInputKitchenData, TransparencyInputKitchenRow,
} from "../../transparencyTypes";
import { cell, findHeaderIndex, parseBoolCell, parseIntCell } from "./transparencyCellHelpers";

// "Wh Id","Week","wo number","Wo Status","Sub Recipe Name","Sub Recipe Id",
// "Staging Day","Staging Shift","Target Qty","Allocate","Release Picking",
// "Picking Tasks","Uom","Cook Methods"
export function parseWmsWo(rows: string[][]): TransparencyWmsWoData {
  const headerIdx = findHeaderIndex(rows, 2, "wo number");
  const parsed: TransparencyWmsWoRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 2);
      if (!workOrder) continue;
      parsed.push({
        week: cell(row, 1),
        workOrder,
        status: cell(row, 3),
        subRecipeName: cell(row, 4),
        subRecipeId: cell(row, 5),
        stagingDay: cell(row, 6),
        targetQty: parseIntCell(row, 8),
        uom: cell(row, 12),
        cookMethods: cell(row, 13),
      });
    }
  }

  return { rows: parsed, byWorkOrder: new Map(parsed.map((r) => [r.workOrder, r] as const)), lastUpdated: Date.now() };
}

// "Cooking day","Work Order Number","Recipe ID","Recipe Name","Sub Recipe
// Name","Production Minimum Needs Amount","Cook Methods","WO Cooked
// Portions","Target Portions","Cooked Portions Excess","Staging Status",
// "Staging Comment","Kitchen Status","Unlocked ETA","Work Order Comment"
export function parseTransparencyEt(rows: string[][]): TransparencyEtData {
  const headerIdx = findHeaderIndex(rows, 1, "Work Order Number");
  const parsed: TransparencyEtRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 1);
      if (!workOrder) continue;
      parsed.push({
        cookingDay: cell(row, 0),
        workOrder,
        recipeId: cell(row, 2),
        recipeName: cell(row, 3),
        subRecipeName: cell(row, 4),
        stagingStatus: cell(row, 10),
        kitchenStatus: cell(row, 12),
      });
    }
  }

  return { rows: parsed, byWorkOrder: new Map(parsed.map((r) => [r.workOrder, r] as const)), lastUpdated: Date.now() };
}

// "","Priority","WOStaging by","Comments WO's","Debox Day","WO Ready","Hot
// Kitchen Weekday","Date Needed","Work Order Number","Recipe ID","Recipe
// Name","Sub Recipe Name","Production Minimum Needs Amount","Cook Methods",
// "WO Cooked Portions","Target Portions","Cooked Portions Excess","Staging
// Status","Staging Comment","Kitchen Status","Unlocked ETA","Work Order
// Comment","Date Needed","Work Order Number","Recipe ID","Allergense"
export function parseInputKitchen(rows: string[][]): TransparencyInputKitchenData {
  const headerIdx = findHeaderIndex(rows, 1, "Priority");
  const parsed: TransparencyInputKitchenRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 8);
      if (!workOrder) continue;
      parsed.push({
        priority: cell(row, 1),
        woStagingBy: cell(row, 2),
        deboxDay: cell(row, 4),
        woReady: parseBoolCell(row, 5),
        hotKitchenWeekday: cell(row, 6),
        dateNeeded: cell(row, 7),
        workOrder,
        recipeName: cell(row, 10),
        subRecipeName: cell(row, 11),
        cookMethods: cell(row, 13),
        targetPortions: parseIntCell(row, 15),
        stagingStatus: cell(row, 17),
        kitchenStatus: cell(row, 19),
        allergens: cell(row, 25),
      });
    }
  }

  return { rows: parsed, byWorkOrder: new Map(parsed.map((r) => [r.workOrder, r] as const)), lastUpdated: Date.now() };
}
