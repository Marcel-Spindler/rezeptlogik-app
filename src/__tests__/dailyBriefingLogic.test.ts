import { describe, expect, it } from "vitest";
import { buildDailyBriefing } from "../features/daily-briefing/dailyBriefingLogic";
import type { MealProgress, WoMatchedStatus } from "../features/gsheet-monitor/postblastMatch";
import type { TransparencyProducibilityResult, MealProducibility } from "../features/gsheet-monitor/transparencyTypes";
import type { BackfillAlert, BackfillFeasibility, CombinedBackfillNeed } from "../features/backfills/backfillTypes";
import type { DataBundle, DetailedIngredient, DetailedSubRecipe, RecipeStructure } from "../core/types";
import type { KetRow } from "../features/ket-plan/ketTypes";
import type { RtiMealBackfill } from "../features/backfills/rtiBackfillCalculator";

// Gleiche Fixture-Helfer wie mealProgress.test.ts, damit MealProgress/WoMatchedStatus
// nicht bei jedem Test komplett neu ausgeschrieben werden müssen.
function wo(overrides: Partial<WoMatchedStatus>): WoMatchedStatus {
  return {
    workOrder: "38-1", subRecipe: "Sauce", recipeCode: "FV0001A", recipeName: "Test",
    plannedMeals: 1000, plannedKg: 100, actualKg: 0, progressPct: 0, deltaKg: -100,
    isComplete: false, isCritical: false, hasPlan: true, isEstimated: false,
    preBlastKg: 0, shrinkKg: 0, shrinkPct: 0, awaitingPostBlast: false, preBlastLikelyDone: false,
    lastPreBlastWeighing: null, run: 1, weighings: [], lastWeighing: null,
    platingHoldingKg: 0, rtiStatus: null,
    ...overrides,
  };
}

function meal(workOrders: WoMatchedStatus[], over: Partial<MealProgress> = {}): MealProgress {
  const planned = workOrders.filter(w => w.plannedKg > 0);
  const totalPlannedKg = planned.reduce((s, w) => s + w.plannedKg, 0);
  const totalActualKg = planned.reduce((s, w) => s + w.actualKg, 0);
  return {
    recipeCode: "FV0001A", recipeName: "Test", plannedMeals: 1000, workOrders,
    totalPlannedKg, totalActualKg,
    progressPct: totalPlannedKg > 0 ? Math.min((totalActualKg / totalPlannedKg) * 100, 100) : 0,
    completedWOs: workOrders.filter(w => w.isComplete).length,
    totalWOs: workOrders.length,
    criticalWOs: workOrders.filter(w => w.isCritical),
    ...over,
  };
}

function producibility(entries: MealProducibility[]): TransparencyProducibilityResult {
  return {
    byRecipeCode: new Map(entries.map(e => [e.recipeCode, e])),
    meals: entries,
    readyCount: entries.filter(e => e.status === "ready").length,
    partialCount: entries.filter(e => e.status === "partial").length,
    blockedCount: entries.filter(e => e.status === "blocked").length,
  } as TransparencyProducibilityResult;
}

function isoOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY_ISO = isoOffset(0);
const TOMORROW_ISO = isoOffset(1);
const LATER_ISO = isoOffset(4);

function ketRow(overrides: Partial<KetRow>): KetRow {
  return {
    key: "k1", dateNeeded: TODAY_ISO, shift: "1", woNumber: "38-1", recipeId: "r1",
    recipeCode: "FV0001A", recipeName: "Test", subRecipeName: "Sauce", cookMethods: [],
    woCookedPortions: 0, targetPortions: 100, cookedPortionsExcess: null,
    stagingStatus: "", stagingComment: "", kitchenStatus: "", unlockedEta: "", workOrderComment: "",
    ...overrides,
  };
}

function feasibility(overrides: Partial<BackfillFeasibility>): BackfillFeasibility {
  return {
    recipeCode: "FV0002A", verdict: "blocked", scope: "components",
    neededPortions: 100, maxProduciblePortions: 0, coveragePct: 0,
    targetSubRecipes: [], unmatchedComponents: [], bottleneck: [], ingredients: [],
    ...overrides,
  };
}

