import { describe, expect, it } from "vitest";
import type { KetRow } from "../features/ket-plan/ketTypes";
import { buildFreitagsIstMailText } from "../features/vorstellungsplan/istPlanungText";

function row(overrides: Partial<KetRow>): KetRow {
  return {
    key: "test",
    dateNeeded: "2026-09-08 - 1",
    shift: "1",
    woNumber: "WO-100",
    recipeId: "recipe",
    recipeCode: "FV100",
    recipeName: "Test Recipe",
    subRecipeName: "Test Component",
    cookMethods: [],
    woCookedPortions: 100,
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

describe("buildFreitagsIstMailText", () => {
  it("ordnet WOs ab Sonntag nach berechnetem Kochstart und zeigt Fälligkeit samt Shift", () => {
    const text = buildFreitagsIstMailText([
      row({ woNumber: "WO-200", dateNeeded: "2026-09-10 - 2", subRecipeName: "Thursday component" }),
      row({ woNumber: "WO-100", dateNeeded: "2026-09-07 - 1", subRecipeName: "Sunday component" }),
    ], "37");

    expect(text).toContain("Sonntag, 06.09. | 1 WO");
    expect(text).toContain("Mittwoch, 09.09. | 1 WO");
    expect(text).toContain("Kochstart: So., 06.09. | Fällig: Mo 07.09. · Shift 1");
    expect(text.indexOf("WO WO-100")).toBeLessThan(text.indexOf("WO WO-200"));
  });
});