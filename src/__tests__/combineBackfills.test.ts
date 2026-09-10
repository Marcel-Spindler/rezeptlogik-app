import { describe, expect, it } from "vitest";
import { combineBackfillSignals, detectCrossSourceAlerts } from "../features/backfills/combineBackfills";
import { computeRtiBackfills } from "../features/backfills/rtiBackfillCalculator";
import type { BackfillNeed } from "../features/gsheet-monitor/postblastMatch";
import type { LinePlaitingData, LinePlaitingRow, RtiData, RtiMealBlock, RtiSubRecipeEntry } from "../features/gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../features/redzone-live/redzoneTypes";
import type { StoredRow } from "../features/wms-overview/wmsTypes";
import type { WmsSkuInfo } from "../lib/wmsSkuEnrichment";

function rtiSub(status: RtiSubRecipeEntry["status"], overrides: Partial<RtiSubRecipeEntry> = {}): RtiSubRecipeEntry {
  return {
    workOrder: "36-001", subRecipeName: "Sub A", platingHoldingKg: 0, weighedKg: 0,
    gramPerMeal: 100, availableMealcount: 0, minimumNeed: 0, backfillMeals: 0,
    shortagePct: 0, status, isBackfillCandidate: false,
    ...overrides,
  };
}

function rtiData(meal: Partial<RtiMealBlock>): RtiData {
  const block: RtiMealBlock = {
    mealCode: "FV0001A", mealName: "Test Meal", plannedTarget: 5000, actuals: 4200,
    delta: -800, deltaPct: 16, subRecipes: [rtiSub("open")],
    ...meal,
  };
  return { week: "W36", meals: [block], lastUpdated: Date.now() };
}

