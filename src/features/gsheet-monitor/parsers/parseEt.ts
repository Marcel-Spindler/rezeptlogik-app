// GSheet Monitor – ET Parser: parst die Master-WO-Liste (Tab "ET").
// Spalten: Cooking day, Work Order Number, Recipe ID, Recipe Name, Sub Recipe Name, …
// (weitere Spalten sind Sheet-interne Hilfsspalten und werden ignoriert).
import type { EtData, EtEntry } from "../gsheetTypes";

const FV_HEADER_RE = /^(FV\d{4}[A-Z]?)\s*-\s*(.+)/i;

function extractCookingDay(raw: string): string {
  // Format im Sheet: "2026/08/10"
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(raw.trim());
  if (!m) return "";
  const [, year, month, day] = m;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseEt(rows: string[][]): EtData {
  const entries: EtEntry[] = [];

  // Header ist Zeile 0.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const workOrder = (row[1] ?? "").trim();
    const recipeNameRaw = (row[3] ?? "").trim();
    const subRecipeName = (row[4] ?? "").trim();
    if (!workOrder || !recipeNameRaw) continue;

    const fvMatch = FV_HEADER_RE.exec(recipeNameRaw);
    const recipeCode = fvMatch ? fvMatch[1].toUpperCase() : recipeNameRaw;
    const recipeName = fvMatch ? fvMatch[2].replace(/\s*\[.*?\]\s*$/, "").trim() : recipeNameRaw;

    entries.push({
      cookingDay: extractCookingDay(row[0] ?? ""),
      workOrder,
      recipeId: (row[2] ?? "").trim(),
      recipeCode,
      recipeName,
      subRecipeName,
    });
  }

  const byWorkOrder = new Map<string, EtEntry>();
  for (const e of entries) byWorkOrder.set(e.workOrder, e);

  return { entries, byWorkOrder, lastUpdated: Date.now() };
}
