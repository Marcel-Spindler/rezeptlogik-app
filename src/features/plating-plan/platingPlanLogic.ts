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

import type { DataBundle, RecipeProfile, WeekRecipe } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import {
  PLATING_DAYS, type PlatingDay, type PlatingDayCapacity, type PlatingMealPlan,
  type PlatingPlanParams, type PlatingRun, type PlatingWeekPlan,
} from "./platingPlanTypes";
import { describeDayPlan } from "./platingDayLogic";

/** Default-Stellschrauben ohne den KW-abhängigen First-Run-Anteil. */
export const DEFAULT_PLATING_PARAMS: Omit<PlatingPlanParams, "firstRunPct"> = {
  singleRunMaxDemand: 2250,
  singleRunBuffer: 0.10,
  multiRunBuffer: 0.05,
  platingRatePerLineHour: 900,
  changeoverEasyMin: 10,
  changeoverAllergenMin: 30,
};

/** Bekannte First-Run-% pro KW aus dem Sheet; sonst 70 %. */
export function firstRunPctForWeek(week: string): number {
  const m = /W(\d{1,2})$/.exec(week);
  const wn = m ? Number(m[1]) : 0;
  if (wn === 29 || wn === 30) return 0.62;
  if (wn === 31) return 0.66;
  return 0.70;
}

/** Vollständige Default-Params für eine KW (First Run % aus dem Sheet-Muster). */
export function buildDefaultParams(week: string): PlatingPlanParams {
  return { firstRunPct: firstRunPctForWeek(week), ...DEFAULT_PLATING_PARAMS };
}