const EMPTY_DATA = {} as unknown as DataBundle;

// Gleiche Struktur-Fixture-Helfer wie backfillFeasibility.test.ts, für die
// Plating-Besetzung (jetzt über die echte Rezeptstruktur statt KET-Zeilen).
function ing(id: string, grossQty: number, uom = "grams"): DetailedIngredient {
  return { id, name: id, grossQty, netQty: grossQty, uom };
}
function structNode(overrides: Partial<DetailedSubRecipe>): DetailedSubRecipe {
  return { id: "SUB-1", name: "Sauce", categories: "BRAISER", uom: "grams", subRecipes: [], ingredients: [ing("PRO-X", 10)], ...overrides };
}
function dataWithStructure(nodes: DetailedSubRecipe[], code = "FV0001A"): DataBundle {
  const structure: RecipeStructure = { code, recipeId: "REC-1", name: "Test Meal", markets: { DE: nodes } };
  return { structures: { [code]: structure } } as unknown as DataBundle;
}

function run(opts: {
  meals?: MealProgress[];
  alerts?: BackfillAlert[];
  prod?: TransparencyProducibilityResult | null;
  combined?: CombinedBackfillNeed[];
  feasibilityByMeal?: Map<string, BackfillFeasibility>;
  ketRows?: KetRow[];
  plaitedByCode?: Map<string, number>;
  rtiMeals?: RtiMealBackfill[];
  data?: DataBundle;
  kitchenHeadcountFromPlan?: number | null;
}) {
  return buildDailyBriefing({
    data: opts.data ?? EMPTY_DATA,
    meals: opts.meals ?? [],
    rtiMeals: opts.rtiMeals ?? [],
    alerts: opts.alerts ?? [],
    ketRows: opts.ketRows ?? [],
    plaitedByCode: opts.plaitedByCode ?? new Map(),
    producibility: opts.prod ?? null,
    week: "W38",
    combined: opts.combined ?? [],
    feasibilityByMeal: opts.feasibilityByMeal,
    kitchenHeadcountFromPlan: opts.kitchenHeadcountFromPlan,
  });
}

