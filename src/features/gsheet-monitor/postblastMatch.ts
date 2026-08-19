// Postblast Live Matching — verknüpft GSheet-Wiegungen mit geplanten Work Orders.
import type { PostblastData, PostblastEntry } from "./gsheetTypes";
import type { ProductionPlan } from "../../core/types";

export interface WoMatchedStatus {
  workOrder: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  plannedKg: number;
  actualKg: number;
  progressPct: number;
  deltaKg: number;
  isComplete: boolean;
  isCritical: boolean;
  run: number;
  weighings: PostblastEntry[];
  lastWeighing: string | null;
}

export interface MealProgress {
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  workOrders: WoMatchedStatus[];
  totalPlannedKg: number;
  totalActualKg: number;
  progressPct: number;
  completedWOs: number;
  totalWOs: number;
  criticalWOs: WoMatchedStatus[];
}

export interface BackfillNeed {
  workOrder: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  missingKg: number;
  missingPct: number;
  estimatedPortions: number;
  priority: "critical" | "behind" | "on-track";
}

export function matchPostblastToWorkOrders(
  postblast: PostblastData | null,
  productionPlan: ProductionPlan | undefined
): { matched: WoMatchedStatus[]; meals: MealProgress[]; backfill: BackfillNeed[] } {
  if (!productionPlan || !postblast) return { matched: [], meals: [], backfill: [] };

  const matched: WoMatchedStatus[] = [];

  for (const wo of productionPlan.rows) {
    const woNum = wo.workOrder;
    const weighings = postblast.byWorkOrder.get(woNum) ?? [];
    const actualKg = weighings.reduce((s, e) => s + e.rawWeightKg, 0);
    const plannedKg = wo.postKg || wo.kitchenKg || wo.stagingKg || 0;
    const progressPct = plannedKg > 0 ? (actualKg / plannedKg) * 100 : (actualKg > 0 ? 100 : 0);
    const deltaKg = actualKg - plannedKg;
    const isComplete = progressPct >= 95;
    const isCritical = plannedKg > 0 && progressPct < 30 && actualKg === 0;

    matched.push({
      workOrder: woNum,
      subRecipe: wo.subRecipe,
      recipeCode: wo.recipeCode,
      recipeName: wo.recipeName,
      plannedMeals: wo.plannedMeals,
      plannedKg,
      actualKg,
      progressPct: Math.min(progressPct, 100),
      deltaKg,
      isComplete,
      isCritical,
      run: wo.run ?? 1,
      weighings,
      lastWeighing: weighings.length > 0 ? weighings[weighings.length - 1].timestamp : null,
    });
  }

  // Gruppierung nach Meal (recipeCode)
  const mealMap = new Map<string, WoMatchedStatus[]>();
  for (const m of matched) {
    if (!mealMap.has(m.recipeCode)) mealMap.set(m.recipeCode, []);
    mealMap.get(m.recipeCode)!.push(m);
  }

  const meals: MealProgress[] = [];
  for (const [recipeCode, wos] of mealMap) {
    const totalPlannedKg = wos.reduce((s, w) => s + w.plannedKg, 0);
    const totalActualKg = wos.reduce((s, w) => s + w.actualKg, 0);
    meals.push({
      recipeCode,
      recipeName: wos[0].recipeName,
      plannedMeals: wos[0].plannedMeals,
      workOrders: wos,
      totalPlannedKg,
      totalActualKg,
      progressPct: totalPlannedKg > 0 ? Math.min((totalActualKg / totalPlannedKg) * 100, 100) : 0,
      completedWOs: wos.filter(w => w.isComplete).length,
      totalWOs: wos.length,
      criticalWOs: wos.filter(w => w.isCritical),
    });
  }
  meals.sort((a, b) => a.progressPct - b.progressPct);

  // Backfill-Berechnung: Was fehlt noch?
  const backfill: BackfillNeed[] = matched
    .filter(m => !m.isComplete && m.plannedKg > 0)
    .map(m => {
      const missingKg = Math.max(0, m.plannedKg - m.actualKg);
      const missingPct = m.plannedKg > 0 ? (missingKg / m.plannedKg) * 100 : 0;
      const portionsPerKg = m.plannedMeals > 0 && m.plannedKg > 0 ? m.plannedMeals / m.plannedKg : 0;
      return {
        workOrder: m.workOrder,
        subRecipe: m.subRecipe,
        recipeCode: m.recipeCode,
        recipeName: m.recipeName,
        missingKg,
        missingPct,
        estimatedPortions: Math.round(missingKg * portionsPerKg),
        priority: missingPct > 80 ? "critical" as const : missingPct > 40 ? "behind" as const : "on-track" as const,
      };
    })
    .filter(b => b.missingKg >= 0.5)
    .sort((a, b) => b.missingKg - a.missingKg);

  return { matched, meals, backfill };
}
