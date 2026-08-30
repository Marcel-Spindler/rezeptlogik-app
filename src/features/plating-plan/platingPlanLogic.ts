// Deterministischer Kern des Wochen-Plating-Plans + eine kapazitäts- und
// regelbewusste Tag-Zuweisung. Reine Logik, kein React.
//
// Regeln (aus Marcels „Plating Plan"-GSheet, Tabs W29–W39 + „Rules of 3 weeks"):
//  - Demand D = BENL + NORD + DE  (NORD = DKSE)
//  - D ≤ 2250  → 1 Run,  Buffer +10%
//    D >  2250 → 2 Runs, Buffer  +5%
//  - 2 Runs:  Run 1 = firstRun% × bufferedTotal,  Run 2 = Rest
//    firstRun% ist pro KW (62 % W29/30, 66 % W31, sonst 70 %)
//  - Tag: Run 1 früh, Run 2 als Refire ~2 Tage später.
//    Seafood: 1. Run frühestens Mittwoch, möglichst an einem Tag.
//    Bis Donnerstag muss jedes Meal mind. 1× geplant sein (CPT).
//    Fr/Sa reduzierte Kapazität, So zu.

import type { DataBundle, WeekRecipe } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import {
  PLATING_DAYS, type PlatingDay, type PlatingDayCapacity, type PlatingMealPlan,
  type PlatingRun, type PlatingWeekPlan,
} from "./platingPlanTypes";

export interface PlatingParams {
  singleRunMaxDemand: number;  // ≤ dieser Wert → 1 Run
  singleRunBuffer: number;     // +10 %
  multiRunBuffer: number;      // +5 %
  firstRunPct: number;         // pro KW
}

export const DEFAULT_PLATING_PARAMS: Omit<PlatingParams, "firstRunPct"> = {
  singleRunMaxDemand: 2250,
  singleRunBuffer: 0.10,
  multiRunBuffer: 0.05,
};

/** Bekannte First-Run-% pro KW aus dem Sheet; sonst 70 %. */
export function firstRunPctForWeek(week: string): number {
  const m = /W(\d{1,2})$/.exec(week);
  const wn = m ? Number(m[1]) : 0;
  if (wn === 29 || wn === 30) return 0.62;
  if (wn === 31) return 0.66;
  return 0.70;
}

export const DEFAULT_DAY_CAPACITY: Partial<Record<PlatingDay, PlatingDayCapacity>> = {
  Mo: { lines: 0, hours: 0 },   // Montag nur Spätschicht — im Sheet meist 0 geplant
  Di: { lines: 3, hours: 22 },
  Mi: { lines: 3, hours: 22 },
  Do: { lines: 3, hours: 22 },
  Fr: { lines: 2, hours: 14 },
  Sa: { lines: 2, hours: 10 },  // Fr/Sa reduziert (Backfilling)
  So: { lines: 0, hours: 0 },
};

const SEAFOOD_RE = /\b(fish|salmon|shrimp|barramundi|crustacean|prawn|seafood|tuna)\b/i;
const STATION_KEYS = ["Grill", "Cup", "Butter", "Oven", "Braiser", "Slice"] as const;

function round(n: number): number {
  return Math.max(0, Math.round(n));
}

/** Demand → Runs (ohne Tag). */
export function splitMealIntoRuns(demand: number, params: PlatingParams): {
  runCount: number; bufferedTotal: number; runs: Omit<PlatingRun, "day">[];
} {
  if (demand <= 0) return { runCount: 0, bufferedTotal: 0, runs: [] };
  if (demand <= params.singleRunMaxDemand) {
    const total = round(demand * (1 + params.singleRunBuffer));
    return { runCount: 1, bufferedTotal: total, runs: [{ runIndex: 1, portions: total }] };
  }
  const total = round(demand * (1 + params.multiRunBuffer));
  const run1 = round(total * params.firstRunPct);
  const run2 = Math.max(0, total - run1);
  return {
    runCount: 2,
    bufferedTotal: total,
    runs: [{ runIndex: 1, portions: run1 }, { runIndex: 2, portions: run2 }],
  };
}