describe("buildDailyBriefing – criticalItems", () => {
  it("surfaces a kitchen critical WO even without any Transparency/producibility data", () => {
    // Das war die eigentliche Lücke am alten Stand: Küche zeigt klar "nichts
    // gewogen trotz Plan", aber ohne die 4 Transparency-Tabs blieb die
    // Kritisch-Liste komplett leer.
    const m = meal([
      wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true }),
    ]);
    const briefing = run({ meals: [m], prod: null });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({
      recipeCode: "FV0001A",
      severity: "critical",
      source: "kitchen",
    });
    expect(briefing.criticalItems[0].message).toContain("38-1");
    expect(briefing.summary.criticalCount).toBe(1);
  });

  it("surfaces blocked/partial meals from producibility as critical/warning", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100 })]);
    const prod = producibility([
      { recipeCode: "FV0001A", recipeName: "Test", status: "blocked", subRecipes: [], blockedReasons: [] },
    ]);
    const briefing = run({ meals: [m], prod });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({ source: "producibility", severity: "critical" });
  });

  it("surfaces critical/warning backfill alerts and excludes info-level ones", () => {
    const alerts: BackfillAlert[] = [
      { id: "1", severity: "critical", recipeCode: "FV0002A", recipeName: "Backfill Meal", title: "Backfill nötig", message: "50 Stk fehlen" },
      { id: "2", severity: "info", recipeCode: "FV0003A", recipeName: "Info Meal", title: "Info", message: "nur zur Kontrolle" },
    ];
    const briefing = run({ alerts });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({ source: "backfill", severity: "critical", recipeCode: "FV0002A" });
  });

  it("sorts critical before warning", () => {
    const prod = producibility([
      { recipeCode: "AAAA", recipeName: "Warn Meal", status: "partial", subRecipes: [], blockedReasons: [] },
    ]);
    const alerts: BackfillAlert[] = [
      { id: "1", severity: "critical", recipeCode: "ZZZZ", recipeName: "Crit Meal", title: "x", message: "x" },
    ];
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, recipeCode: "AAAA", recipeName: "Warn Meal" })], { recipeCode: "AAAA", recipeName: "Warn Meal" });
    const briefing = run({ meals: [m], alerts, prod });

    expect(briefing.criticalItems.map(c => c.severity)).toEqual(["critical", "warning"]);
  });

  it("surfaces a blocked backfill feasibility (no raw material) as critical, with bottleneck ingredient", () => {
    const f = feasibility({
      verdict: "blocked", neededPortions: 200, maxProduciblePortions: 0, coveragePct: 0,
      bottleneck: [{
        ingredientId: "SKU1", ingredientName: "Hähnchenbrust", subRecipeName: "Marinade", uom: "kg",
        grossPerPortion: 0.1, neededTotal: 20, availableQty: 0, expiredQty: 0, notInWms: false,
        maxPortions: 0, isBottleneck: true, nearestExpiry: null,
      }],
    });
    const combined: CombinedBackfillNeed[] = [{ recipeCode: "FV0002A", recipeName: "Backfill Meal" } as CombinedBackfillNeed];
    const briefing = run({ feasibilityByMeal: new Map([["FV0002A", f]]), combined });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({ source: "feasibility", severity: "critical", recipeCode: "FV0002A", recipeName: "Backfill Meal" });
    expect(briefing.criticalItems[0].message).toContain("Hähnchenbrust");
  });

  it("surfaces a partial backfill feasibility as warning, and skips a fully feasible one", () => {
    const partial = feasibility({ recipeCode: "FV0004A", verdict: "partial", neededPortions: 100, maxProduciblePortions: 40, coveragePct: 0.4 });
    const ok = feasibility({ recipeCode: "FV0005A", verdict: "feasible", neededPortions: 50, maxProduciblePortions: 50, coveragePct: 1 });
    const briefing = run({ feasibilityByMeal: new Map([["FV0004A", partial], ["FV0005A", ok]]) });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({ source: "feasibility", severity: "warning", recipeCode: "FV0004A" });
  });

  it("reports zero critical items and count 0 when everything is clean", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, isComplete: true })]);
    const briefing = run({ meals: [m] });
    expect(briefing.criticalItems).toEqual([]);
    expect(briefing.summary.criticalCount).toBe(0);
  });
});

