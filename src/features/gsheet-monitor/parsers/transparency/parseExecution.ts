// Transparency Plan – Ausführung/Holding: "Plating Excecution Tracking",
// "Counting Plating Holding" (beide Tab-Namen im Sheet mit Tippfehlern, hier
// bewusst unverändert als Registry-Key-Titel übernommen).
import type {
  TransparencyPlatingExecutionData, TransparencyPlatingExecutionRow,
  TransparencyPlatingHoldingData, TransparencyPlatingHoldingRow,
} from "../../transparencyTypes";
import { cell, findHeaderIndex, parseIntCell } from "./transparencyCellHelpers";

// "Type","Production Shift","Total Target","Total Mapped","Recipe WO #",
// "Recipe Name","Recipe WO Mapped","Recipe WO Target","Recipe Plating
// Status","Recipe Manual Plating Status", ...
export function parsePlatingExecution(rows: string[][]): TransparencyPlatingExecutionData {
  const headerIdx = findHeaderIndex(rows, 0, "Type");
  const parsed: TransparencyPlatingExecutionRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 4);
      if (!workOrder) continue;
      parsed.push({
        productionShift: cell(row, 1),
        workOrder,
        recipeName: cell(row, 5),
        recipeWoMapped: parseIntCell(row, 6),
        recipeWoTarget: parseIntCell(row, 7),
        platingStatus: cell(row, 8),
        manualPlatingStatus: cell(row, 9),
      });
    }
  }

  return { rows: parsed, byWorkOrder: new Map(parsed.map((r) => [r.workOrder, r] as const)), lastUpdated: Date.now() };
}

// "WO Number","Sub Recipe Description","Quantity" -- darüber liegt ein
// Datum/Uhrzeit-Raster (mehrere Zählzeitpunkte pro Tag), das hier bewusst
// nicht ausgewertet wird; nur der jeweils letzte "Quantity"-Wert je Zeile.
export function parseCountingPlatingHolding(rows: string[][]): TransparencyPlatingHoldingData {
  const headerIdx = findHeaderIndex(rows, 0, "WO Number");
  const parsed: TransparencyPlatingHoldingRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 0);
      if (!workOrder) continue;
      parsed.push({ workOrder, subRecipeName: cell(row, 1), quantity: parseIntCell(row, 2) });
    }
  }

  const byWorkOrder = new Map<string, TransparencyPlatingHoldingRow[]>();
  for (const r of parsed) {
    if (!byWorkOrder.has(r.workOrder)) byWorkOrder.set(r.workOrder, []);
    byWorkOrder.get(r.workOrder)!.push(r);
  }

  return { rows: parsed, byWorkOrder, lastUpdated: Date.now() };
}
