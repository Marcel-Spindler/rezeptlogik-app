// What-If Rechner – Sub-Rezept-Baum-Aggregation (Forward/Reverse, yield-aware).
import type { DetailedSubRecipe, Market, Recipe, RecipeStructure, WeekRecipe } from "../../core/types";
import type { FlatIngredient, FullIngredientNeed, SubRecipeAggregate, SubRecipeIngredientNeed, YieldSource } from "./whatIfTypes";

/**
 * Normalisiert einen yieldPct-Wert aus den Daten.
 * - 0 < val <= 2: bereits Dezimal (0.7011 = 70.11%) → direkt verwenden (erlaubt Quellprodukte bis 200%)
 * - 2 < val <= 100: war Prozentzahl (70.11) → durch 100 teilen
 * - > 100: ungültig → undefined
 * - <= 0 oder undefined: kein Yield → undefined
 */
export function normalizeYield(val: number | undefined): number | undefined {
  if (val === undefined || val <= 0) return undefined;
  if (val <= 2) return val;
  if (val <= 100) return val / 100;
  return undefined;
}

/**
 * Bestimmt den effektiven Yield und dessen Quelle.
 * Priorität: Override > CSV yieldPct > berechnet aus netQty/grossQty > Fallback 1.0
 */
export function resolveYield(
  yieldPct: number | undefined,
  grossQty: number,
  netQty: number,
  override: number | undefined
): { effectiveYield: number; yieldSource: YieldSource; yieldMissing: boolean } {
  if (override !== undefined) {
    return { effectiveYield: override, yieldSource: "override", yieldMissing: false };
  }
  const normalized = normalizeYield(yieldPct);
  if (normalized !== undefined) {
    return { effectiveYield: normalized, yieldSource: "csv", yieldMissing: false };
  }
  if (grossQty > 0 && netQty > 0 && netQty !== grossQty) {
    const computed = netQty / grossQty;
    if (computed > 0 && computed <= 2) {
      return { effectiveYield: computed, yieldSource: "computed", yieldMissing: false };
    }
  }
  return { effectiveYield: 1, yieldSource: "fallback", yieldMissing: true };
}

export function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  const total = (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0);
  return total > 0;
}

export function getBaseVolume(r: WeekRecipe): number {
  return r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE;
}

export function getStructureForRecipe(structure: RecipeStructure | undefined): DetailedSubRecipe[] {
  if (!structure) return [];
  for (const m of ["DE", "BENL", "DKSE"] as Market[]) {
    const arr = structure.markets[m];
    if (arr && arr.length > 0) return arr;
  }
  return [];
}

export function buildInstructionsMap(recipe: Recipe | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!recipe) return map;
  for (const market of Object.keys(recipe.markets) as Market[]) {
    const sd = recipe.markets[market];
    if (!sd) continue;
    for (const sub of sd.subRecipes) {
      if (sub.instructions && !map.has(sub.id)) {
        map.set(sub.id, sub.instructions);
      }
    }
  }
  return map;
}

const GRAM_UOMS = new Set(["grams", "gram", "g", "gr"]);

function isGramQuantity(node: DetailedSubRecipe): boolean {
  return GRAM_UOMS.has((node.uom ?? "").trim().toLowerCase()) && (node.quantity ?? 0) > 0;
}

/**
 * Plattierte Netto-Ausgabe eines Sub-Rezepts in Gramm.
 * Primär: MSKUs `Sub-Recipe N Quantity` (grams) — autoritativ, per Definition exakt.
 * Fallback (nur `each`-Subs / fehlende Menge, ~5 %): eigener Kochyield × Eingangsmasse.
 */
export function computeStatedOutputG(node: DetailedSubRecipe): { statedOutputG: number; statedFromMsku: boolean } {
  if (isGramQuantity(node)) {
    return { statedOutputG: node.quantity as number, statedFromMsku: true };
  }
  const ings = node.ingredients ?? [];
  const repYield = ings
    .map(i => normalizeYield(i.yieldPct))
    .find(v => v !== undefined) ?? 1;
  const ownInput = ings.reduce((s, i) => {
    const base = i.netQty > 0 && i.netQty <= i.grossQty ? i.netQty : i.grossQty;
    return s + base;
  }, 0);
  const childInput = (node.subRecipes ?? []).reduce((s, c) => s + computeStatedOutputG(c).statedOutputG, 0);
  return { statedOutputG: repYield * (ownInput + childInput), statedFromMsku: false };
}

