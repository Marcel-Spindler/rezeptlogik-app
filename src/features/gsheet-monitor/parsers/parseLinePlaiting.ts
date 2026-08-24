// GSheet Monitor – LinePlaiting-Parser.
// Parst das wöchentliche "LinePlaiting Wxx"-Tab: Zeitslot-Raster (halbstündlich)
// über Montag-Samstag. Montag hat keine Plating-Daten. Di-Do zeigt reguläres
// Plating (Planned/Actual/Delta/Grund je Meal-Slot), Freitag berechnet daraus
// den Mindest-Nachproduktionsbedarf ("Min Needs" statt "Backfills"-Header),
// Samstag hält das Ergebnis der gefahrenen Backfill-Chargen fest.
//
// Spalten (0-indiziert, siehe gsheetTypes.ts LinePlaitingRow):
// A Week Day, C Time, K Code, L Meal, M Planned, Q Actual, R Delta,
// T Comment, U Backfills/Min Needs, W Shortage, X Shortage in %.
import type { LinePlaitingData, LinePlaitingDayTotal, LinePlaitingPhase, LinePlaitingRow } from "../gsheetTypes";

const DAY_PHASE: Partial<Record<string, LinePlaitingPhase>> = {
  Tuesday: "shortage",
  Wednesday: "shortage",
  Thursday: "shortage",
  Friday: "min-needs",
  Saturday: "result",
};

// Portionen sind immer ganzzahlig — ein einzelnes "," oder "." vor genau 3
// Ziffern ist ein Tausender-Trenner (das Sheet mischt beide Stile je nach
// Spalten-Zellformat, z.B. "18,840" in einer Totalzeile vs. "Min: 1.400" in
// Handeingaben), kein Dezimalpunkt.
function parseWholeNumber(raw: string): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return 0;
  const cleaned = trimmed.replace(/[.,](\d{3})(?!\d)/g, "$1").replace(/[^\d.\-]/g, "");
  const n = parseInt(cleaned, 10);
  return isFinite(n) ? n : 0;
}

function parsePct(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed.replace("%", "").replace(",", "."));
  return isFinite(n) ? n : null;
}

// "yes" (Di-Do-Flag), "Min: 1.400" (Fr-Bedarf) oder eine nackte Zahl (Sa-
// Ergebnis) — je nach Tag/Phase steckt in derselben Spalte etwas anderes.
function parseBackfillCell(raw: string): { confirmed: boolean; minNeeded: number | null } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { confirmed: false, minNeeded: null };
  if (/^yes$/i.test(trimmed)) return { confirmed: true, minNeeded: null };
  const numeric = parseWholeNumber(trimmed);
  return { confirmed: false, minNeeded: numeric > 0 ? numeric : null };
}

export function parseLinePlaiting(rows: string[][]): LinePlaitingData {
  const parsedRows: LinePlaitingRow[] = [];
  const dayTotals: LinePlaitingDayTotal[] = [];
  let currentDay = "";

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dayCell = (row[0] ?? "").trim();
    if (dayCell) currentDay = dayCell;
    const phase = DAY_PHASE[currentDay];
    if (!phase) continue; // Montag (Vorbereitung) oder unbekannter Tag -> keine Plating-Daten

    const code = (row[10] ?? "").trim();
    const meal = (row[11] ?? "").trim();
    const plannedRaw = (row[12] ?? "").trim();

    // Header-Wiederholung ("Code"/"Meal" als Literal) -> überspringen.
    if (code === "Code") continue;

    // Tages-/Phasen-Summenzeile: Code+Meal leer, aber Planned gefüllt.
    if (!code) {
      if (plannedRaw) {
        dayTotals.push({
          day: currentDay,
          phase,
          plannedPortions: parseWholeNumber(plannedRaw),
          actualPortions: parseWholeNumber(row[16] ?? ""),
          deltaPortions: parseWholeNumber(row[17] ?? ""),
          shortagePct: parsePct(row[23] ?? ""),
        });
      }
      continue;
    }

    const backfillCell = parseBackfillCell(row[20] ?? "");

    parsedRows.push({
      day: currentDay,
      time: (row[2] ?? "").trim(),
      phase,
      recipeCode: code,
      meal,
      plannedPortions: parseWholeNumber(plannedRaw),
      actualPortions: parseWholeNumber(row[16] ?? ""),
      deltaPortions: parseWholeNumber(row[17] ?? ""),
      comment: (row[19] ?? "").trim(),
      backfillConfirmed: backfillCell.confirmed,
      minNeededPortions: backfillCell.minNeeded,
      shortageReason: (row[22] ?? "").trim(),
      shortagePct: parsePct(row[23] ?? ""),
    });
  }

  const byRecipeCode = new Map<string, LinePlaitingRow[]>();
  for (const r of parsedRows) {
    if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
    byRecipeCode.get(r.recipeCode)!.push(r);
  }

  return { rows: parsedRows, byRecipeCode, dayTotals, lastUpdated: Date.now() };
}
