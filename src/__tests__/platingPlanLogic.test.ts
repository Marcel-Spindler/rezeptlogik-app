import { describe, expect, it } from "vitest";
import {
  splitMealIntoRuns, DEFAULT_PLATING_PARAMS, firstRunPctForWeek, resolvePlatingParams,
  generatePlatingPlan, computeDayLoads, computeRunFeasibility, computeOpenBackfills, nextRunIndex,
  splitUnfinishedRun, clearUnfinishedRun, suggestCarryForwardDay, countUnfinishedMarkers,
} from "../features/plating-plan/platingPlanLogic";
import type { DataBundle } from "../core/types";
import type { PlatingDay, PlatingDayCapacity, PlatingRun, PlatingWeekPlan } from "../features/plating-plan/platingPlanTypes";
import type { CombinedBackfillNeed } from "../features/backfills/backfillTypes";

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

/** Minimaler, handgebauter Wochenplan für Kapazitäts-/Feasibility-Tests, ohne
 *  über den vollen generatePlatingPlan-Weg zu gehen (Fokus rein auf
 *  computeDayLoads/computeRunFeasibility). */
function fakeWeekPlan(
  dayCapacity: Partial<Record<PlatingDay, PlatingDayCapacity>>,
  meals: { code: string; runs: Pick<PlatingRun, "runIndex" | "day" | "portions" | "shift" | "isBackfill">[] }[],
): PlatingWeekPlan {
  return {
    week: "2026-W37",
    params: { ...DEFAULT_PLATING_PARAMS, firstRunPct: 0.7 },
    generatedAt: "", updatedAt: "", source: "generated",
    dayCapacity,
    meals: meals.map(m => ({
      code: m.code, name: m.code, preference: "Keto",
      demand: { benl: 0, nord: 0, de: 0 }, totalDemand: 0,
      bufferedTotal: m.runs.reduce((s, r) => s + r.portions, 0),
      runCount: m.runs.length, runs: m.runs,
      allergens: "", seafood: false, stations: [], complexity: null, subMealCount: 0,
    })),
  };
}

describe("Schicht-Kapazität (7,5h fix)", () => {
  it("computeDayLoads ignoriert einen veralteten hours-Wert bei shifts=2 — fix 2×7,5h", () => {
    const plan = fakeWeekPlan(
      { Di: { lines: 3, hours: 999, shifts: 2 } }, // hours bewusst falsch/veraltet
      [{ code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 1000, shift: "früh" }] }],
    );
    const di = computeDayLoads(plan).find(l => l.day === "Di")!;
    expect(di.availableHours).toBe(15); // 2 × 7,5, NICHT der gespeicherte 999-Wert
    expect(di.shiftLoads?.[0].availableHours).toBe(7.5);
    expect(di.shiftLoads?.[1].availableHours).toBe(7.5);
  });

  it("Tagesgesamt-Kapazität bei shifts=2 bleibt lines × 2×7,5h × rate, unabhängig vom hours-Feld", () => {
    const rate = DEFAULT_PLATING_PARAMS.platingRatePerLineHour; // 900
    const capacityPortions = 3 * 15 * rate; // lines × (2×7,5h) × rate = 40500
    const plan = fakeWeekPlan(
      { Di: { lines: 3, hours: 22, shifts: 2 } }, // hours = alter 1-Schicht-Wert, muss ignoriert werden
      [{ code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: capacityPortions + 1000 }] }],
    );
    const di = computeDayLoads(plan).find(l => l.day === "Di")!;
    expect(di.overCapacity).toBe(true);
    expect(di.neededHours).toBeGreaterThan(15);
  });
});

