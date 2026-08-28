import { describe, expect, it } from "vitest";
import type { DetailedSubRecipe } from "../core/types";
import {
  aggregateSubRecipe,
  flattenIngredients,
  computeStatedOutputG,
  aggregateSubRecipeIngredientNeeds,
} from "../features/whatif/whatIfAggregate";

const NO_OVERRIDES = new Map<string, number>();
const NO_INSTR = new Map<string, string>();

function ing(id: string, grossQty: number, opts: { netQty?: number; yieldPct?: number } = {}) {
  return {
    id,
    name: id,
    grossQty,
    netQty: opts.netQty ?? grossQty,
    uom: "grams",
    yieldPct: opts.yieldPct,
  };
}

function sub(
  id: string,
  quantity: number | undefined,
  ingredients: ReturnType<typeof ing>[],
  subRecipes: DetailedSubRecipe[] = [],
  uom = "grams",
): DetailedSubRecipe {
  return { id, name: id, categories: "", quantity, uom, subRecipes, ingredients };
}

describe("aggregateSubRecipe — Stated-Quantity-Modell", () => {
  it("Sub-Netto kommt direkt aus der MSKU-quantity (grams)", () => {
    const sub2 = sub("sub2", 60, [ing("i2", 100)]);
    const sub1 = sub("sub1", 200, [ing("i1", 150)], [sub2]);

    const agg = aggregateSubRecipe(sub1, [], 0, NO_OVERRIDES, NO_INSTR);

    expect(agg.statedFromMsku).toBe(true);
    expect(agg.subtreeNetPerPortion).toBe(200);
    // Eingang = 150 (getrimmt) + 60 (Kind-Ausgabe)
    expect(agg.ownGrossInput).toBe(210);
    expect(agg.localYield).toBeCloseTo(200 / 210, 6);
    // Rohware inkl. Kind bleibt Brutto-Summe aller Blätter
    expect(agg.subtreeGrossPerPortion).toBe(250);
  });

  it("Kind-Zutat kompoundiert eigenen Sub- und Eltern-Yield", () => {
    const sub2 = sub("sub2", 60, [ing("i2", 100)]);
    const sub1 = sub("sub1", 200, [ing("i1", 150)], [sub2]);
    const agg = aggregateSubRecipe(sub1, [], 0, NO_OVERRIDES, NO_INSTR);

    const flat = flattenIngredients(agg);
    const i1 = flat.find(x => x.ingredientId === "i1")!;
    const i2 = flat.find(x => x.ingredientId === "i2")!;

    expect(i1.effectiveYield).toBeCloseTo(200 / 210, 6);
    expect(i1.ancestorYieldFactor).toBe(1);
    // i2: eigener Sub 60/100, Eltern-Kette 200/210
    expect(i2.ancestorYieldFactor).toBeCloseTo(200 / 210, 6);
    expect(i2.effectiveYield).toBeCloseTo((60 / 100) * (200 / 210), 6);

    // Σ Zutaten-Endteller-Netto == Σ Top-Level statedOutput
    const sumFinal = flat.reduce((s, x) => s + x.grossQty * x.effectiveYield, 0);
    expect(sumFinal).toBeCloseTo(200, 4);
  });

  it("Zutaten-Trimmung (netQty < grossQty) fließt in den effektiven Faktor ein", () => {
    // localYield == 1 (quantity == getrimmter Eingang), nur Trim wirkt
    const s = sub("strim", 100, [ing("t", 200, { netQty: 100, yieldPct: 1.0 })]);
    const agg = aggregateSubRecipe(s, [], 0, NO_OVERRIDES, NO_INSTR);
    const t = flattenIngredients(agg)[0];
    expect(agg.localYield).toBeCloseTo(1, 6);
    expect(t.effectiveYield).toBeCloseTo(0.5, 6);
    expect(agg.subtreeNetPerPortion).toBe(100);
  });

  it("each-Sub ohne grams-quantity → geschätzt via computeStatedOutputG", () => {
    const s = sub("prot", 1, [ing("chick", 120, { yieldPct: 0.7 })], [], "each");
    const { statedOutputG, statedFromMsku } = computeStatedOutputG(s);
    expect(statedFromMsku).toBe(false);
    expect(statedOutputG).toBeCloseTo(0.7 * 120, 6);

    const agg = aggregateSubRecipe(s, [], 0, NO_OVERRIDES, NO_INSTR);
    expect(agg.statedFromMsku).toBe(false);
    expect(agg.subtreeNetPerPortion).toBeCloseTo(84, 6);
  });

  it("Override schlägt die Kompoundierung (exakter Wert, keine Neuverteilung)", () => {
    const sub1 = sub("sub1", 200, [ing("i1", 150)], [sub("sub2", 60, [ing("i2", 100)])]);
    const overrides = new Map<string, number>([["i2__sub2", 0.5]]);
    const agg = aggregateSubRecipe(sub1, [], 0, overrides, NO_INSTR);
    const i2 = flattenIngredients(agg).find(x => x.ingredientId === "i2")!;
    expect(i2.hasOverride).toBe(true);
    expect(i2.effectiveYield).toBe(0.5);
  });
});

describe("aggregateSubRecipeIngredientNeeds — sub-lokal", () => {
  it("Summe der Netto-Mengen == statedOutputG des gewählten Subs", () => {
    const sub2 = sub("sub2", 60, [ing("i2", 100)]);
    const sub1 = sub("sub1", 200, [ing("i1", 150)], [sub2]);
    const root = aggregateSubRecipe(sub1, [], 0, NO_OVERRIDES, NO_INSTR);

    // Subrezept-Rechner für sub1: ancestorDivisor = root.ancestorYieldFactor (1)
    const needs = aggregateSubRecipeIngredientNeeds(flattenIngredients(root), 1000, root.ancestorYieldFactor);
    const totalNet = needs.reduce((s, n) => s + n.netTotal, 0);
    expect(totalNet).toBeCloseTo(200 * 1000, 1);
  });

  it("nested Sub sub-lokal: Verlust nur innerhalb des Subs", () => {
    const sub2 = sub("sub2", 60, [ing("i2", 100)]);
    const sub1 = sub("sub1", 200, [ing("i1", 150)], [sub2]);
    const root = aggregateSubRecipe(sub1, [], 0, NO_OVERRIDES, NO_INSTR);
    const child = root.childSubRecipes[0];

    const needs = aggregateSubRecipeIngredientNeeds(flattenIngredients(child), 1000, child.ancestorYieldFactor);
    const totalNet = needs.reduce((s, n) => s + n.netTotal, 0);
    expect(totalNet).toBeCloseTo(60 * 1000, 1);
  });
});
