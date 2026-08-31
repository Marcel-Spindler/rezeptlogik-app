import { describe, expect, it } from "vitest";
import {
  splitMealIntoRuns, DEFAULT_PLATING_PARAMS, firstRunPctForWeek, resolvePlatingParams,
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

const profile = (code: string, cx: number) => ({
  code, complexityCx: cx, complexityRaw: cx * 1025, activeCookMin: 400,
  numCookStations: 6, numSubs: 5, bottleneckPortionsPerBatch: 2,
  cookStations: ["BLAST CHILLER", "BRAISER", "OVEN"], allergens: "milk", traces: "", passiveHoldMin: 0,
});

function fakeData(opts: { withProfiles?: boolean } = {}): DataBundle {
  const { withProfiles = true } = opts;
  const mk = (code: string, benl: number, dkse: number, de: number, name: string) => ({
    hfWeek: "2026-W37", weekShort: "W37", code, recipeName: name, preference: "Keto",
    slot: { BENL: benl, DKSE: dkse, DE: de },
    verdenVolume: { BENL: benl, DKSE: dkse, DE: de },
    totalVerdenVolume: benl + dkse + de, productionBuffer: 0,
  });
  const sub = (name: string) => ({ id: name, name, category: "OVEN" });
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
        markets: { BENL: { market: "BENL", msku: "", recipeNameLocal: "", allergens: "fish,soya",
          subRecipes: [sub("a"), sub("b"), sub("c"), sub("d"), sub("e"), sub("f"), sub("g")], ingredients: [] } },
      },
    } as unknown as DataBundle["recipes"],
    ...(withProfiles ? {
      recipeProfiles: {
        FV0257A: profile("FV0257A", 1.30),  // komplex
        FV4101A: profile("FV4101A", 1.00),  // Seafood — cx egal
        FV0651A: profile("FV0651A", 0.55),  // einfach
      } as unknown as DataBundle["recipeProfiles"],
    } : {}),
    cookSchedules: {}, structures: {},
  } as DataBundle;
}

describe("generatePlatingPlan", () => {
  it("baut Meals der KW, verplant Runs auf Tage, hält CPT (bis Do)", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    expect(plan.meals).toHaveLength(3);
    expect(plan.params.firstRunPct).toBe(0.70);

    // Seafood-Meal erkannt
    const salmon = plan.meals.find(m => m.code === "FV4101A")!;
    expect(salmon.seafood).toBe(true);
    // Seafood Run 1 so spät wie möglich → Do
    expect(salmon.runs[0].day).toBe("Do");

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

  it("legt die aufgelösten Params am Plan ab", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37", { firstRunPct: 0.66 });
    expect(plan.params.firstRunPct).toBe(0.66);
    expect(plan.params.singleRunMaxDemand).toBe(2250);
    expect(plan.params.platingRatePerLineHour).toBe(900);
  });
});

describe("resolvePlatingParams", () => {
  it("merged Override auf die KW-Defaults", () => {
    const p = resolvePlatingParams("2026-W31", { singleRunMaxDemand: 3000 });
    expect(p.firstRunPct).toBe(0.66);          // KW-Default bleibt
    expect(p.singleRunMaxDemand).toBe(3000);   // Override greift
  });
  it("klemmt unsinnige Werte", () => {
    const p = resolvePlatingParams("2026-W37", { singleRunBuffer: 9, firstRunPct: -1, platingRatePerLineHour: 0, platerFactor: 99, platingHelpers: -3 });
    expect(p.singleRunBuffer).toBeLessThanOrEqual(0.5);
    expect(p.firstRunPct).toBeGreaterThanOrEqual(0.4);
    expect(p.platingRatePerLineHour).toBeGreaterThanOrEqual(1);
    expect(p.platerFactor).toBeLessThanOrEqual(3);
    expect(p.platingHelpers).toBeGreaterThanOrEqual(0);
  });
  it("Besetzungs-Defaults sind gesetzt", () => {
    const p = resolvePlatingParams("2026-W37");
    expect(p.platerFactor).toBe(0.7);
    expect(p.platingHelpers).toBe(2);
  });
});

