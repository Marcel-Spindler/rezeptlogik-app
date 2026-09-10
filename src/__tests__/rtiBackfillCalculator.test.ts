import { describe, expect, it } from "vitest";
import { computeRtiBackfills, MIN_SUB_SHORTFALL, type RtiExternalTarget } from "../features/backfills/rtiBackfillCalculator";
import type { RtiData, RtiMealBlock, RtiSubRecipeEntry } from "../features/gsheet-monitor/gsheetTypes";

function sub(overrides: Partial<RtiSubRecipeEntry>): RtiSubRecipeEntry {
  return {
    workOrder: "38-000", subRecipeName: "Sub", platingHoldingKg: 0, weighedKg: 0,
    gramPerMeal: 100, availableMealcount: 0, minimumNeed: 0, backfillMeals: 0,
    shortagePct: 0, status: "open", isBackfillCandidate: false,
    ...overrides,
  };
}

function rti(...meals: Partial<RtiMealBlock>[]): RtiData {
  return {
    week: "W38", lastUpdated: Date.now(),
    meals: meals.map(m => ({
      mealCode: "FV0001A", mealName: "Test", plannedTarget: 3763, actuals: 2848,
      delta: -915, deltaPct: 24.32, subRecipes: [], ...m,
    })),
  };
}

describe("computeRtiBackfills — Rechenweg (echte KW38-Zahlen, FV4048A)", () => {
  // gap = 3763 − 2848 = 915. Hier alle Engpass-Subs mit Status "" (offen).
  const meal = rti({
    mealCode: "FV4048A", mealName: "Creamy Leek Pork tenderloin",
    plannedTarget: 3763, actuals: 2848,
    subRecipes: [
      sub({ workOrder: "38-161", subRecipeName: "Creamy Leek -Low Fat (Creamier)", weighedKg: 97.31, availableMealcount: 974, minimumNeed: 59, shortagePct: 1.57 }),
      sub({ workOrder: "38-162", subRecipeName: "Green beans - Roasted", weighedKg: 53.5, availableMealcount: 1271, minimumNeed: 356, shortagePct: 9.46 }),
      sub({ workOrder: "38-163", subRecipeName: "Mash - Creamy Sweet Potato Puree (more salt)", weighedKg: 0, availableMealcount: 0, minimumNeed: -915, backfillMeals: -1137, shortagePct: -24.32, status: "open" }),
      sub({ workOrder: "38-164", subRecipeName: "Pork tenderloin - herb marinade", weighedKg: 10.22, availableMealcount: 103, minimumNeed: -812, backfillMeals: -987, shortagePct: -21.58, status: "open" }),
      sub({ workOrder: "38-198", subRecipeName: "Mash - Creamy Sweet Potato Puree (more salt)", minimumNeed: -915, backfillMeals: -1137, isBackfillCandidate: true }),
    ],
  });
  const [r] = computeRtiBackfills(meal);

  it("gap 915, nur Mash + Pork offen (Creamy Leek/Green Beans aus Holding gedeckt)", () => {
    expect(r.gap).toBe(915);
    expect(r.openSubs.map(s => s.subRecipeName).sort()).toEqual([
      "Mash - Creamy Sweet Potato Puree (more salt)",
      "Pork tenderloin - herb marinade",
    ]);
  });

  it("Mash: minimumNeed 915, bufferedNeed 1137 aus Spalte I", () => {
    const mash = r.openSubs.find(s => s.subRecipeName.startsWith("Mash"))!;
    expect(mash.minimumNeed).toBe(915);
    expect(mash.bufferedNeed).toBe(1137);
    expect(mash.basis).toBe("sheet");
  });

  it("Pork: minimumNeed 812, bufferedNeed 987", () => {
    const pork = r.openSubs.find(s => s.subRecipeName.startsWith("Pork"))!;
    expect(pork.minimumNeed).toBe(812);
    expect(pork.bufferedNeed).toBe(987);
  });

  it("recommendedMin 915, recommendedBuffered 1137", () => {
    expect(r.recommendedMin).toBe(915);
    expect(r.recommendedBuffered).toBe(1137);
  });

  it("Kandidaten-Zeile ignoriert", () => {
    expect(r.openSubs).toHaveLength(2);
    expect(r.candidateSubNames).toContain("Mash - Creamy Sweet Potato Puree (more salt)");
  });
});

