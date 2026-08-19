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

export function aggregateSubRecipe(
  node: DetailedSubRecipe,
  parentPath: string[],
  depth: number,
  overrides: Map<string, number>,
  instructionsMap: Map<string, string>
): SubRecipeAggregate {
  const path = [...parentPath, node.name];

  const ingredients: FlatIngredient[] = (node.ingredients ?? []).map(ing => {
    const ovKey = `${ing.id}__${node.id}`;
    const override = overrides.get(ovKey);
    const { effectiveYield, yieldSource, yieldMissing } = resolveYield(
      ing.yieldPct, ing.grossQty, ing.netQty, override
    );
    return {
      ingredientId: ing.id,
      ingredientName: ing.name,
      subRecipeId: node.id,
      subRecipePath: path,
      grossQty: ing.grossQty,
      netQty: ing.netQty,
      uom: ing.uom,
      defaultYield: ing.yieldPct,
      effectiveYield,
      hasOverride: override !== undefined,
      yieldSource,
      yieldMissing
    };
  });

  const childSubRecipes = (node.subRecipes ?? []).map(child =>
    aggregateSubRecipe(child, path, depth + 1, overrides, instructionsMap)
  );

  const totalGross = ingredients.reduce((s, x) => s + x.grossQty, 0);
  const totalNet = ingredients.reduce((s, x) => s + (x.grossQty * x.effectiveYield), 0);
  const subtreeGross = totalGross + childSubRecipes.reduce((s, child) => s + child.subtreeGrossPerPortion, 0);
  const subtreeNet = totalNet + childSubRecipes.reduce((s, child) => s + child.subtreeNetPerPortion, 0);
  const ingsWithYield = ingredients.filter(x => x.effectiveYield > 0);
  const yieldWeightSum = ingsWithYield.reduce((s, x) => s + x.grossQty, 0);
  const yieldWeighted = yieldWeightSum > 0
    ? ingsWithYield.reduce((s, x) => s + (x.effectiveYield * x.grossQty), 0) / yieldWeightSum
    : undefined;

  return {
    subRecipeId: node.id,
    name: node.name,
    categories: node.categories,
    path,
    depth,
    totalGrossPerPortion: totalGross,
    totalNetPerPortion: totalNet,
    subtreeGrossPerPortion: subtreeGross,
    subtreeNetPerPortion: subtreeNet,
    avgYield: yieldWeighted,
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

export function aggregateSubRecipeIngredientNeeds(ingredients: FlatIngredient[], portions: number): SubRecipeIngredientNeed[] {
  const grouped = new Map<string, SubRecipeIngredientNeed>();
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

