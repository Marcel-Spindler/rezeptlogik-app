import { describe, expect, it } from "vitest";
import { netPlateable, mealCodeKey, platedForMeal } from "../features/gsheet-monitor/plateableNet";
import type { MealProgress, WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";

function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "39-1", subRecipe: "Sauce", recipeCode: "FV0001A", recipeName: "Test Meal",
    plannedMeals: 1000, plannedKg: 300, actualKg: 0, progressPct: 0, deltaKg: -300,
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
    recipeCode: "FV0001A", recipeName: "Test Meal", plannedMeals: 1000, workOrders,
    totalPlannedKg, totalActualKg,
    progressPct: totalPlannedKg > 0 ? (totalActualKg / totalPlannedKg) * 100 : 0,
    completedWOs: workOrders.filter(w => w.isComplete).length,
    totalWOs: workOrders.length,
    criticalWOs: workOrders.filter(w => w.isCritical),
  };
}

describe("netPlateable", () => {
  it("returns the gross count untouched when nothing has been plated yet", () => {
    const m = meal([wo({ actualKg: 300 })]);
    const net = netPlateable(m, 1000, 0);
    expect(net.netMeals).toBe(1000);
    expect(net.grossMeals).toBe(1000);
    expect(net.platedMeals).toBe(0);
    expect(net.fullyPlated).toBe(false);
    expect(net.partiallyPlated).toBe(false);
  });

  it("subtracts already-plated portions from the gross count", () => {
    const m = meal([wo({ actualKg: 300 })]);
    const net = netPlateable(m, 1000, 400);
    expect(net.netMeals).toBe(600);
    expect(net.platedMeals).toBe(400);
    expect(net.partiallyPlated).toBe(true);
    expect(net.fullyPlated).toBe(false);
  });

  it("marks the meal fully plated once plated output reaches the gross count", () => {
    const m = meal([wo({ actualKg: 300 })]);
    const net = netPlateable(m, 1000, 1000);
    expect(net.netMeals).toBe(0);
    expect(net.fullyPlated).toBe(true);
    expect(net.partiallyPlated).toBe(false);
  });

  it("never goes negative when more was plated than we think was produced", () => {
    const m = meal([wo({ actualKg: 300 })]);
    const net = netPlateable(m, 1000, 1500);
    expect(net.netMeals).toBe(0);
    expect(net.fullyPlated).toBe(true);
  });

  it("treats missing / nullish plated input as zero", () => {
    const m = meal([wo({ actualKg: 300 })]);
    expect(netPlateable(m, 1000, undefined).netMeals).toBe(1000);
    expect(netPlateable(m, 1000, null).netMeals).toBe(1000);
  });

  it("no run breakdown for a single-run meal", () => {
    const m = meal([wo({ run: 1, actualKg: 300 })]);
    expect(netPlateable(m, 1000, 200).runs).toEqual([]);
  });

  it("splits a two-run meal by kg share and consumes run 1 first", () => {
    // Run 1 produced 2x the kg of run 2 → gross split ~667 / 333.
    const m = meal([
      wo({ workOrder: "39-1", run: 1, actualKg: 600 }),
      wo({ workOrder: "39-2", run: 2, actualKg: 300 }),
    ]);
    const net = netPlateable(m, 900, 700);
    expect(net.netMeals).toBe(200);
    expect(net.runs).toHaveLength(2);

    const run1 = net.runs.find(r => r.run === 1)!;
    const run2 = net.runs.find(r => r.run === 2)!;
    // Run 1's whole share is eaten first…
    expect(run1.grossMeals).toBe(600);
    expect(run1.netMeals).toBe(0);
    expect(run1.done).toBe(true);
    // …the remaining 100 plated portions bite into run 2.
    expect(run2.grossMeals).toBe(300);
    expect(run2.netMeals).toBe(200);
    expect(run2.done).toBe(false);
  });

  it("keys meals by their 4-digit identity, tolerant of prefixes and letter variants", () => {
    expect(mealCodeKey("FV1351A")).toBe("1351");
    expect(mealCodeKey("[DE] - FV1351A")).toBe("1351");
    expect(mealCodeKey("[BENL]-FV0257A")).toBe("0257");
    expect(mealCodeKey("FV4063B")).toBe("4063"); // same meal as FV4063A
    expect(mealCodeKey("weird")).toBe("WEIRD");

    const map = new Map([["1351", 4406]]);
    expect(platedForMeal(map, "FV1351A")).toBe(4406);
    expect(platedForMeal(map, "[DE] - FV1351A")).toBe(4406); // plan code is prefixed, map key is bare digits
    expect(platedForMeal(map, "FV9999A")).toBe(0);
    expect(platedForMeal(undefined, "FV1351A")).toBe(0);
  });

  it("run shares always sum back to the gross count (rounding lands on the last run)", () => {
    const m = meal([
      wo({ workOrder: "39-1", run: 1, actualKg: 100 }),
      wo({ workOrder: "39-2", run: 2, actualKg: 100 }),
      wo({ workOrder: "39-3", run: 3, actualKg: 100 }),
    ]);
    const net = netPlateable(m, 1000, 0);
    expect(net.runs.reduce((s, r) => s + r.grossMeals, 0)).toBe(1000);
  });
});