function clampNum(n: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Merged einen (Teil-)Override auf die KW-Defaults und klemmt auf plausible Werte. */
export function resolvePlatingParams(week: string, override?: Partial<PlatingPlanParams>): PlatingPlanParams {
  const d = buildDefaultParams(week);
  const p = { ...d, ...(override ?? {}) };
  return {
    firstRunPct: clampNum(p.firstRunPct, 0.4, 0.95, d.firstRunPct),
    singleRunMaxDemand: Math.round(clampNum(p.singleRunMaxDemand, 0, 1e6, d.singleRunMaxDemand)),
    singleRunBuffer: clampNum(p.singleRunBuffer, 0, 0.5, d.singleRunBuffer),
    multiRunBuffer: clampNum(p.multiRunBuffer, 0, 0.5, d.multiRunBuffer),
    platingRatePerLineHour: Math.round(clampNum(p.platingRatePerLineHour, 1, 1e5, d.platingRatePerLineHour)),
    changeoverEasyMin: Math.round(clampNum(p.changeoverEasyMin, 0, 120, d.changeoverEasyMin)),
    changeoverAllergenMin: Math.round(clampNum(p.changeoverAllergenMin, 0, 240, d.changeoverAllergenMin)),
  };
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

const SEAFOOD_RE = /\b(fish|salmon|shrimp|barramundi|crustacean|prawn|seafood|tuna|molluscs|shellfish)\b/i;
const STATION_KEYS = ["Grill", "Cup", "Butter", "Oven", "Braiser", "Slice"] as const;

/** Kochstationen aus dem Recipe-Profil auf die 6 Sheet-Spalten mappen. */
function stationsFromProfile(cookStations: string[]): string[] {
  const j = cookStations.join(" ").toUpperCase();
  const out: string[] = [];
  if (/GRILL/.test(j)) out.push("Grill");
  if (/CUP/.test(j)) out.push("Cup");
  if (/BUTTER|SCOOPER/.test(j)) out.push("Butter");
  if (/OVEN/.test(j)) out.push("Oven");
  if (/BRAIS/.test(j)) out.push("Braiser");
  if (/SLIC/.test(j)) out.push("Slice");
  return out;
}

/** Fallback-Komplexität, wenn kein Recipe-Profil vorliegt: grobe Skala aus der
 *  Sub-Anzahl (Median-Rezept ~5 Subs → ~1.0), geklemmt auf die Sheet-Spanne. */
function fallbackComplexity(subCount: number | null): number | null {
  if (subCount == null || subCount <= 0) return null;
  return Math.round(Math.min(1.7, Math.max(0.4, subCount / 5)) * 100) / 100;
}

function round(n: number): number {
  return Math.max(0, Math.round(n));
}

/** Demand → Runs (ohne Tag). */
export function splitMealIntoRuns(demand: number, params: PlatingPlanParams): {
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

function mealRowFromWeekRecipe(
  wr: WeekRecipe,
  recipe: DataBundle["recipes"][string] | undefined,
  profile: RecipeProfile | undefined,
  params: PlatingPlanParams,
): PlatingMealPlan {
  const benl = Math.round(wr.verdenVolume.BENL || 0);
  const nord = Math.round(wr.verdenVolume.DKSE || 0);
  const de = Math.round(wr.verdenVolume.DE || 0);
  const totalDemand = benl + nord + de;
  const split = splitMealIntoRuns(totalDemand, params);

  const md = recipe ? Object.values(recipe.markets)[0] : undefined;
  const allergens = profile?.allergens || md?.allergens || "";
  const subCount = md?.subRecipes?.length ?? (profile?.numSubs ?? null);

  let stations: string[];
  if (profile?.cookStations?.length) {
    stations = stationsFromProfile(profile.cookStations);
  } else {
    // ohne Recipe-Profil: grob aus den Cook-Methoden der Sub-Rezepte ableiten
    stations = [];
    const methods = (md?.subRecipes ?? []).map(s => s.category.toUpperCase()).join(" ");
    for (const key of STATION_KEYS) {
      if (key === "Oven" && /OVEN|OFEN|ROAST/.test(methods)) stations.push(key);
      else if (key === "Braiser" && /BRAIS|SCHMOR/.test(methods)) stations.push(key);
      else if (key === "Grill" && /GRILL/.test(methods)) stations.push(key);
    }
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
    complexity: profile?.complexityCx ?? fallbackComplexity(subCount),
    subMealCount: Math.max(0, subCount ?? 0),
    ...(profile ? { activeCookMin: profile.activeCookMin, passiveHoldMin: profile.passiveHoldMin } : {}),
  };
}

/** Baut den Wochenplan-Rohbau (alle Meals der KW, Runs, noch ohne Tag). */
export function buildPlatingSkeleton(
  data: DataBundle, week: string, paramsOverride?: Partial<PlatingPlanParams>,
): PlatingWeekPlan {
  const params = resolvePlatingParams(week, paramsOverride);
  const byCode = data.recipes ?? {};
  const profiles = data.recipeProfiles ?? {};
  const meals = data.weekRecipes
    .filter(wr => wr.hfWeek === week && (wr.verdenVolume.BENL + wr.verdenVolume.DKSE + wr.verdenVolume.DE) > 0)
    .map(wr => mealRowFromWeekRecipe(wr, byCode[wr.code], profiles[wr.code], params))
    .sort((a, b) => b.totalDemand - a.totalDemand);

  const now = new Date().toISOString();
  return {
    week, params, generatedAt: now, updatedAt: now,
    meals, dayCapacity: { ...DEFAULT_DAY_CAPACITY }, source: "generated",
  };
}

// ── Tag-Zuweisung ────────────────────────────────────────────────────────────

const RUN1_DAYS: PlatingDay[] = ["Di", "Mi", "Do"];          // Hauptlauf, 3 Linien
const RUN1_DAYS_SIMPLE: PlatingDay[] = ["Mo", "Di", "Mi", "Do"]; // einfache Meals dürfen Montag (Spätschicht-Fill-up)
const RUN1_DAYS_SEAFOOD: PlatingDay[] = ["Do", "Mi"];        // Seafood so spät wie möglich → spätester Tag zuerst
const REFIRE_DAYS: PlatingDay[] = ["Do", "Fr", "Sa"];        // 2. Run (Refire), Fr/Sa bevorzugt
const SEAFOOD_EARLINESS_PENALTY = 0.35;                      // drückt Seafood-Run-1 auf den spätest möglichen Tag
const SEAFOOD_ONE_DAY_MAX_UTIL = 1.15;                       // Seafood möglichst an EINEM Tag, solange der Tag ≤ dieser Auslastung bleibt
const REFIRE_BACKFILL_BONUS = 0.10;                          // Fr/Sa als Refire-Tag leicht bevorzugt

// Complexity Score (cx, Median-Meal = 1.0): komplexe Meals → 1. Run früh (Zeit für
// Nacharbeit + CPT-Deadline Do), einfache Meals flexibel (Auslastung entscheidet,
// Montag erlaubt). Siehe „Rules of 3 weeks planning".
const COMPLEX_CX = 1.15;
const SIMPLE_CX = 0.80;
const COMPLEX_EARLINESS_PENALTY = 0.20;                      // je späterer Tag, desto schlechter für komplexe Meals

function dayCapacityPortions(cap: PlatingDayCapacity | undefined, ratePerLineHour: number): number {
  if (!cap || cap.lines <= 0 || cap.hours <= 0) return 0;
  return cap.lines * cap.hours * ratePerLineHour;
}

/** Verteilt die Runs auf Tage — greedy, kapazitäts- und regelbewusst:
 *  - größte Meals zuerst
 *  - Tag mit der NIEDRIGSTEN resultierenden Auslastung (nicht „meiste freie Menge")
 *    → keine Dienstag-Häufung, Meals über die Woche balanciert
 *  - Seafood: 1. Run so spät wie möglich (Do), Bedarf möglichst an EINEM Tag (Allergen)
 *  - Complexity: komplexe Meals → 1. Run früh (Di), einfache → flexibel (Montag erlaubt)
 *  - 2. Run (Refire): nach dem 1. Run, Fr/Sa bevorzugt
 */
export function assignRunsToDays(plan: PlatingWeekPlan): PlatingWeekPlan {
  const rate = plan.params.platingRatePerLineHour || 900;
  const cap = {} as Record<PlatingDay, number>;
  const load: Record<PlatingDay, number> = { Mo: 0, Di: 0, Mi: 0, Do: 0, Fr: 0, Sa: 0, So: 0 };
  for (const d of PLATING_DAYS) cap[d] = dayCapacityPortions(plan.dayCapacity[d], rate);
  const util = (d: PlatingDay, add: number) => (cap[d] > 0 ? (load[d] + add) / cap[d] : Infinity);

  // größte Meals zuerst
  const meals = [...plan.meals].sort((a, b) => b.totalDemand - a.totalDemand);

  for (const meal of meals) {
    const run1 = meal.runs[0];
    if (!run1 || run1.portions <= 0) continue;
    const run2 = meal.runs[1] && meal.runs[1].portions > 0 ? meal.runs[1] : null;

    // ── Run 1: niedrigste resultierende Auslastung; Seafood Richtung Do, komplexe früh ──
    const cx = meal.complexity ?? 1;
    const isComplex = cx >= COMPLEX_CX;
    const isSimple = cx <= SIMPLE_CX;
    const days1 = meal.seafood ? RUN1_DAYS_SEAFOOD : (isSimple ? RUN1_DAYS_SIMPLE : RUN1_DAYS);
    let bestDay: PlatingDay = RUN1_DAYS[0];
    let bestScore = Infinity;
    days1.forEach((d, i) => {
      if (cap[d] <= 0) return;
      let score = util(d, run1.portions);
      if (meal.seafood) score += i * SEAFOOD_EARLINESS_PENALTY;
      else if (isComplex) score += i * COMPLEX_EARLINESS_PENALTY; // frühe Tage bevorzugt
      // isSimple: reine Auslastung entscheidet (darf auch Montag)
      if (score < bestScore) { bestScore = score; bestDay = d; }
    });
    if (bestScore === Infinity) { // kein Tag mit Kapazität in days1 → Fallback
      for (const d of RUN1_DAYS) if (cap[d] > 0) { bestDay = d; break; }
    }
    run1.day = bestDay;
    load[bestDay] += run1.portions;

    if (!run2) continue;

    // ── Seafood: 2. Run möglichst auf denselben Tag (alles an 1 Tag, Allergen) ──
    if (meal.seafood && cap[bestDay] > 0 && util(bestDay, run2.portions) <= SEAFOOD_ONE_DAY_MAX_UTIL) {
      run1.portions += run2.portions;
      load[bestDay] += run2.portions;
      run2.portions = 0;
      run2.day = null;
      meal.runCount = 1;
      continue;
    }

    // ── Refire: nach dem 1. Run, Fr/Sa bevorzugt, niedrigste resultierende Auslastung ──
    const startIdx = PLATING_DAYS.indexOf(bestDay);
    let candidates = REFIRE_DAYS.filter(d => PLATING_DAYS.indexOf(d) > startIdx && cap[d] > 0);
    if (!candidates.length) candidates = REFIRE_DAYS.filter(d => cap[d] > 0);
    if (!candidates.length) candidates = [bestDay];

    let rDay: PlatingDay = candidates[0];
    let rScore = Infinity;
    for (const d of candidates) {
      const backfill = d === "Fr" || d === "Sa" ? REFIRE_BACKFILL_BONUS : 0;
      const score = util(d, run2.portions) - backfill;
      if (score < rScore) { rScore = score; rDay = d; }
    }
    run2.day = rDay;
    load[rDay] += run2.portions;
  }

  return { ...plan, meals, updatedAt: new Date().toISOString(), source: "generated" };
}

export function generatePlatingPlan(
  data: DataBundle, week: string,
  paramsOverride?: Partial<PlatingPlanParams>,
  dayCapacityOverride?: Partial<Record<PlatingDay, PlatingDayCapacity>>,
): PlatingWeekPlan {
  const skeleton = buildPlatingSkeleton(data, week, paramsOverride);
  if (dayCapacityOverride && Object.keys(dayCapacityOverride).length) {
    skeleton.dayCapacity = { ...DEFAULT_DAY_CAPACITY, ...dayCapacityOverride };
  }
  return assignRunsToDays(skeleton);
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
  const rate = plan.params.platingRatePerLineHour || 900;
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
    const neededHours = lines > 0 ? portions / (lines * rate) : (portions > 0 ? Infinity : 0);
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
  const p = plan.params;
  const lines: string[] = [];
  lines.push(`Plating-Plan ${plan.week} · ${plan.meals.length} Meals · Stand ${plan.source}`);
  lines.push(`Params: First Run ${Math.round(p.firstRunPct * 100)}% · Puffer 1R +${Math.round(p.singleRunBuffer * 100)}% / 2R +${Math.round(p.multiRunBuffer * 100)}% · Schwelle 1→2 Runs ${fmtNum(p.singleRunMaxDemand)} · Rate ${fmtNum(p.platingRatePerLineHour)}/Linie/h`);
  const unassigned = plan.meals.filter(m => m.runs.some(r => !r.day && r.portions > 0));
  if (unassigned.length) lines.push(`Ungeplant: ${unassigned.map(m => m.code).join(", ")}`);
  lines.push("Tageslast:");
  for (const l of loads) {
    if (l.lines === 0 && l.portions === 0) continue;
    lines.push(`  ${l.day}: ${fmtNum(l.portions)} P · ${l.meals} Runs · ${l.lines} Linien/${l.hours}h · ~${fmtNum(l.perHourPerLine)}/h/Linie${l.overCapacity ? " ⚠ ÜBER KAPAZITÄT" : ""}`);
  }
  lines.push("Meals (cx = Complexity Score, Median-Meal = 1.0):");
  for (const m of plan.meals.slice(0, 60)) {
    const runs = m.runs.filter(r => r.portions > 0).map(r => `${r.day ?? "?"}:${fmtNum(r.portions)}`).join(" + ");
    const cx = m.complexity != null ? ` · cx ${m.complexity.toFixed(2)}${m.complexity >= 1.15 ? " KOMPLEX" : m.complexity <= 0.80 ? " einfach" : ""}` : "";
    lines.push(`  ${m.code} ${m.name} · ${m.preference}${m.seafood ? " · SEAFOOD" : ""}${cx} · Demand ${fmtNum(m.totalDemand)} → ${runs}`);
  }
  const daily = plan.dailyPlans ?? {};
  const days = PLATING_DAYS.filter(d => daily[d]);
  if (days.length) {
    lines.push("Tägliche Linienpläne (Phase 2):");
    for (const d of days) lines.push(describeDayPlan(daily[d]!));
  }
  return lines.join("\n");
}
