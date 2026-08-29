// GSheet Monitor – LinePlaiting-Parser (Kitchen Priority List, Tab "LinePlating W{XX}").
//
// Zeitslot-Raster Mo-Sa. Jeder Tagesblock beginnt mit einer "Comms"-Zeile
// (Spalte 1 == "Comms"), die die Spaltenüberschriften des rechten Meal-Blocks
// trägt: Code, Meal, Planned, Actual, Delta, "{Tag} needs" (bzw. "Min Needs
// THU"), Shortage, Shortage in %, ggf. Comment/Backfills.
//
// WICHTIG — zwei Quellen mit unterschiedlicher Header-Vollständigkeit:
//  1. Sheets-API-Dump (scripts/dump-gsheet.ts): jede "Comms"-Zeile hat ALLE
//     Header-Texte.
//  2. gviz-CSV-Export (Live-Poller der App): behält nur die ERSTE "Comms"-Zeile
//     voll beschriftet, bei den 5 Wiederhol-Blöcken lässt gviz die Header der
//     als numerisch erkannten Spalten (Planned/Actual/Delta/{Tag} needs/
//     Shortage in %) WEG.
// Deshalb: Spalten-Map über ALLE "Comms"-Zeilen HINWEG mergen — eine spätere
// Zeile überschreibt nur die Spalten, die sie selbst beschriftet. Zusätzlich
// wandern die Positionen von KW zu KW (W34 ≠ W35 ≠ W36).
//
// Phasen (nur zur Kategorisierung der Tages-Summen + Abwärtskompatibilität):
// Di-Do "shortage", Fr "min-needs", Sa "result". Montag = keine Plating-Daten.
import type { LinePlaitingData, LinePlaitingDayTotal, LinePlaitingPhase, LinePlaitingRow } from "../gsheetTypes";

const DAY_PHASE: Partial<Record<string, LinePlaitingPhase>> = {
  Tuesday: "shortage",
  Wednesday: "shortage",
  Thursday: "shortage",
  Friday: "min-needs",
  Saturday: "result",
};

const EN_DAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
const DE_DAY: Record<string, string> = {
  montag: "Monday", dienstag: "Tuesday", mittwoch: "Wednesday", donnerstag: "Thursday",
  freitag: "Friday", samstag: "Saturday", sonntag: "Sunday",
};

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

