import { describe, expect, it } from "vitest";
import { reconcileWorkOrders, severityByRecipe } from "../features/wo-reconciliation/reconcileWorkOrders";
import type { ProductionPlan, WorkOrderEntry } from "../core/types";
import type { KetRow } from "../features/ket-plan/ketTypes";
import type { PetRow } from "../features/pet-plan/petTypes";
import type { PostblastData, PostblastEntry } from "../features/gsheet-monitor/gsheetTypes";
import type { RecipeWeightLookup } from "../features/gsheet-monitor/parsers/parseExportRecipes";

function woEntry(overrides: Partial<WorkOrderEntry>): WorkOrderEntry {
  return {
    run: 1, kitchenDay: "2026-08-20", workOrder: "35-1", recipeCode: "FV0001A", recipeName: "Test Meal",
    subRecipe: "Test Sub", plannedMeals: 1000, stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0,
    ...overrides,
  };
}

function ketRow(overrides: Partial<KetRow>): KetRow {
  return {
    key: "k1", dateNeeded: "2026-08-20", shift: "1", woNumber: "35-1", recipeId: "REC-1", recipeCode: "FV0001A",
    recipeName: "Test Meal", subRecipeName: "Test Sub", cookMethods: [], woCookedPortions: null,
    targetPortions: 1000, cookedPortionsExcess: null, stagingStatus: "", stagingComment: "", kitchenStatus: "",
    unlockedEta: "", workOrderComment: "",
    ...overrides,
  };
}

function petRow(overrides: Partial<PetRow>): PetRow {
  return {
    key: "p1", shiftKey: "1", shiftTotalTarget: 1000, shiftTotalMapped: 1000, _woNumber: "35-1",
    recipeName: "Test Meal", recipeCode: "FV0001A", market: "DE", mapped: 1000, target: 1000,
    platingStatus: "", manualStatus: "", weekUnlocked: null, weekMapped: null, minNeeds: null,
    expiringDatetime: "", expiringSubRecipe: "", expiringPortions: "", expiringLp: "", comment: "",
    rolloverAmount: null, bestByDate: "", bestBySubRecipe: "",
    ...overrides,
  };
}

function postblastEntry(overrides: Partial<PostblastEntry>): PostblastEntry {
  return {
    timestamp: "2026-08-20T10:00:00Z", date: "2026-08-20", workOrder: "35-1", skuCode: "FV0001A",
    subRecipeName: "Test Sub", rawWeightKg: 100, subSubRecipe: "", postBlastKg: 100, targetKg: 100,
    ...overrides,
  };
}

function postblastData(entries: PostblastEntry[]): PostblastData {
  const byWorkOrder = new Map<string, PostblastEntry[]>();
  for (const e of entries) {
    if (!byWorkOrder.has(e.workOrder)) byWorkOrder.set(e.workOrder, []);
    byWorkOrder.get(e.workOrder)!.push(e);
  }
  return { entries, byWorkOrder, bySubRecipe: new Map(), totalWeightKg: entries.reduce((s, e) => s + e.rawWeightKg, 0), lastEntry: entries[entries.length - 1] ?? null, lastUpdated: Date.now() };
}

function weightsFor(recipeCode: string, subRecipe: string, gramsPerPortion: number): RecipeWeightLookup {
  return { gramsPerPortion: new Map([[`${recipeCode}||${subRecipe}`, gramsPerPortion]]), recipeCount: 1, rowCount: 1 };
}

describe("reconcileWorkOrders", () => {
  it("flags no mismatch when App-Plan and KET agree", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({ postKg: 100 })] };
    const ket = [ketRow({ targetPortions: 1000 })];
    const weights = weightsFor("FV0001A", "Test Sub", 100); // 1000 portions * 100g = 100kg -> matches app
    const rows = reconcileWorkOrders(plan, ket, null, null, weights);
    expect(rows).toHaveLength(1);
    expect(rows[0].kgMismatch).toBe(false);
    expect(rows[0].severity).toBe("ok");
  });

  it("flags a kg mismatch when App-Plan and KET estimate disagree", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({ postKg: 100 })] };
    const ket = [ketRow({ targetPortions: 1000 })];
    const weights = weightsFor("FV0001A", "Test Sub", 200); // 1000 * 200g = 200kg vs app's 100kg -> >15% off
    const rows = reconcileWorkOrders(plan, ket, null, null, weights);
    expect(rows[0].kgMismatch).toBe(true);
    expect(rows[0].appKg).toBe(100);
    expect(rows[0].ketKg).toBe(200);
  });

  it("flags a portions mismatch across App/KET/PET without needing kg data", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({ plannedMeals: 1000 })] };
    const ket = [ketRow({ targetPortions: 1000 })];
    const pet = [petRow({ target: 1400 })]; // >15% off from 1000
    const rows = reconcileWorkOrders(plan, ket, pet, null, null);
    expect(rows[0].portionsMismatch).toBe(true);
    expect(rows[0].severity).toBe("warn");
  });

  it("does not treat an unweighed-but-agreeing WO as a severity mismatch", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({ postKg: 100, plannedMeals: 1000 })] };
    const ket = [ketRow({ targetPortions: 1000 })];
    const weights = weightsFor("FV0001A", "Test Sub", 100);
    const rows = reconcileWorkOrders(plan, ket, null, null, weights);
    // isCritical (nothing weighed yet) is tracked separately from severity —
    // a WO that just hasn't run yet is not a cross-source "Unstimmigkeit".
    expect(rows[0].isCritical).toBe(true);
    expect(rows[0].severity).toBe("ok");
  });

  it("marks a WO missing from PET when PET data is loaded but doesn't cover it", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({})] };
    const pet = [petRow({ _woNumber: "35-2" })]; // different WO -> PET data present, but not for 35-1
    const rows = reconcileWorkOrders(plan, null, pet, null, null);
    expect(rows[0].missingPetAssignment).toBe(true);
    expect(rows[0].severity).toBe("warn");
  });

  it("does not flag missing-PET when no PET data was uploaded at all", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({})] };
    const rows = reconcileWorkOrders(plan, null, null, null, null);
    expect(rows[0].missingPetAssignment).toBe(false);
    expect(rows[0].severity).toBe("ok");
  });

  it("joins actual weighed kg from Postblast for the same WO", () => {
    const plan: ProductionPlan = { week: "2026-W35", generatedAt: "", rows: [woEntry({ postKg: 100 })] };
    const pb = postblastData([postblastEntry({ rawWeightKg: 40 }), postblastEntry({ rawWeightKg: 35 })]);
    const rows = reconcileWorkOrders(plan, null, null, pb, null);
    expect(rows[0].actualKg).toBe(75);
    expect(rows[0].weighingCount).toBe(2);
    expect(rows[0].presentIn).toContain("postblast");
  });

  it("rolls up the worst severity per recipe across multiple WOs", () => {
    const plan: ProductionPlan = {
      week: "2026-W35", generatedAt: "",
      rows: [woEntry({ workOrder: "35-1", postKg: 100 }), woEntry({ workOrder: "35-2", postKg: 100 })],
    };
    const ket = [ketRow({ woNumber: "35-2", targetPortions: 1000 })];
    const weights = weightsFor("FV0001A", "Test Sub", 200); // mismatches WO 35-2 only
    const rows = reconcileWorkOrders(plan, ket, null, null, weights);
    const bySeverity = severityByRecipe(rows);
    expect(bySeverity.get("FV0001A")).toEqual({ severity: "warn", count: 1 });
  });
});