function redzoneRun(overrides: Partial<PlatingRunDisplay>): PlatingRunDisplay {
  return {
    areaName: "Plating", locationName: "Line 1", productTypeName: "FV0001A - Test Meal", productTypeSKU: "SKU1",
    outCount: 50, inCount: 50, startTime: "2026-08-23T10:00:00Z", endTime: "2026-08-23T10:30:00Z",
    runName: "Run 1", status: "completed", mealCode: "FV0001A", durationMin: 30,
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredRow>): StoredRow {
  return {
    locationId: "PLH-01", itemNumber: "SUB-001", actualQty: 5000, lotNumber: "LOT1", huId: "HU1",
    status: "STORED", fifoDate: null, expirationDate: null, dbChangeCommitTime: null, kw: null,
    ...overrides,
  };
}

function skuInfoIndexWith(entries: Array<[string, Partial<WmsSkuInfo>]>): Map<string, WmsSkuInfo> {
  const map = new Map<string, WmsSkuInfo>();
  for (const [sku, overrides] of entries) {
    map.set(sku, {
      sku, name: "Test Sub-Rezept", uom: "grams", category: "SUB", plannedQty: 0,
      recipes: new Set(["FV0001A"]), source: "week-plan",
      ...overrides,
    });
  }
  return map;
}

function kitchenNeed(overrides: Partial<BackfillNeed>): BackfillNeed {
  return {
    workOrder: "35-1", subRecipe: "Test Sub", recipeCode: "FV0001A", recipeName: "Test Meal",
    missingKg: 10, missingPct: 20, estimatedPortions: 100, priority: "behind",
    platingHoldingKg: 0, rtiConfirmed: false,
    ...overrides,
  };
}

function plaitingRow(overrides: Partial<LinePlaitingRow>): LinePlaitingRow {
  return {
    week: "W36", day: "Tuesday", time: "06:00 - 06:30", phase: "shortage", recipeCode: "FV0001A", meal: "Test Meal",
    plannedPortions: 1000, actualPortions: 800, deltaPortions: -200, comment: "", backfillConfirmed: true,
    minNeededPortions: null, dayNeedPortions: null, statusText: "",
    shortageReason: "Sauce short", shortagePct: 20,
    ...overrides,
  };
}

function linePlaitingData(rows: LinePlaitingRow[]): LinePlaitingData {
  const byRecipeCode = new Map<string, LinePlaitingRow[]>();
  for (const r of rows) {
    if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
    byRecipeCode.get(r.recipeCode)!.push(r);
  }
  return { week: "W36", rows, byRecipeCode, dayTotals: [], lastUpdated: Date.now() };
}

function combine(
  kitchen: BackfillNeed[],
  lp: LinePlaitingData | null,
  rti: RtiData | null,
  redzoneRuns?: PlatingRunDisplay[],
  wmsRows?: StoredRow[],
  skuIndex?: Map<string, WmsSkuInfo>,
) {
  return combineBackfillSignals(kitchen, lp, rti, computeRtiBackfills(rti), redzoneRuns, wmsRows, skuIndex);
}

describe("combineBackfillSignals", () => {
  it("marks a meal as confirmed when both kitchen and plating report a shortage", () => {
    const combined = combine(
      [kitchenNeed({})],
      linePlaitingData([plaitingRow({})]),
      null,
    );
    expect(combined).toHaveLength(1);
    expect(combined[0].confidence).toBe("confirmed");
    expect(combined[0].platingShortagePortions).toBe(200);
    expect(combined[0].platingShortageReasons).toContain("Sauce short");
  });

  it("marks a meal plating-only when only LinePlaiting sees a shortage", () => {
    const combined = combine([], linePlaitingData([plaitingRow({})]), null);
    expect(combined).toHaveLength(1);
    expect(combined[0].confidence).toBe("plating-only");
    expect(combined[0].kitchenMissingKg).toBe(0);
  });

  it("marks a meal kitchen-only when only Postblast sees a shortage", () => {
    const combined = combine([kitchenNeed({})], null, null);
    expect(combined).toHaveLength(1);
    expect(combined[0].confidence).toBe("kitchen-only");
    expect(combined[0].platingShortagePortions).toBe(0);
  });

  it("picks up Friday's Min Needs and Saturday's backfill result", () => {
    const data = linePlaitingData([
      plaitingRow({}),
      plaitingRow({ day: "Friday", phase: "min-needs", deltaPortions: -50, minNeededPortions: 150, shortageReason: "" }),
      plaitingRow({ day: "Saturday", phase: "result", deltaPortions: 20, actualPortions: 220, comment: "Done", shortageReason: "" }),
    ]);
    const combined = combine([kitchenNeed({})], data, null);
    expect(combined[0].minNeededPortions).toBe(150);
    expect(combined[0].backfillResultPortions).toBe(220);
    expect(combined[0].backfillResultComments).toContain("Done");
  });

  it("does not invent a shortage for a meal with only positive deltas (surplus)", () => {
    const data = linePlaitingData([plaitingRow({ deltaPortions: 50, actualPortions: 1050, shortageReason: "" })]);
    const combined = combine([], data, null);
    expect(combined[0].platingShortagePortions).toBe(0);
  });

  it("recommends the LinePlating '{Tag} needs' over the raw plating shortage when both exist", () => {
    const data = linePlaitingData([
      plaitingRow({}), // Di: -200 shortage
      plaitingRow({ day: "Friday", phase: "min-needs", deltaPortions: -50, minNeededPortions: 260, shortageReason: "" }),
    ]);
    const combined = combine([kitchenNeed({ estimatedPortions: 999 })], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(260);
    expect(combined[0].recommendedSource).toBe("lineplating");
  });

  it("falls back to Σ(Planned − Actual) when no '{Tag} needs' exists yet", () => {
    const data = linePlaitingData([plaitingRow({})]); // nur Di, noch keine Fr/Sa-Zeilen
    const combined = combine([], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(200);
    expect(combined[0].recommendedSource).toBe("plating");
  });

  it("falls back to the kitchen weight-based estimate when no plating data exists at all", () => {
    const combined = combine([kitchenNeed({ estimatedPortions: 150 })], null, null);
    expect(combined[0].recommendedBackfillPortions).toBe(150);
    expect(combined[0].recommendedSource).toBe("kitchen");
  });

  it("does NOT net a Saturday plating run against the recommendation — its meaning is unconfirmed", () => {
    const data = linePlaitingData([
      plaitingRow({}),
      plaitingRow({ day: "Friday", phase: "min-needs", deltaPortions: -1216, minNeededPortions: 260, shortageReason: "Peppers-Short" }),
      plaitingRow({ day: "Saturday", phase: "result", deltaPortions: 136, actualPortions: 1296, comment: "Done", shortageReason: "" }),
    ]);
    const combined = combine([], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(260);
    expect(combined[0].recommendedSource).toBe("lineplating");
    expect(combined[0].backfillResultPortions).toBe(1296);
  });
});

describe("combineBackfillSignals — Redzone enrichment", () => {
  it("attaches a live Redzone count to an existing kitchen/plating entry without changing the recommendation", () => {
    const combined = combine(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ outCount: 75, status: "active" })],
    );
    expect(combined[0].liveRedzonePortions).toBe(75);
    expect(combined[0].liveRedzoneStatus).toBe("active");
    expect(combined[0].recommendedBackfillPortions).toBe(100);
  });

  it("sums multiple Redzone runs (e.g. two lines) for the same meal", () => {
    const combined = combine(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ outCount: 30 }), redzoneRun({ outCount: 20, locationName: "Line 2" })],
    );
    expect(combined[0].liveRedzonePortions).toBe(50);
  });

  it("ignores non-Plating areas (Ovens/Braisers) and runs without a resolved meal code", () => {
    const combined = combine(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ areaName: "Ovens", outCount: 999 }), redzoneRun({ mealCode: null, outCount: 999 })],
    );
    expect(combined[0].liveRedzonePortions).toBeNull();
  });

  it("does not create a new meal entry purely from a Redzone run with no kitchen/plating signal", () => {
    const combined = combine([], null, null, [redzoneRun({})]);
    expect(combined).toHaveLength(0);
  });

  it("defaults to null when no Redzone data is passed (e.g. running online without the local WMS server)", () => {
    const combined = combine([kitchenNeed({})], null, null);
    expect(combined[0].liveRedzonePortions).toBeNull();
    expect(combined[0].liveRedzoneStatus).toBeNull();
  });
});

