import { describe, expect, it } from "vitest";
import { combineBackfillSignals, detectCrossSourceAlerts } from "../features/backfills/combineBackfills";
import type { BackfillNeed } from "../features/gsheet-monitor/postblastMatch";
import type { LinePlaitingData, LinePlaitingRow } from "../features/gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../features/redzone-live/redzoneTypes";
import type { StoredRow } from "../features/wms-overview/wmsTypes";
import type { WmsSkuInfo } from "../lib/wmsSkuEnrichment";

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
    day: "Tuesday", time: "06:00 - 06:30", phase: "shortage", recipeCode: "FV0001A", meal: "Test Meal",
    plannedPortions: 1000, actualPortions: 800, deltaPortions: -200, comment: "", backfillConfirmed: true,
    minNeededPortions: null, shortageReason: "Sauce short", shortagePct: 20,
    ...overrides,
  };
}

function linePlaitingData(rows: LinePlaitingRow[]): LinePlaitingData {
  const byRecipeCode = new Map<string, LinePlaitingRow[]>();
  for (const r of rows) {
    if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
    byRecipeCode.get(r.recipeCode)!.push(r);
  }
  return { rows, byRecipeCode, dayTotals: [], lastUpdated: Date.now() };
}

describe("combineBackfillSignals", () => {
  it("marks a meal as confirmed when both kitchen and plating report a shortage", () => {
    const combined = combineBackfillSignals(
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
    const combined = combineBackfillSignals([], linePlaitingData([plaitingRow({})]), null);
    expect(combined).toHaveLength(1);
    expect(combined[0].confidence).toBe("plating-only");
    expect(combined[0].kitchenMissingKg).toBe(0);
  });

  it("marks a meal kitchen-only when only Postblast sees a shortage", () => {
    const combined = combineBackfillSignals([kitchenNeed({})], null, null);
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
    const combined = combineBackfillSignals([kitchenNeed({})], data, null);
    expect(combined[0].minNeededPortions).toBe(150);
    expect(combined[0].backfillResultPortions).toBe(220);
    expect(combined[0].backfillResultComments).toContain("Done");
  });

  it("does not invent a shortage for a meal with only positive deltas (surplus)", () => {
    const data = linePlaitingData([plaitingRow({ deltaPortions: 50, actualPortions: 1050, shortageReason: "" })]);
    const combined = combineBackfillSignals([], data, null);
    expect(combined[0].platingShortagePortions).toBe(0);
  });

  it("recommends Friday's Min Needs over the raw plating shortage when both exist", () => {
    const data = linePlaitingData([
      plaitingRow({}), // Di: -200 shortage
      plaitingRow({ day: "Friday", phase: "min-needs", deltaPortions: -50, minNeededPortions: 260, shortageReason: "" }),
    ]);
    const combined = combineBackfillSignals([kitchenNeed({ estimatedPortions: 999 })], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(260);
    expect(combined[0].recommendedSource).toBe("min-needs");
  });

  it("falls back to the measured plating shortage when no Min Needs exists yet", () => {
    const data = linePlaitingData([plaitingRow({})]); // nur Di, noch keine Fr/Sa-Zeilen
    const combined = combineBackfillSignals([], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(200);
    expect(combined[0].recommendedSource).toBe("plating");
  });

  it("falls back to the kitchen weight-based estimate when no plating data exists at all", () => {
    const combined = combineBackfillSignals([kitchenNeed({ estimatedPortions: 150 })], null, null);
    expect(combined[0].recommendedBackfillPortions).toBe(150);
    expect(combined[0].recommendedSource).toBe("kitchen");
  });

  it("does NOT net a Saturday plating run against the recommendation — its meaning is unconfirmed", () => {
    // FV0713A aus der echten W35-Auswertung: Fr Min Needs 260, Sa zeigt eigenes
    // Planned/Actual (1160/1296) — das sieht wie ein regulärer Plating-Tag aus,
    // nicht zwingend wie die gefahrene Backfill-Menge (siehe Kommentar in
    // combineBackfills.ts). Verrechnen würde bei vielen echten Meals fälschlich
    // "0 nötig" zeigen, deshalb bleibt Sa rein informativ.
    const data = linePlaitingData([
      plaitingRow({}),
      plaitingRow({ day: "Friday", phase: "min-needs", deltaPortions: -1216, minNeededPortions: 260, shortageReason: "Peppers-Short" }),
      plaitingRow({ day: "Saturday", phase: "result", deltaPortions: 136, actualPortions: 1296, comment: "Done", shortageReason: "" }),
    ]);
    const combined = combineBackfillSignals([], data, null);
    expect(combined[0].recommendedBackfillPortions).toBe(260);
    expect(combined[0].recommendedSource).toBe("min-needs");
    expect(combined[0].backfillResultPortions).toBe(1296); // weiterhin sichtbar, nur nicht verrechnet
  });
});

describe("combineBackfillSignals — Redzone enrichment", () => {
  it("attaches a live Redzone count to an existing kitchen/plating entry without changing the recommendation", () => {
    const combined = combineBackfillSignals(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ outCount: 75, status: "active" })],
    );
    expect(combined[0].liveRedzonePortions).toBe(75);
    expect(combined[0].liveRedzoneStatus).toBe("active");
    expect(combined[0].recommendedBackfillPortions).toBe(100); // unveraendert von der Kueche
  });

  it("sums multiple Redzone runs (e.g. two lines) for the same meal", () => {
    const combined = combineBackfillSignals(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ outCount: 30 }), redzoneRun({ outCount: 20, locationName: "Line 2" })],
    );
    expect(combined[0].liveRedzonePortions).toBe(50);
  });

  it("ignores non-Plating areas (Ovens/Braisers) and runs without a resolved meal code", () => {
    const combined = combineBackfillSignals(
      [kitchenNeed({})],
      null,
      null,
      [redzoneRun({ areaName: "Ovens", outCount: 999 }), redzoneRun({ mealCode: null, outCount: 999 })],
    );
    expect(combined[0].liveRedzonePortions).toBeNull();
  });

  it("does not create a new meal entry purely from a Redzone run with no kitchen/plating signal", () => {
    const combined = combineBackfillSignals([], null, null, [redzoneRun({})]);
    expect(combined).toHaveLength(0);
  });

  it("defaults to null when no Redzone data is passed (e.g. running online without the local WMS server)", () => {
    const combined = combineBackfillSignals([kitchenNeed({})], null, null);
    expect(combined[0].liveRedzonePortions).toBeNull();
    expect(combined[0].liveRedzoneStatus).toBeNull();
  });
});