describe("computeRunFeasibility", () => {
  it("alles passt → fits für jeden Run", () => {
    // Kapazität Di = 1 Linie × 10h × 900/h = 9000 Portionen
    const plan = fakeWeekPlan(
      { Di: { lines: 1, hours: 10, shifts: 1 } },
      [
        { code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 3000 }] },
        { code: "FV0002A", runs: [{ runIndex: 1, day: "Di", portions: 2000 }] },
      ],
    );
    const feas = computeRunFeasibility(plan, "Di");
    expect(feas.get("FV0001A-R1")?.fits).toBe(true);
    expect(feas.get("FV0002A-R1")?.fits).toBe(true);
  });

  it("der die Kapazität sprengende Run trägt den exakten Überschuss", () => {
    // Kapazität = 1 × 10h × 900/h = 9000; 6000 (größter, zuerst) + 4000 = 10000 → 1000 zu viel
    const plan = fakeWeekPlan(
      { Di: { lines: 1, hours: 10, shifts: 1 } },
      [
        { code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 6000 }] },
        { code: "FV0002A", runs: [{ runIndex: 1, day: "Di", portions: 4000 }] },
      ],
    );
    const feas = computeRunFeasibility(plan, "Di");
    expect(feas.get("FV0001A-R1")).toEqual({ fits: true, overflowPortions: 0 });
    expect(feas.get("FV0002A-R1")).toEqual({ fits: false, overflowPortions: 1000 });
  });

  it("Früh-/Spätschicht teilen sich keine Kapazität (kein Leak zwischen Buckets)", () => {
    // shifts=2 → je Schicht fix 7,5h × 1 Linie × 900/h = 6750 Kapazität
    const plan = fakeWeekPlan(
      { Di: { lines: 1, hours: 15, shifts: 2 } },
      [
        { code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 6000, shift: "früh" }] },
        { code: "FV0002A", runs: [{ runIndex: 1, day: "Di", portions: 6000, shift: "spät" }] },
      ],
    );
    const feas = computeRunFeasibility(plan, "Di");
    // 12000 Portionen gesamt würden eine einzelne 6750er-Kapazität sprengen —
    // auf zwei getrennte Schichten verteilt passt aber jeweils 6000 ≤ 6750.
    expect(feas.get("FV0001A-R1")?.fits).toBe(true);
    expect(feas.get("FV0002A-R1")?.fits).toBe(true);
  });

  it("computeDayLoads/computeRunFeasibility haben keine versteckte 2-Run-Annahme (3. Run = Backfill)", () => {
    const plan = fakeWeekPlan(
      { Di: { lines: 1, hours: 10, shifts: 1 } }, // Kapazität = 9000
      [{ code: "FV0001A", runs: [
        { runIndex: 1, day: "Di", portions: 3000 },
        { runIndex: 2, day: "Di", portions: 3000 },
        { runIndex: 3, day: "Di", portions: 3000, isBackfill: true },
      ] }],
    );
    const loads = computeDayLoads(plan);
    const di = loads.find(l => l.day === "Di")!;
    expect(di.portions).toBe(9000);
    expect(di.overCapacity).toBe(false);
    const feas = computeRunFeasibility(plan, "Di");
    expect(feas.get("FV0001A-R1")?.fits).toBe(true);
    expect(feas.get("FV0001A-R2")?.fits).toBe(true);
    expect(feas.get("FV0001A-R3")?.fits).toBe(true);
  });
});

function fakeBackfillNeed(overrides: Partial<CombinedBackfillNeed> & { recipeCode: string }): CombinedBackfillNeed {
  return {
    codeVariants: [], recipeName: overrides.recipeCode,
    kitchenMissingKg: 0, kitchenMissingPortions: 0, kitchenPriority: null, kitchenSubRecipes: [],
    platingPlannedPortions: 0, platingShortagePortions: 0, platingShortageReasons: [], platingDaysAffected: [],
    lpShortfallPortions: 0, lpWeek: "W37", lpStatusText: "",
    minNeededPortions: null, backfillResultPortions: null, backfillResultComments: [],
    rtiHoldingKg: 0, rtiPlannedTarget: null, rtiActuals: null, rtiShortfallPortions: 0,
    rtiKitchenDone: false, rtiHasOpenSubs: false, rtiVetoed: false, rtiBackfillCandidateSubs: [],
    liveWmsHoldingKg: null, liveRedzonePortions: null, liveRedzoneStatus: null,
    recommendedBackfillPortions: 0, recommendedSource: "none", confidence: "kitchen-only", priority: "on-track",
    ...overrides,
  };
}

