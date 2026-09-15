// Konvertiert PlanningSheetData (gviz-Fetch aus dem Planning-GSheet) in einen
// PlatingWeekPlan. Grundlage: PlanningRow.days = Portionen je Wochentag je Meal.
// Jeder Tag mit Menge > 0 wird zu einem PlatingRun. Demand-Aufschlüsselung und
// Allergen/Seafood/Complexity kommen aus DataBundle (weekRecipes + recipeProfiles).

import type { DataBundle } from "../../core/types";
import type { PlanningSheetData, SheetDay } from "../../lib/planningSheetApi";
import { DEFAULT_DAY_CAPACITY, buildDefaultParams, resolvePlatingParams } from "./platingPlanLogic";
import type { PlatingDay, PlatingMealPlan, PlatingPlanParams, PlatingWeekPlan } from "./platingPlanTypes";

const DAY_MAP: Partial<Record<SheetDay, PlatingDay>> = {
  Monday: "Mo", Tuesday: "Di", Wednesday: "Mi",
  Thursday: "Do", Friday: "Fr", Saturday: "Sa", Sunday: "So",
};

const DAY_ORDER: PlatingDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const SEAFOOD_RE = /\b(fish|salmon|shrimp|barramundi|crustacean|prawn|seafood|tuna|mollusc|shellfish)\b/i;

export function importSheetIntoPlan(
  sheetData: PlanningSheetData,
  data: DataBundle,
  existingPlan: PlatingWeekPlan | null,
  paramsOverride?: Partial<PlatingPlanParams>,
): PlatingWeekPlan {
  const week = sheetData.week;
  const params = resolvePlatingParams(week, {
    ...(existingPlan?.params ?? buildDefaultParams(week)),
    ...(paramsOverride ?? {}),
  });

  const recipeByCode = data.recipes ?? {};
  const profileByCode = data.recipeProfiles ?? {};
  const weekRecipeByCode = new Map(
    (data.weekRecipes ?? [])
      .filter(wr => wr.hfWeek === week)
      .map(wr => [wr.code, wr]),
  );

  const existingByCode = new Map((existingPlan?.meals ?? []).map(m => [m.code, m]));

  const meals: PlatingMealPlan[] = [];

  for (const row of sheetData.rows) {
    const dayEntries = (Object.entries(row.days) as [SheetDay, number][])
      .map(([sd, portions]) => ({ day: DAY_MAP[sd], portions: Math.round(portions ?? 0) }))
      .filter((e): e is { day: PlatingDay; portions: number } => !!e.day && e.portions > 0)
      .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day));

    if (dayEntries.length === 0) continue;

    const existing = existingByCode.get(row.code);
    const wr = weekRecipeByCode.get(row.code);
    const recipe = recipeByCode[row.code];
    const profile = profileByCode[row.code];

    const md = recipe ? Object.values(recipe.markets)[0] : undefined;

    // Demand-Aufschlüsselung
    const benl = Math.round(wr?.verdenVolume?.BENL ?? 0);
    const nord = Math.round(wr?.verdenVolume?.DKSE ?? 0);
    const de = Math.round(wr?.verdenVolume?.DE ?? 0);
    const totalDemand = benl + nord + de || Math.round(row.total) || 0;

    // Gepufferte Summe aus dem Sheet (Total+Buffer), Fallback: Summe der Runs
    const bufferedTotal = row.totalBuffer > 0
      ? Math.round(row.totalBuffer)
      : dayEntries.reduce((s, e) => s + e.portions, 0);

    const runCount = dayEntries.length;
    const runs = dayEntries.map((e, i) => ({
      runIndex: i + 1,
      portions: e.portions,
      day: e.day,
    }));

    const allergens = profile?.allergens ?? md?.allergens ?? existing?.allergens ?? "";
    const seafoodFromName = SEAFOOD_RE.test(`${row.name} ${allergens}`);
    const seafood = existing?.seafood ?? seafoodFromName;

    const subCount = md?.subRecipes?.length ?? profile?.numSubs ?? null;
    const complexity = profile?.complexityCx ?? existing?.complexity ?? null;

    const stationList = (Object.entries(row.stations) as [string, boolean | undefined][])
      .filter(([, v]) => v)
      .map(([k]) => k);

    meals.push({
      code: row.code,
      name: row.name || recipe?.baseName || row.code,
      preference: row.preference || existing?.preference || "",
      demand: { benl, nord, de },
      totalDemand,
      bufferedTotal,
      runCount,
      runs,
      allergens,
      seafood,
      stations: stationList.length ? stationList : (existing?.stations ?? []),
      complexity,
      subMealCount: Math.max(0, subCount ?? existing?.subMealCount ?? 0),
      ...(profile ? { activeCookMin: profile.activeCookMin, passiveHoldMin: profile.passiveHoldMin } : {}),
      ...(existing?.note ? { note: existing.note } : {}),
    });
  }

  const now = new Date().toISOString();
  return {
    week,
    params,
    generatedAt: now,
    updatedAt: now,
    meals,
    dayCapacity: existingPlan?.dayCapacity ?? { ...DEFAULT_DAY_CAPACITY },
    source: "edited",
  };
}