describe("combineBackfillSignals — WMS Plating Holding enrichment", () => {
  it("converts grams to kg and attaches the live Plating-Holding stock to a matching meal", () => {
    const rows = [storedRow({ itemNumber: "SUB-001", actualQty: 5000 })];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}]]);
    const combined = combineBackfillSignals([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBe(5);
  });

  it("sums multiple PLH locations/lots for the same resolved recipe", () => {
    const rows = [
      storedRow({ itemNumber: "SUB-001", actualQty: 3000, locationId: "PLH-01" }),
      storedRow({ itemNumber: "SUB-002", actualQty: 2000, locationId: "PLH-02" }),
    ];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}], ["SUB-002", {}]]);
    const combined = combineBackfillSignals([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBe(5);
  });

  it("ignores non-SUB SKUs (e.g. finished packaged meals) to avoid mixing units", () => {
    const rows = [storedRow({ itemNumber: "MSKU-001", actualQty: 500 })];
    const skuInfoIndex = skuInfoIndexWith([["MSKU-001", { category: "MSKU" }]]);
    const combined = combineBackfillSignals([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });

  it("ignores rows whose SKU cannot be resolved to a recipe at all", () => {
    const rows = [storedRow({ itemNumber: "UNKNOWN-SKU", actualQty: 5000 })];
    const skuInfoIndex = skuInfoIndexWith([["SUB-001", {}]]);
    const combined = combineBackfillSignals([kitchenNeed({})], null, null, undefined, rows, skuInfoIndex);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });

  it("defaults to null when no WMS Holding data is passed (server unreachable)", () => {
    const combined = combineBackfillSignals([kitchenNeed({})], null, null);
    expect(combined[0].liveWmsHoldingKg).toBeNull();
  });
});

describe("detectCrossSourceAlerts", () => {
  // Post-Blast (Küche) und Plating sind zwei EIGENSTÄNDIGE Kontrollpunkte —
  // ein plating-only-Fund ist deshalb KEINE Unstimmigkeit, die einen Alert
  // braucht (das war der ursprüngliche Denkfehler). Er ist ein vollwertiger
  // eigener Backfill-Bedarf, sichtbar über priority/recommendedBackfillPortions
  // in der Meal-Liste selbst, nicht über einen separaten "Früherkennung"-Alert.
  it("does NOT raise a cross-source alert for a plating-only shortage — that's a normal, independent finding", () => {
    const combined = combineBackfillSignals([], linePlaitingData([plaitingRow({})]), null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.recipeCode === "FV0001A")).toBe(false);
  });

  it("raises an info-level forward-looking note for a critical kitchen-only deficit not yet seen at plating", () => {
    const combined = combineBackfillSignals([kitchenNeed({ priority: "critical" })], null, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.severity === "info" && a.recipeCode === "FV0001A")).toBe(true);
  });

  it("does not alert when both sources agree closely on the missing amount", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 100, shortageReason: "" }),
    ]);
    const combined = combineBackfillSignals([kitchenNeed({ estimatedPortions: 105 })], data, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.title.includes("Abweichung"))).toBe(false);
  });

  it("flags a large deviation between Friday's Min Needs and the weight-based estimate", () => {
    const data = linePlaitingData([
      plaitingRow({ day: "Friday", phase: "min-needs", minNeededPortions: 100, shortageReason: "" }),
    ]);
    const combined = combineBackfillSignals([kitchenNeed({ estimatedPortions: 500 })], data, null);
    const alerts = detectCrossSourceAlerts(combined);
    expect(alerts.some(a => a.title.includes("Abweichung"))).toBe(true);
  });
});
