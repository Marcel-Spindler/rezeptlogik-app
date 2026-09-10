// Ersatz-Kopfzahlen für den RTI-Backfill-Rechner, wenn Planned Target / Actuals
// im RTI-Sheet-Kopf (noch) nicht von Hand eingetragen sind. Rein, kein Hook.
//
//   Planned Target  ← Forecast (WeekRecipe.totalVerdenVolume der KW),
//                     Fallback: LinePlaiting Σ Planned der KW
//   Actuals         ← Redzone Σ outCount (Plating-Runs, ab Montag),
//                     Fallback: LinePlaiting Σ Actual der KW
//
// Key = codeDigits(mealCode).toUpperCase() (4-stellig) — identisch zum Key in
// computeRtiBackfills / combineBackfills, damit FV4063A und FV4063B zusammenfallen.
import type { DataBundle } from "../../core/types";
import type { LinePlaitingData } from "../gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../redzone-live/redzoneTypes";
import { codeDigits } from "../../lib/helpers";
import { aggregatePlatingByMeal } from "./combineBackfills";
import type { RtiExternalTarget } from "./rtiBackfillCalculator";

function key(code: string): string {
  return codeDigits(code).toUpperCase();
}

// Montag 00:00 (lokal) der Woche, in der `now` liegt.
function startOfWeekMonday(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay() || 7; // So = 7
  d.setDate(d.getDate() - (dow - 1));
  return d.getTime();
}

export interface BuildRtiTargetsInput {
  data: DataBundle | null | undefined;
  /** HF-/KW-Kürzel der aufgelösten Woche, z.B. "W38". */
  weekShort: string;
  linePlaiting: LinePlaitingData | null;
  redzoneRuns: PlatingRunDisplay[] | undefined;
  now?: Date;
}

export function buildRtiExternalTargets(input: BuildRtiTargetsInput): Map<string, RtiExternalTarget> {
  const { data, weekShort, linePlaiting, redzoneRuns, now = new Date() } = input;
  const out = new Map<string, RtiExternalTarget>();
  // Ohne eindeutige KW kein verlässliches Forecast-Ziel — dann keine Schätzung.
  if (!weekShort) return out;

  // ── Planned Target: Forecast (WeekRecipe) ─────────────────────────────────
  const plannedByCode = new Map<string, number>();
  const plannedSrc = new Map<string, "Forecast" | "LinePlaiting">();
  for (const wr of data?.weekRecipes ?? []) {
    if (wr.weekShort !== weekShort) continue;
    if (!(wr.totalVerdenVolume > 0)) continue;
    const k = key(wr.code);
    // größten Wert behalten (Code-Varianten / Doppel-Zeilen)
    if ((plannedByCode.get(k) ?? 0) < wr.totalVerdenVolume) {
      plannedByCode.set(k, wr.totalVerdenVolume);
      plannedSrc.set(k, "Forecast");
    }
  }

  // ── LinePlaiting Σ Planned / Σ Actual der KW (Fallback bzw. Ist-Quelle) ────
  const platingByMeal = aggregatePlatingByMeal(linePlaiting);
  const lpPlanned = new Map<string, number>();
  const lpActual = new Map<string, number>();
  for (const [k, agg] of platingByMeal) {
    if (agg.allPlannedTotal > 0) lpPlanned.set(k, Math.round(agg.allPlannedTotal));
    if (agg.allActualTotal > 0) lpActual.set(k, Math.round(agg.allActualTotal));
  }
  for (const [k, v] of lpPlanned) {
    if (!plannedByCode.has(k)) { plannedByCode.set(k, v); plannedSrc.set(k, "LinePlaiting"); }
  }

  // ── Actuals: Redzone Σ outCount (Plating), ab Montag dieser Woche ──────────
  const weekStart = startOfWeekMonday(now);
  const redzoneByCode = new Map<string, number>();
  for (const run of redzoneRuns ?? []) {
    if (run.areaName !== "Plating" || !run.mealCode) continue;
    const startMs = run.startTime ? Date.parse(run.startTime) : NaN;
    if (Number.isFinite(startMs) && startMs < weekStart) continue;
    const add = run.outCount ?? 0;
    if (add <= 0) continue;
    const k = key(run.mealCode);
    redzoneByCode.set(k, (redzoneByCode.get(k) ?? 0) + add);
  }

  // ── Zusammenführen: nur Meals mit Planned Target ──────────────────────────
  for (const [k, plannedTarget] of plannedByCode) {
    const redz = redzoneByCode.get(k) ?? 0;
    const lp = lpActual.get(k) ?? 0;
    let actuals = 0;
    let actualSrc = "";
    if (redz > 0) { actuals = Math.round(redz); actualSrc = "Redzone"; }
    else if (lp > 0) { actuals = lp; actualSrc = "LinePlaiting"; }
    else continue; // ohne Ist-Zahl kein rechenbarer gap

    // klemmen: das Ist kann durch Zähl-/Fensterlücken minimal übers Ziel gehen
    if (actuals > plannedTarget) actuals = plannedTarget;

    const source = `${plannedSrc.get(k) ?? "Forecast"} + ${actualSrc}`;
    out.set(k, { plannedTarget: Math.round(plannedTarget), actuals, source });
  }

  return out;
}