describe("computeRtiBackfills — Status J", () => {
  it("Status 'done' = ins System eingetragen → enteredSubs, nicht openSubs", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 3763, actuals: 2848,
      subRecipes: [
        sub({ subRecipeName: "Mash", minimumNeed: -915, backfillMeals: -1137, shortagePct: -24.32, status: "done" }),
        sub({ subRecipeName: "Pork", minimumNeed: -812, backfillMeals: -987, shortagePct: -21.58, status: "open" }),
      ],
    }));
    expect(m.openSubs.map(s => s.subRecipeName)).toEqual(["Pork"]);
    expect(m.enteredSubs.map(s => s.subRecipeName)).toEqual(["Mash"]);
    expect(m.allEntered).toBe(false);
  });

  it("alle Engpässe 'done' → allEntered=true, openSubs leer", () => {
    const [m] = computeRtiBackfills(rti({
      subRecipes: [sub({ minimumNeed: -915, status: "done" }), sub({ subRecipeName: "B", minimumNeed: -800, status: "done" })],
    }));
    expect(m.openSubs).toHaveLength(0);
    expect(m.allEntered).toBe(true);
  });

  it("Status 'no' → notNeededSubs", () => {
    const [m] = computeRtiBackfills(rti({
      subRecipes: [sub({ subRecipeName: "Fondue", minimumNeed: -954, status: "open" }), sub({ subRecipeName: "Zucchini", minimumNeed: -543, status: "not-needed" })],
    }));
    expect(m.openSubs.map(s => s.subRecipeName)).toEqual(["Fondue"]);
    expect(m.notNeededSubs.map(s => s.subRecipeName)).toEqual(["Zucchini"]);
  });
});

describe("computeRtiBackfills — Sheet unvollständig", () => {
  it("D/F/G leer, nur Meal-Rückstand bekannt → basis 'gap-only', hasGapOnly=true", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 2838, actuals: 2608, // gap 230
      subRecipes: [sub({ subRecipeName: "Cheese", availableMealcount: 0, minimumNeed: 0, backfillMeals: 0 })],
    }));
    expect(m.openSubs[0].minimumNeed).toBe(230);
    expect(m.openSubs[0].basis).toBe("gap-only");
    expect(m.hasGapOnly).toBe(true);
  });

  it("Spalte D leer, aber G gerechnet → basis 'sheet', Zahl aus G", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 5236, actuals: 4176, // gap 1060
      subRecipes: [sub({ subRecipeName: "Turmeric green beans", weighedKg: 0, availableMealcount: 0, minimumNeed: -1060, backfillMeals: -1275, shortagePct: -20.24, status: "done" })],
    }));
    expect(m.enteredSubs[0].minimumNeed).toBe(1060);
    expect(m.enteredSubs[0].bufferedNeed).toBe(1275);
    expect(m.enteredSubs[0].basis).toBe("sheet");
  });

  it("weighingStarted spiegelt, ob irgendein Sub schon D oder Status hat", () => {
    const untouched = computeRtiBackfills(rti({ subRecipes: [sub({ minimumNeed: -915 })] }))[0];
    expect(untouched.weighingStarted).toBe(false);
    const touched = computeRtiBackfills(rti({ subRecipes: [sub({ minimumNeed: -915, weighedKg: 5 })] }))[0];
    expect(touched.weighingStarted).toBe(true);
  });
});