describe("buildDailyBriefing – Tages-Fokus (heute + morgen, nicht die ganze Woche)", () => {
  it("excludes a meal that is neither kitchen-relevant today/tomorrow nor has anything ready to plate", () => {
    // Das war der live beobachtete Bug: "Plating 0/69.321" — die Summe ALLER
    // Meals der Woche, nicht nur der von heute/morgen relevanten. Nichts
    // gekocht (actualKg: 0) → auch keine Plating-Relevanz, also zurecht raus.
    const laterOnly = meal(
      [wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, recipeCode: "FV9999A", recipeName: "Später diese Woche" })],
      { recipeCode: "FV9999A", recipeName: "Später diese Woche", plannedMeals: 5000 },
    );
    const ketRows = [ketRow({ recipeCode: "FV0001A", dateNeeded: LATER_ISO })]; // andere WO, nicht dasselbe Meal
    const briefing = run({ meals: [laterOnly], ketRows });

    expect(briefing.mealPlating).toEqual([]);
    expect(briefing.summary.totalMeals).toBe(0);
    expect(briefing.summary.totalPlannedPortions).toBe(0);
  });

  it("includes a meal with nothing cooked today/tomorrow but that is already fully cooked and ready to plate (dayScope 'plating')", () => {
    // Der eigentliche Bugfix: Plaitieren folgt nicht dem Küchen-WO-Kalender —
    // ein Meal ohne Küchen-WO heute/morgen, das aber fertig gekocht und noch
    // nicht plaitiert ist, muss trotzdem als "zu plaitieren" auftauchen.
    const readyToPlate = meal(
      [wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, recipeCode: "FV9999A", recipeName: "Fertig gekocht" })],
      { recipeCode: "FV9999A", recipeName: "Fertig gekocht", plannedMeals: 5000 },
    );
    const ketRows = [ketRow({ recipeCode: "FV0001A", dateNeeded: LATER_ISO })]; // andere WO, nicht dasselbe Meal
    const briefing = run({ meals: [readyToPlate], ketRows });

    expect(briefing.mealPlating).toHaveLength(1);
    expect(briefing.mealPlating[0].dayScope).toBe("plating");
    expect(briefing.platingTodo).toHaveLength(1);
    expect(briefing.platingTodo[0].netMeals).toBeGreaterThan(0);
  });

  it("includes a meal with a WO today and tags it dayScope 'heute'", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100, recipeCode: "FV0001A" })], { recipeCode: "FV0001A", plannedMeals: 1000 });
    const ketRows = [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO })];
    const briefing = run({ meals: [m], ketRows });

    expect(briefing.mealPlating).toHaveLength(1);
    expect(briefing.mealPlating[0].dayScope).toBe("heute");
    expect(briefing.summary.totalPlannedPortions).toBe(1000);
  });

  it("includes a meal with a WO only tomorrow, tags it 'morgen', and tags a critical item from it accordingly", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, recipeCode: "FV0001A" })], { recipeCode: "FV0001A" });
    const ketRows = [ketRow({ recipeCode: "FV0001A", dateNeeded: TOMORROW_ISO })];
    const briefing = run({ meals: [m], ketRows });

    expect(briefing.criticalItems).toHaveLength(1);
    expect(briefing.criticalItems[0]).toMatchObject({ source: "kitchen", dayScope: "morgen" });
  });

  it("still shows everything (dayScope 'unbekannt') when KET has no rows at all, instead of going blank", () => {
    // KET-Plan nicht verbunden → Tag lässt sich nicht bestimmen. Muss NICHT
    // filtern, sonst verschwindet der Meal-Teil, obwohl Postblast längst läuft.
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true })]);
    const briefing = run({ meals: [m], ketRows: [] });

    expect(briefing.mealPlating).toHaveLength(1);
    expect(briefing.mealPlating[0].dayScope).toBe("unbekannt");
    expect(briefing.criticalItems).toHaveLength(1);
  });

  it("scopes the backfill watcher to today/tomorrow via the RTI meal code", () => {
    const rtiMeals = [{
      mealCode: "FV0002A", mealName: "Backfill Meal", gap: 50, allEntered: false, recommendedMin: 50,
      openSubs: [{ subRecipeName: "Sauce", minimumNeed: 50, bufferedNeed: 60, availableMealcount: 0 }],
      enteredSubs: [], notNeededSubs: [], candidateSubNames: [], headerIncomplete: false,
      plannedTarget: 100, actuals: 0, recommendedBuffered: 60, targetEstimated: false, targetSourceLabel: "",
    }] as unknown as RtiMealBackfill[];

    const inWeek = buildDailyBriefing({
      data: EMPTY_DATA, meals: [], rtiMeals, alerts: [], plaitedByCode: new Map(), producibility: null, week: "W38",
      ketRows: [ketRow({ recipeCode: "FV0002A", dateNeeded: LATER_ISO })],
    });
    expect(inWeek.backfillWatch).toEqual([]);

    const today = buildDailyBriefing({
      data: EMPTY_DATA, meals: [], rtiMeals, alerts: [], plaitedByCode: new Map(), producibility: null, week: "W38",
      ketRows: [ketRow({ recipeCode: "FV0002A", dateNeeded: TODAY_ISO })],
    });
    expect(today.backfillWatch).toHaveLength(1);
  });
});