describe("computeOpenBackfills", () => {
  it("matcht über recipeCode und liefert die offene Menge", () => {
    const plan = fakeWeekPlan({}, [{ code: "FV0001A", runs: [] }]);
    const need = fakeBackfillNeed({ recipeCode: "FV0001A", recommendedBackfillPortions: 500, priority: "critical" });
    const open = computeOpenBackfills(plan, [need]);
    expect(open).toHaveLength(1);
    expect(open[0].openPortions).toBe(500);
  });

  it("matcht auch über codeVariants (anderer Buchstaben-Suffix, gleiche 4 Ziffern)", () => {
    const plan = fakeWeekPlan({}, [{ code: "FV0001B", runs: [] }]);
    const need = fakeBackfillNeed({ recipeCode: "FV0001A", codeVariants: ["FV0001A"], recommendedBackfillPortions: 300 });
    expect(computeOpenBackfills(plan, [need])).toHaveLength(1);
  });

  it("überspringt Meals, die diese KW nicht geplant sind", () => {
    const plan = fakeWeekPlan({}, [{ code: "FV0001A", runs: [] }]);
    const need = fakeBackfillNeed({ recipeCode: "FV9999A", recommendedBackfillPortions: 300 });
    expect(computeOpenBackfills(plan, [need])).toHaveLength(0);
  });

  it("offene Menge sinkt mit vorhandenen isBackfill-Runs und wird bei Erreichen des Bedarfs auf 0 geklemmt", () => {
    const plan = fakeWeekPlan({}, [
      { code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 400, isBackfill: true }] },
    ]);
    const need = fakeBackfillNeed({ recipeCode: "FV0001A", recommendedBackfillPortions: 500 });
    const open = computeOpenBackfills(plan, [need]);
    expect(open[0].openPortions).toBe(100);

    const covered = fakeWeekPlan({}, [
      { code: "FV0001A", runs: [{ runIndex: 1, day: "Di", portions: 500, isBackfill: true }] },
    ]);
    expect(computeOpenBackfills(covered, [need])).toHaveLength(0); // voll gedeckt → kein Chip mehr
  });
});

