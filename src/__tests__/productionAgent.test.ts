import { describe, expect, it } from "vitest";
import { analyzeProduction } from "../features/gsheet-monitor/productionAgent";
import type { MealProgress, WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";
import type { PostblastData, PostblastEntry } from "../features/gsheet-monitor/gsheetTypes";

function weighing(hoursAgo: number, weightKg: number, workOrder: string, subRecipeName: string): PostblastEntry {
  const ts = new Date(Date.now() - hoursAgo * 3_600_000);
  return { timestamp: ts.toISOString(), date: ts.toISOString().slice(0, 10), workOrder, subRecipeName, weightKg };
}

function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "36-1", subRecipe: "Sauce", recipeCode: "FV0001A", recipeName: "Test Meal",
    plannedMeals: 100, plannedKg: 100, actualKg: 0, progressPct: 0, deltaKg: -100,
    isComplete: false, isCritical: false, hasPlan: true, isEstimated: false,
    preBlastKg: 0, shrinkKg: 0, shrinkPct: 0, awaitingPostBlast: false, preBlastLikelyDone: false,
    lastPreBlastWeighing: null, run: 1, weighings: [], lastWeighing: null,
    platingHoldingKg: 0, rtiStatus: null,
    ...overrides,
  };
}

function meal(workOrders: WoMatchedStatus[]): MealProgress {
  const totalPlannedKg = workOrders.reduce((s, w) => s + w.plannedKg, 0);
  const totalActualKg = workOrders.reduce((s, w) => s + w.actualKg, 0);
  return {
    recipeCode: workOrders[0].recipeCode, recipeName: workOrders[0].recipeName, plannedMeals: 100, workOrders,
    totalPlannedKg, totalActualKg,
    progressPct: totalPlannedKg > 0 ? (totalActualKg / totalPlannedKg) * 100 : 0,
    completedWOs: workOrders.filter(w => w.isComplete).length,
    totalWOs: workOrders.length,
    criticalWOs: workOrders.filter(w => w.isCritical),
  };
}

const emptyPostblast: PostblastData = {
  entries: [], byWorkOrder: new Map(), bySubRecipe: new Map(), totalWeightKg: 0, lastEntry: null, lastUpdated: Date.now(),
};

describe("analyzeProduction recommendations", () => {
  it("explains WHEN and WHY when it declares a meal almost done", () => {
    const done = wo({ workOrder: "36-1", plannedKg: 100, actualKg: 100, isComplete: true });
    const open = wo({
      workOrder: "36-2", plannedKg: 100, actualKg: 85,
      weighings: [weighing(1, 40, "36-2", "Sauce"), weighing(0, 45, "36-2", "Sauce")],
    });
    const m = meal([done, open]); // 185/200 = 92.5% -> qualifies as "fast fertig"

    const intelligence = analyzeProduction(emptyPostblast, [m], [], [done, open], undefined, 8);
    const rec = intelligence.recommendations.find(r => r.startsWith("Fast fertig:"));

    expect(rec).toBeDefined();
    expect(rec).toMatch(/voraussichtlich fertig ca\. \d{2}:\d{2} Uhr/);
    expect(rec).toContain("kg offen");
  });

  it("surfaces a sub-meal that is itself almost done even though its meal overall is not", () => {
    const slow = wo({ workOrder: "36-3", subRecipe: "Slow Sub", plannedKg: 100, actualKg: 5 });
    const fastSub = wo({
      workOrder: "36-4", subRecipe: "Fast Sub", plannedKg: 100, actualKg: 90, progressPct: 90,
      weighings: [weighing(1, 45, "36-4", "Fast Sub"), weighing(0, 45, "36-4", "Fast Sub")],
    });
    const m = meal([slow, fastSub]); // (5+90)/200 = 47.5% -> NOT "fast fertig" as a whole meal

    const intelligence = analyzeProduction(emptyPostblast, [m], [], [slow, fastSub], undefined, 8);

    expect(intelligence.recommendations.some(r => r.startsWith("Fast fertig:"))).toBe(false);
    const subRec = intelligence.recommendations.find(r => r.startsWith("Sub-Meal fast fertig:"));
    expect(subRec).toBeDefined();
    expect(subRec).toContain("Fast Sub");
    expect(subRec).toMatch(/voraussichtlich fertig ca\. \d{2}:\d{2} Uhr/);
  });
});