export function aggregateSubRecipe(
  node: DetailedSubRecipe,
  parentPath: string[],
  depth: number,
  overrides: Map<string, number>,
  instructionsMap: Map<string, string>,
  ancestorYieldFactor = 1
): SubRecipeAggregate {
  const path = [...parentPath, node.name];

  // 1. Ausgabe (MSKU-Menge) + Eingangsmasse dieses Kochschritts.
  //    Eingang = getrimmte Zutatenmasse (netQty) + Kind-Ausgaben, damit
  //    Σ(Zutaten-Netto) == statedOutputG exakt aufgeht.
  const { statedOutputG, statedFromMsku } = computeStatedOutputG(node);
  const ownLeafGross = (node.ingredients ?? []).reduce((s, i) => s + i.grossQty, 0);
  const ownLeafTrimmed = (node.ingredients ?? []).reduce(
    (s, i) => s + (i.netQty > 0 && i.netQty <= i.grossQty ? i.netQty : i.grossQty),
    0
  );
  const childStatedSum = (node.subRecipes ?? []).reduce(
    (s, c) => s + computeStatedOutputG(c).statedOutputG,
    0
  );
  const ownGrossInput = ownLeafTrimmed + childStatedSum;
  const localYield = ownGrossInput > 0 ? statedOutputG / ownGrossInput : 1;
  const nodeYieldFactor = ancestorYieldFactor * localYield;

  // 2. Zutaten mit kompoundiertem Faktor (raw → Endteller)
  const ingredients: FlatIngredient[] = (node.ingredients ?? []).map(ing => {
    const ovKey = `${ing.id}__${node.id}`;
    const override = overrides.get(ovKey);
    const { yieldSource, yieldMissing } = resolveYield(ing.yieldPct, ing.grossQty, ing.netQty, override);
    const trimRatio =
      ing.grossQty > 0 && ing.netQty > 0 && ing.netQty < ing.grossQty ? ing.netQty / ing.grossQty : 1;
    const ownYieldFactor = trimRatio * localYield;
    const fullFactor = trimRatio * nodeYieldFactor;
    return {
      ingredientId: ing.id,
      ingredientName: ing.name,
      subRecipeId: node.id,
      subRecipePath: path,
      grossQty: ing.grossQty,
      netQty: ing.netQty,
      uom: ing.uom,
      defaultYield: ing.yieldPct,
      effectiveYield: override !== undefined ? override : fullFactor,
      ownYieldFactor,
      ancestorYieldFactor,
      hasOverride: override !== undefined,
      yieldSource,
      yieldMissing
    };
  });

  // 3. Kinder rekursiv mit dem kompoundierten Faktor dieses Knotens
  const childSubRecipes = (node.subRecipes ?? []).map(child =>
    aggregateSubRecipe(child, path, depth + 1, overrides, instructionsMap, nodeYieldFactor)
  );

  const totalGross = ownLeafGross;
  const totalNet = ingredients.reduce((s, x) => s + x.grossQty * x.effectiveYield, 0);
  const subtreeGross = totalGross + childSubRecipes.reduce((s, child) => s + child.subtreeGrossPerPortion, 0);

  return {
    subRecipeId: node.id,
    name: node.name,
    categories: node.categories,
    path,
    depth,
    totalGrossPerPortion: totalGross,
    totalNetPerPortion: totalNet,
    subtreeGrossPerPortion: subtreeGross,
    subtreeNetPerPortion: statedOutputG,
    statedOutputG,
    ownGrossInput,
    localYield,
    ancestorYieldFactor,
    statedFromMsku,
    // Ø-Yield für die Anzeige: Gesamt Rohware (inkl. Kinder) → MSKU-Ausgabe.
    avgYield: subtreeGross > 0 ? statedOutputG / subtreeGross : undefined,
    ingredients,
    childSubRecipes,
    instructions: instructionsMap.get(node.id)
  };
}

export function flattenIngredients(agg: SubRecipeAggregate): FlatIngredient[] {
  return [
    ...agg.ingredients,
    ...agg.childSubRecipes.flatMap(flattenIngredients)
  ];
}

export function flattenSubRecipes(agg: SubRecipeAggregate): SubRecipeAggregate[] {
  return [agg, ...agg.childSubRecipes.flatMap(flattenSubRecipes)];
}

