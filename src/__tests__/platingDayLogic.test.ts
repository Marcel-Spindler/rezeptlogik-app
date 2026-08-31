import { describe, expect, it } from "vitest";
import {
  applyDayPlanMoves, generateDayPlan, generateAllDayPlans, summarizeDayPlan, recomputeDayPlan,
} from "../features/plating-plan/platingDayLogic";
import { DEFAULT_PLATING_PARAMS } from "../features/plating-plan/platingPlanLogic";
import type { PlatingMealPlan, PlatingWeekPlan } from "../features/plating-plan/platingPlanTypes";

const params = { ...DEFAULT_PLATING_PARAMS, firstRunPct: 0.7 };

function meal(
  code: string, name: string, allergens: string,
  runs: { runIndex: number; portions: number; day: PlatingMealPlan["runs"][number]["day"] }[],
  subMealCount = 3,
): PlatingMealPlan {
  const total = runs.reduce((s, r) => s + r.portions, 0);
  return {
    code, name, preference: "Keto",
    demand: { benl: total, nord: 0, de: 0 }, totalDemand: total, bufferedTotal: total,
    runCount: runs.length, runs, allergens, seafood: /fish|salmon|shrimp/i.test(name),
    stations: [], complexity: 1, subMealCount,
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

  it("gleiche Allergene, anderes Protein → KEIN Changeover (rein allergen-getrieben)", () => {
    const plan = weekPlan(
      [
        meal("A", "Grilled Chicken", "milk", [{ runIndex: 1, portions: 1200, day: "Di" }]),
        meal("B", "Beef Chili", "milk", [{ runIndex: 1, portions: 1100, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    const co = dp.lines[0].slots.find(s => s.changeoverBeforeMin > 0);
    expect(co).toBeUndefined();
    expect(dp.lines[0].changeovers).toBe(0);
  });

  it("Besetzung = Sub-Meals + 1 je Slot, Spitze/Pers.-h rollen hoch", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 1800, day: "Di" }], 4),
        meal("B", "Cream Chicken", "milk", [{ runIndex: 1, portions: 1500, day: "Di" }], 2),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    const bySlot = Object.fromEntries(dp.lines[0].slots.map(s => [s.code, s.headcount]));
    expect(bySlot.A).toBe(5); // 4 + 1
    expect(bySlot.B).toBe(3); // 2 + 1
    expect(dp.lines[0].peakHeadcount).toBe(5);
    const s = summarizeDayPlan(dp);
    expect(s.peakHeadcount).toBe(5);
    expect(s.manHours).toBeGreaterThan(0);
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

describe("Phase 3 — Allergen-Reihenfolge & Linien", () => {
  it("Allergen nur zufügen (milk → milk,sulphites) = easy changeover, keine Reinigung", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 1500, day: "Di" }]),
        meal("B", "Cream Chicken", "milk,sulphites", [{ runIndex: 1, portions: 1400, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const l1 = generateDayPlan(plan, "Di").lines[0];
    expect(l1.slots.map(s => s.code)).toEqual(["A", "B"]); // wenig → viel Allergene
    expect(l1.slots[1].changeoverReason).toBe("easy");
    expect(l1.slots[1].changeoverBeforeMin).toBe(params.changeoverEasyMin);
    expect(l1.changeovers).toBe(0);        // keine Saubermach-Aktion
    expect(l1.easyChangeovers).toBe(1);
  });

  it("Allergen wegnehmen (milk,sulphites → milk) = volle Reinigung", () => {
    const wp = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 1400, day: "Di" }]),
        meal("B", "Cream Chicken", "milk,sulphites", [{ runIndex: 1, portions: 1500, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(wp, "Di");
    // Reihenfolge erzwingen: B vor A → Wegfall von sulphites
    const flipped = { ...dp, lines: dp.lines.map(l => ({ ...l, slots: [...l.slots].reverse() })) };
    const re = recomputeDayPlan(flipped, wp);
    const aSlot = re.lines[0].slots[1];
    expect(aSlot.code).toBe("A");
    expect(aSlot.changeoverReason).toBe("allergen");
    expect(aSlot.changeoverBeforeMin).toBe(params.changeoverAllergenMin);
    expect(re.lines[0].changeovers).toBe(1);
  });

  it("L1 Highrunner = größter sauberer Block mit 0 Reinigungen, L2 nimmt die Reinigungen", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 4000, day: "Di" }]),
        meal("B", "Cream Chicken", "milk,sulphites", [{ runIndex: 1, portions: 3500, day: "Di" }]),
        meal("C", "Sesame Chicken", "sesame,soya", [{ runIndex: 1, portions: 3000, day: "Di" }]),
        meal("D", "Peanut Chicken", "peanuts", [{ runIndex: 1, portions: 2500, day: "Di" }]),
      ],
      { Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    expect(dp.lines[0].role).toBe("highrunner");
    expect(dp.lines[0].changeovers).toBe(0);
    expect(dp.lines[0].slots.map(s => s.code).sort()).toEqual(["A", "B"]); // milk-Kette
    expect(dp.lines[1].slots.map(s => s.code).sort()).toEqual(["C", "D"]);
  });

  it("nutzt nur 2 Linien, auch wenn 3 besetzt sind (L3 erst bei Überlauf)", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 3000, day: "Di" }]),
        meal("B", "Sesame Chicken", "sesame", [{ runIndex: 1, portions: 2500, day: "Di" }]),
      ],
      { Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    expect(dp.lines.length).toBeLessThanOrEqual(2);
    expect(dp.lines.every(l => l.role !== "overload")).toBe(true);
  });

  it("öffnet L3 (Overload) wenn L1+L2 das Volumen nicht fassen", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 30000, day: "Di" }]),
        meal("B", "Sesame Chicken", "sesame", [{ runIndex: 1, portions: 25000, day: "Di" }]),
        meal("C", "Peanut Beef", "peanuts", [{ runIndex: 1, portions: 20000, day: "Di" }]),
      ],
      { Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    expect(dp.lines.length).toBe(3);
    expect(dp.lines[2].role).toBe("overload");
  });

  it("Seafood-Carry-over wird als kritisch markiert (harte Deadline)", () => {
    const plan = weekPlan(
      [meal("F", "Sticky Salmon", "fish", [{ runIndex: 1, portions: 30000, day: "Do" }])],
      { Do: { lines: 1, hours: 4 } },
    );
    const dp = generateDayPlan(plan, "Do");
    expect(dp.carryOutToNext[0]?.critical).toBe(true);
  });

  it("sequenziert eine Linie aufsteigend nach Allergen-Anzahl", () => {
    const plan = weekPlan(
      [
        meal("A", "Chicken Trio", "milk,sulphites,celery", [{ runIndex: 1, portions: 1000, day: "Di" }]),
        meal("B", "Plain Chicken", "", [{ runIndex: 1, portions: 1200, day: "Di" }]),
        meal("C", "Milk Chicken", "milk", [{ runIndex: 1, portions: 1100, day: "Di" }]),
        meal("D", "Milk Sulph Chicken", "milk,sulphites", [{ runIndex: 1, portions: 900, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const l1 = generateDayPlan(plan, "Di").lines[0];
    expect(l1.slots.map(s => s.code)).toEqual(["B", "C", "D", "A"]);
    expect(l1.changeovers).toBe(0); // reine Zufüge-Kette
  });
});

describe("applyDayPlanMoves", () => {
  const wp = () => weekPlan(
    [
      meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 3000, day: "Di" }]),
      meal("B", "Cream Chicken", "milk,sulphites", [{ runIndex: 1, portions: 2500, day: "Di" }]),
      meal("C", "Sesame Beef", "sesame,soya", [{ runIndex: 1, portions: 2000, day: "Di" }]),
    ],
    { Di: { lines: 3, hours: 22 } },
  );

  it("verschiebt einen Slot auf eine andere Linie und rechnet neu", () => {
    const dp = generateDayPlan(wp(), "Di");
    const l1codes = dp.lines[0].slots.map(s => s.code);
    const moveCode = l1codes[l1codes.length - 1] ?? dp.lines[1]?.slots[0]?.code;
    const target = dp.lines.length > 1 ? 2 : 1;
    const { dayPlan, applied, skipped } = applyDayPlanMoves(dp, wp(), [
      { code: moveCode, toLine: target },
    ]);
    expect(skipped).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(dayPlan.source).toBe("edited");
    const placedAfter = dayPlan.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0)
      + dayPlan.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(placedAfter).toBe(7500);
  });

  it("ordnet innerhalb einer Linie um (toIndex)", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 1500, day: "Di" }]),
        meal("B", "Plain Chicken", "", [{ runIndex: 1, portions: 1400, day: "Di" }]),
        meal("C", "Milk Sulph Chicken", "milk,sulphites", [{ runIndex: 1, portions: 1300, day: "Di" }]),
      ],
      { Di: { lines: 1, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    expect(dp.lines[0].slots.map(s => s.code)).toEqual(["B", "A", "C"]);
    // C an den Anfang ziehen
    const { dayPlan } = applyDayPlanMoves(dp, plan, [{ code: "C", toLine: 1, toIndex: 0 }]);
    expect(dayPlan.lines[0].slots.map(s => s.code)).toEqual(["C", "B", "A"]);
    expect(dayPlan.lines[0].slots[0].changeoverBeforeMin).toBe(0);
  });

  it("meldet unbekannte Codes / Linien als skipped", () => {
    const dp = generateDayPlan(wp(), "Di");
    const { skipped } = applyDayPlanMoves(dp, wp(), [
      { code: "ZZ999", toLine: 1 },
      { code: "A", toLine: 9 },
    ]);
    expect(skipped).toHaveLength(2);
  });

  it("kann eine neue Overload-Linie öffnen, wenn die Tageskapazität es zulässt", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 3000, day: "Di" }]),
        meal("B", "Sesame Beef", "sesame", [{ runIndex: 1, portions: 2500, day: "Di" }]),
      ],
      { Di: { lines: 3, hours: 22 } },
    );
    const dp = generateDayPlan(plan, "Di");
    expect(dp.lines.length).toBeLessThanOrEqual(2);
    const { dayPlan, skipped } = applyDayPlanMoves(dp, plan, [
      { code: "B", toLine: dp.lines.length + 1 },
    ]);
    expect(skipped).toHaveLength(0);
    expect(dayPlan.lines.length).toBe(dp.lines.length + 1);
    expect(dayPlan.lines[dayPlan.lines.length - 1].slots.map(s => s.code)).toEqual(["B"]);
  });
});

describe("Restkapazität aller Linien (durchziehen statt Carry-over)", () => {
  it("verplant so viel wie möglich, Portionen bleiben über Linien + Carry-over erhalten", () => {
    const plan = weekPlan(
      [
        meal("A", "Herb Chicken", "milk", [{ runIndex: 1, portions: 6000, day: "Di" }]),
        meal("B", "Cream Chicken", "milk", [{ runIndex: 1, portions: 5000, day: "Di" }]),
        meal("C", "Butter Chicken", "milk", [{ runIndex: 1, portions: 4000, day: "Di" }]),
      ],
      { Di: { lines: 2, hours: 6 } }, // 2 × 6h × 900 = 10800 Kapazität, 15000 Bedarf
    );
    const dp = generateDayPlan(plan, "Di");
    const placed = dp.lines.flatMap(l => l.slots).reduce((s, sl) => s + sl.portions, 0);
    const carry = dp.carryOutToNext.reduce((s, c) => s + c.portions, 0);
    expect(placed + carry).toBe(15000);
    // beide Linien nahe Kapazität ausgereizt (kein "grundlos Carry-over")
    for (const l of dp.lines) {
      expect(l.platingMin + l.changeoverMin).toBeGreaterThan(l.availableMin * 0.9);
    }
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