describe("splitUnfinishedRun / clearUnfinishedRun (nicht geschafft)", () => {
  const mealWith = (runs: PlatingRun[]) =>
    fakeWeekPlan({}, [{ code: "FV0001A", runs }]).meals[0];

  it("reduziert den Ursprungs-Run auf die Ist-Menge und legt den Rest als Nachhol-Run an", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 6894 }]);
    const runs = splitUnfinishedRun(meal, 1, 4000, "Do");
    expect(runs).toHaveLength(2);
    const orig = runs.find(r => r.runIndex === 1)!;
    expect(orig.portions).toBe(4000);
    expect(orig.donePortions).toBe(4000);
    expect(orig.plannedPortions).toBe(6894);
    expect(orig.done).toBe(true);
    const carry = runs.find(r => r.isCarryForward)!;
    expect(carry.portions).toBe(2894);
    expect(carry.day).toBe("Do");
    expect(carry.carryFromDay).toBe("Di");
    expect(carry.carryFromRun).toBe(1);
    expect(carry.runIndex).toBe(2);
  });

  it("Ist ≥ geplant → kein Nachhol-Run, Run bleibt bei der geplanten Menge", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 5000 }]);
    const runs = splitUnfinishedRun(meal, 1, 9999, "Do");
    expect(runs).toHaveLength(1);
    expect(runs[0].portions).toBe(5000);
    expect(runs[0].donePortions).toBe(5000);
  });

  it("Ist = 0 → der ganze Run wandert auf den anderen Tag", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 5000 }]);
    const runs = splitUnfinishedRun(meal, 1, 0, "Fr");
    const orig = runs.find(r => r.runIndex === 1)!;
    expect(orig.portions).toBe(0);
    expect(runs.find(r => r.isCarryForward)!.portions).toBe(5000);
  });

  it("erneuter Aufruf rechnet gegen die ursprünglich geplante Menge und ersetzt den Nachhol-Run", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 6894 }]);
    const once = splitUnfinishedRun(meal, 1, 4000, "Do");
    const twice = splitUnfinishedRun({ ...meal, runs: once }, 1, 3000, "Fr");
    expect(twice.filter(r => r.isCarryForward)).toHaveLength(1);
    const carry = twice.find(r => r.isCarryForward)!;
    expect(carry.portions).toBe(3894); // 6894 - 3000, nicht 6894 - 4000 - 3000
    expect(carry.day).toBe("Fr");
    expect(twice.find(r => r.runIndex === 1)!.portions).toBe(3000);
  });

  it("ein Nachhol-Run selbst kann nicht gesplittet werden", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 6894 }]);
    const runs = splitUnfinishedRun(meal, 1, 4000, "Do");
    const carry = runs.find(r => r.isCarryForward)!;
    expect(splitUnfinishedRun({ ...meal, runs }, carry.runIndex, 100, "Sa")).toEqual(runs);
  });

  it("clearUnfinishedRun stellt die geplante Menge wieder her und entfernt den Nachhol-Run", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 6894 }, { runIndex: 2, day: "Fr", portions: 2000 }]);
    const split = splitUnfinishedRun(meal, 1, 4000, "Do");
    const cleared = clearUnfinishedRun({ ...meal, runs: split }, 1);
    expect(cleared.filter(r => r.isCarryForward)).toHaveLength(0);
    const orig = cleared.find(r => r.runIndex === 1)!;
    expect(orig.portions).toBe(6894);
    expect(orig.donePortions).toBeUndefined();
    expect(orig.plannedPortions).toBeUndefined();
    expect(orig.done).toBeUndefined();
    expect(cleared.find(r => r.runIndex === 2)!.portions).toBe(2000); // anderer Run unberührt
  });

  it("countUnfinishedMarkers zählt Ursprungs- und Nachhol-Runs", () => {
    const meal = mealWith([{ runIndex: 1, day: "Di", portions: 6894 }]);
    const runs = splitUnfinishedRun(meal, 1, 4000, "Do");
    const plan = fakeWeekPlan({}, []);
    plan.meals = [{ ...meal, runs }];
    expect(countUnfinishedMarkers(plan)).toBe(2);
    expect(countUnfinishedMarkers(fakeWeekPlan({}, [{ code: "X", runs: [{ runIndex: 1, day: "Di", portions: 100 }] }]))).toBe(0);
  });
});

describe("suggestCarryForwardDay", () => {
  it("nimmt den nächsten Tag nach fromDay, der die Menge noch fasst", () => {
    const plan = fakeWeekPlan(
      { Di: { lines: 1, hours: 10, shifts: 1 }, Mi: { lines: 1, hours: 10, shifts: 1 }, Do: { lines: 1, hours: 10, shifts: 1 } },
      [{ code: "A", runs: [{ runIndex: 1, day: "Di", portions: 3000 }] }],
    );
    expect(suggestCarryForwardDay(plan, "Di", 2000)).toBe("Mi");
  });

  it("sind alle Folgetage voll → der am wenigsten ausgelastete", () => {
    const plan = fakeWeekPlan(
      {
        Do: { lines: 1, hours: 10, shifts: 1 },
        Fr: { lines: 1, hours: 1, shifts: 1 },   // Kapazität 900
        Sa: { lines: 1, hours: 2, shifts: 1 },   // Kapazität 1800
      },
      [{ code: "A", runs: [{ runIndex: 1, day: "Fr", portions: 900 }] }],
    );
    expect(suggestCarryForwardDay(plan, "Do", 2000)).toBe("Sa");
  });
});

describe("nextRunIndex", () => {
  it("liefert den nächsten freien Index für 1-, 2- und 3-Run-Meals", () => {
    expect(nextRunIndex({ ...fakeWeekPlan({}, [{ code: "X", runs: [] }]).meals[0] })).toBe(1);
    expect(nextRunIndex(fakeWeekPlan({}, [{ code: "X", runs: [{ runIndex: 1, day: "Di", portions: 100 }] }]).meals[0])).toBe(2);
    expect(nextRunIndex(fakeWeekPlan({}, [{ code: "X", runs: [
      { runIndex: 1, day: "Di", portions: 100 }, { runIndex: 2, day: "Mi", portions: 100 },
    ] }]).meals[0])).toBe(3);
  });
});
