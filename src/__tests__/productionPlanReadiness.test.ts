import { describe, expect, it } from "vitest";
import { checkPlanReadiness, describePlanReadiness, nextReadyCheckpoint } from "../features/gsheet-monitor/productionPlanReadiness";
import type { ProductionPlanRow } from "../features/gsheet-monitor/gsheetTypes";
import type { MealProgress } from "../features/gsheet-monitor/postblastMatch";

function planRow(overrides: Partial<ProductionPlanRow>): ProductionPlanRow {
  return {
    code: "FV0001A", preference: "Keto", recipeName: "Test Meal",
    benl: 0, nordics: 0, de: 0, total: 2518, totalWithBuffer: 2518,
    complexityScore: null, subCount: null, cookStationCount: null,
    activeCookMin: null, passiveHoldMin: null,
    stations: { grill: false, cup: false, butter: false, oven: false, braiser: false, slice: false },
    allergens: "",
    byDay: {
      Sunday: { kind: "empty" }, Monday: { kind: "empty" }, Tuesday: { kind: "empty" },
      Wednesday: { kind: "empty" }, Thursday: { kind: "empty" }, Friday: { kind: "empty" }, Saturday: { kind: "empty" },
    },
    readyByDay: { thu: 2518, fri: 2518, sat: 2518 },
    minNeedsByDay: { thu: -1540, fri: -1540, sat: -1540 },
    ...overrides,
  };
}

function meal(overrides: Partial<MealProgress>): MealProgress {
  return {
    recipeCode: "FV0001A", recipeName: "Test Meal", plannedMeals: 2518,
    workOrders: [], totalPlannedKg: 1000, totalActualKg: 500,
    progressPct: 50, completedWOs: 0, totalWOs: 1, criticalWOs: [],
    ...overrides,
  };
}

describe("nextReadyCheckpoint", () => {
  it("maps Sunday through Thursday to the 'thu' checkpoint", () => {
    for (const day of [0, 1, 2, 3, 4]) {
      expect(nextReadyCheckpoint(new Date(Date.UTC(2026, 7, 23 + day)))).toBe("thu");
    }
  });

  it("maps Friday to 'fri' and Saturday to 'sat'", () => {
    expect(nextReadyCheckpoint(new Date(Date.UTC(2026, 7, 28)))).toBe("fri"); // Friday
    expect(nextReadyCheckpoint(new Date(Date.UTC(2026, 7, 29)))).toBe("sat"); // Saturday
  });
});

describe("checkPlanReadiness", () => {
  it("estimates produced portions from the meal's own kg progress ratio", () => {
    const row = planRow({});
    const m = meal({ plannedMeals: 2000, totalPlannedKg: 1000, totalActualKg: 250 }); // 25% kg progress
    const thursday = new Date(Date.UTC(2026, 7, 27)); // Thursday
    const check = checkPlanReadiness(row, m, thursday);
    expect(check).not.toBeNull();
    expect(check!.estimatedProducedPortions).toBeCloseTo(500, 5); // 2000 * 0.25
    expect(check!.readyTargetPortions).toBe(2518);
    expect(check!.sheetMinNeedsPortions).toBe(-1540);
  });

  it("returns null when the sheet has no Ready target for the relevant checkpoint", () => {
    const row = planRow({ readyByDay: { thu: null, fri: null, sat: null } });
    const check = checkPlanReadiness(row, meal({}), new Date(Date.UTC(2026, 7, 27)));
    expect(check).toBeNull();
  });

  it("treats Sunday as the start of the new week (maps to its own 'thu')", () => {
    const sunday = new Date(Date.UTC(2026, 7, 30)); // the following Sunday
    expect(nextReadyCheckpoint(sunday)).toBe("thu");
  });
});

describe("describePlanReadiness", () => {
  it("reports the gap and relays the sheet's own Min-Needs figure without inventing new numbers", () => {
    const row = planRow({});
    const m = meal({ plannedMeals: 2518, totalPlannedKg: 1000, totalActualKg: 100 }); // far behind
    const check = checkPlanReadiness(row, m, new Date(Date.UTC(2026, 7, 27)))!;
    const text = describePlanReadiness(check);
    expect(text).toContain("FV0001A");
    expect(text).toContain("2.518");
    expect(text).toContain("darunter");
    expect(text).toContain("Überschuss");
  });
});
