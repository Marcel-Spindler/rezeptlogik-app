// GSheet Monitor – Postblast-Wiegungs-Parser.
// Parst das Haupt-Tab (gid=0) mit den Live-Gewichtseingaben aus der Produktion.
import type { PostblastData, PostblastEntry } from "../gsheetTypes";

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
    // Google Sheets exportiert immer M/D/YYYY (US), auch bei DE-Locale
    return `${year}-${part1.padStart(2, "0")}-${part2.padStart(2, "0")}`;
  }
  // Fallback: ISO-Format oder DD.MM.YYYY
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(timestamp);
  if (de) return `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`;
  return "";
}

export function parsePostblast(rows: string[][]): PostblastData {
  const entries: PostblastEntry[] = [];

  // Header ist Zeile 0 — Spalten: Timestamp, WO Number, SKU code, Sub Recipe name, Raw weight (kg), Subsubrecipe, Post-Blast kg, Target kg
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const timestamp = (row[0] ?? "").trim();
    const workOrder = (row[1] ?? "").trim();
    const subRecipeName = (row[3] ?? "").trim();

    // Leere Zeilen skippen
    if (!timestamp && !workOrder && !subRecipeName) continue;
    // Muss mindestens einen WO oder Sub-Recipe haben
    if (!workOrder && !subRecipeName) continue;

    entries.push({
      timestamp,
      date: extractDate(timestamp),
      workOrder,
      skuCode: (row[2] ?? "").trim(),
      subRecipeName,
      rawWeightKg: num(row[4] ?? ""),
      subSubRecipe: (row[5] ?? "").trim(),
      postBlastKg: num(row[6] ?? ""),
      targetKg: num(row[7] ?? ""),
    });
  }

  // Gruppierungen
  const byWorkOrder = new Map<string, PostblastEntry[]>();
  const bySubRecipe = new Map<string, PostblastEntry[]>();

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

  const totalWeightKg = entries.reduce((s, e) => s + e.rawWeightKg, 0);
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

  return { entries, byWorkOrder, bySubRecipe, totalWeightKg, lastEntry, lastUpdated: Date.now() };
}