// Portionen sind ganzzahlig — ein "," oder "." vor genau 3 Ziffern ist ein
// Tausender-Trenner (das Sheet mischt beide Stile, z.B. "5,485" vs. "5.485"),
// kein Dezimalpunkt.
function parseWholeNumber(raw: unknown): number {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return 0;
  const cleaned = trimmed.replace(/[.,](\d{3})(?!\d)/g, "$1").replace(/[^\d.\-]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

// wie parseWholeNumber, aber "" / "done" / "Ready" / andere Nicht-Zahlen → null.
// Die "{Tag} needs"-Spalte enthält am Sa oft "done" statt einer Zahl.
function parseOptionalWholeNumber(raw: unknown): number | null {
  const t = String(raw ?? "").trim();
  if (!t || !/^-?[\d.,\s]+$/.test(t)) return null;
  return parseWholeNumber(t);
}

function parsePct(raw: unknown): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const n = parseFloat(t.replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Alt-Layout-Spalte "Backfills" (≤ W35): "yes" (Flag), "Min: 1.400" (Fr-Bedarf)
// oder nackte Zahl (Sa). Nur Fallback für dayNeed, wenn kein "{Tag} needs" da ist.
function parseBackfillCell(raw: unknown): number | null {
  const t = String(raw ?? "").trim();
  if (!t || /^yes$/i.test(t)) return null;
  const n = parseWholeNumber(t);
  return n > 0 ? n : null;
}

interface ColMap {
  code: number;
  meal: number;
  planned: number;
  actual: number;
  delta: number;
  dayNeed: number;        // "{Tag} needs" / "Min Needs THU"
  shortageReason: number;
  shortagePct: number;
  comment: number;
  backfills: number;      // Alt-Layout ≤ W35
}

const EMPTY_COLS: ColMap = {
  code: -1, meal: -1, planned: -1, actual: -1, delta: -1,
  dayNeed: -1, shortageReason: -1, shortagePct: -1, comment: -1, backfills: -1,
};

// Liest die Spalten, die DIESE Zeile beschriftet (Werte -1 für nicht gefunden),
// und merged sie in `prev` — eine spätere "Comms"-Zeile überschreibt nur die
// Spalten, die sie selbst benennt (gviz lässt bei Wiederhol-Blöcken welche weg).
function mergeHeader(prev: ColMap, row: unknown[]): ColMap {
  const idx = (pred: (h: string) => boolean): number => {
    for (let i = 0; i < row.length; i++) if (pred(norm(row[i]))) return i;
    return -1;
  };
  const take = (found: number, fallback: number) => (found >= 0 ? found : fallback);
  return {
    code: take(idx((h) => h === "code"), prev.code),
    meal: take(idx((h) => h === "meal"), prev.meal),
    planned: take(idx((h) => h === "planned"), prev.planned),
    actual: take(idx((h) => h === "actual"), prev.actual),
    delta: take(idx((h) => h === "delta"), prev.delta),
    dayNeed: take(idx((h) => h.includes("need")), prev.dayNeed),
    shortageReason: take(idx((h) => h === "shortage"), prev.shortageReason),
    shortagePct: take(idx((h) => h === "shortage in %" || h === "shortage %"), prev.shortagePct),
    comment: take(idx((h) => h === "comment" || h === "comments"), prev.comment),
    backfills: take(idx((h) => h === "backfills"), prev.backfills),
  };
}

function isCommsRow(row: unknown[]): boolean {
  if (norm(row[1]) === "comms") return true;
  // Fallback: Zeile beschriftet Code UND Meal (falls "Comms" mal fehlt).
  return row.some((c) => norm(c) === "code") && row.some((c) => norm(c) === "meal");
}

// Tag aus einer "Comms"-Zeile (deutscher Name in Spalte 2, ggf. "W36 Time Montag").
function dayFromComms(row: unknown[]): string {
  for (const cell of row) {
    for (const word of norm(cell).split(/\s+/)) {
      if (DE_DAY[word]) return DE_DAY[word];
    }
  }
  return "";
}

// "W36" aus dem Tab-Kopf (irgendeine Zelle der ersten Zeilen, meist A1/C1).
function detectWeek(rows: string[][]): string {
  for (const row of rows.slice(0, 4)) {
    for (const cell of row ?? []) {
      const m = /\bW(\d{1,2})\b/i.exec(String(cell ?? "").trim());
      if (m) return `W${m[1].padStart(2, "0")}`;
    }
  }
  return "";
}

export function parseLinePlaiting(rows: string[][]): LinePlaitingData {
  const parsedRows: LinePlaitingRow[] = [];
  const dayTotals: LinePlaitingDayTotal[] = [];
  const week = detectWeek(rows);
  let currentDay = "";
  let cols: ColMap = EMPTY_COLS;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    if (isCommsRow(row)) {
      cols = mergeHeader(cols, row);
      const d = dayFromComms(row);
      if (d) currentDay = d;
      continue;
    }

    const dayCell = String(row[0] ?? "").trim();
    if (EN_DAYS.has(dayCell)) currentDay = dayCell;

    const phase = DAY_PHASE[currentDay];
    if (!phase || cols.code < 0 || cols.meal < 0 || cols.planned < 0) continue;

    const code = String(row[cols.code] ?? "").trim();
    const plannedRaw = String(row[cols.planned] ?? "").trim();

    // Tages-/Phasen-Summenzeile: Code leer, aber Planned gefüllt.
    if (!code) {
      if (plannedRaw) {
        dayTotals.push({
          day: currentDay,
          phase,
          plannedPortions: parseWholeNumber(plannedRaw),
          actualPortions: cols.actual >= 0 ? parseWholeNumber(row[cols.actual]) : 0,
          deltaPortions: cols.delta >= 0 ? parseWholeNumber(row[cols.delta]) : 0,
          shortagePct: cols.shortagePct >= 0 ? parsePct(row[cols.shortagePct]) : null,
        });
      }
      continue;
    }
    if (norm(code) === "code" || !/^[A-Z]{1,3}\d/i.test(code)) continue; // Header-Reste / Nicht-Codes

    const planned = parseWholeNumber(plannedRaw);
    const actual = cols.actual >= 0 ? parseWholeNumber(row[cols.actual]) : 0;
    const delta =
      cols.delta >= 0 && String(row[cols.delta] ?? "").trim()
        ? parseWholeNumber(row[cols.delta])
        : actual - planned;

    let dayNeed = cols.dayNeed >= 0 ? parseOptionalWholeNumber(row[cols.dayNeed]) : null;
    if (dayNeed == null && cols.backfills >= 0) dayNeed = parseBackfillCell(row[cols.backfills]);

    const pctCell = cols.shortagePct >= 0 ? String(row[cols.shortagePct] ?? "").trim() : "";
    const shortagePct = parsePct(pctCell);
    // In manchen KW steht am Fr/Sa in der "Shortage in %"-Spalte Status-Text
    // ("Ready" / "blocked" / "done") statt einer Prozentzahl.
    const statusText = shortagePct == null ? pctCell : "";

    parsedRows.push({
      week,
      day: currentDay,
      time: String(row[2] ?? "").trim(),
      phase,
      recipeCode: code.toUpperCase(),
      meal: String(row[cols.meal] ?? "").trim(),
      plannedPortions: planned,
      actualPortions: actual,
      deltaPortions: delta,
      comment: cols.comment >= 0 ? String(row[cols.comment] ?? "").trim() : "",
      backfillConfirmed: cols.backfills >= 0 && /^yes$/i.test(String(row[cols.backfills] ?? "").trim()),
      minNeededPortions: phase === "min-needs" ? dayNeed : null,
      dayNeedPortions: dayNeed,
      statusText,
      shortageReason: cols.shortageReason >= 0 ? String(row[cols.shortageReason] ?? "").trim() : "",
      shortagePct,
    });
  }

  const byRecipeCode = new Map<string, LinePlaitingRow[]>();
  for (const r of parsedRows) {
    if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
    byRecipeCode.get(r.recipeCode)!.push(r);
  }

  return { week, rows: parsedRows, byRecipeCode, dayTotals, lastUpdated: Date.now() };
}
