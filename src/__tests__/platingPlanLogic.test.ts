import { describe, expect, it } from "vitest";
import {
  splitMealIntoRuns, DEFAULT_PLATING_PARAMS, firstRunPctForWeek,
  generatePlatingPlan, computeDayLoads,
} from "../features/plating-plan/platingPlanLogic";
import type { DataBundle } from "../core/types";

const params = (firstRunPct: number) => ({ ...DEFAULT_PLATING_PARAMS, firstRunPct });

describe("splitMealIntoRuns", () => {
  it("≤ 2250 → 1 Run mit +10 % Buffer", () => {
    const s = splitMealIntoRuns(845, params(0.7));
    expect(s.runCount).toBe(1);
    expect(s.bufferedTotal).toBe(930); // 845 * 1.10
    expect(s.runs[0].portions).toBe(930);
  });

  it("> 2250 → 2 Runs mit +5 % Buffer, Run 1 = firstRun%", () => {
    const s = splitMealIntoRuns(8244, params(0.7));
    expect(s.runCount).toBe(2);
    expect(s.bufferedTotal).toBe(8656); // 8244 * 1.05
    expect(s.runs[0].portions).toBe(6059); // round(8656 * 0.70)
    expect(s.runs[1].portions).toBe(8656 - 6059);
  });

  it("reproduziert Sheet-Werte W37 (70 %)", () => {
    // FV4101A: Demand 9915 → 10411, Run 1 7288
    const s = splitMealIntoRuns(9915, params(0.7));
    expect(s.bufferedTotal).toBe(10411);
    expect(s.runs[0].portions).toBe(7288);
  });

  it("Grenzfall knapp über 2250 → 2 Runs", () => {
    const s = splitMealIntoRuns(2355, params(0.7));
    expect(s.runCount).toBe(2);
    expect(s.bufferedTotal).toBe(2473);
  });

  it("0 Demand → keine Runs", () => {
    expect(splitMealIntoRuns(0, params(0.7)).runCount).toBe(0);
  });
});

describe("firstRunPctForWeek", () => {
  it("kennt die Sheet-Wochen", () => {
    expect(firstRunPctForWeek("2026-W29")).toBe(0.62);
    expect(firstRunPctForWeek("2026-W31")).toBe(0.66);
    expect(firstRunPctForWeek("2026-W37")).toBe(0.70);
    expect(firstRunPctForWeek("2026-W40")).toBe(0.70);
  });
});

function fakeData(): DataBundle {
  const mk = (code: string, benl: number, dkse: number, de: number, name: string) => ({
    hfWeek: "2026-W37", weekShort: "W37", code, recipeName: name, preference: "Keto",
    slot: { BENL: benl, DKSE: dkse, DE: de },
    verdenVolume: { BENL: benl, DKSE: dkse, DE: de },
    totalVerdenVolume: benl + dkse + de, productionBuffer: 0,
  });
  return {
    generatedAt: "", weeks: ["2026-W37"],
    weekRecipes: [
      mk("FV0257A", 3985, 2567, 1692, "Greek beef"),
      mk("FV4101A", 4566, 3300, 2049, "Sticky Salmon"),
      mk("FV0651A", 371, 244, 230, "BBQ Chickpeas"),
    ],
    recipes: {
      FV4101A: {
        code: "FV4101A", baseName: "Sticky Salmon", grossIngredients: {},
        markets: { BENL: { market: "BENL", msku: "", recipeNameLocal: "", allergens: "fish,soya", subRecipes: [], ingredients: [] } },
      },
    } as unknown as DataBundle["recipes"],
    cookSchedules: {}, structures: {},
  } as DataBundle;
}

describe("generatePlatingPlan", () => {
  it("baut Meals der KW, verplant Runs auf Tage, hält CPT (bis Do)", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    expect(plan.meals).toHaveLength(3);
    expect(plan.firstRunPct).toBe(0.70);

    // Seafood-Meal erkannt
    const salmon = plan.meals.find(m => m.code === "FV4101A")!;
    expect(salmon.seafood).toBe(true);
    // Seafood Run 1 frühestens Mittwoch
    expect(["Mi", "Do"]).toContain(salmon.runs[0].day);

    // jedes Meal hat Run 1 an einem Tag ≤ Do
    for (const m of plan.meals) {
      expect(["Di", "Mi", "Do"]).toContain(m.runs[0].day);
    }

    // kleines Meal = 1 Run, großes = 2
    expect(plan.meals.find(m => m.code === "FV0651A")!.runCount).toBe(1);
    expect(plan.meals.find(m => m.code === "FV0257A")!.runCount).toBe(2);
  });

  it("computeDayLoads summiert Portionen je Tag", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    const loads = computeDayLoads(plan);
    const total = loads.reduce((s, l) => s + l.portions, 0);
    const planTotal = plan.meals.flatMap(m => m.runs).reduce((s, r) => s + r.portions, 0);
    expect(total).toBe(planTotal);
  });
});
