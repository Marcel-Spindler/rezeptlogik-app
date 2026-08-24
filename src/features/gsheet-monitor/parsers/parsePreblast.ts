// GSheet Monitor – Pre-Blast-Wiegungs-Parser.
// Parst das Pre-Blast-Tab — die Wiegung direkt nach dem Kochen, BEVOR die
// Charge durch den Blast Chiller läuft und dabei an Menge verliert (Schwund).
// Dient in postblastMatch.ts als früher Zwischenstatus ("schon gekocht, noch
// im Chiller") und als Referenzwert für den Schwund gegenüber Post-Blast.
import type { PreblastData, PreblastEntry } from "../gsheetTypes";

function num(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[,\s]/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function extractDate(timestamp: string): string {
  // Format: "M/D/YYYY H:MM:SS" (US-Format aus Google Sheets)
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(timestamp);
  if (m) {
    const [, part1, part2, year] = m;
    return `${year}-${part1.padStart(2, "0")}-${part2.padStart(2, "0")}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(timestamp);
  if (de) return `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`;
  return "";
}

export function parsePreblast(rows: string[][]): PreblastData {
  const entries: PreblastEntry[] = [];
  let lastKnownDate = "";

  // Header ist Zeile 0 — Spalten: Datum, WO Number, Pre Blast weight (kg),
  // SKU code, Sub Recipe Name, Anzahl pro Rack -> Bei Proteins, Blast chiller.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const workOrder = (row[1] ?? "").trim();
    const subRecipeName = (row[4] ?? "").trim();
    if (!workOrder && !subRecipeName) continue;

    const rawTimestamp = (row[0] ?? "").trim();
    if (rawTimestamp) lastKnownDate = extractDate(rawTimestamp);

    const piecesRaw = (row[5] ?? "").trim();
    const pieces = piecesRaw ? num(piecesRaw) : 0;

    entries.push({
      timestamp: rawTimestamp,
      date: rawTimestamp ? extractDate(rawTimestamp) : lastKnownDate,
      workOrder,
      subRecipeName,
      weightKg: num(row[2] ?? ""),
      piecesPerRack: pieces > 0 ? pieces : null,
    });
  }

  const byWorkOrder = new Map<string, PreblastEntry[]>();
  const bySubRecipe = new Map<string, PreblastEntry[]>();

  for (const e of entries) {
    if (e.workOrder) {
      if (!byWorkOrder.has(e.workOrder)) byWorkOrder.set(e.workOrder, []);
      byWorkOrder.get(e.workOrder)!.push(e);
    }
    if (e.subRecipeName) {
      if (!bySubRecipe.has(e.subRecipeName)) bySubRecipe.set(e.subRecipeName, []);
      bySubRecipe.get(e.subRecipeName)!.push(e);
    }
  }

  const totalWeightKg = entries.reduce((s, e) => s + e.weightKg, 0);
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

  return { entries, byWorkOrder, bySubRecipe, totalWeightKg, lastEntry, lastUpdated: Date.now() };
}
