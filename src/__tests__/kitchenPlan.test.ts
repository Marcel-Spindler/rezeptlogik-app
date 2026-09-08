import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { PlatingDay, PlatingWeekPlan } from "../features/plating-plan/platingPlanTypes";
import { DEFAULT_PLATING_PARAMS } from "../features/plating-plan/platingPlanLogic";
import {
  describeKitchenPlan, generateKitchenPlan, kitchenDayFor, summarizeKitchenPlan,
} from "../features/kitchen-plan/kitchenPlanLogic";
import type { KitchenDayPlan, KitchenSubJob, KitchenWeekPlan } from "../features/kitchen-plan/kitchenPlanTypes";

// ── Fixtures ────────────────────────────────────────────────────────────────

const sub = (id: string, name: string, category: string, grams: number) =>
  ({ id, name, category, yield: grams, yieldUom: "g" });

function fakeData(): DataBundle {
  const wr = (code: string, name: string, total: number) => ({
    hfWeek: "2026-W37", weekShort: "W37", code, recipeName: name, preference: "Keto",
    slot: {}, verdenVolume: { BENL: total, DKSE: 0, DE: 0 },
    totalVerdenVolume: total, productionBuffer: 0,
  });
  return {
    generatedAt: "", weeks: ["2026-W37"],
    weekRecipes: [
      wr("FV0001A", "Beef braise", 3000),
      wr("FV0002A", "Chicken brine", 5000),
      wr("FV0003A", "Weekend fish", 2000),
    ],
    recipes: {
      FV0001A: {
        code: "FV0001A", baseName: "Beef braise", grossIngredients: {},
        markets: { BENL: { market: "BENL", msku: "", recipeNameLocal: "", allergens: "milk",
          subRecipes: [sub("beef-braise", "Beef", "BRAISER", 180), sub("tomato-sauce", "Tomato sauce", "IMMERSION BLENDER/SAUCE", 60)], ingredients: [] } },
      },
      FV0002A: {
        code: "FV0002A", baseName: "Chicken brine", grossIngredients: {},
        markets: { BENL: { market: "BENL", msku: "", recipeNameLocal: "", allergens: "milk,mustard",
          subRecipes: [sub("chicken-brine", "Chicken", "BRAISER/BRINE/OVEN", 200), sub("tomato-sauce", "Tomato sauce", "IMMERSION BLENDER/SAUCE", 60)], ingredients: [] } },
      },
      FV0003A: {
        code: "FV0003A", baseName: "Weekend fish", grossIngredients: {},
        markets: { BENL: { market: "BENL", msku: "", recipeNameLocal: "", allergens: "fish",
          subRecipes: [sub("fish-fillet", "Fish", "OVEN", 160)], ingredients: [] } },
      },
    } as unknown as DataBundle["recipes"],
    processSpecs: {
      "beef-braise": { subRecipeId: "beef-braise", name: "Beef", batchSizeKg: 50, minutesPerBatch: { Braiser: 40 }, holdTimeMin: {} },
      "chicken-brine": { subRecipeId: "chicken-brine", name: "Chicken", batchSizeKg: 100, minutesPerBatch: { Braiser: 20, Oven: 10 }, holdTimeMin: {} },
      "tomato-sauce": { subRecipeId: "tomato-sauce", name: "Tomato sauce", batchSizeKg: 200, minutesPerBatch: { "Immersion Blender": 15 }, holdTimeMin: {} },
      "fish-fillet": { subRecipeId: "fish-fillet", name: "Fish", batchSizeKg: 40, minutesPerBatch: { Oven: 12 }, holdTimeMin: {} },
    } as unknown as DataBundle["processSpecs"],
    cookSchedules: {}, structures: {},
  } as DataBundle;
}

function platingPlan(meals: {
  code: string; name: string; allergens?: string; seafood?: boolean; complexity?: number | null;
  runs: { runIndex: number; day: PlatingDay; portions: number }[];
}[]): PlatingWeekPlan {
  return {
    week: "2026-W37",
    params: { ...DEFAULT_PLATING_PARAMS, firstRunPct: 0.7 },
    generatedAt: "", updatedAt: "", source: "generated",
    dayCapacity: {},
    meals: meals.map(m => ({
      code: m.code, name: m.name, preference: "Keto",
      demand: { benl: 0, nord: 0, de: 0 }, totalDemand: 0,
      bufferedTotal: m.runs.reduce((s, r) => s + r.portions, 0),
      runCount: m.runs.length, runs: m.runs,
      allergens: m.allergens ?? "", seafood: m.seafood ?? false, stations: [],
      complexity: m.complexity ?? null, subMealCount: 0,
    })),
  };
}