describe("buildDailyBriefing – WO-Standort (Fertig per Menge, nicht Status-Text)", () => {
  // Live beobachteter Bug: "Kitchen/Staging Status" kennt in der Praxis GAR
  // KEIN "Done"/"Fertig" (echte Werte: "Not Started"/"Pre Blast"/"Post Blast"
  // bzw. "Open"/"Picking"/"Partially Staged"/"Staged"/"Released", siehe
  // statusColors() in ketLogic.ts) — die WO-Tabelle zeigte deshalb immer
  // "0 fertig", egal wie hoch die gekochte Menge stand.
  it("marks a WO Fertig once >=95% of target is cooked, even with a non-'done' status text", () => {
    const briefing = run({ ketRows: [ketRow({ targetPortions: 100, woCookedPortions: 96, kitchenStatus: "Post Blast" })] });
    expect(briefing.ketDays.find(d => d.isToday)?.rows[0].location).toBe("Fertig");
  });

  it("does not treat 'Pre Blast' as Post-Blast just because both contain the word 'blast'", () => {
    const briefing = run({ ketRows: [ketRow({ targetPortions: 100, woCookedPortions: 10, kitchenStatus: "Pre Blast" })] });
    expect(briefing.ketDays.find(d => d.isToday)?.rows[0].location).toBe("Kitchen");
  });

  it("treats staging status 'Not Started' as Warte, not Staging", () => {
    const briefing = run({ ketRows: [ketRow({ targetPortions: 100, woCookedPortions: 0, kitchenStatus: "Not Started", stagingStatus: "Not Started" })] });
    expect(briefing.ketDays.find(d => d.isToday)?.rows[0].location).toBe("Warte");
  });

  it("drops days other than today/tomorrow from ketDays (no more Sunday/Monday leftovers)", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", dateNeeded: LATER_ISO }),
      ketRow({ recipeCode: "FV0002A", dateNeeded: TODAY_ISO }),
    ] });
    expect(briefing.ketDays.every(d => d.isToday || d.isTomorrow)).toBe(true);
    expect(briefing.ketDays.some(d => d.date === LATER_ISO)).toBe(false);
  });
});

describe("buildDailyBriefing – was soll geplaitet werden", () => {
  it("lists a meal with net-plateable portions (produced but not yet plaited)", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100 })], { plannedMeals: 1000 });
    const briefing = run({
      meals: [m],
      ketRows: [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO })],
      plaitedByCode: new Map([["0001", 200]]),
    });
    expect(briefing.platingTodo).toHaveLength(1);
    expect(briefing.platingTodo[0].platedMeals).toBe(200);
    expect(briefing.platingTodo[0].netMeals).toBeGreaterThan(0);
  });

  it("omits a meal that is already fully plaited", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100 })], { plannedMeals: 1000 });
    const briefing = run({
      meals: [m],
      ketRows: [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO })],
      plaitedByCode: new Map([["0001", 100_000]]), // weit mehr als produziert
    });
    expect(briefing.platingTodo).toEqual([]);
  });
});

describe("buildDailyBriefing – gefährdete WOs", () => {
  it("attaches concrete WO numbers and reasons to at-risk meals", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, workOrder: "38-77" })]);
    const briefing = run({
      meals: [m],
      ketRows: [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO, woNumber: "38-77" })],
    });
    expect(briefing.atRiskWos).toHaveLength(1);
    expect(briefing.atRiskWos[0]).toMatchObject({ woNumbers: ["38-77"], isToday: true, dayLabel: "Heute" });
    expect(briefing.atRiskWos[0].reasons[0]).toContain("Küche");
  });

  it("groups multiple at-risk WOs of the same meal into one entry instead of repeating the reason per WO", () => {
    // Live beobachtet: ein Meal mit 6 offenen Sub-Rezept-WOs zeigte denselben
    // langen Backfill-Absatz 6x identisch untereinander.
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, workOrder: "38-1" })]);
    const briefing = run({
      meals: [m],
      ketRows: [
        ketRow({ recipeCode: "FV0001A", subRecipeName: "Sauce", dateNeeded: TODAY_ISO, woNumber: "38-1" }),
        ketRow({ recipeCode: "FV0001A", subRecipeName: "Rice", dateNeeded: TODAY_ISO, woNumber: "38-2" }),
        ketRow({ recipeCode: "FV0001A", subRecipeName: "Sauce", dateNeeded: TOMORROW_ISO, woNumber: "38-3" }),
      ],
    });
    expect(briefing.atRiskWos).toHaveLength(1);
    expect(briefing.atRiskWos[0].woNumbers).toEqual(["38-1", "38-2", "38-3"]);
    expect(briefing.atRiskWos[0].reasons).toHaveLength(1);
    expect(briefing.atRiskWos[0].dayLabel).toBe("Heute + Morgen");
  });

  it("does not list an already-finished WO as at risk", () => {
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, workOrder: "38-77" })]);
    const briefing = run({
      meals: [m],
      ketRows: [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO, woNumber: "38-77", targetPortions: 100, woCookedPortions: 100 })],
    });
    expect(briefing.atRiskWos).toEqual([]);
  });
});

