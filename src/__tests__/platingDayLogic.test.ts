import { describe, expect, it } from "vitest";
import { generateDayPlan, generateAllDayPlans, summarizeDayPlan, recomputeDayPlan } from "../features/plating-plan/platingDayLogic";
import { DEFAULT_PLATING_PARAMS } from "../features/plating-plan/platingPlanLogic";
import type { PlatingMealPlan, PlatingWeekPlan } from "../features/plating-plan/platingPlanTypes";

const params = { ...DEFAULT_PLATING_PARAMS, firstRunPct: 0.7 };

function meal(
  code: string, name: string, allergens: string,
  runs: { runIndex: number; portions: number; day: PlatingMealPlan["runs"][number]["day"] }[],
): PlatingMealPlan {
  const total = runs.reduce((s, r) => s + r.portions, 0);
  return {
    code, name, preference: "Keto",
    demand: { benl: total, nord: 0, de: 0 }, totalDemand: total, bufferedTotal: total,
    runCount: runs.length, runs, allergens, seafood: /fish|salmon|shrimp/i.test(name),
    stations: [], complexity: 1,
  };
}

function weekPlan(meals: PlatingMealPlan[], cap: PlatingWeekPlan["dayCapacity"], p = params): PlatingWeekPlan {
  return {
    week: "2026-W37", params: p, generatedAt: "", updatedAt: "",
    meals, dayCapacity: cap, source: "generated",
  };
}

describe("generateDayPlan", () => {
  it("verplant die Runs eines Tages auf Linien, Portionen bleiben erhalten", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 3000, day: "Di" }]),
        meal("B", "Chicken Alfredo", "milk", [{ runIndex: 1, portions: 2000, day: "Di" }]),
      ],
      { Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    const placed = dp.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0);
    const carry = dp.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(placed + carry).toBe(5000);
    expect(dp.lines[0].role).toBe("highrunner");
  });

  it("gleiche Allergene nacheinander → kein Umrüsten; andere → Umrüstzeit", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk,sulphites", [{ runIndex: 1, portions: 1500, day: "Di" }]),
        meal("B", "Cream Chicken", "milk,sulphites", [{ runIndex: 1, portions: 1400, day: "Di" }]),
        meal("C", "Sesame Chicken", "sesame,soya", [{ runIndex: 1, portions: 1300, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    const l1 = dp.lines[0];
    // A und B teilen die Allergensignatur → dazwischen 0; zu C hin ein Wechsel
    const changeoverSlots = l1.slots.filter(s => s.changeoverBeforeMin > 0);
    expect(changeoverSlots.length).toBe(1);
    expect(changeoverSlots[0].changeoverBeforeMin).toBe(params.changeoverAllergenMin);
  });

  it("Protein-Typ-Wechsel kostet mehr als ein Allergen-Wechsel", () => {
    const plan = weekPlan(
      [
        meal("A", "Grilled Chicken", "milk", [{ runIndex: 1, portions: 1200, day: "Di" }]),
        meal("B", "Beef Chili", "milk", [{ runIndex: 1, portions: 1100, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    const co = dp.lines[0].slots.find(s => s.changeoverBeforeMin > 0);
    expect(co?.changeoverReason).toBe("protein");
    expect(co?.changeoverBeforeMin).toBe(params.changeoverProteinMin);
  });

  it("zu wenig Kapazität → Carry-over auf den Folgetag, Portionen konserviert", () => {
    const plan = weekPlan(
      [meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 20000, day: "Di" }])],
      { Di: { lines: 1, hours: 4 } }, // 4h * 900 = 3600 Kapazität
    );
    const dp = generateDayPlan(plan, "Di");
    const placed = dp.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0);
    const carry = dp.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(carry).toBeGreaterThan(0);
    expect(placed + carry).toBe(20000);
    expect(placed).toBeLessThanOrEqual(3700);
  });

  it("kein Linien-Kapazität → alles Carry-over", () => {
    const plan = weekPlan(
      [meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 1000, day: "Mo" }])],
      { Mo: { lines: 0, hours: 0 }, Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Mo");
    expect(dp.lines).toHaveLength(0);
    expect(dp.carryOutToNext.reduce((s, c) => s + c.portions, 0)).toBe(1000);
  });
});

describe("generateAllDayPlans", () => {
  it("reicht Carry-over von Tag zu Tag durch", () => {
    const plan = weekPlan(
      [meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 12000, day: "Di" }])],
      { Di: { lines: 1, hours: 4 }, Mi: { lines: 3, hours: 22 } },
    );
    const all = generateAllDayPlans(plan);
    expect(all.Di?.carryOutToNext.length).toBeGreaterThan(0);
    // der Rest taucht Mi als Carry-in auf und wird dort verplant
    expect(all.Mi?.carryInFromPrev.length).toBeGreaterThan(0);
    const miPlaced = all.Mi!.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0);
    expect(miPlaced).toBeGreaterThan(0);
  });
});

describe("recomputeDayPlan", () => {
  it("rechnet Umrüsten nach manueller Umsortierung neu", () => {
    const wp = weekPlan(
      [
        meal("A", "Grilled Chicken", "milk", [{ runIndex: 1, portions: 1500, day: "Di" }]),
        meal("B", "Sesame Chicken", "sesame", [{ runIndex: 1, portions: 1400, day: "Di" }]),
        meal("C", "Cream Chicken", "milk", [{ runIndex: 1, portions: 1300, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(wp, "Di");
    // Sequenz umdrehen → Umrüst-Zeiten müssen sich neu berechnen
    const flipped = { ...dp, lines: dp.lines.map(l => ({ ...l, slots: [...l.slots].reverse() })) };
    const re = recomputeDayPlan(flipped, wp);
    expect(re.source).toBe("edited");
    expect(re.lines[0].slots[0].changeoverBeforeMin).toBe(0); // erster Slot nie Umrüsten
    const total = re.lines[0].slots.reduce((s, sl) => s + sl.portions, 0)
      + re.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(total).toBe(4200);
  });

  it("Slot auf eine andere (volle) Linie → Carry-over", () => {
    const wp = weekPlan(
      [
        meal("A", "Chicken", "milk", [{ runIndex: 1, portions: 3000, day: "Di" }]),
        meal("B", "Beef", "milk", [{ runIndex: 1, portions: 2000, day: "Di" }]),
      ],
      { Di: { lines: 2, hours: 3 } }, // je Linie 3h*900 = 2700
    );
    const dp = generateDayPlan(wp, "Di");
    // alles auf Linie 1 schieben
    const l1slots = dp.lines.flatMap(l => l.slots);
    const jammed = {
      ...dp,
      lines: [
        { ...dp.lines[0], slots: l1slots },
        { ...dp.lines[1], slots: [] },
      ],
    };
    const re = recomputeDayPlan(jammed, wp);
    const placed = re.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0);
    const carry = re.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(carry).toBeGreaterThan(0);
    expect(placed + carry).toBe(5000);
  });
});

describe("summarizeDayPlan", () => {
  it("zählt Slots, Wechsel und Carry-over", () => {
    const plan = weekPlan(
      [
        meal("A", "Grilled Chicken", "milk", [{ runIndex: 1, portions: 1500, day: "Di" }]),
        meal("B", "Beef Chili", "soya", [{ runIndex: 1, portions: 1400, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const s = summarizeDayPlan(generateDayPlan(plan, "Di"));
    expect(s.slots).toBe(2);
    expect(s.changeovers).toBe(1);
    expect(s.totalPortions).toBe(2900);
  });
});