describe("combineBackfillSignals — WMS Plating Holding enrichment", () => {
  it("converts grams to kg and attaches the live Plating-Holding stock to a matching meal", () => {
    const rows = [storedRow({ itemNumber: "SUB-001", actualQty: 5000 })];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}]]);
    const combined = combine([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBe(5);
  });

  it("sums multiple PLH locations/lots for the same resolved recipe", () => {
    const rows = [
      storedRow({ itemNumber: "SUB-001", actualQty: 3000, locationId: "PLH-01" }),
      storedRow({ itemNumber: "SUB-002", actualQty: 2000, locationId: "PLH-02" }),
    ];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}], ["SUB-002", {}]]);
    const combined = combine([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBe(5);
  });

  it("ignores non-SUB SKUs (e.g. finished packaged meals) to avoid mixing units", () => {
    const rows = [storedRow({ itemNumber: "MSKU-001", actualQty: 500 })];
    const skuInfoIndex = skuInfoIndexWith([["MSKU-001", { category: "MSKU" }]]);
    const combined = combine([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });

  it("ignores rows whose SKU cannot be resolved to a recipe at all", () => {
    const rows = [storedRow({ itemNumber: "UNKNOWN-SKU", actualQty: 5000 })];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}]]);
    const combined = combine([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });

  it("defaults to null when no WMS Holding data is passed (server unreachable)", () => {
    const combined = combine([kitchenNeed({})], null, null);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });
});

