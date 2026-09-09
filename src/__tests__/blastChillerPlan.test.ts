import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHILLER_PLAN_PARAMS,
  aggregateWeekPlan,
  buildRecipeGroups,
  canonicalAllergens,
  classicLayout,
  cyclesPerDay,
  planChillers,
  racksPerChillerDay,
  toChillerWo,
  type ChillerPlanParams,
  type ChillerWoInput,
} from "../features/blast-chiller/blastChillerPlan";

function wo(o: Partial<ChillerWoInput>): ReturnType<typeof toChillerWo> {
  return toChillerWo({
    wo: "37-1", name: "Component", recipeCode: "FV0001A", recipeName: "FV0001A - Demo",
    date: "2026-08-31", kg: 100, allergen: null, precision: "sub", ...o,
  });
}

/** Testparameter mit fester Tageskapazität = `capPerDay` Racks/Chiller (cycleHours 24 → 1 Zyklus). */
const mkParams = (capPerDay: number, extra: Partial<ChillerPlanParams> = {}): ChillerPlanParams => ({
  ...DEFAULT_CHILLER_PLAN_PARAMS, racksPerCycle: capPerDay, cycleHours: 24, rackKg: 200, ...extra,
});
const P = mkParams(4);

describe("capacity model (Beladefenster)", () => {
  it("counts cycles from the load window: 08–23 Uhr / 2,5 h → 7 Zyklen", () => {
    const p = { ...DEFAULT_CHILLER_PLAN_PARAMS, firstLoadHour: 8, lastLoadHour: 23, cycleHours: 2.5, racksPerCycle: 6 };
    expect(cyclesPerDay(p)).toBe(7);
    expect(racksPerChillerDay(p)).toBe(42);
  });

  it("shrinks with a shorter window and longer cycles", () => {
    expect(cyclesPerDay({ ...DEFAULT_CHILLER_PLAN_PARAMS, firstLoadHour: 8, lastLoadHour: 16, cycleHours: 3 })).toBe(3);
    expect(cyclesPerDay({ ...DEFAULT_CHILLER_PLAN_PARAMS, firstLoadHour: 8, lastLoadHour: 8, cycleHours: 2 })).toBe(1);
  });
});

describe("canonicalAllergens", () => {
  it("maps raw allergen strings to short labels", () => {
    expect(canonicalAllergens("MILCH (EINSCHLIESSLICH LAKTOSE), SCHWEFELDIOXIDE UND SULFITE"))
      .toEqual(["Milch", "Sulfite"]);
    expect(canonicalAllergens("MANDELN, SCHALENFRÜCHTE")).toEqual(["Nüsse"]);
    expect(canonicalAllergens("FISCH")).toEqual(["Fisch"]);
    expect(canonicalAllergens("KEINE")).toEqual([]);
    expect(canonicalAllergens(null)).toEqual([]);
  });
});

describe("buildRecipeGroups", () => {
  it("keeps all components of one recipe together regardless of allergens", () => {
    const wos = [
      wo({ wo: "37-1", name: "Salmon", recipeCode: "FV0009A", allergen: "FISCH" }),
      wo({ wo: "37-2", name: "Rice", recipeCode: "FV0009A", allergen: "KEINE" }),
      wo({ wo: "37-3", name: "Sauce", recipeCode: "FV0009A", allergen: "MILCH (EINSCHLIESSLICH LAKTOSE)" }),
    ];
    const groups = buildRecipeGroups(wos, P);
    expect(groups).toHaveLength(1);
    expect(groups[0].wos).toHaveLength(3);
    expect(groups[0].allergens).toEqual(["Fisch", "Milch"]);
    expect(groups[0].allergenFree).toBe(false);
  });

  it("splits the same recipe cooked on different days", () => {
    const wos = [
      wo({ recipeCode: "FV0001A", date: "2026-08-31" }),
      wo({ recipeCode: "FV0001A", date: "2026-09-01" }),
    ];
    expect(buildRecipeGroups(wos, P)).toHaveLength(2);
  });

  it("rounds kg up to racks, minimum 1", () => {
    const groups = buildRecipeGroups([wo({ kg: 250 })], { ...P, rackKg: 200 });
    expect(groups[0].racks).toBe(2);
    expect(buildRecipeGroups([wo({ kg: 0 })], P)[0].racks).toBe(1);
  });
});

