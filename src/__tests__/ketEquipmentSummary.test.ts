import { describe, expect, it } from "vitest";
import type { KetRow, BatchCalc, GnTraySummary, ScoopInfo } from "../features/ket-plan/ketTypes";
import type { RunInfo } from "../features/ket-plan/ketRunLogic";
import type { ChillerAssignment } from "../features/blast-chiller/blastChillerLogic";
import {
  computeEquipmentDemand,
  computeFullResourceDemand,
  formatFullResourceAsText,
  formatFullResourceAsHtml,
} from "../features/ket-plan/ketEquipmentSummary";

function makeRow(overrides: Partial<KetRow> & { key: string; woNumber: string; dateNeeded: string }): KetRow {
  return {
    shift: "1",
    recipeId: "REC-001",
    recipeCode: "FV0001A",
    recipeName: "Test",
    subRecipeName: "Test Sub",
    cookMethods: [],
    woCookedPortions: null,
    targetPortions: 100,
    cookedPortionsExcess: null,
    stagingStatus: "",
    stagingComment: "",
    kitchenStatus: "",
    unlockedEta: "",
    workOrderComment: "",
    ...overrides,
  };
}

function makeCalc(overrides: Partial<BatchCalc> & { equipBatches: BatchCalc["equipBatches"] }): BatchCalc {
  return {
    totalKg: 80,
    primaryEquip: overrides.equipBatches[0]?.equip ?? null,
    capacityKg: overrides.equipBatches[0]?.capacityKg ?? null,
    batches: overrides.equipBatches[0]?.batches ?? 0,
    perBatchKg: overrides.equipBatches[0]?.perBatchKg ?? 0,
    remainderKg: 0,
    resolvedCookMethods: overrides.equipBatches.map(e => e.equip),
    ingredients: [],
    recipeFound: true,
    subRecipeFound: true,
    cookingInstructions: null,
    subRecipeInstructions: null,
    subRecipeInstructionsDE: null,
    subRecipeInstructionsGermanFallback: false,
    rti: false,
    neverBatch: false,
    factorCapacityKg: null,
    factorBatches: null,
    factorBatchQtyKg: null,
    factorFallbackCapacity: false,
    readyMade: false,
    allergensContains: [],
    chillerAssignment: null,
    uomWarnings: [],
    factorOverridesEquip: false,
    components: [],
    gnTraySummary: [],
    scoopInfo: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// COMPAT: computeEquipmentDemand
// ═══════════════════════════════════════════════════════════════════════

describe("computeEquipmentDemand (compat)", () => {
  const rows: KetRow[] = [
    makeRow({ key: "wo::1", woNumber: "34-1", dateNeeded: "2026-08-18 - 1" }),
    makeRow({ key: "wo::2", woNumber: "34-2", dateNeeded: "2026-08-18 - 1" }),
    makeRow({ key: "wo::3", woNumber: "34-3", dateNeeded: "2026-08-18 - 2" }),
    makeRow({ key: "wo::4", woNumber: "34-4", dateNeeded: "2026-08-19 - 1" }),
  ];

  const calcs = new Map<string, BatchCalc>([
    ["wo::1", makeCalc({ equipBatches: [
      { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 2, perBatchKg: 40, remainderKg: 0, utilizationPct: 50 },
      { equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 1, perBatchKg: 30, remainderKg: 0, utilizationPct: 50 },
    ]})],
    ["wo::2", makeCalc({ equipBatches: [
      { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 3, perBatchKg: 26.67, remainderKg: 0, utilizationPct: 33 },
    ]})],
    ["wo::3", makeCalc({ equipBatches: [
      { equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 2, perBatchKg: 40, remainderKg: 0, utilizationPct: 67 },
    ]})],
    ["wo::4", makeCalc({ equipBatches: [
      { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 1, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 },
    ]})],
  ]);

  it("gruppiert nach Tag+Schicht", () => {
    const result = computeEquipmentDemand(rows, calcs);
    expect(result.byDayShift).toHaveLength(3);
    expect(result.byDayShift[0].date).toBe("2026-08-18");
    expect(result.byDayShift[0].woCount).toBe(2);
  });

  it("summiert Batches pro Equipment", () => {
    const result = computeEquipmentDemand(rows, calcs);
    const braiser = result.byDayShift[0].equipment.find(e => e.equip === "BRAISER");
    expect(braiser!.totalBatches).toBe(5);
  });

  it("erkennt Peaks", () => {
    const result = computeEquipmentDemand(rows, calcs);
    const braiserPeak = result.weekPeaks.find(p => p.equip === "BRAISER");
    expect(braiserPeak!.peakBatches).toBe(5);
  });

  it("behandelt fehlende BatchCalcs gracefully", () => {
    const result = computeEquipmentDemand(rows, new Map());
    expect(result.byDayShift[0].equipment).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// computeFullResourceDemand
// ═══════════════════════════════════════════════════════════════════════

describe("computeFullResourceDemand", () => {
  const gnSummary: GnTraySummary[] = [{ gnType: "GN 2/1", trays: 5 }];
  const scoop: ScoopInfo = { methodType: "SCOOP", methodColor: "grey", yieldGrams: 125, yieldUom: "grams" };
  const chillerMilk: ChillerAssignment = { key: "4", allergen: "MILCH", cfg: { label: "Chiller 4", sub: "Milch", headBg: "", headColor: "", cntBg: "", cntColor: "" }, unknown: false };
  const chillerFree: ChillerAssignment = { key: "1", allergen: "KEINE", cfg: { label: "Chiller 1 & 2", sub: "Allergenfrei", headBg: "", headColor: "", cntBg: "", cntColor: "" }, unknown: false };

  const rows: KetRow[] = [
    makeRow({ key: "wo::1", woNumber: "34-1", dateNeeded: "2026-08-18 - 1" }),
    makeRow({ key: "wo::2", woNumber: "34-2", dateNeeded: "2026-08-18 - 1" }),
    makeRow({ key: "wo::3", woNumber: "34-3", dateNeeded: "2026-08-19 - 1" }),
  ];

  const calcs = new Map<string, BatchCalc>([
    ["wo::1", makeCalc({
      equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 2, perBatchKg: 40, remainderKg: 0, utilizationPct: 50 }],
      resolvedCookMethods: ["BRAISER"],
      gnTraySummary: gnSummary,
      scoopInfo: scoop,
      allergensContains: ["MILCH"],
      chillerAssignment: chillerMilk,
    })],
    ["wo::2", makeCalc({
      equipBatches: [{ equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 1, perBatchKg: 50, remainderKg: 0, utilizationPct: 83 }],
      resolvedCookMethods: ["OVEN"],
      gnTraySummary: [{ gnType: "GN 2/1", trays: 8 }],
      scoopInfo: null,
      allergensContains: ["FISCH"],
      chillerAssignment: chillerFree,
    })],
    ["wo::3", makeCalc({
      equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 3, perBatchKg: 26.67, remainderKg: 0, utilizationPct: 33 }],
      resolvedCookMethods: ["BRAISER"],
      gnTraySummary: [],
      scoopInfo: scoop,
      allergensContains: [],
      chillerAssignment: chillerMilk,
    })],
  ]);

  const runAssignments = new Map<string, RunInfo>([
    ["wo::1", { run: 1, cumulativeSharePct: 0.5, isSplit: true }],
    ["wo::2", { run: 1, cumulativeSharePct: 0.7, isSplit: true }],
    ["wo::3", { run: 2, cumulativeSharePct: 1.0, isSplit: true }],
  ]);

  it("trennt nach Run 1 und Run 2", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const run1 = result.byRunDayShift.filter(r => r.run === 1);
    const run2 = result.byRunDayShift.filter(r => r.run === 2);
    expect(run1.length).toBeGreaterThan(0);
    expect(run2.length).toBeGreaterThan(0);
    expect(run1[0].runSharePct).toBe(70);
    expect(run2[0].runSharePct).toBe(30);
  });

  it("aggregiert GN-Trays pro Station", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const run1Day = result.byRunDayShift.find(r => r.run === 1);
    const braiser = run1Day!.stations.find(s => s.station === "BRAISER");
    expect(braiser!.gnTrays).toHaveLength(1);
    expect(braiser!.gnTrays[0].count).toBe(5);
  });

  it("berechnet Ofen-Rack-Ladungen", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments, { ovenRackCapacity: 4 });
    const run1Day = result.byRunDayShift.find(r => r.run === 1);
    const oven = run1Day!.stations.find(s => s.station === "OVEN");
    expect(oven!.ovenLoads).toBe(2);
  });

  it("sammelt Scoops korrekt", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    expect(result.scoopInventory).toHaveLength(1);
    expect(result.scoopInventory[0].methodType).toBe("SCOOP");
    expect(result.scoopInventory[0].count).toBe(2);
  });

  it("ordnet Allergene den richtigen Stationen zu", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const braiserAllergen = result.allergenStationMap.find(a => a.station === "BRAISER");
    expect(braiserAllergen!.allergens).toContain("MILCH");
    const ovenAllergen = result.allergenStationMap.find(a => a.station === "OVEN");
    expect(ovenAllergen!.allergens).toContain("FISCH");
  });

  it("berechnet Blast-Chiller-Slots", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    expect(result.chillerWeekSummary.length).toBeGreaterThan(0);
    const chiller4 = result.chillerWeekSummary.find(c => c.key === "4");
    expect(chiller4).toBeDefined();
    expect(chiller4!.woCount).toBe(2); // wo::1 + wo::3
    expect(chiller4!.woNumbers).toContain("34-1");
    expect(chiller4!.woNumbers).toContain("34-3");
  });

  it("berechnet Gantt-Timeline sequenziell", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const run1Day = result.byRunDayShift.find(r => r.run === 1);
    const stations = run1Day!.stations;
    // Erste Station startet bei 0
    expect(stations[0].ganttStartMin).toBe(0);
    expect(stations[0].ganttEndMin).toBe(stations[0].effectiveMinutes);
    // Zweite Station startet wo erste aufhört
    if (stations.length > 1) {
      expect(stations[1].ganttStartMin).toBe(stations[0].ganttEndMin);
    }
  });

  it("berücksichtigt stationCount für effectiveMinutes", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments, { stationCount: { BRAISER: 2 } });
    const run1Day = result.byRunDayShift.find(r => r.run === 1);
    const braiser = run1Day!.stations.find(s => s.station === "BRAISER");
    // 2 batches × 45min = 90min total, ÷ 2 Geräte = 45min effective
    expect(braiser!.estimatedMinutes).toBe(90);
    expect(braiser!.effectiveMinutes).toBe(45);
    expect(braiser!.deviceCount).toBe(2);
  });

  it("berechnet criticalPathMinutes als Summe der effectiveMinutes", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const run1Day = result.byRunDayShift.find(r => r.run === 1);
    const expectedPath = run1Day!.stations.reduce((s, st) => s + st.effectiveMinutes, 0);
    expect(run1Day!.criticalPathMinutes).toBe(expectedPath);
  });

  it("Engpass basiert auf effectiveMinutes (parallelisiert)", () => {
    // 20 Batches × 45min = 900min total, aber ÷ 3 Braiser = 300min = 5h → KEIN Engpass
    const heavyCalcs = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({ equipBatches: [
        { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 20, perBatchKg: 4, remainderKg: 0, utilizationPct: 5 },
      ]})],
    ]);
    const singleRow = [makeRow({ key: "wo::1", woNumber: "34-1", dateNeeded: "2026-08-18 - 1" })];
    const result = computeFullResourceDemand(singleRow, heavyCalcs, new Map(), { stationCount: { BRAISER: 3 } });
    // 900min ÷ 3 = 300min = 5h < 8h → kein Engpass
    expect(result.bottlenecks).toHaveLength(0);
  });

  it("sortiert Stationen nach PROCESS_ORDER", () => {
    const multiCalcs = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({
        equipBatches: [
          { equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 1, perBatchKg: 50, remainderKg: 0, utilizationPct: 83 },
          { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 1, perBatchKg: 40, remainderKg: 0, utilizationPct: 50 },
        ],
        resolvedCookMethods: ["OVEN", "BRAISER"],
      })],
    ]);
    const singleRow = [makeRow({ key: "wo::1", woNumber: "34-1", dateNeeded: "2026-08-18 - 1" })];
    const result = computeFullResourceDemand(singleRow, multiCalcs, new Map());
    const stations = result.byRunDayShift[0].stations;
    const braiserIdx = stations.findIndex(s => s.station === "BRAISER");
    const ovenIdx = stations.findIndex(s => s.station === "OVEN");
    expect(braiserIdx).toBeLessThan(ovenIdx);
  });

  it("behandelt fehlende runAssignments als Run 1", () => {
    const result = computeFullResourceDemand(rows, calcs, new Map());
    expect(result.byRunDayShift.every(r => r.run === 1)).toBe(true);
  });

  it("formatFullResourceAsText ist lesbar", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const text = formatFullResourceAsText(result);
    expect(text).toContain("STATIONS-RESSOURCEN-PLAN");
    expect(text).toContain("Run 1");
    expect(text).toContain("Gantt");
    expect(text).toContain("BLAST CHILLER");
  });

  it("formatFullResourceAsHtml liefert valides HTML-Snippet", () => {
    const result = computeFullResourceDemand(rows, calcs, runAssignments);
    const html = formatFullResourceAsHtml(result);
    expect(html).toContain("<div");
    expect(html).toContain("Run 1");
    expect(html).toContain("BLAST CHILLER");
    expect(html).toContain("SCOOPS");
  });
});