describe("computeRtiBackfills — nichts zu tun", () => {
  it("Rückstand komplett aus Holding gedeckt", () => {
    expect(computeRtiBackfills(rti({
      subRecipes: [sub({ subRecipeName: "A", minimumNeed: 59 }), sub({ subRecipeName: "B", minimumNeed: 356 })],
    }))).toHaveLength(0);
  });

  it("ohne erfasste Actuals + noch nichts gewogen → gar kein Eintrag", () => {
    expect(computeRtiBackfills(rti({ actuals: 0, subRecipes: [sub({ minimumNeed: -915 })] }))).toHaveLength(0);
  });

  it("Sub-Bedarf unter der Rauschschwelle", () => {
    expect(computeRtiBackfills(rti({ plannedTarget: 5000, actuals: 4990, subRecipes: [sub({ minimumNeed: -10 })] }))).toHaveLength(0);
    expect(MIN_SUB_SHORTFALL).toBe(30);
  });

  it("behält den echten Wiegeblock neben leeren Prep-Blöcken für denselben Code", () => {
    const result = computeRtiBackfills({
      week: "W38", lastUpdated: Date.now(),
      meals: [
        { mealCode: "FV0001A", mealName: "T", plannedTarget: 2000, actuals: 1700, delta: -300, deltaPct: 15, subRecipes: [sub({ minimumNeed: -300, status: "open" })] },
        { mealCode: "FV0001A", mealName: "T", plannedTarget: 0, actuals: 0, delta: 0, deltaPct: 0, subRecipes: [] },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].recommendedMin).toBe(300);
  });
});

describe("computeRtiBackfills — Kopf aus App-Daten ergänzt (externalTargets)", () => {
  const targets = (t: Partial<RtiExternalTarget>): Map<string, RtiExternalTarget> =>
    new Map([["0001", { plannedTarget: 3000, actuals: 2600, source: "Forecast + Redzone", ...t }]]);

  // Bottleneck-Sub kam leer zurück (weighedKg 0), ein anderes Sub wurde gewogen
  // → someWeighed=true, aber der Engpass-Sub deckt nichts aus dem Holding.
  const emptyBottleneck = (name: string) => [
    sub({ subRecipeName: "Beilage", weighedKg: 40, gramPerMeal: 100 }),
    sub({ subRecipeName: name, weighedKg: 0, gramPerMeal: 100 }),
  ];

  it("Planned Target fehlt → aus externalTargets, targetEstimated=true, gap gerechnet", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 2600,
      subRecipes: emptyBottleneck("Mash"),
    }), targets({ plannedTarget: 3000 }));
    expect(m.targetEstimated).toBe(true);
    expect(m.targetSource).toBe("app");
    expect(m.targetSourceLabel).toBe("Forecast + Redzone");
    expect(m.headerIncomplete).toBe(false);
    expect(m.plannedTarget).toBe(3000);
    expect(m.actuals).toBe(2600);
    expect(m.gap).toBe(400);
    const mash = m.openSubs.find(s => s.subRecipeName === "Mash")!;
    expect(mash.minimumNeed).toBe(400);
    expect(mash.basis).toBe("gap-only");
  });

  it("Actuals fehlt → aus externalTargets, Sheet-Planned bleibt", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 3200, actuals: 0,
      subRecipes: emptyBottleneck("Beef"),
    }), targets({ actuals: 2900 }));
    expect(m.targetEstimated).toBe(true);
    expect(m.plannedTarget).toBe(3200);
    expect(m.actuals).toBe(2900);
    expect(m.gap).toBe(300);
  });

  it("beide fehlen → beide aus externalTargets", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: emptyBottleneck("Rice"),
    }), targets({ plannedTarget: 5000, actuals: 4000 }));
    expect(m.targetEstimated).toBe(true);
    expect(m.gap).toBe(1000);
  });

  it("noch nichts zurückgewogen → KEINE Substitution (sonst floodet die Liste)", () => {
    const res = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: [sub({ subRecipeName: "Mash", weighedKg: 0, status: "open" })],
    }), targets({ plannedTarget: 3000, actuals: 100 }));
    expect(res).toHaveLength(0);
  });

  it("unplausibler externer Wert (Ist ≫ Ziel) → verworfen, wieder headerIncomplete", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: emptyBottleneck("X"),
    }), targets({ plannedTarget: 3000, actuals: 3600 }));
    expect(m.headerIncomplete).toBe(true);
    expect(m.targetEstimated).toBe(false);
  });

  it("Sheet-Kopf vollständig → externalTargets werden ignoriert", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 3763, actuals: 2848,
      subRecipes: [sub({ subRecipeName: "Mash", minimumNeed: -915, status: "open" })],
    }), targets({ plannedTarget: 9999, actuals: 1 }));
    expect(m.targetEstimated).toBe(false);
    expect(m.plannedTarget).toBe(3763);
    expect(m.gap).toBe(915);
  });

  it("kein externalTargets-Argument → Verhalten unverändert (Nag)", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: [sub({ subRecipeName: "Sauce", weighedKg: 12.5, status: "open" })],
    }));
    expect(m.headerIncomplete).toBe(true);
    expect(m.targetEstimated).toBe(false);
  });
});

describe("computeRtiBackfills — Kopf unvollständig (Planned Target/Actuals fehlen)", () => {
  it("wird schon gewogen, aber kein Planned Target → headerIncomplete-Hinweis, keine openSubs", () => {
    const [m] = computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: [sub({ subRecipeName: "Sauce", weighedKg: 12.5, status: "open" })],
    }));
    expect(m.headerIncomplete).toBe(true);
    expect(m.openSubs).toHaveLength(0);
    expect(m.weighingStarted).toBe(true);
  });

  it("Actuals fehlt, aber ein Sub schon gewogen → Hinweis", () => {
    const [m] = computeRtiBackfills(rti({ plannedTarget: 5000, actuals: 0, subRecipes: [sub({ weighedKg: 40 })] }));
    expect(m?.headerIncomplete).toBe(true);
  });

  it("kein Planned Target UND alle Subs auf 'no' → still, kein Hinweis (bewusst nicht getrackt)", () => {
    expect(computeRtiBackfills(rti({
      plannedTarget: 0, actuals: 0,
      subRecipes: [sub({ weighedKg: 5, status: "not-needed" }), sub({ subRecipeName: "B", weighedKg: 8, status: "not-needed" })],
    }))).toHaveLength(0);
  });

  it("kein Planned Target UND noch nichts gewogen → still", () => {
    expect(computeRtiBackfills(rti({ plannedTarget: 0, actuals: 0, subRecipes: [sub({ weighedKg: 0, status: "open" })] }))).toHaveLength(0);
  });
});