describe("planChillers", () => {
  it("puts the fish recipe and its allergen-free rice side in the same chiller", () => {
    const wos = [
      wo({ wo: "1", name: "Salmon", recipeCode: "FV0009A", allergen: "FISCH", kg: 300 }),
      wo({ wo: "2", name: "Rice", recipeCode: "FV0009A", allergen: "KEINE", kg: 200 }),
    ];
    const plan = planChillers(wos, P);
    const withFish = plan.chillers.filter(c => c.groups.some(g => g.recipeCode === "FV0009A"));
    expect(withFish).toHaveLength(1);
    expect(withFish[0].groups[0].wos).toHaveLength(2);
  });

  it("never merges allergen-free recipes into an allergenic chiller", () => {
    const wos = [
      wo({ wo: "1", recipeCode: "FREE1", allergen: "KEINE", kg: 100 }),
      wo({ wo: "2", recipeCode: "FREE2", allergen: "KEINE", kg: 100 }),
      wo({ wo: "3", recipeCode: "MILK1", allergen: "MILCH", kg: 100 }),
      wo({ wo: "4", recipeCode: "FISH1", allergen: "FISCH", kg: 100 }),
    ];
    const plan = planChillers(wos, P);
    for (const c of plan.chillers) {
      const hasFree = c.groups.some(g => g.allergenFree);
      const hasAllergen = c.groups.some(g => !g.allergenFree);
      expect(hasFree && hasAllergen).toBe(false);
    }
  });

  it("balances load so no chiller exceeds capacity when total capacity is sufficient", () => {
    const wos = Array.from({ length: 12 }, (_, i) =>
      wo({ wo: String(i), recipeCode: `R${i}`, allergen: i % 2 ? "MILCH" : "SCHWEFELDIOXIDE UND SULFITE", kg: 200 }),
    );
    // 12 racks total, 6 chillers × 4 = 24 capacity
    const plan = planChillers(wos, P);
    expect(plan.over).toBe(false);
    expect(plan.chillers.every(c => c.racks <= c.capRacks)).toBe(true);
  });

  it("flags an over-capacity day and names a recipe to move", () => {
    const wos = Array.from({ length: 40 }, (_, i) =>
      wo({ wo: String(i), recipeCode: `R${i}`, allergen: "MILCH", kg: 200 }),
    );
    const plan = planChillers(wos, mkParams(2));
    expect(plan.over).toBe(true);
    expect(plan.overflowRacks).toBeGreaterThan(0);
    expect(plan.hints.join(" ")).toMatch(/über Gesamtkapazität|verschieben/);
  });

  it("keeps unknown work orders out of the allergen-free area and flags them", () => {
    const wos = [
      wo({ wo: "1", recipeCode: "FREE1", allergen: "KEINE", kg: 100 }),
      wo({ wo: "2", recipeCode: "MYST1", allergen: null, precision: "none", kg: 100 }),
    ];
    const plan = planChillers(wos, P);
    expect(plan.unknownWoCount).toBe(1);
    const unit1 = plan.chillers[0];
    expect(unit1.groups.every(g => !g.hasUnknown)).toBe(true);
    expect(plan.hints.join(" ")).toMatch(/ohne klare Allergen-Daten/);
  });

  it("always returns exactly 6 chillers", () => {
    expect(planChillers([], P).chillers).toHaveLength(6);
    expect(planChillers([wo({})], P).chillers).toHaveLength(6);
  });

  it("a KEINE component of an allergenic recipe never counts as allergen-free (safety net)", () => {
    const wos = [
      // recipe carries milk elsewhere, but this component reports no allergen
      wo({ wo: "1", recipeCode: "MILKREC", name: "Plain rice", allergen: "KEINE", recipeAllergen: "MILCH (EINSCHLIESSLICH LAKTOSE)", kg: 100 }),
      wo({ wo: "2", recipeCode: "TRUEFREE", name: "Steamed broccoli", allergen: "KEINE", recipeAllergen: "", kg: 100 }),
      wo({ wo: "3", recipeCode: "FISHREC", allergen: "FISCH", recipeAllergen: "FISCH", kg: 100 }),
    ];
    const groups = buildRecipeGroups(wos, P);
    expect(groups.find(g => g.recipeCode === "MILKREC")!.allergenFree).toBe(false);
    expect(groups.find(g => g.recipeCode === "MILKREC")!.allergens).toContain("Milch");
    expect(groups.find(g => g.recipeCode === "TRUEFREE")!.allergenFree).toBe(true);

    const plan = planChillers(wos, P);
    const cleanUnits = plan.chillers.filter(c => c.role === "allergenfrei");
    for (const c of cleanUnits) {
      expect(c.groups.every(g => g.recipeCode === "TRUEFREE")).toBe(true);
    }
  });
});

