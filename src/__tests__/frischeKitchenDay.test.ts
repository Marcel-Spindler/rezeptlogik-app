import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { PlanningSheetData } from "../lib/planningSheetApi";
import { buildV2Data } from "../features/ket-plan/frischeV2Logic";

// Minimal-Bundle: 1 Rezept, 1 PHF-Zutat 200 g/Portion, keine Cook-Schedule
// (→ Fallback shifts = 1, leadDays = 2).
const data = {
  weekRecipes: [{ hfWeek: "2026-W39", code: "FV1351A", recipeName: "Test", preference: "CS", totalVerdenVolume: 6846 }],
  recipes: {
    FV1351A: {
      code: "FV1351A", baseName: "Test", markets: {},
      grossIngredients: {
        DE: [{ subRecipe1: "Sauce", ingredient: "Sahne", ingredientId: "SKU-1", ingredientCategory: "PHF", grossQuantityPerPortion: 200, uom: "grams" }],
      },
    },
  },
  cookSchedules: {},
} as unknown as DataBundle;

const catFilter = new Set(["PHF"] as const);

function planSheet(rowExtra: Partial<PlanningSheetData["rows"][number]>): PlanningSheetData {
  return {
    week: "2026-W39", tabName: "W39", shiftModel: "dual", fetchedAt: Date.now(),
    rows: [{
      code: "FV1351A", name: "Test", preference: "CS", total: 6846, totalBuffer: 7188,
      stations: { Oven: true },
      days: { Wednesday: 5000, Friday: 2000 }, // Plating
      ...rowExtra,
    }],
  };
}

describe("Frischeliste – Küchenplan-Kochtag (Zweischicht)", () => {
  it("Kochtag = Plating-Tag − 1: identisch zum klassischen Plating-Pfad", () => {
    // Plating-Pfad (kein kitchenDays): Wed 5000 → geliefert Mo, Fr 2000 → geliefert Mi
    const platingOnly = buildV2Data(data, planSheet({ kitchenDays: undefined }), catFilter);
    // Küchen-Pfad, Kochtag = Plating − 1 (Di / Do): Di 5000 → geliefert Mo, Do 2000 → geliefert Mi
    const withKitchen = buildV2Data(data, planSheet({ kitchenDays: { Tuesday: 5000, Thursday: 2000 } }), catFilter);

    expect(withKitchen.daysKg).toEqual(platingOnly.daysKg);
    expect(withKitchen.daysKg.Monday).toBeCloseTo(1000); // 5000 Portionen * 200 g / 1000
    expect(withKitchen.daysKg.Wednesday).toBeCloseTo(400);
  });

  it("abweichender Kochtag verschiebt den Anlieferungstag entsprechend", () => {
    // Kochtag Montag statt Dienstag → Anlieferung Sonntag statt Montag.
    const shifted = buildV2Data(data, planSheet({ kitchenDays: { Monday: 5000, Thursday: 2000 } }), catFilter);
    expect(shifted.daysKg.Monday).toBe(0);
    expect(shifted.daysKg.Sunday).toBeCloseTo(1000);
    expect(shifted.daysKg.Wednesday).toBeCloseTo(400); // Do-Kochtag unverändert → Mi Anlieferung
  });

  it("Einschicht-Woche (kein kitchenDays) bleibt auf dem Plating-Pfad", () => {
    const single = buildV2Data(
      data,
      { week: "2026-W39", tabName: "W39", shiftModel: "single", fetchedAt: Date.now(), rows: [{
        code: "FV1351A", name: "Test", preference: "CS", total: 6846, totalBuffer: 7188,
        stations: { Oven: true }, days: { Wednesday: 5000 },
      }] },
      catFilter,
    );
    expect(single.daysKg.Monday).toBeCloseTo(1000); // Wed − 2
  });
});
