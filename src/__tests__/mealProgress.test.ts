import { describe, expect, it } from "vitest";
import { honestMealProgress, grossPlateable, mealReadiness } from "../features/gsheet-monitor/mealProgress";
import type { MealProgress, WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";

function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "38-1", subRecipe: "Sauce", recipeCode: "FV0001A", recipeName: "Test",
    plannedMeals: 1000, plannedKg: 100, actualKg: 0, progressPct: 0, deltaKg: -100,
    isComplete: false, isCritical: false, hasPlan: true, isEstimated: false,
    preBlastKg: 0, shrinkKg: 0, shrinkPct: 0, awaitingPostBlast: false, preBlastLikelyDone: false,
    lastPreBlastWeighing: null, run: 1, weighings: [], lastWeighing: null,
    platingHoldingKg: 0, rtiStatus: null,
    ...overrides,
  };
}

function meal(workOrders: WoMatchedStatus[], over: Partial<MealProgress> = {}): MealProgress {
  const planned = workOrders.filter(w => w.plannedKg > 0);
  const totalPlannedKg = planned.reduce((s, w) => s + w.plannedKg, 0);
  const totalActualKg = planned.reduce((s, w) => s + w.actualKg, 0);
  return {
    recipeCode: "FV0001A", recipeName: "Test", plannedMeals: 1000, workOrders,
    totalPlannedKg, totalActualKg,
    progressPct: totalPlannedKg > 0 ? Math.min((totalActualKg / totalPlannedKg) * 100, 100) : 0,
    completedWOs: workOrders.filter(w => w.isComplete).length,
    totalWOs: workOrders.length,
    criticalWOs: workOrders.filter(w => w.isCritical),
    ...over,
  };
}

describe("honestMealProgress", () => {
  it("takes the weakest sub-recipe, not the kg average", () => {
    // Sauce overproduced (150/100), Rice at 60/100 → aggregate = 105% (capped 100),
    // but honest = 60%.
    const m = meal([
      wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 150 }),
      wo({ subRecipe: "Rice", plannedKg: 100, actualKg: 60 }),
    ]);
    expect(m.progressPct).toBe(100);
    expect(honestMealProgress(m).pct).toBeCloseTo(60, 5);
    expect(honestMealProgress(m).bottleneckSub).toBe("Rice");
  });

  it("drops to 0 % when a whole sub-recipe is missing", () => {
    const m = meal([
      wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, isComplete: true }),
      wo({ subRecipe: "Zucchini", plannedKg: 100, actualKg: 0, isCritical: true }),
    ]);
    expect(honestMealProgress(m).pct).toBe(0);
  });

  it("falls back to meal.progressPct when no sub has a plan", () => {
    const m = meal([wo({ plannedKg: 0, actualKg: 50, hasPlan: false })], { progressPct: 42 });
    expect(honestMealProgress(m).pct).toBe(42);
  });
});

describe("mealReadiness", () => {
  it("marks a fully-plaited meal finished and shows 100 %", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, isComplete: true })], { completedWOs: 1, totalWOs: 1 });
    const r = mealReadiness(m, null, new Map([["0001", 5000]])); // way more plaited than producible
    expect(r.finished).toBe(true);
    expect(r.displayPct).toBe(100);
  });

  it("caps at 99 % while WOs are still open, and 0 % when a sub is missing", () => {
    const m = meal([
      wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, isComplete: true }),
      wo({ subRecipe: "Zucchini", plannedKg: 100, actualKg: 0, isCritical: true }),
    ]);
    const r = mealReadiness(m, null, undefined);
    expect(r.finished).toBe(false);
    expect(r.displayPct).toBe(0);
  });
});

describe("grossPlateable", () => {
  it("is the bottleneck sub via plan ratio when no gram weights are given", () => {
    const m = meal([
      wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100 }),
      wo({ subRecipe: "Rice", plannedKg: 100, actualKg: 50 }),
    ]);
    // Rice at 50 % → floor(0.5 * 1000) = 500
    expect(grossPlateable(m, null)?.meals).toBe(500);
  });
});