describe("classicLayout (Klassik-Modus, Chiller 6 entlastet)", () => {
  it("keeps the fixed buckets and sub-groups chiller 6 by allergen with UNKNOWN on top", () => {
    const wos = [
      wo({ wo: "1", allergen: "SCHWEFELDIOXIDE UND SULFITE" }),      // → 3
      wo({ wo: "2", allergen: "MILCH (EINSCHLIESSLICH LAKTOSE)" }),  // → 4
      wo({ wo: "3", allergen: "MILCH (EINSCHLIESSLICH LAKTOSE), SCHWEFELDIOXIDE UND SULFITE" }), // → 5
      wo({ wo: "4", allergen: "FISCH" }), wo({ wo: "5", allergen: "FISCH" }),
      wo({ wo: "6", allergen: "GLUTENHALTIGES GETREIDE" }),
      wo({ wo: "7", allergen: null, precision: "none" }),            // UNBEKANNT
    ];
    // useEmptyChillers=false → keine Umverteilung, reine Unterteilung
    const { sections } = classicLayout(wos, false);
    const s6 = sections.find(s => s.chillerKey === "6")!;
    expect(s6.groups[0].unknown).toBe(true);                          // UNBEKANNT-Block zuerst
    expect(s6.groups.map(g => g.allergen)).toEqual(expect.arrayContaining(["UNBEKANNT", "Fisch", "Gluten"]));
    expect(sections.find(s => s.chillerKey === "3")!.woCount).toBe(1);
  });

  it("moves the biggest rest-allergen group into an empty allergen chiller", () => {
    const wos = [
      wo({ wo: "1", allergen: "MILCH (EINSCHLIESSLICH LAKTOSE)" }),  // Chiller 4 belegt
      ...Array.from({ length: 5 }, (_, i) => wo({ wo: `f${i}`, allergen: "FISCH" })),
      wo({ wo: "g1", allergen: "GLUTENHALTIGES GETREIDE" }),
    ];
    const before = classicLayout(wos, false).sections.find(s => s.chillerKey === "6")!.woCount;
    const layout = classicLayout(wos, true);
    // Chiller 3 und 5 sind leer → Fisch (größte Gruppe) wandert in einen davon
    const reassigned = layout.sections.filter(s => s.reassigned);
    expect(reassigned.length).toBeGreaterThanOrEqual(1);
    expect(reassigned.some(s => s.groups[0].allergen === "Fisch" && /heute: Fisch/.test(s.label))).toBe(true);
    // Chiller 6 ist danach deutlich entlastet
    const after = layout.sections.find(s => s.chillerKey === "6")!.woCount;
    expect(after).toBeLessThan(before);
    expect(layout.movedGroups).toBeGreaterThanOrEqual(1);
  });

  it("never touches the allergen-free bucket and flags a lopsided chiller 6", () => {
    const wos = [
      wo({ wo: "free", allergen: "KEINE" }),
      ...Array.from({ length: 20 }, (_, i) => wo({ wo: `x${i}`, allergen: i % 2 ? "SESAM" : "SELLERIE" })),
    ];
    const layout = classicLayout(wos, false);
    expect(layout.sections.find(s => s.chillerKey === "1")!.woCount).toBe(1);
    expect(layout.restOverloaded).toBe(true);
  });
});

describe("splitLargeRecipes", () => {
  it("splits a recipe bigger than one chiller-day across chillers, parts never share a unit", () => {
    // one recipe, one giant WO: 4000 kg = 20 racks, cap = 8 → 3 parts
    const wos = [wo({ wo: "1", recipeCode: "BIGFISH", name: "Scallion Salmon", allergen: "FISCH", kg: 4000 })];
    const plan = planChillers(wos, mkParams(8));
    const parts = plan.chillers.flatMap(c => c.groups.filter(g => g.splitKey).map(g => ({ unit: c.unit, ...g })));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(parts.map(p => p.unit)).size).toBe(parts.length); // alle in verschiedenen Chillern
    expect(parts.every(p => p.partCount === parts.length)).toBe(true);
    // Summe der Teil-kg ≈ Original
    expect(parts.reduce((s, p) => s + p.kg, 0)).toBeCloseTo(4000, 0);
    expect(plan.hints.join(" ")).toMatch(/aufgeteilt/);
  });

  it("leaves recipes within capacity untouched", () => {
    const plan = planChillers([wo({ wo: "1", recipeCode: "OK", allergen: "MILCH", kg: 800 })], mkParams(8));
    expect(plan.chillers.flatMap(c => c.groups).every(g => !g.splitKey)).toBe(true);
  });

  it("does not split when the toggle is off", () => {
    const plan = planChillers(
      [wo({ wo: "1", recipeCode: "BIG", allergen: "MILCH", kg: 4000 })],
      mkParams(8, { splitLargeRecipes: false }),
    );
    expect(plan.chillers.flatMap(c => c.groups).every(g => !g.splitKey)).toBe(true);
    expect(plan.over).toBe(true);
  });
});

describe("aggregateWeekPlan", () => {
  it("reports the peak day's rack load per chiller and a day matrix", () => {
    const mon = Array.from({ length: 8 }, (_, i) => wo({ wo: `m${i}`, recipeCode: `M${i}`, date: "2026-08-31", allergen: "MILCH", kg: 200 }));
    const tue = [wo({ wo: "t1", recipeCode: "T1", date: "2026-09-01", allergen: "MILCH", kg: 200 })];
    const dayPlans = [
      planChillers(mon, P, "2026-08-31", 1),
      planChillers(tue, P, "2026-09-01", 1),
    ];
    const week = aggregateWeekPlan(dayPlans, P);
    expect(week.byDay).toHaveLength(2);
    expect(week.byDay![0].units).toHaveLength(6);
    // peak per chiller ≥ any single day's load
    for (let i = 0; i < 6; i++) {
      const peak = week.chillers[i].racks;
      expect(peak).toBeGreaterThanOrEqual(Math.max(...dayPlans.map(p => p.chillers[i].racks)));
    }
  });
});