const allJobs = (dp: KitchenDayPlan | undefined): KitchenSubJob[] =>
  (dp?.shifts ?? []).flatMap(s => s.blocks).flatMap(b => b.jobs);
const job = (plan: KitchenWeekPlan, day: PlatingDay, subId: string): KitchenSubJob | undefined =>
  allJobs(plan.days[day]).find(j => j.subRecipeId === subId);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("kitchenDayFor", () => {
  it("normaler Rückwärts-Vorlauf klemmt auf Mo–Fr (Sonntag NUR über die Sauce-Regel)", () => {
    expect(kitchenDayFor("Do", 1)).toBe("Mi");
    expect(kitchenDayFor("Di", 1)).toBe("Mo");
    expect(kitchenDayFor("Di", 2)).toBe("Mo");   // würde So sein → auf Mo geklemmt
    expect(kitchenDayFor("Mo", 1)).toBe("Mo");
    expect(kitchenDayFor("Mi", 3)).toBe("Mo");
  });
  it("Wochenend-Plating rechnet gegen Freitag (Küche Sa zu)", () => {
    expect(kitchenDayFor("Sa", 1)).toBe("Fr");
    expect(kitchenDayFor("Sa", 3)).toBe("Mi");
  });
});

describe("generateKitchenPlan", () => {
  it("verteilt Sub-Meals auf Küchentage nach Cook-Schedule-Vorlauf", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0001A", name: "Beef braise", allergens: "milk", runs: [{ runIndex: 1, day: "Do", portions: 1000 }] }]),
    );
    const beef = job(plan, "Mi", "beef-braise")!;
    expect(beef).toBeDefined();
    expect(beef.area).toBe("Braiser");
    expect(beef.cookDay).toBe("Mi");
    expect(beef.platingDays).toEqual(["Do"]);
    expect(beef.kg).toBe(180);            // 1000 × 180 g / 1000
    expect(beef.batches).toBe(4);          // ceil(180 / 50)
    expect(beef.activeCookMin).toBe(160);  // 4 × 40
  });

  it("2-Shift-Schedule zieht den Kochtag zwei Tage vor", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0002A", name: "Chicken brine", runs: [{ runIndex: 1, day: "Do", portions: 1000 }] }]),
    );
    const chicken = job(plan, "Di", "chicken-brine")!;
    expect(chicken.cookShifts).toBe(2);
    expect(chicken.cookDay).toBe("Di");
  });

  it("Sauce für frühes Plating (≤ Mi) landet am Sonntag, eine Schicht", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0001A", name: "Beef braise", runs: [{ runIndex: 1, day: "Di", portions: 1000 }] }]),
    );
    const sauce = job(plan, "So", "tomato-sauce")!;
    expect(sauce.longPrep).toBe(true);
    expect(sauce.cookDay).toBe("So");
    expect(sauce.shift).toBe("tag");
    expect(plan.days.So!.shiftModel).toBe(1);
  });

  it("Sauce für spätes Plating (> Mi) NICHT am Sonntag — normaler Vorlauf", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0001A", name: "Beef braise", runs: [{ runIndex: 1, day: "Fr", portions: 1000 }] }]),
    );
    expect(job(plan, "So", "tomato-sauce")).toBeUndefined();
    // Fr − 1 (1 Shift) = Do
    expect(job(plan, "Do", "tomato-sauce")).toBeDefined();
  });

  it("nur die Run-Menge bis zum Cutoff landet am Sonntag, der Rest normal", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([
        { code: "FV0001A", name: "Beef braise", runs: [{ runIndex: 1, day: "Di", portions: 800 }] },
        { code: "FV0002A", name: "Chicken brine", runs: [{ runIndex: 1, day: "Fr", portions: 1200 }] },
      ]),
    );
    // tomato-sauce speist Di (≤ Di-Cutoff) UND Fr — nur die 800 vom Di-Run auf Sonntag
    expect(job(plan, "So", "tomato-sauce")!.portions).toBe(800);
    // die 1200 vom Fr-Run laufen normal: Fr − 1 Shift = Do
    expect(job(plan, "Do", "tomato-sauce")!.portions).toBe(1200);
  });

  it("Mehrschicht-Prozesse (Brine/Marinade) kommen auf den Sonntag", () => {
    // chicken-brine: 2-Shift-Schedule, Plating Di (≤ Mi) → Sonntag
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0002A", name: "Chicken brine", runs: [{ runIndex: 1, day: "Di", portions: 1000 }] }]),
    );
    expect(job(plan, "So", "chicken-brine")).toBeDefined();
    expect(job(plan, "So", "chicken-brine")!.cookShifts).toBe(2);
  });

  it("Sonntag-Kapazität: nur so viel wie in eine Schicht passt, Rest → Montag", () => {
    const data = fakeData();
    // drei Braiser-Saucen für Di-Plating, je 400 aktive Min → nur eine passt in
    // die Sonntag-Schicht (sundayShiftMin 675), die anderen zwei → Montag.
    for (const id of ["sauce-a", "sauce-b", "sauce-c"]) {
      const code = `FV01${id.slice(-1).toUpperCase()}0A`;
      (data.recipes as Record<string, unknown>)[code] = {
        code, baseName: id, grossIngredients: {},
        markets: { BENL: { market: "BENL", allergens: "", subRecipes: [sub(id, `${id} sauce`, "BRAISER/SAUCE", 60)], ingredients: [] } },
      };
      (data.processSpecs as Record<string, unknown>)[id] = { subRecipeId: id, batchSizeKg: 100000, minutesPerBatch: { Braiser: 400 }, holdTimeMin: {} };
      data.weekRecipes.push({ hfWeek: "2026-W37", weekShort: "W37", code, recipeName: id, preference: "Keto",
        slot: {}, verdenVolume: { BENL: 500, DKSE: 0, DE: 0 }, totalVerdenVolume: 500, productionBuffer: 0 } as never);
    }
    const plan = generateKitchenPlan(data, platingPlan([
      { code: "FV01A0A", name: "sauce-a", runs: [{ runIndex: 1, day: "Di", portions: 500 }] },
      { code: "FV01B0A", name: "sauce-b", runs: [{ runIndex: 1, day: "Di", portions: 500 }] },
      { code: "FV01C0A", name: "sauce-c", runs: [{ runIndex: 1, day: "Di", portions: 500 }] },
    ]));
    const onSunday = ["sauce-a", "sauce-b", "sauce-c"].filter(id => job(plan, "So", id));
    const onMonday = ["sauce-a", "sauce-b", "sauce-c"].filter(id => job(plan, "Mo", id));
    expect(onSunday).toHaveLength(1);
    expect(onMonday).toHaveLength(2);
  });

  it("Werktage laufen Früh + Spät", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV0001A", name: "Beef braise", runs: [{ runIndex: 1, day: "Do", portions: 1000 }] }]),
    );
    expect(plan.days.Mi!.shiftModel).toBe(2);
    expect(job(plan, "Mi", "beef-braise")!.shift).toMatch(/früh|spät/);
  });

  it("aggregiert dasselbe Sub-Rezept über zwei Meals + sammelt Allergene", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([
        { code: "FV0001A", name: "Beef braise", allergens: "milk", runs: [{ runIndex: 1, day: "Di", portions: 1000 }] },
        { code: "FV0002A", name: "Chicken brine", allergens: "milk,mustard", runs: [{ runIndex: 1, day: "Di", portions: 2000 }] },
      ]),
    );
    const sauce = job(plan, "So", "tomato-sauce")!;
    expect(sauce.feedsMeals.map(m => m.code).sort()).toEqual(["FV0001A", "FV0002A"]);
    expect(sauce.portions).toBe(3000);
    expect(sauce.allergens).toContain("milk");
    expect(sauce.allergens).toContain("mustard");
  });

  it("sequenziert eine Station allergen-aufsteigend + zählt Reinigungen", () => {
    // drei Braiser-Subs am selben Tag/Schicht, unterschiedliche Allergene:
    //  none → milk → milk (aufsteigend, keine Reinigung); Reinigung nur bei Wegfall.
    const data = fakeData();
    (data.recipes as Record<string, unknown>).FV0007A = {
      code: "FV0007A", baseName: "Multi", grossIngredients: {},
      markets: { BENL: { market: "BENL", allergens: "", subRecipes: [
        sub("s-clean", "Plain veg", "BRAISER", 100),
        sub("s-milk", "Creamy", "BRAISER", 100),
        sub("s-nuts", "Nutty", "BRAISER", 100),
      ], ingredients: [] } },
    };
    (data.processSpecs as Record<string, unknown>)["s-clean"] = { subRecipeId: "s-clean", batchSizeKg: 100, minutesPerBatch: { Braiser: 10 }, holdTimeMin: {} };
    (data.processSpecs as Record<string, unknown>)["s-milk"] = { subRecipeId: "s-milk", batchSizeKg: 100, minutesPerBatch: { Braiser: 10 }, holdTimeMin: {} };
    (data.processSpecs as Record<string, unknown>)["s-nuts"] = { subRecipeId: "s-nuts", batchSizeKg: 100, minutesPerBatch: { Braiser: 10 }, holdTimeMin: {} };
    data.weekRecipes.push({ hfWeek: "2026-W37", weekShort: "W37", code: "FV0007A", recipeName: "Multi", preference: "Keto",
      slot: {}, verdenVolume: { BENL: 900, DKSE: 0, DE: 0 }, totalVerdenVolume: 900, productionBuffer: 0 } as never);

    // ein Meal, drei Subs mit verschiedenen Allergenen — Meal-Allergene decken alle ab
    const plan = generateKitchenPlan(data, platingPlan([
      { code: "FV0007A", name: "Multi", allergens: "milk,nuts", runs: [{ runIndex: 1, day: "Mi", portions: 300 }] },
    ]));
    // subs teilen alle die Meal-Allergene "milk,nuts" → keine echte Reinigung, aber Sequenz stabil
    const braiserBlocks = (plan.days.Di?.shifts ?? []).concat(plan.days.Mo?.shifts ?? [])
      .flatMap(s => s.blocks).filter(b => b.area === "Braiser");
    expect(braiserBlocks.length).toBeGreaterThan(0);
    expect(braiserBlocks[0].cleanCount).toBe(0);
    // Sequenz: erster Job hat startMin 0, folgende bauen darauf auf
    const seqJobs = braiserBlocks[0].jobs;
    expect(seqJobs[0].startMin).toBe(0);
    if (seqJobs.length > 1) expect(seqJobs[1].startMin).toBeGreaterThanOrEqual(seqJobs[0].endMin);
  });

  it("Override setzt Kochtag + Schicht", () => {
    const pp = platingPlan([{ code: "FV0001A", name: "Beef braise", runs: [{ runIndex: 1, day: "Do", portions: 1000 }] }]);
    const plan = generateKitchenPlan(fakeData(), pp, undefined, { "beef-braise": { cookDay: "Mo", shift: "spät" } });
    expect(job(plan, "Mi", "beef-braise")).toBeUndefined();
    const beef = job(plan, "Mo", "beef-braise")!;
    expect(beef.cookDay).toBe("Mo");
    expect(beef.shift).toBe("spät");
    expect(beef.overridden).toBe(true);
  });

  it("fixierte Reihenfolge (order-Override) gewinnt über Allergen-Auto", () => {
    const data = fakeData();
    const pp = platingPlan([
      { code: "FV0001A", name: "Beef braise", allergens: "milk", runs: [{ runIndex: 1, day: "Di", portions: 1000 }] },
      { code: "FV0002A", name: "Chicken brine", allergens: "milk", runs: [{ runIndex: 1, day: "Di", portions: 1000 }] },
    ]);
    // beide Sub-Meals liegen auf So (Sauce). Fixiere tomato-sauce vor irgendwas via order.
    const plan = generateKitchenPlan(data, pp, undefined, {
      "tomato-sauce": { order: 0 },
    });
    const so = plan.days.So!;
    const blk = so.shifts.flatMap(s => s.blocks).find(b => b.jobs.some(j => j.subRecipeId === "tomato-sauce"))!;
    expect(blk.jobs[0].subRecipeId).toBe("tomato-sauce");
    expect(blk.jobs[0].manualOrder).toBe(true);
  });

  it("Meals ohne Sub-Rezept-Stammdaten landen in unresolvedMeals", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([{ code: "FV9999A", name: "Unbekannt", runs: [{ runIndex: 1, day: "Do", portions: 500 }] }]),
    );
    expect(plan.unresolvedMeals).toContain("FV9999A");
    expect(Object.keys(plan.days)).toHaveLength(0);
  });
});

describe("summarizeKitchenPlan / describeKitchenPlan", () => {
  it("liefert KPI-Summen und einen lesbaren Kurztext", () => {
    const plan = generateKitchenPlan(
      fakeData(),
      platingPlan([
        { code: "FV0001A", name: "Beef braise", allergens: "milk", runs: [{ runIndex: 1, day: "Do", portions: 1000 }] },
        { code: "FV0002A", name: "Chicken brine", allergens: "milk,mustard", runs: [{ runIndex: 1, day: "Do", portions: 2000 }] },
      ]),
    );
    const kpi = summarizeKitchenPlan(plan);
    expect(kpi.jobs).toBeGreaterThan(0);
    expect(kpi.kg).toBeGreaterThan(0);
    expect(kpi.days).toBeGreaterThan(0);

    const text = describeKitchenPlan(plan);
    expect(text).toContain("Kochplan 2026-W37");
    expect(text).toMatch(/Frühschicht|Spätschicht|Tag/);
  });
});
