// GSheet Monitor – Parser für die "Shorts Tracker"-Tab (Rohstoff-Engpässe).
// Spalten (verifiziert per Live-Dump, 2026-08-25): A WO, B Staging Day,
// C Ingredient, D SKU, E Short (KGs), F Recovery Status, G Quantity Located,
// H Ticket #, I Notes, J Filled. Davor liegen ein bis mehrere informative
// Kopf-/Leerzeilen ohne festen Offset — Datenzeilen werden deshalb an ihrer
// FORM erkannt (Spalte A = reine Ziffernfolge, Spalte B = "TT.MM.JJJJ")
// statt an einer hart codierten Zeilennummer.
import type { ShortageEntry, ShortsTrackerData } from "../gsheetTypes";
import { hfWeekForDate } from "../../../lib/hfWeek";
import { weekNumFromHfWeek } from "../../wms-overview/wmsWeeks";

function num(s: string): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[,\s]/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function parseGermanDate(s: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim());
  if (!m) return "";
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// KW muss aus dem Kalenderdatum rekonstruiert werden (siehe gsheetTypes.ts) —
// nutzt dieselbe HF-Wochen-Konvention (ISO-Woche + 1) wie überall sonst in
// der App, damit das Ergebnis exakt zu den WO-Präfixen aus Postblast/ET passt.
function reconstructWorkOrder(woSuffix: string, stagingDayIso: string): string | null {
  if (!stagingDayIso) return null;
  const date = new Date(`${stagingDayIso}T12:00:00Z`);
  if (isNaN(date.getTime())) return null;
  const weekNum = weekNumFromHfWeek(hfWeekForDate(date));
  return weekNum != null ? `${weekNum}-${woSuffix}` : null;
}

function isDataRow(row: string[]): boolean {
  return /^\d+$/.test((row[0] ?? "").trim()) && /^\d{1,2}\.\d{1,2}\.\d{4}$/.test((row[1] ?? "").trim());
}

export function parseShortsTracker(rows: string[][]): ShortsTrackerData {
  const entries: ShortageEntry[] = [];

  rows.forEach((row, rowIndex) => {
    if (!isDataRow(row)) return;
    const rawWorkOrderSuffix = row[0].trim();
    const stagingDay = parseGermanDate(row[1]);
    entries.push({
      rawWorkOrderSuffix,
      stagingDay,
      workOrder: reconstructWorkOrder(rawWorkOrderSuffix, stagingDay),
      ingredient: (row[2] ?? "").trim(),
      sku: (row[3] ?? "").trim(),
      shortKg: num(row[4] ?? ""),
      recoveryStatus: (row[5] ?? "").trim(),
      ticketNumber: (row[7] ?? "").trim(),
      notes: (row[8] ?? "").trim(),
      filled: /^(true|wahr|x)$/i.test((row[9] ?? "").trim()),
      rowIndex,
    });
  });

  const byWorkOrder = new Map<string, ShortageEntry[]>();
  for (const e of entries) {
    if (!e.workOrder) continue;
    if (!byWorkOrder.has(e.workOrder)) byWorkOrder.set(e.workOrder, []);
    byWorkOrder.get(e.workOrder)!.push(e);
  }

  return { entries, byWorkOrder, lastUpdated: Date.now() };
}