/**
 * Bedarf je Zutat für ein einzelnes Sub-Rezept. `ancestorDivisor` = das
 * `ancestorYieldFactor` des gewählten Sub-Rezepts: damit rechnet die Funktion
 * **sub-lokal** (nur Verlust innerhalb dieses Subs), sodass die Summe der
 * Netto-Mengen exakt der MSKU-Ausgabemenge (`statedOutputG`) des Subs entspricht.
 */
export function aggregateSubRecipeIngredientNeeds(
  ingredients: FlatIngredient[],
  portions: number,
  ancestorDivisor = 1
): SubRecipeIngredientNeed[] {
  const grouped = new Map<string, SubRecipeIngredientNeed>();
  const div = ancestorDivisor > 0 ? ancestorDivisor : 1;
  for (const ing of ingredients) {
    const key = `${ing.ingredientId}__${ing.uom}`;
    const grossPerPortion = ing.grossQty;
    const localEff = ing.hasOverride ? ing.effectiveYield : ing.effectiveYield / div;
    const netPerPortion = ing.grossQty * localEff;
    const current = grouped.get(key) ?? {
      key,
      ingredientId: ing.ingredientId,
      ingredientName: ing.ingredientName,
      uom: ing.uom,
      grossPerPortion: 0,
      netPerPortion: 0,
      grossTotal: 0,
      netTotal: 0,
      lossTotal: 0,
      lossPercent: 0,
      costLoss: undefined
    };
    current.grossPerPortion += grossPerPortion;
    current.netPerPortion += netPerPortion;
    current.grossTotal += grossPerPortion * portions;
    current.netTotal += netPerPortion * portions;
    current.lossTotal = current.grossTotal - current.netTotal;
    current.lossPercent = current.grossTotal > 0 ? (current.lossTotal / current.grossTotal) * 100 : 0;
    if (ing.pricePerKg !== undefined) {
      current.costLoss = (current.costLoss ?? 0) + ((grossPerPortion - netPerPortion) * portions / 1000 * ing.pricePerKg);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.grossPerPortion - a.grossPerPortion);
}

export function aggregateRecipeIngredientNeeds(ingredients: FlatIngredient[], portions: number): FullIngredientNeed[] {
  const grouped = new Map<string, FullIngredientNeed>();
  for (const ing of ingredients) {
    const key = `${ing.ingredientId}__${ing.uom}`;
    const grossPerPortion = ing.grossQty;
    const netPerPortion = ing.grossQty * ing.effectiveYield;
    const current = grouped.get(key) ?? {
      key,
      ingredientId: ing.ingredientId,
      ingredientName: ing.ingredientName,
      uom: ing.uom,
      grossPerPortion: 0,
      netPerPortion: 0,
      grossTotal: 0,
      netTotal: 0,
      lossTotal: 0,
      lossPercent: 0,
      costLoss: undefined
    };
    current.grossPerPortion += grossPerPortion;
    current.netPerPortion += netPerPortion;
    current.grossTotal += grossPerPortion * portions;
    current.netTotal += netPerPortion * portions;
    current.lossTotal = current.grossTotal - current.netTotal;
    current.lossPercent = current.grossTotal > 0 ? (current.lossTotal / current.grossTotal) * 100 : 0;
    if (ing.pricePerKg !== undefined) {
      current.costLoss = (current.costLoss ?? 0) + ((grossPerPortion - netPerPortion) * portions / 1000 * ing.pricePerKg);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.grossPerPortion - a.grossPerPortion);
}

/** Findet die Top-N Engpass-Zutaten im Reverse-Modus */
export function findBottlenecks(ingredients: FlatIngredient[], availableRawGrams: Map<string, number>, topN = 3): Array<{
  ingredientId: string;
  ingredientName: string;
  grossPerPortion: number;
  availableGrams: number;
  maxPortions: number;
  isLimiting: boolean;
}> {
  const results = ingredients
    .filter(ing => ing.grossQty > 0)
    .map(ing => {
      const available = availableRawGrams.get(ing.ingredientId) ?? Infinity;
      return {
        ingredientId: ing.ingredientId,
        ingredientName: ing.ingredientName,
        grossPerPortion: ing.grossQty,
        availableGrams: available,
        maxPortions: available === Infinity ? Infinity : Math.floor(available / ing.grossQty),
        isLimiting: false
      };
    })
    .filter(r => r.maxPortions !== Infinity)
    .sort((a, b) => a.maxPortions - b.maxPortions);

  if (results.length > 0) results[0].isLimiting = true;
  return results.slice(0, topN);
}

