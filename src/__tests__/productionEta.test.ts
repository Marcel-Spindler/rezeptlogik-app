import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateMealEta, estimateWoEta } from "../features/gsheet-monitor/productionEta";
import type { MealProgress, WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";
import type { PostblastEntry } from "../features/gsheet-monitor/gsheetTypes";

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
const TODAY = "2026-08-25";

function entry(hoursAgo: number, weightKg: number, workOrder: string, subRecipeName: string): PostblastEntry {
  const ts = new Date(NOW - hoursAgo * 3_600_000);
  return { timestamp: ts.toISOString(), date: TODAY, workOrder, subRecipeName, weightKg };
}

function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "36-1", subRecipe: "Sauce", recipeCode: "FV0001A", recipeName: "Test Meal",
    plannedMeals: 100, plannedKg: 300, actualKg: 0, progressPct: 0, deltaKg: -300,
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
    recipeCode: "FV0001A", recipeName: "Test Meal", plannedMeals: 100, workOrders,
    totalPlannedKg, totalActualKg,
    progressPct: totalPlannedKg > 0 ? (totalActualKg / totalPlannedKg) * 100 : 0,
    completedWOs: workOrders.filter(w => w.isComplete).length,
    totalWOs: workOrders.length,
    criticalWOs: workOrders.filter(w => w.isCritical),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("estimateWoEta", () => {
  it("uses the WO's own today weighings when there are at least two", () => {
    const weighings = [entry(2, 40, "36-1", "Sauce"), entry(0, 60, "36-1", "Sauce")];
    const target = wo({ workOrder: "36-1", actualKg: 100, plannedKg: 300, weighings });
    const eta = estimateWoEta(target, [target]);
    expect(eta.paceSource).toBe("eigene-wiegung");
    expect(eta.paceKgPerHour).toBeCloseTo(50, 5); // 100 kg over 2h
    expect(eta.remainingKg).toBeCloseTo(200, 5);
    expect(eta.etaHours).toBeCloseTo(4, 5); // 200 kg / 50 kg/h
  });

  it("falls back to the average pace of other WOs of the same sub-recipe when this WO has no own data yet", () => {
    const peerWeighings = [entry(3, 30, "36-2", "Sauce"), entry(1, 90, "36-2", "Sauce")]; // 120 kg over 2h = 60 kg/h
    const peer = wo({ workOrder: "36-2", subRecipe: "Sauce", actualKg: 120, plannedKg: 120, isComplete: true, weighings: peerWeighings });
    const target = wo({ workOrder: "36-1", subRecipe: "Sauce", plannedKg: 300, actualKg: 0, weighings: [] });
    const eta = estimateWoEta(target, [target, peer]);
    expect(eta.paceSource).toBe("sub-rezept-schnitt");
    expect(eta.paceKgPerHour).toBeCloseTo(60, 5);
    expect(eta.etaHours).toBeCloseTo(5, 5); // 300 kg / 60 kg/h
  });

  it("gives no ETA when neither own weighings nor peer WOs of the same sub-recipe exist", () => {
    const target = wo({ workOrder: "36-1", subRecipe: "Mystery Sub", plannedKg: 300, actualKg: 0, weighings: [] });
    const eta = estimateWoEta(target, [target]);
    expect(eta.paceSource).toBe("keine");
    expect(eta.etaHours).toBeNull();
    expect(eta.etaTime).toBeNull();
  });

  it("treats a WO that already reached its plan as immediately done", () => {
    const target = wo({ plannedKg: 100, actualKg: 100 });
    const eta = estimateWoEta(target, [target]);
    expect(eta.etaHours).toBe(0);
    expect(eta.remainingKg).toBe(0);
  });
});

describe("estimateMealEta", () => {
  it("uses the slowest predictable WO as the limiting one for the meal ETA", () => {
    const fast = wo({
      workOrder: "36-1", subRecipe: "Fast Sub", plannedKg: 150, actualKg: 100,
      weighings: [entry(1, 50, "36-1", "Fast Sub"), entry(0, 50, "36-1", "Fast Sub")], // 100kg/h -> 0.5h remaining
    });
    const slow = wo({
      workOrder: "36-2", subRecipe: "Slow Sub", plannedKg: 100, actualKg: 20,
      weighings: [entry(2, 10, "36-2", "Slow Sub"), entry(0, 10, "36-2", "Slow Sub")], // 10kg/h -> 8h remaining
    });
    const blocked = wo({ workOrder: "36-3", subRecipe: "Mystery Sub", plannedKg: 50, actualKg: 0, weighings: [] });
    const m = meal([fast, slow, blocked]);

    const eta = estimateMealEta(m, [fast, slow, blocked]);
    expect(eta.limitingWo?.workOrder).toBe("36-2");
    expect(eta.etaHours).toBeCloseTo(8, 5);
    expect(eta.unpredictableWos.map(w => w.workOrder)).toEqual(["36-3"]);
  });

  it("reports the meal as already done once every WO with a plan is complete", () => {
    const done = wo({ workOrder: "36-1", plannedKg: 100, actualKg: 100, isComplete: true });
    const m = meal([done]);
    const eta = estimateMealEta(m, [done]);
    expect(eta.remainingKg).toBe(0);
    expect(eta.etaHours).toBe(0);
    expect(eta.limitingWo).toBeNull();
  });

  it("gives no meal ETA when none of its open WOs have any pace reference", () => {
    const blockedA = wo({ workOrder: "36-1", subRecipe: "Mystery A", plannedKg: 50, actualKg: 0, weighings: [] });
    const blockedB = wo({ workOrder: "36-2", subRecipe: "Mystery B", plannedKg: 50, actualKg: 0, weighings: [] });
    const m = meal([blockedA, blockedB]);
    const eta = estimateMealEta(m, [blockedA, blockedB]);
    expect(eta.etaHours).toBeNull();
    expect(eta.limitingWo).toBeNull();
    expect(eta.unpredictableWos).toHaveLength(2);
  });
});