describe("buildDailyBriefing – morgen zuerst anfassen", () => {
  it("puts a critical meal first, ahead of a larger non-critical batch", () => {
    const critMeal = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, recipeCode: "FV0001A" })], { recipeCode: "FV0001A" });
    const briefing = run({
      meals: [critMeal],
      ketRows: [
        ketRow({ recipeCode: "FV0001A", dateNeeded: TOMORROW_ISO, woNumber: "38-1", targetPortions: 50 }),
        ketRow({ recipeCode: "FV0002A", dateNeeded: TOMORROW_ISO, woNumber: "38-2", targetPortions: 500 }),
      ],
    });
    expect(briefing.tomorrowPriority.map(p => p.woNumber)).toEqual(["38-1", "38-2"]);
    expect(briefing.tomorrowPriority[0].reason).toContain("Kritisch");
    expect(briefing.tomorrowPriority[1].reason).toContain("Großer Ansatz");
  });

  it("is empty when tomorrow has no open WOs", () => {
    const briefing = run({ ketRows: [ketRow({ dateNeeded: TOMORROW_ISO, targetPortions: 100, woCookedPortions: 100 })] });
    expect(briefing.tomorrowPriority).toEqual([]);
  });
});

describe("buildDailyBriefing – Besetzungs-Schätzung Küche", () => {
  it("falls back to counting distinct sub-recipes in active kitchen work today (+1) when no plan figure is given", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", subRecipeName: "Sauce", dateNeeded: TODAY_ISO, kitchenStatus: "Pre Blast", woCookedPortions: 5, targetPortions: 100 }),
      ketRow({ recipeCode: "FV0001A", subRecipeName: "Rice", dateNeeded: TODAY_ISO, kitchenStatus: "Pre Blast", woCookedPortions: 5, targetPortions: 100 }),
    ] });
    expect(briefing.staffing.kitchenComponents).toBe(2);
    expect(briefing.staffing.kitchen).toBe(3);
    expect(briefing.staffing.kitchenSource).toBe("estimate");
  });

  it("uses the concrete headcount from the staffing-plan sheet when given, overriding the estimate", () => {
    const briefing = run({
      ketRows: [ketRow({ recipeCode: "FV0001A", subRecipeName: "Sauce", dateNeeded: TODAY_ISO, kitchenStatus: "Pre Blast", woCookedPortions: 5, targetPortions: 100 })],
      kitchenHeadcountFromPlan: 36,
    });
    expect(briefing.staffing.kitchen).toBe(36);
    expect(briefing.staffing.kitchenSource).toBe("plan");
  });

  it("returns 0/none (not 1) when nothing is open today and no plan figure is given", () => {
    const briefing = run({ ketRows: [] });
    expect(briefing.staffing.kitchen).toBe(0);
    expect(briefing.staffing.kitchenSource).toBe("none");
    expect(briefing.staffing.plating).toBe(0);
  });
});

describe("buildDailyBriefing – Besetzungs-Schätzung Plating (aus der Rezeptstruktur)", () => {
  it("counts a to-be-plated meal's actual sub-recipe components (+1), not just today's KET rows", () => {
    // Küche hat die Komponenten schon vor Tagen fertig gekocht (keine KET-Zeile
    // heute) — das Meal steht trotzdem zum Plaitieren an. Muss trotzdem zählen.
    const m = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 100 })], { plannedMeals: 1000 });
    const data = dataWithStructure([
      structNode({ id: "SUB-1", name: "Sauce" }),
      structNode({ id: "SUB-2", name: "Rice" }),
    ]);
    const briefing = run({
      meals: [m],
      data,
      ketRows: [ketRow({ recipeCode: "FV0001A", dateNeeded: TODAY_ISO })], // nur für den Tages-Fokus, keine Sauce/Rice-Zeilen
      plaitedByCode: new Map([["0001", 200]]),
    });
    expect(briefing.platingTodo).toHaveLength(1);
    expect(briefing.staffing.platingComponents).toBe(2);
    expect(briefing.staffing.plating).toBe(3);
  });
});

