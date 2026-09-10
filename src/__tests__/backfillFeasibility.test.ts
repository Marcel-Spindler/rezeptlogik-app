import { describe, expect, it } from "vitest";
import { computeBackfillFeasibility } from "../features/backfills/backfillFeasibility";
import type { CombinedBackfillNeed } from "../features/backfills/backfillTypes";
import type { DataBundle, DetailedIngredient, DetailedSubRecipe, RecipeStructure } from "../core/types";
import type { FullInventoryRow } from "../features/wms-overview/wmsTypes";

function ing(id: string, grossQty: number, uom = "grams"): DetailedIngredient {
  return { id, name: id, grossQty, netQty: grossQty, uom };
}

function node(overrides: Partial<DetailedSubRecipe>): DetailedSubRecipe {
  return { id: "SUB-1", name: "Chicken - garlic", categories: "BRAISER", uom: "grams", subRecipes: [], ingredients: [], ...overrides };
}

function dataWith(nodes: DetailedSubRecipe[], code = "FV0001A"): DataBundle {
  const structure: RecipeStructure = { code, recipeId: "REC-1", name: "Test Meal", markets: { DE: nodes } };
  return { structures: { [code]: structure } } as unknown as DataBundle;
}

function need(overrides: Partial<CombinedBackfillNeed> = {}): CombinedBackfillNeed {
  return {
    recipeCode: "FV0001A", codeVariants: ["FV0001A"], recipeName: "Test Meal",
    kitchenMissingKg: 0, kitchenMissingPortions: 0, kitchenPriority: null, kitchenSubRecipes: [],
    platingPlannedPortions: 0, platingShortagePortions: 0, platingShortageReasons: [], platingDaysAffected: [],
    lpShortfallPortions: 0, lpWeek: "W36", lpStatusText: "",
    minNeededPortions: null, backfillResultPortions: null, backfillResultComments: [],
    rtiHoldingKg: 0,
    rtiPlannedTarget: null, rtiActuals: null, rtiShortfallPortions: 0, rtiRecommendedBuffered: 0,
    rtiKitchenDone: false, rtiHasOpenSubs: false, rtiVetoed: false,
    rtiTargetEstimated: false, rtiTargetSourceLabel: "",
    rtiBackfillCandidateSubs: [], rtiSubShortfalls: [],
    liveWmsHoldingKg: null, liveRedzonePortions: null, liveRedzoneStatus: null,
    recommendedBackfillPortions: 100, recommendedSource: "plating",
    confidence: "plating-only", priority: "behind",
    ...overrides,
  };
}

function invRow(overrides: Partial<FullInventoryRow>): FullInventoryRow {
  return {
    locationId: "BULK-01", itemNumber: "PRO-CHICK", actualQty: 0, unavailableQty: null, status: "A", type: null,
    lotNumber: "", huId: "", fifoDate: null, expirationDate: null, reservedFor: "", inspectionCode: "",
    putAwayLocation: "", shipmentNumber: "", dbChangeCommitTime: null, kw: null,
    ...overrides,
  };
}

