import { describe, expect, it } from "vitest";
import type { KetRow } from "../features/ket-plan/ketTypes";
import { computeRunAssignments, shiftLabel, shiftWindow } from "../features/ket-plan/ketRunLogic";

function makeRow(overrides: Partial<KetRow>): KetRow {
  return {
    key: overrides.key ?? "k",
    dateNeeded: "2026-08-17 - 1",
    shift: "1",
    woNumber: "35-1",
    recipeId: "REC-001",
    recipeCode: "FV0001A",
    recipeName: "Test recipe",
    subRecipeName: "Test sauce",
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

describe("shift model", () => {
  it("maps shift 1/2 to the confirmed clock windows", () => {
    expect(shiftWindow("1")).toEqual({ label: "Frühschicht", start: "06:00", end: "14:00" });
    expect(shiftWindow("2")).toEqual({ label: "Spätschicht", start: "14:00", end: "22:00" });
    expect(shiftLabel("1")).toBe("Frühschicht (06:00–14:00 Uhr)");
  });

  it("returns null for an unconfirmed shift number rather than guessing", () => {
    expect(shiftWindow("3")).toBeNull();
    expect(shiftLabel("")).toBeNull();
  });
});

describe("run assignment (computeRunAssignments)", () => {
  it("keeps a single-day meal entirely in Run 1, marked as not split", () => {
    const rows = [
      makeRow({ key: "a", dateNeeded: "2026-08-17 - 1", targetPortions: 500 }),
      makeRow({ key: "b", dateNeeded: "2026-08-17 - 1", subRecipeName: "Other sub", targetPortions: 500 }),
    ];
    const assignments = computeRunAssignments(rows);
    expect(assignments.get("a")!.run).toBe(1);
    expect(assignments.get("b")!.run).toBe(1);
    expect(assignments.get("a")!.isSplit).toBe(false);
  });

  it("splits a high-volume meal across the week once cumulative volume crosses the 70% default threshold", () => {
    // Mo+Di+Mi = 1500 von 2000 (75%) → Run 1; Do = 500 (25%) → Run 2.
    const rows = [
      makeRow({ key: "mo", dateNeeded: "2026-08-17 - 1", targetPortions: 500 }),
      makeRow({ key: "di", dateNeeded: "2026-08-18 - 1", targetPortions: 500 }),
      makeRow({ key: "mi", dateNeeded: "2026-08-19 - 2", targetPortions: 500 }),
      makeRow({ key: "do", dateNeeded: "2026-08-20 - 1", targetPortions: 500 }),
    ];
    const assignments = computeRunAssignments(rows);
    expect(assignments.get("mo")!.run).toBe(1);
    expect(assignments.get("di")!.run).toBe(1);
    expect(assignments.get("mi")!.run).toBe(1);
    expect(assignments.get("do")!.run).toBe(2);
    expect(assignments.get("mo")!.isSplit).toBe(true);
  });

  it("keeps every sub-recipe row of the same meal+day in the same run (run is meal- and day-wide, not per sub-recipe)", () => {
    const rows = [
      makeRow({ key: "mo-base", dateNeeded: "2026-08-17 - 1", subRecipeName: "Base", targetPortions: 1500 }),
      makeRow({ key: "mo-rice", dateNeeded: "2026-08-17 - 1", subRecipeName: "Rice", targetPortions: 1500 }),
      makeRow({ key: "do-base", dateNeeded: "2026-08-20 - 1", subRecipeName: "Base", targetPortions: 500 }),
    ];
    const assignments = computeRunAssignments(rows);
    expect(assignments.get("mo-base")!.run).toBe(1);
    expect(assignments.get("mo-rice")!.run).toBe(1);
    expect(assignments.get("do-base")!.run).toBe(2);
  });

  it("respects a custom firstRunPct instead of the 70% default", () => {
    const rows = [
      makeRow({ key: "mo", dateNeeded: "2026-08-17 - 1", targetPortions: 500 }),
      makeRow({ key: "di", dateNeeded: "2026-08-18 - 1", targetPortions: 500 }),
    ];
    // 50%-Schwelle: Tag 1 startet bei 0 < 250 → Run 1; Tag 2 startet bei 500 (bereits über der 250-Schwelle) → Run 2.
    const assignments = computeRunAssignments(rows, 50);
    expect(assignments.get("mo")!.run).toBe(1);
    expect(assignments.get("di")!.run).toBe(2);
  });

  it("keeps meals of different recipeCodes fully independent", () => {
    const rows = [
      makeRow({ key: "a1", recipeCode: "FV0001A", dateNeeded: "2026-08-17 - 1", targetPortions: 100 }),
      makeRow({ key: "a2", recipeCode: "FV0001A", dateNeeded: "2026-08-20 - 1", targetPortions: 900 }),
      makeRow({ key: "b1", recipeCode: "FV0002A", dateNeeded: "2026-08-17 - 1", targetPortions: 100 }),
    ];
    const assignments = computeRunAssignments(rows);
    // FV0001A: Tag1 (100/1000=10%) < 70% → Run1; Tag2 startet bei 100 (10%) < 70% → auch noch Run1
    // (ein einzelner riesiger zweiter Tag kann Run 1 "überziehen" — siehe Kommentar in ketRunLogic.ts).
    expect(assignments.get("a1")!.run).toBe(1);
    // FV0002A hat nur einen Tag → Run 1, nicht gesplittet.
    expect(assignments.get("b1")!.run).toBe(1);
    expect(assignments.get("b1")!.isSplit).toBe(false);
  });
});