describe("assignRunsToDays — Regeln", () => {
  it("Seafood mittlerer Größe: 1. Run Do, ganzer Bedarf an einem Tag", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    const salmon = plan.meals.find(m => m.code === "FV4101A")!;
    expect(salmon.runs[0].day).toBe("Do");
    expect(salmon.runs.filter(r => r.portions > 0)).toHaveLength(1);
    expect(salmon.runs[0].portions).toBe(10411); // 9915 * 1.05, gebündelt
    expect(salmon.runCount).toBe(1);
  });

  it("Großes Seafood wird auf Do + Refire (Fr/Sa) gesplittet", () => {
    // niedrige Rate → Tag ist voll → keine Bündelung
    const plan = generatePlatingPlan(fakeData(), "2026-W37", { platingRatePerLineHour: 30 });
    const salmon = plan.meals.find(m => m.code === "FV4101A")!;
    expect(salmon.runs[0].day).toBe("Do");
    expect(["Fr", "Sa"]).toContain(salmon.runs[1].day);
    expect(salmon.runs[1].portions).toBeGreaterThan(0);
  });

  it("verteilt die 1. Runs statt alles auf Dienstag zu kippen", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    const run1Days = plan.meals.map(m => m.runs[0].day);
    // 3 Meals, nicht alle am selben Tag
    expect(new Set(run1Days).size).toBeGreaterThan(1);
  });

  it("computeDayLoads nutzt die Plan-Rate für overCapacity", () => {
    const hi = generatePlatingPlan(fakeData(), "2026-W37");
    expect(computeDayLoads(hi).some(l => l.overCapacity)).toBe(false);
    const lo = generatePlatingPlan(fakeData(), "2026-W37", { platingRatePerLineHour: 15 });
    expect(computeDayLoads(lo).some(l => l.overCapacity)).toBe(true);
  });
});

describe("Complexity Score", () => {
  it("übernimmt cx aus dem Recipe-Profil", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    expect(plan.meals.find(m => m.code === "FV0257A")!.complexity).toBe(1.30);
    expect(plan.meals.find(m => m.code === "FV0651A")!.complexity).toBe(0.55);
    expect(plan.meals.find(m => m.code === "FV4101A")!.activeCookMin).toBe(400);
  });

  it("ohne Recipe-Profil → grober Fallback aus #Subs", () => {
    const plan = generatePlatingPlan(fakeData({ withProfiles: false }), "2026-W37");
    // FV4101A hat 7 Sub-Rezepte → clamp(7/5, .4, 1.7) = 1.4
    expect(plan.meals.find(m => m.code === "FV4101A")!.complexity).toBe(1.4);
    // FV0257A ohne Rezept-Stammdaten → unbekannt
    expect(plan.meals.find(m => m.code === "FV0257A")!.complexity).toBeNull();
  });

  it("komplexes Meal → 1. Run am frühesten Tag (Di)", () => {
    const plan = generatePlatingPlan(fakeData(), "2026-W37");
    expect(plan.meals.find(m => m.code === "FV0257A")!.runs[0].day).toBe("Di");
  });

  it("einfaches Meal darf Montag (Fill-up), komplexes bleibt auf Di–Do", () => {
    // Mo groß, Di–Do winzig → das einfache Meal weicht auf Montag aus
    const cap = {
      Mo: { lines: 3, hours: 20 }, Di: { lines: 1, hours: 2 }, Mi: { lines: 1, hours: 2 },
      Do: { lines: 1, hours: 2 }, Fr: { lines: 1, hours: 2 }, Sa: { lines: 1, hours: 2 },
    };
    const plan = generatePlatingPlan(fakeData(), "2026-W37", undefined, cap);
    expect(plan.meals.find(m => m.code === "FV0651A")!.runs[0].day).toBe("Mo");
    expect(["Di", "Mi", "Do"]).toContain(plan.meals.find(m => m.code === "FV0257A")!.runs[0].day);
  });
});