describe("buildDailyBriefing – copyText hat dieselben Abschnitte wie die PDF", () => {
  it("includes the open-today WO list, not just the day summary", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", woNumber: "38-5", dateNeeded: TODAY_ISO, targetPortions: 100, woCookedPortions: 10 }),
    ] });
    expect(briefing.copyText).toContain("Heute noch offen");
    expect(briefing.copyText).toContain("WO 38-5");
  });

  it("omits the open-today section once everything today is finished", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", woNumber: "38-5", dateNeeded: TODAY_ISO, targetPortions: 100, woCookedPortions: 100 }),
    ] });
    expect(briefing.copyText).not.toContain("Heute noch offen");
  });
});

describe("buildDailyBriefing – Zweischicht-Modell (ab KW39: Früh/Spät je Tag)", () => {
  it("splits today into two separate Früh/Spät groups instead of merging them", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", woNumber: "39-1", dateNeeded: `${TODAY_ISO} - 1`, targetPortions: 100, woCookedPortions: 100 }),
      ketRow({ recipeCode: "FV0002A", woNumber: "39-2", dateNeeded: `${TODAY_ISO} - 2`, targetPortions: 200, woCookedPortions: 0 }),
    ] });
    const todayGroups = briefing.ketDays.filter(d => d.isToday);
    expect(todayGroups).toHaveLength(2);
    expect(todayGroups.map(d => d.shift).sort()).toEqual(["1", "2"]);
    expect(todayGroups.find(d => d.shift === "1")?.dateLabel).toContain("Früh");
    expect(todayGroups.find(d => d.shift === "2")?.dateLabel).toContain("Spät");
  });

  it("aggregates today's summary across BOTH shifts, not just the first found", () => {
    // Regression: alle Stellen, die vorher ketDays.find(d => d.isToday) nutzten,
    // hätten sonst die Spätschicht stillschweigend verschluckt.
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", woNumber: "39-1", dateNeeded: `${TODAY_ISO} - 1`, targetPortions: 100, woCookedPortions: 100 }),
      ketRow({ recipeCode: "FV0002A", woNumber: "39-2", dateNeeded: `${TODAY_ISO} - 2`, targetPortions: 200, woCookedPortions: 0 }),
    ] });
    expect(briefing.summary.todayWos).toBe(2);
    expect(briefing.summary.todayCooked).toBe(100);
    expect(briefing.summary.todayCookedPct).toBe(33); // 100 / 300
  });

  it("aggregates tomorrow's WO count and priority list across both shifts", () => {
    const critMeal = meal([wo({ subRecipe: "Sauce", plannedKg: 100, actualKg: 0, isCritical: true, recipeCode: "FV0001A" })], { recipeCode: "FV0001A" });
    const briefing = run({
      meals: [critMeal],
      ketRows: [
        ketRow({ recipeCode: "FV0001A", woNumber: "39-3", dateNeeded: `${TOMORROW_ISO} - 1`, targetPortions: 50 }),
        ketRow({ recipeCode: "FV0002A", woNumber: "39-4", dateNeeded: `${TOMORROW_ISO} - 2`, targetPortions: 500 }),
      ],
    });
    expect(briefing.summary.tomorrowWos).toBe(2);
    expect(briefing.tomorrowPriority.map(p => p.woNumber)).toEqual(["39-3", "39-4"]);
  });

  it("counts kitchen staffing components across both of today's shifts", () => {
    const briefing = run({ ketRows: [
      ketRow({ recipeCode: "FV0001A", subRecipeName: "Sauce", dateNeeded: `${TODAY_ISO} - 1`, kitchenStatus: "Pre Blast", woCookedPortions: 5, targetPortions: 100 }),
      ketRow({ recipeCode: "FV0001A", subRecipeName: "Rice", dateNeeded: `${TODAY_ISO} - 2`, kitchenStatus: "Pre Blast", woCookedPortions: 5, targetPortions: 100 }),
    ] });
    expect(briefing.staffing.kitchenComponents).toBe(2);
  });
});
