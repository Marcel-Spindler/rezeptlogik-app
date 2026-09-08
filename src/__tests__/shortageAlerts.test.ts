import { describe, expect, it } from "vitest";
import { correlateShortages, describeShortageImpact, formatRecoveryStatus } from "../features/gsheet-monitor/shortageAlerts";
import type { ShortageEntry } from "../features/gsheet-monitor/gsheetTypes";
import type { WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";

function shortage(overrides: Partial<ShortageEntry>): ShortageEntry {
  return {
    rawWorkOrderSuffix: "58", stagingDay: "2026-08-22", workOrder: "35-58",
    ingredient: "FA-DE Basil, Fresh", sku: "PHF-00-139175-3", shortKg: 81.5,
    recoveryStatus: "", ticketNumber: "", notes: "", filled: false, rowIndex: 5,
    ...overrides,
  };
}

function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "35-58", subRecipe: "Basil Pesto", recipeCode: "FV0001A", recipeName: "Test Meal",
    plannedMeals: 100, plannedKg: 300, actualKg: 0, progressPct: 0, deltaKg: -300,
    isComplete: false, isCritical: false, hasPlan: true, isEstimated: false,
    preBlastKg: 0, shrinkKg: 0, shrinkPct: 0, awaitingPostBlast: false, preBlastLikelyDone: false,
    lastPreBlastWeighing: null, run: 1, weighings: [], lastWeighing: null,
    platingHoldingKg: 0, rtiStatus: null,
    ...overrides,
  };
}

describe("correlateShortages", () => {
  it("filters out shortages already marked Filled in the sheet", () => {
    const open = shortage({ rowIndex: 1, filled: false });
    const closed = shortage({ rowIndex: 2, filled: true });
    const result = correlateShortages([open, closed], []);
    expect(result.map(r => r.shortage.rowIndex)).toEqual([1]);
  });

  it("finds the affected work order by the reconstructed WO number", () => {
    const matchingWo = wo({ workOrder: "35-58", subRecipe: "Basil Pesto" });
    const result = correlateShortages([shortage({ workOrder: "35-58" })], [matchingWo]);
    expect(result[0].affectedWo?.subRecipe).toBe("Basil Pesto");
  });

  it("leaves affectedWo null when the WO isn't in the current plan", () => {
    const result = correlateShortages([shortage({ workOrder: "35-999" })], [wo({ workOrder: "35-58" })]);
    expect(result[0].affectedWo).toBeNull();
  });

  it("marks an entry with neither recovery status nor notes as new/untriaged", () => {
    const result = correlateShortages([shortage({ recoveryStatus: "", notes: "" })], []);
    expect(result[0].isNew).toBe(true);
  });

  it("does not mark an entry with a recovery status as new", () => {
    const result = correlateShortages([shortage({ recoveryStatus: "Shipment  En Route", notes: "" })], []);
    expect(result[0].isNew).toBe(false);
  });

  it("normalizes extra whitespace in the sheet status before translating it", () => {
    expect(formatRecoveryStatus("Shipment  En Route")).toBe("Versand auf dem Weg");
    expect(formatRecoveryStatus("Located in Warehouse")).toBe("Im Lager");
  });

  it("sorts by shortage size, largest first", () => {
    const small = shortage({ rowIndex: 1, shortKg: 10 });
    const large = shortage({ rowIndex: 2, shortKg: 500 });
    const result = correlateShortages([small, large], []);
    expect(result.map(r => r.shortage.rowIndex)).toEqual([2, 1]);
  });
});

describe("describeShortageImpact", () => {
  it("names the affected meal/sub-recipe and relays the sheet's own recovery info", () => {
    const impact = correlateShortages(
      [shortage({ workOrder: "35-58", ingredient: "FA-DE Basil, Fresh", shortKg: 81.5, recoveryStatus: "Shipment En Route" })],
      [wo({ workOrder: "35-58", subRecipe: "Basil Pesto", recipeCode: "FV0001A", recipeName: "Test Meal" })]
    )[0];
    const text = describeShortageImpact(impact);
    expect(text).toContain("FA-DE Basil, Fresh");
    expect(text).toContain("81.5");
    expect(text).toContain("Basil Pesto");
    expect(text).toContain("FV0001A");
    expect(text).toContain("Versand auf dem Weg");
  });

  it("flags a genuinely new entry as needing a decision instead of inventing a solution", () => {
    const impact = correlateShortages([shortage({ recoveryStatus: "", notes: "" })], [])[0];
    const text = describeShortageImpact(impact);
    expect(text).toContain("NEU");
    expect(text).toContain("Noch keine Recovery-Info");
  });
});
