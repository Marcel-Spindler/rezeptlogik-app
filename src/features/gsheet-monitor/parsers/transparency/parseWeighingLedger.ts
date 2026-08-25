// Transparency Plan – Tab "Importrange Weights": DIE Rohwiegungsquelle. Drei
// unabhängige Spaltengruppen (Raw / Pre-Blast / Post-Blast), NICHT zeilenweise
// verknüpft — eine Zeile kann z.B. nur eine Post-Blast-Wiegung enthalten,
// während Raw/Pre-Blast in dieser Zeile leer sind (die drei Ketten wachsen
// unabhängig voneinander). Jede Gruppe wird deshalb separat über ihre eigenen
// Spalten extrahiert, wie schon bei den bestehenden Preblast/Postblast-Tabs.
//
// Spalten (0-indiziert): 1 WO/4 Raw kg (Raw), 6 WO/7 kg/8 SKU/9 Subrezept/10
// Stück pro Rack (Pre-Blast), 12 WO/13 kg/14 SKU/15 Rezept/16 Subrezept
// (Post-Blast). Die RTI-Spalten rechts davon (ab ~17) sind ein manuell
// selektiertes Einzel-Meal-Panel, kein Tabellen-Layout — bewusst nicht geparst
// (RTEM liefert dasselbe strukturiert, siehe parseRtem.ts).
import type { TransparencyWeighingData, TransparencyRawWeightEntry, TransparencyPreBlastEntry, TransparencyPostBlastEntry } from "../../transparencyTypes";
import { cell, findHeaderIndex, parseFloatCell, parseIntCell } from "./transparencyCellHelpers";

export function parseWeighingLedger(rows: string[][]): TransparencyWeighingData {
  const headerIdx = findHeaderIndex(rows, 1, "WO Number");
  const raw: TransparencyRawWeightEntry[] = [];
  const preBlast: TransparencyPreBlastEntry[] = [];
  const postBlast: TransparencyPostBlastEntry[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rawWo = cell(row, 1);
      if (rawWo) {
        const weightKg = parseFloatCell(row, 4);
        if (weightKg != null) raw.push({ workOrder: rawWo, skuCode: cell(row, 2), subRecipeName: cell(row, 3), weightKg });
      }

      const preWo = cell(row, 6);
      if (preWo) {
        const weightKg = parseFloatCell(row, 7);
        if (weightKg != null) {
          preBlast.push({ workOrder: preWo, skuCode: cell(row, 8), subRecipeName: cell(row, 9), weightKg, piecesPerRack: parseIntCell(row, 10) });
        }
      }

      const postWo = cell(row, 12);
      if (postWo) {
        const weightKg = parseFloatCell(row, 13);
        if (weightKg != null) {
          postBlast.push({ workOrder: postWo, skuCode: cell(row, 14), weightKg, recipeName: cell(row, 15), subRecipeName: cell(row, 16) });
        }
      }
    }
  }

  function sumByWo<T extends { workOrder: string; weightKg: number }>(entries: T[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.workOrder, (m.get(e.workOrder) ?? 0) + e.weightKg);
    return m;
  }

  return {
    raw,
    preBlast,
    postBlast,
    rawKgByWorkOrder: sumByWo(raw),
    preBlastKgByWorkOrder: sumByWo(preBlast),
    postBlastKgByWorkOrder: sumByWo(postBlast),
    lastUpdated: Date.now(),
  };
}
