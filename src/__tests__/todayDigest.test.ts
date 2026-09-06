import { describe, expect, it } from "vitest";
import type { PlannerWeekAnalysis } from "../lib/planner";
import type { WeeklyStationLoad } from "../lib/equipment";
import type { BackfillAlert } from "../features/backfills/backfillTypes";
import type { ShortageEntry } from "../features/gsheet-monitor/gsheetTypes";
import {
  buildBackfillSection,
  buildPlanSection,
  buildReconSection,
  buildStockSection,
  filterReconciliationRowsForWeek,
  summarizeDigest,
} from "../features/today/todayDigest";
import type { WoReconciliationRow } from "../features/wo-reconciliation/woReconcileTypes";

function analysis(over: Partial<PlannerWeekAnalysis>): PlannerWeekAnalysis {
  return {
    week: "2026-W37",
    scenario: { id: "base", name: "Basis", assignments: {} },
    unplannedCount: 0,
    plannedCount: 0,
    recipes: [],
    conflicts: [],
    poolConflicts: [],
    stationLoadBySlot: {},
    poolLoadBySlot: {},
    ...over,
  };
}

const load = (over: Partial<WeeklyStationLoad>): WeeklyStationLoad => ({
  key: "Oven", label: "Ofen", model: "minutes", deviceCount: 2,
  utilizationPct: 50, extraDevicesNeeded: 0, basis: "x", ...over,
});

describe("buildPlanSection", () => {
  it("flags unplanned meals, station conflicts and hot equipment", () => {
    const s = buildPlanSection(
      analysis({
        recipes: [
          { recipeCode: "FV0001A", recipeName: "A", activeMin: 0, totalActiveMin: 0, topStations: [], subRecipes: [] },
          { recipeCode: "FV0002A", recipeName: "B", assigned: { recipeCode: "FV0002A", day: "Di", shift: "S1" }, activeMin: 0, totalActiveMin: 0, topStations: [], subRecipes: [] },
        ],
        conflicts: [
          { station: "Braiser", day: "Mi", shift: "S1", totalMin: 900, capacityMin: 600, deviceCount: 1, utilizationPct: 150, requiredDevices: 2, assignments: [{ recipeCode: "FV0002A", recipeName: "B", minutes: 900 }] },
        ],
      }),
      [load({ key: "Braiser", label: "Braiser", utilizationPct: 110, extraDevicesNeeded: 1 }), load({ utilizationPct: 40 })],
    );
    const texts = s.items.map((i) => i.text);
    expect(texts.some((t) => t.includes("1 Meal") && t.includes("ungeplant"))).toBe(true);
    expect(texts.some((t) => t.includes("Braiser Mi/S1"))).toBe(true);
    expect(texts.some((t) => t.includes("Braiser: 110%"))).toBe(true);
    // critical (150% conflict + 110% load) sorted before the info "unplanned" row
    expect(s.items[0].severity).toBe("critical");
    expect(s.items.find((i) => i.id === "plan-unplanned")?.severity).toBe("info");
    expect(s.view).toBe("planning");
  });

  it("is empty when nothing is wrong", () => {
    expect(buildPlanSection(analysis({}), [load({ utilizationPct: 30 })]).items).toHaveLength(0);
  });
});

describe("buildReconSection", () => {
  it("lists critical before warn and carries the recipe code", () => {
    const m = new Map<string, { severity: "warn" | "critical"; count: number }>([
      ["FV0009A", { severity: "warn", count: 1 }],
      ["FV0003A", { severity: "critical", count: 2 }],
    ]);
    const s = buildReconSection(m);
    expect(s.items[0]).toMatchObject({ severity: "critical", recipeCode: "FV0003A" });
    expect(s.items[1].severity).toBe("warning");
  });

  it("empty map → no items", () => {
    expect(buildReconSection(new Map()).items).toHaveLength(0);
    expect(buildReconSection(null).items).toHaveLength(0);
  });
});

describe("filterReconciliationRowsForWeek", () => {
  it("keeps only rows from the current week", () => {
    const row = (weekNum: number): WoReconciliationRow => ({
      workOrder: `${weekNum}-10`, weekNum, recipeCode: `FV${weekNum}01A`, recipeName: "Meal", subRecipe: "Sauce",
      presentIn: ["app"], appPortions: 1, ketPortions: 1, petTarget: null, petMapped: null,
      appKg: 1, ketKg: 1, actualKg: 1, progressPct: 100, isComplete: true, isCritical: false,
      kgMismatch: false, portionsMismatch: false, missingPetAssignment: false, severity: "warn",
      weighingCount: 1, lastWeighing: null,
    });
    expect(filterReconciliationRowsForWeek([row(35), row(36)], 36)).toHaveLength(1);
    expect(filterReconciliationRowsForWeek([row(35)], null)).toHaveLength(0);
  });
});

describe("buildBackfillSection", () => {
  const alert = (over: Partial<BackfillAlert>): BackfillAlert => ({
    id: "a1", severity: "critical", recipeCode: "FV0001A", recipeName: "A",
    title: "Backfill nötig", message: "80 Portionen", ...over,
  });

  it("keeps critical + warning, drops info, adds stale note", () => {
    const s = buildBackfillSection({
      alerts: [alert({}), alert({ id: "a2", severity: "info" })],
      isStaleWeek: true,
      selectedWeekNum: 36,
      connected: true,
    });
    expect(s.items.filter((i) => i.id.startsWith("bf-a")).length).toBe(1);
    expect(s.items.some((i) => i.text.includes("KW 36"))).toBe(true);
    expect(s.offline).toBeUndefined();
  });

  it("marks offline when no source connected", () => {
    const s = buildBackfillSection({ alerts: [], isStaleWeek: false, selectedWeekNum: null, connected: false });
    expect(s.offline).toBeTruthy();
  });
});

describe("buildStockSection", () => {
  const shortage = (over: Partial<ShortageEntry>): ShortageEntry => ({
    rawWorkOrderSuffix: "10", stagingDay: "2026-09-08", workOrder: "37-10",
    ingredient: "Paprika", sku: "VEG-1", shortKg: 12, recoveryStatus: "", ticketNumber: "",
    notes: "", filled: false, rowIndex: 3, ...over,
  });

  it("ranks new (untriaged) shortages as critical, sorted by kg", () => {
    const s = buildStockSection({
      shortages: [shortage({ shortKg: 5, rowIndex: 1, recoveryStatus: "ordered" }), shortage({ shortKg: 20, rowIndex: 2 })],
    });
    expect(s.items[0].severity).toBe("critical");
    expect(s.items[0].text).toContain("20.0 kg");
    expect(s.items[1].severity).toBe("warning");
  });

  it("drops filled shortages", () => {
    const s = buildStockSection({ shortages: [shortage({ filled: true })] });
    expect(s.items).toHaveLength(0);
  });

  it("offline only when the source is null", () => {
    expect(buildStockSection({ shortages: null }).offline).toBeTruthy();
    expect(buildStockSection({ shortages: [] }).offline).toBeUndefined();
  });
});

describe("summarizeDigest", () => {
  it("counts by severity and detects all-clear", () => {
    const empty = summarizeDigest([
      buildPlanSection(analysis({}), []),
      buildReconSection(new Map()),
    ]);
    expect(empty.allClear).toBe(true);

    const withStuff = summarizeDigest([
      buildReconSection(new Map([["FV0003A", { severity: "critical", count: 1 }]])),
    ]);
    expect(withStuff).toMatchObject({ critical: 1, total: 1, allClear: false });
  });
});