describe("computeBackfillFeasibility", () => {
  it("feasible when raw stock covers the recommended portions", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000 })]; // 20000 / 150 = 133
    const f = computeBackfillFeasibility([need({ recommendedBackfillPortions: 100 })], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("feasible");
    expect(f.maxProduciblePortions).toBe(133);
  });

  it("partial when raw stock covers only part of the need — bottleneck is the limiting ingredient", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150), ing("SPI-MIX", 10)] })]);
    const rows = [
      invRow({ itemNumber: "PRO-CHICK", actualQty: 30_000 }), // 200 Portionen
      invRow({ itemNumber: "SPI-MIX", actualQty: 500 }),      //  50 Portionen  ← Engpass
    ];
    const f = computeBackfillFeasibility([need({ recommendedBackfillPortions: 100 })], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("partial");
    expect(f.maxProduciblePortions).toBe(50);
    expect(f.bottleneck.map(b => b.ingredientId)).toEqual(["SPI-MIX"]);
  });

  it("blocked when the ingredient exists in WMS but nothing is available (status not A)", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000, status: "H" })];
    const f = computeBackfillFeasibility([need()], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("blocked");
    expect(f.bottleneck[0].notInWms).toBe(false);
    expect(f.bottleneck[0].availableQty).toBe(0);
  });

  it("flags an ingredient that never appears in the inventory dump as notInWms", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    // Nicht-leerer Bestand, aber der Artikel PRO-CHICK ist nicht dabei.
    const rows = [invRow({ itemNumber: "SPI-SOMETHING-ELSE", actualQty: 5000 })];
    const f = computeBackfillFeasibility([need()], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("blocked");
    expect(f.bottleneck[0].notInWms).toBe(true);
  });

  it("ignores tap water — never a bottleneck even if it is missing from the WMS dump", () => {
    const data = dataWith([node({ ingredients: [
      ing("PRO-CHICK", 150),
      { id: "OTH-00-144038-5", name: "FA-DE Water / Wasser", grossQty: 55, netQty: 55, uom: "grams" },
    ] })]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000 })]; // Wasser fehlt im Dump
    const f = computeBackfillFeasibility([need({ recommendedBackfillPortions: 100 })], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("feasible");
    expect(f.ingredients.some((i) => /water|wasser/i.test(i.ingredientName))).toBe(false);
  });

  it("a component that is only water counts as feasible, not 'unknown'", () => {
    const data = dataWith([node({ name: "Cooking water", ingredients: [
      { id: "OTH-00-144038-5", name: "FA-DE Water / Wasser", grossQty: 200, netQty: 200, uom: "grams" },
    ] })]);
    const f = computeBackfillFeasibility([need()], data, [invRow({ itemNumber: "X", actualQty: 1 })]).get("FV0001A")!;
    expect(f.verdict).toBe("feasible");
  });

  it("does NOT exclude real water-named SKUs like coconut water", () => {
    const data = dataWith([node({ ingredients: [
      { id: "PRO-COCO", name: "Coconut water / Kokoswasser", grossQty: 100, netQty: 100, uom: "grams" },
    ] })]);
    const rows = [invRow({ itemNumber: "SPI-OTHER", actualQty: 5000 })]; // Kokoswasser fehlt
    const f = computeBackfillFeasibility([need()], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("blocked");
    expect(f.bottleneck[0].notInWms).toBe(true);
  });

  it("returns an empty map for an empty inventory dump (treated as not connected)", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    expect(computeBackfillFeasibility([need()], data, []).size).toBe(0);
  });

  it("excludes expired stock from the available quantity", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000, expirationDate: "2020-01-01T00:00:00Z" })];
    const f = computeBackfillFeasibility([need()], data, rows).get("FV0001A")!;
    expect(f.verdict).toBe("blocked");
    expect(f.ingredients[0].expiredQty).toBe(20_000);
    expect(f.ingredients[0].availableQty).toBe(0);
  });

  it("returns unknown when no recipe structure can be resolved", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    const f = computeBackfillFeasibility(
      [need({ recipeCode: "FV9999Z", recipeName: "Nonexistent" })],
      data,
      [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000 })],
    ).get("FV9999Z")!;
    expect(f.verdict).toBe("unknown");
    expect(f.reason).toMatch(/struktur/i);
  });

  it("scopes to the kitchen-reported sub-recipe and ignores the rest of the meal", () => {
    const data = dataWith([
      node({ id: "SUB-1", name: "Chicken - garlic", ingredients: [ing("PRO-CHICK", 150)] }),
      node({ id: "SUB-2", name: "Rice pilaf", ingredients: [ing("DRY-RICE", 90)] }),
    ]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000 })]; // Rice fehlt im Lager
    const f = computeBackfillFeasibility(
      [need({ kitchenSubRecipes: ["Chicken - garlic"], recommendedBackfillPortions: 100 })],
      data,
      rows,
    ).get("FV0001A")!;
    expect(f.scope).toBe("components");
    expect(f.ingredients.map(i => i.ingredientId)).toEqual(["PRO-CHICK"]);
    expect(f.verdict).toBe("feasible");
  });

  it("falls back to the whole meal when no component is identified", () => {
    const data = dataWith([
      node({ id: "SUB-1", name: "Chicken - garlic", ingredients: [ing("PRO-CHICK", 150)] }),
      node({ id: "SUB-2", name: "Rice pilaf", ingredients: [ing("DRY-RICE", 90)] }),
    ]);
    const rows = [invRow({ itemNumber: "PRO-CHICK", actualQty: 20_000 })];
    const f = computeBackfillFeasibility([need({ recommendedBackfillPortions: 100 })], data, rows).get("FV0001A")!;
    expect(f.scope).toBe("full-meal");
    expect(f.verdict).toBe("blocked");
    expect(f.bottleneck[0].ingredientId).toBe("DRY-RICE");
  });

  it("narrows to a sub-recipe via tokens from the plating shortage reason", () => {
    const data = dataWith([
      node({ id: "SUB-1", name: "Beef sauce", ingredients: [ing("PRO-BEEF", 100)] }),
      node({ id: "SUB-2", name: "Mashed potato", ingredients: [ing("VEG-POT", 200)] }),
    ]);
    const rows = [invRow({ itemNumber: "PRO-BEEF", actualQty: 20_000 })]; // potato fehlt
    const f = computeBackfillFeasibility(
      [need({ platingShortageReasons: ["Sauce short - WO 35-12"], recommendedBackfillPortions: 100 })],
      data,
      rows,
    ).get("FV0001A")!;
    expect(f.scope).toBe("components");
    expect(f.ingredients.map(i => i.ingredientId)).toEqual(["PRO-BEEF"]);
    expect(f.verdict).toBe("feasible");
  });

  it("skips meals with no recommended backfill and returns an empty map without inventory data", () => {
    const data = dataWith([node({ ingredients: [ing("PRO-CHICK", 150)] })]);
    expect(computeBackfillFeasibility([need({ recommendedBackfillPortions: 0 })], data, [invRow({})]).size).toBe(0);
    expect(computeBackfillFeasibility([need()], data, undefined).size).toBe(0);
  });
});
