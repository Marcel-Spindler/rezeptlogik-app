import { describe, expect, it } from "vitest";
import { sweepRtiInventory } from "../features/backfills/rtiInventorySweep";
import type { RtiMealBackfill } from "../features/backfills/rtiBackfillCalculator";
import type { DataBundle } from "../core/types";
import type { FullInventoryRow } from "../features/wms-overview/wmsTypes";

function meal(overrides: Partial<RtiMealBackfill> = {}): RtiMealBackfill {
  return {
    mealCode: "FV0001A", mealName: "Test", plannedTarget: 3000, actuals: 2600, gap: 400,
    openSubs: [{
      workOrder: "38-1", subRecipeName: "Roasted Sweet Potato", weighedKg: 0, gramPerMeal: 100,
      availableMealcount: 0, minimumNeed: 400, bufferedNeed: 450, shortagePct: 12, basis: "sheet", status: "open",
    }],
    enteredSubs: [], notNeededSubs: [], recommendedMin: 400, recommendedBuffered: 450,
    allEntered: false, weighingStarted: true, hasGapOnly: false, candidateSubNames: [],
    ...overrides,
  };
}

const data = {
  structures: {
    FV0001A: {
      code: "FV0001A", name: "Test",
      markets: { DE: [{ id: "MSKU-1", name: "Test", subRecipes: [
        { id: "SUB-777-4-001", name: "Roasted Sweet Potato", yield: 0.1, yieldUom: "grams", ingredients: [], subRecipes: [] },
      ] }] },
    },
  },
} as unknown as DataBundle;

function inv(overrides: Partial<FullInventoryRow>): FullInventoryRow {
  return {
    locationId: "BC-04", itemNumber: "SUB-777-4-001", actualQty: 0, unavailableQty: null, status: "A", type: null,
    lotNumber: "", huId: "", fifoDate: null, expirationDate: null, reservedFor: "", inspectionCode: "",
    ...overrides,
  } as FullInventoryRow;
}

describe("sweepRtiInventory", () => {
  it("summiert die fertige Sub-SKU über alle Nicht-PLH-Lagerorte, rechnet in Portionen", () => {
    const rows = [
      inv({ locationId: "BC-04", actualQty: 30_000 }),  // 300 Portionen
      inv({ locationId: "STG-1", actualQty: 12_000 }),  // 120 Portionen
      inv({ locationId: "PLH-02", actualQty: 50_000 }), // Plating Holding → ignoriert
    ];
    const m = sweepRtiInventory([meal()], data, rows);
    const hit = m.get("FV0001A|Roasted Sweet Potato")!;
    expect(hit.totalPortions).toBe(420);
    expect(hit.byLocation.map(l => l.location)).toEqual(["BC-04", "STG-1"]);
    expect(hit.covered).toBe(true); // exakter Name, SKU nicht geteilt, 420 ≥ 400
  });

  it("covered=false, wenn das Woanders-Vorhandene den Mindestbedarf nicht deckt", () => {
    const m = sweepRtiInventory([meal()], data, [inv({ actualQty: 10_000 })]); // 100 < 400
    expect(m.get("FV0001A|Roasted Sweet Potato")!.covered).toBe(false);
  });

  it("covered=false + shared=true, wenn die SKU in mehreren Meals steckt", () => {
    const idx = new Map([["SUB-777-4-001", { sku: "SUB-777-4-001", name: "x", uom: "grams", category: "SUB", plannedQty: 0, recipes: new Set(["FV0001A", "FV0002A"]), source: "week-plan" as const }]]);
    const m = sweepRtiInventory([meal()], data, [inv({ actualQty: 60_000 })], idx);
    const hit = m.get("FV0001A|Roasted Sweet Potato")!;
    expect(hit.shared).toBe(true);
    expect(hit.covered).toBe(false);
  });

  it("überspringt FA-DE-Rohware (kein gekochtes Sub)", () => {
    const raw = meal({ openSubs: [{ ...meal().openSubs[0], subRecipeName: "FA-DE Cheese, White Cheddar" }] });
    expect(sweepRtiInventory([raw], data, [inv({ actualQty: 99_000 })]).size).toBe(0);
  });

  it("ignoriert abgelaufene und nicht-A-Bestände", () => {
    const rows = [
      inv({ actualQty: 40_000, expirationDate: "2000-01-01" }),
      inv({ actualQty: 40_000, status: "H" }),
    ];
    expect(sweepRtiInventory([meal()], data, rows).size).toBe(0);
  });

  it("leere Map ohne WMS-Daten (kein lokaler Server)", () => {
    expect(sweepRtiInventory([meal()], data, null).size).toBe(0);
    expect(sweepRtiInventory([meal()], data, []).size).toBe(0);
  });
});
