// Ersatz-Kopfzahlen für den RTI-Backfill-Rechner, wenn Planned Target / Actuals
// im RTI-Sheet-Kopf (noch) nicht von Hand eingetragen sind. Rein, kein Hook.
//
// WICHTIG: Der RTI-Kopf, wie ihn Menschen füllen, ist NICHT die Forecast-
// Gesamtzahl, sondern der **1. (Haupt-)Plating-Run** des Meals — an KW38 gegen
// 9 von Hand gefüllte Meals verifiziert (RTI Planned == LinePlaiting 1. Run,
// exakt). Ein Meal mit 2–3 Runs hätte sonst ein viel zu hohes Planned Target.
//
//   Planned Target  ← LinePlaiting 1. Run (Planned)  ▸ Fallback Forecast-Gesamt (markiert)
//   Actuals         ← LinePlaiting 1. Run (Actual)   ▸ Fallback Redzone-Output
//
// Key = codeDigits(mealCode).toUpperCase() (4-stellig) — identisch zum Key in
// computeRtiBackfills / combineBackfills, damit FV4063A und FV4063B zusammenfallen.
import type { DataBundle } from "../../core/types";
import type { LinePlaitingData } from "../gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../redzone-live/redzoneTypes";
import { codeDigits } from "../../lib/helpers";
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
  if (!weekShort) return out;

  // ── LinePlaiting: 1. Run (erste Zeile je Meal) Planned + Actual ───────────
  const lpFirstRun = new Map<string, { planned: number; actual: number }>();
  for (const r of linePlaiting?.rows ?? []) {
    if (!r.recipeCode || !(r.plannedPortions > 0)) continue;
    const k = key(r.recipeCode);
    if (lpFirstRun.has(k)) continue; // Zeilen stehen in Tages-/Run-Reihenfolge
    lpFirstRun.set(k, { planned: Math.round(r.plannedPortions), actual: Math.round(Math.max(0, r.actualPortions)) });
  }

  // ── Forecast (WeekRecipe.totalVerdenVolume) — Fallback fürs Ziel ──────────
  const forecast = new Map<string, number>();
  for (const wr of data?.weekRecipes ?? []) {
    if (wr.weekShort !== weekShort || !(wr.totalVerdenVolume > 0)) continue;
    const k = key(wr.code);
    if ((forecast.get(k) ?? 0) < wr.totalVerdenVolume) forecast.set(k, Math.round(wr.totalVerdenVolume));
  }

  // ── Redzone Σ outCount (Plating), ab Montag — Fallback fürs Ist ───────────
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

  const codes = new Set<string>([...lpFirstRun.keys(), ...forecast.keys()]);
  for (const k of codes) {
    const run1 = lpFirstRun.get(k);
    const fc = forecast.get(k) ?? 0;

    let plannedTarget = 0;
    let planSrc = "";
    if (run1 && run1.planned > 0) { plannedTarget = run1.planned; planSrc = "LinePlaiting 1. Run"; }
    else if (fc > 0) { plannedTarget = fc; planSrc = "Forecast-Gesamt"; }
    else continue;

    const redz = redzoneByCode.get(k) ?? 0;
    let actuals = 0;
    let actualSrc = "";
    if (run1 && run1.actual > 0) { actuals = run1.actual; actualSrc = "LinePlaiting 1. Run"; }
    else if (redz > 0 && redz <= plannedTarget * 1.05) { actuals = Math.round(redz); actualSrc = "Redzone"; }
    else continue; // ohne Ist-Zahl kein rechenbarer gap

    actuals = Math.min(actuals, Math.round(plannedTarget * 1.05));
    const source = planSrc === actualSrc ? planSrc : `${planSrc} / ${actualSrc}`;
    out.set(k, { plannedTarget, actuals, source });
  }

  return out;
}