function mealRowFromWeekRecipe(wr: WeekRecipe, recipe: DataBundle["recipes"][string] | undefined, params: PlatingParams): PlatingMealPlan {
  const benl = Math.round(wr.verdenVolume.BENL || 0);
  const nord = Math.round(wr.verdenVolume.DKSE || 0);
  const de = Math.round(wr.verdenVolume.DE || 0);
  const totalDemand = benl + nord + de;
  const split = splitMealIntoRuns(totalDemand, params);

  const md = recipe ? Object.values(recipe.markets)[0] : undefined;
  const allergens = md?.allergens || "";
  const subCount = md?.subRecipes?.length ?? null;
  const stations: string[] = [];
  // Station-X-Markierungen kennt die App nicht direkt — grob aus Cook-Methoden ableiten.
  const methods = (md?.subRecipes ?? []).map(s => s.category.toUpperCase()).join(" ");
  for (const key of STATION_KEYS) {
    if (key === "Oven" && /OVEN|OFEN|ROAST/.test(methods)) stations.push(key);
    else if (key === "Braiser" && /BRAIS|SCHMOR/.test(methods)) stations.push(key);
    else if (key === "Grill" && /GRILL/.test(methods)) stations.push(key);
  }

  return {
    code: wr.code,
    name: recipe?.baseName || wr.recipeName,
    preference: wr.preference,
    demand: { benl, nord, de },
    totalDemand,
    bufferedTotal: split.bufferedTotal,
    runCount: split.runCount,
    runs: split.runs.map(r => ({ ...r, day: null })),
    allergens,
    seafood: SEAFOOD_RE.test(`${wr.recipeName} ${allergens}`),
    stations,
    complexity: subCount,
  };
}

/** Baut den Wochenplan-Rohbau (alle Meals der KW, Runs, noch ohne Tag). */
export function buildPlatingSkeleton(data: DataBundle, week: string, opts?: { firstRunPct?: number }): PlatingWeekPlan {
  const firstRunPct = opts?.firstRunPct ?? firstRunPctForWeek(week);
  const params: PlatingParams = { ...DEFAULT_PLATING_PARAMS, firstRunPct };
  const byCode = data.recipes ?? {};
  const meals = data.weekRecipes
    .filter(wr => wr.hfWeek === week && (wr.verdenVolume.BENL + wr.verdenVolume.DKSE + wr.verdenVolume.DE) > 0)
    .map(wr => mealRowFromWeekRecipe(wr, byCode[wr.code], params))
    .sort((a, b) => b.totalDemand - a.totalDemand);

  const now = new Date().toISOString();
  return {
    week, firstRunPct, generatedAt: now, updatedAt: now,
    meals, dayCapacity: { ...DEFAULT_DAY_CAPACITY }, source: "generated",
  };
}

// ── Tag-Zuweisung ────────────────────────────────────────────────────────────

const RUN1_DAYS: PlatingDay[] = ["Di", "Mi", "Do"];          // Hauptlauf, 3 Linien
const RUN1_DAYS_SEAFOOD: PlatingDay[] = ["Mi", "Do"];        // Seafood frühestens Mi
const REFIRE_GAP = 2;                                         // Run 2 ~2 Tage nach Run 1

function dayCapacityPortions(cap: PlatingDayCapacity | undefined): number {
  if (!cap || cap.lines <= 0) return 0;
  // grobe Rate: ~900 Portionen / Linie / Stunde  (Sheet „per hr/per line" schwankt 500–1150)
  return cap.lines * cap.hours * 900;
}