describe("combineBackfillSignals — RTI-Sheet treibt den Bedarf, pro Sub-Rezept", () => {
  it("creates an rti-only entry aus dem Sub-Engpass (Minimum need)", () => {
    const combined = combine([], null, rtiData({ plannedTarget: 5000, actuals: 4200 }));
    expect(combined).toHaveLength(1);
    expect(combined[0].confidence).toBe("rti-only");
    expect(combined[0].recommendedSource).toBe("rti");
    expect(combined[0].recommendedBackfillPortions).toBe(800);
    expect(combined[0].rtiActuals).toBe(4200);
    expect(combined[0].rtiSubShortfalls).toHaveLength(1);
    expect(combined[0].rtiRecommendedBuffered).toBeGreaterThan(800);
  });

  it("meldet nur die leergelaufenen Sub-Rezepte — aus Holding gedeckte nicht", () => {
    const combined = combine([], null, rtiData({
      plannedTarget: 3763, actuals: 2848,
      subRecipes: [
        rtiSub("open", { subRecipeName: "Creamy Leek", minimumNeed: 59 }),
        rtiSub("open", { subRecipeName: "Green beans", minimumNeed: 356 }),
        rtiSub("open", { subRecipeName: "Mash", minimumNeed: -915, backfillMeals: -1137, shortagePct: -24.32 }),
        rtiSub("open", { subRecipeName: "Pork tenderloin", minimumNeed: -812, backfillMeals: -987, shortagePct: -21.58 }),
      ],
    }));
    expect(combined[0].rtiSubShortfalls.map(s => s.subRecipeName).sort()).toEqual(["Mash", "Pork tenderloin"]);
    expect(combined[0].rtiSubShortfalls.find(s => s.subRecipeName === "Mash")!.bufferedNeed).toBe(1137);
    expect(combined[0].recommendedBackfillPortions).toBe(915);
  });

  it("does NOT create an entry when the shortfall sub-recipe is 'no' (veto)", () => {
    const combined = combine([], null, rtiData({ subRecipes: [rtiSub("not-needed"), rtiSub("not-needed")] }));
    expect(combined).toHaveLength(0);
  });

  it("does NOT create an entry for a sub-threshold shortfall", () => {
    const combined = combine([], null, rtiData({ plannedTarget: 5000, actuals: 4980 }));
    expect(combined).toHaveLength(0);
  });

  it("ein Sub offen, einer schon eingetragen (Sheet 'done') → Alarm nur für den offenen", () => {
    const combined = combine([], null, rtiData({ subRecipes: [rtiSub("done"), rtiSub("open", { subRecipeName: "Sub B" })] }));
    expect(combined[0].rtiHasOpenSubs).toBe(true);
    expect(combined[0].rtiSubShortfalls.map(s => s.subRecipeName)).toEqual(["Sub B"]);
    expect(detectCrossSourceAlerts(combined).some(a => a.title.startsWith("Backfill nötig"))).toBe(true);
  });

  it("alle Engpass-Subs auf 'done' → kein combined-Eintrag (nichts mehr zu tun)", () => {
    const combined = combine([], null, rtiData({ subRecipes: [rtiSub("done"), rtiSub("done")] }));
    expect(combined).toHaveLength(0);
  });

  it("ignores prepared backfill-candidate rows", () => {
    const combined = combine([], null, rtiData({
      subRecipes: [rtiSub("open"), rtiSub("open", { isBackfillCandidate: true, subRecipeName: "Sub A" })],
    }));
    expect(combined[0].rtiSubShortfalls).toHaveLength(1);
    expect(combined[0].rtiBackfillCandidateSubs).toEqual(["Sub A"]);
  });

  it("der RTI-Sub-Engpass schlägt LinePlating '{Tag} needs' für die Zahl", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 300, dayNeedPortions: 300, shortageReason: "" }),
    ]);
    const combined = combine([], data, rtiData({ plannedTarget: 5000, actuals: 4200 }));
    expect(combined[0].recommendedSource).toBe("rti");
    expect(combined[0].recommendedBackfillPortions).toBe(800);
  });

  it("nutzt LinePlating '{Tag} needs', wenn das RTI-Sheet für das Meal nichts hat", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 300, dayNeedPortions: 300, shortageReason: "" }),
    ]);
    const combined = combine([], data, null);
    expect(combined[0].recommendedSource).toBe("lineplating");
    expect(combined[0].recommendedBackfillPortions).toBe(300);
  });

  it("merges code variants (FV4063A ↔ FV4063B) into one entry via the 4-digit key", () => {
    const lp = linePlaitingData([
      plaitingRow({ recipeCode: "FV4063B", meal: "Cheddar pulled beef", day: "Friday", phase: "min-needs", minNeededPortions: 500, dayNeedPortions: 500 }),
    ]);
    const rti = rtiData({ mealCode: "FV4063A", mealName: "Cheddar pulled beef", plannedTarget: 2300, actuals: 1472, subRecipes: [rtiSub("open")] });
    const combined = combine([], lp, rti);
    expect(combined).toHaveLength(1);
    expect(combined[0].codeVariants.sort()).toEqual(["FV4063A", "FV4063B"]);
    expect(combined[0].recipeCode).toBe("FV4063B");
    expect(combined[0].recommendedSource).toBe("rti");
    expect(combined[0].recommendedBackfillPortions).toBe(828);
    expect(combined[0].rtiPlannedTarget).toBe(2300);
  });

  it("keeps the real weighing block when the RTI sheet also has empty prep blocks for the same code", () => {
    const rti: RtiData = {
      week: "W36", lastUpdated: Date.now(),
      meals: [
        { mealCode: "FV0001A", mealName: "Test Meal", plannedTarget: 2000, actuals: 1700, delta: -300, deltaPct: 15, subRecipes: [rtiSub("open")] },
        { mealCode: "FV0001A", mealName: "Test Meal", plannedTarget: 0, actuals: 0, delta: 0, deltaPct: 0, subRecipes: [] },
        { mealCode: "FV0001A", mealName: "Test Meal", plannedTarget: 0, actuals: 0, delta: 0, deltaPct: 0, subRecipes: [] },
      ],
    };
    const combined = combine([], null, rti);
    expect(combined).toHaveLength(1);
    expect(combined[0].rtiPlannedTarget).toBe(2000);
    expect(combined[0].rtiShortfallPortions).toBe(300);
    expect(combined[0].recommendedSource).toBe("rti");
    expect(combined[0].recommendedBackfillPortions).toBe(300);
  });

  it("die app-weite 'Backfill nötig'-Meldung nennt die Sub-Rezepte", () => {
    const combined = combine([], null, rtiData({
      plannedTarget: 5000, actuals: 4200,
      subRecipes: [rtiSub("open", { subRecipeName: "Sauce X", minimumNeed: -800, backfillMeals: -928 })],
    }));
    const a = detectCrossSourceAlerts(combined).find(x => x.title.startsWith("Backfill nötig"));
    expect(a).toBeTruthy();
    expect(a!.severity).toBe("critical");
    expect(a!.message).toContain("Sauce X");
    expect(a!.message).toContain("mit Puffer");
  });
});

describe("detectCrossSourceAlerts", () => {
  it("does NOT raise a cross-source alert for a plating-only shortage — that's a normal, independent finding", () => {
    const combined = combine([], linePlaitingData([plaitingRow({})]), null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.recipeCode === "FV0001A")).toBe(false);
  });

  it("raises an info-level forward-looking note for a critical kitchen-only deficit not yet seen at plating", () => {
    const combined = combine([kitchenNeed({ priority: "critical" })], null, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.severity === "info" && a.recipeCode === "FV0001A")).toBe(true);
  });

  it("does not alert when both sources agree closely on the missing amount", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 100, shortageReason: "" }),
    ]);
    const combined = combine([kitchenNeed({ estimatedPortions: 105 })], data, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.title.includes("Abweichung"))).toBe(false);
  });

  it("flags a large deviation between Friday's Min Needs and the weight-based estimate", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 100, shortageReason: "" }),
    ]);
    const combined = combine([kitchenNeed({ estimatedPortions: 500 })], data, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.title.includes("Abweichung"))).toBe(true);
  });
});