/** Verteilt die Runs auf Tage — greedy, kapazitäts- und regelbewusst. */
export function assignRunsToDays(plan: PlatingWeekPlan): PlatingWeekPlan {
  const load: Record<PlatingDay, number> = { Mo: 0, Di: 0, Mi: 0, Do: 0, Fr: 0, Sa: 0, So: 0 };
  const capFor = (d: PlatingDay) => dayCapacityPortions(plan.dayCapacity[d]);

  // größte Meals zuerst
  const meals = [...plan.meals].sort((a, b) => b.totalDemand - a.totalDemand);

  for (const meal of meals) {
    const run1Days = meal.seafood ? RUN1_DAYS_SEAFOOD : RUN1_DAYS;

    // Run 1: frühester erlaubter Tag mit der meisten freien Kapazität, spätestens Do (CPT)
    let bestDay: PlatingDay = run1Days[0];
    let bestFree = -Infinity;
    for (const d of run1Days) {
      const free = capFor(d) - load[d];
      if (free > bestFree) { bestFree = free; bestDay = d; }
    }
    const run1 = meal.runs[0];
    if (run1) { run1.day = bestDay; load[bestDay] += run1.portions; }

    // Run 2 (Refire): ~2 Tage später, Fr/Sa bevorzugt
    if (meal.runs[1]) {
      const startIdx = PLATING_DAYS.indexOf(bestDay);
      const candidates: PlatingDay[] = [];
      for (let g = REFIRE_GAP; g <= 4; g++) {
        const d = PLATING_DAYS[startIdx + g];
        if (d && capFor(d) > 0) candidates.push(d);
      }
      if (!candidates.length) candidates.push("Fr", "Sa");
      let rd: PlatingDay = candidates[0];
      let rFree = -Infinity;
      for (const d of candidates) {
        const free = capFor(d) - load[d];
        if (free > rFree) { rFree = free; rd = d; }
      }
      meal.runs[1].day = rd;
      load[rd] += meal.runs[1].portions;
    }
  }

  return { ...plan, meals, updatedAt: new Date().toISOString(), source: "generated" };
}

export function generatePlatingPlan(data: DataBundle, week: string, opts?: { firstRunPct?: number }): PlatingWeekPlan {
  return assignRunsToDays(buildPlatingSkeleton(data, week, opts));
}

// ── Auswertung: Tages-Auslastung ─────────────────────────────────────────────

export interface PlatingDayLoad {
  day: PlatingDay;
  meals: number;
  portions: number;
  lines: number;
  hours: number;
  perHourPerLine: number;
  neededHours: number;
  availableHours: number;
  overCapacity: boolean;
}

export function computeDayLoads(plan: PlatingWeekPlan): PlatingDayLoad[] {
  return PLATING_DAYS.map(day => {
    const cap = plan.dayCapacity[day];
    let portions = 0;
    let meals = 0;
    for (const m of plan.meals) {
      for (const r of m.runs) {
        if (r.day === day && r.portions > 0) { portions += r.portions; meals++; }
      }
    }
    const lines = cap?.lines ?? 0;
    const hours = cap?.hours ?? 0;
    const perHourPerLine = lines > 0 && hours > 0 ? portions / (lines * hours) : 0;
    const neededHours = lines > 0 ? portions / (lines * 900) : (portions > 0 ? Infinity : 0);
    return {
      day, meals, portions, lines, hours,
      perHourPerLine: Math.round(perHourPerLine),
      neededHours: Math.round(neededHours * 10) / 10,
      availableHours: hours,
      overCapacity: neededHours > hours + 0.01,
    };
  });
}

/** Kurztext-Zusammenfassung für den KI-Kontext / Tool-Ausgabe. */
export function summarizePlatingPlan(plan: PlatingWeekPlan): string {
  const loads = computeDayLoads(plan);
  const lines: string[] = [];
  lines.push(`Plating-Plan ${plan.week} · First Run ${Math.round(plan.firstRunPct * 100)}% · ${plan.meals.length} Meals · Stand ${plan.source}`);
  const unassigned = plan.meals.filter(m => m.runs.some(r => !r.day && r.portions > 0));
  if (unassigned.length) lines.push(`Ungeplant: ${unassigned.map(m => m.code).join(", ")}`);
  lines.push("Tageslast:");
  for (const l of loads) {
    if (l.lines === 0 && l.portions === 0) continue;
    lines.push(`  ${l.day}: ${fmtNum(l.portions)} P · ${l.meals} Runs · ${l.lines} Linien/${l.hours}h · ~${fmtNum(l.perHourPerLine)}/h/Linie${l.overCapacity ? " ⚠ ÜBER KAPAZITÄT" : ""}`);
  }
  lines.push("Meals:");
  for (const m of plan.meals.slice(0, 60)) {
    const runs = m.runs.map(r => `${r.day ?? "?"}:${fmtNum(r.portions)}`).join(" + ");
    lines.push(`  ${m.code} ${m.name} · ${m.preference}${m.seafood ? " · SEAFOOD" : ""} · Demand ${fmtNum(m.totalDemand)} → ${runs}`);
  }
  return lines.join("\n");
}
