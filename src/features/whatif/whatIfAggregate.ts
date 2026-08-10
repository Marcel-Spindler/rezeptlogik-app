// What-If Rechner – Sub-Rezept-Baum-Aggregation (Forward/Reverse, yield-aware).
import type { DetailedSubRecipe, Market, Recipe, RecipeStructure, WeekRecipe } from "../../core/types";
import type { FlatIngredient, FullIngredientNeed, SubRecipeAggregate, SubRecipeIngredientNeed } from "./whatIfTypes";

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
    const effectiveYield = override !== undefined
      ? override
      : (ing.yieldPct !== undefined && ing.yieldPct > 0 && ing.yieldPct <= 1 ? ing.yieldPct : 1);
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
      hasOverride: override !== undefined
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
      lossTotal: 0
    };
    current.grossPerPortion += grossPerPortion;
    current.netPerPortion += netPerPortion;
    current.grossTotal += grossPerPortion * portions;
    current.netTotal += netPerPortion * portions;
    current.lossTotal = current.grossTotal - current.netTotal;
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
      lossTotal: 0
    };
    current.grossPerPortion += grossPerPortion;
    current.netPerPortion += netPerPortion;
    current.grossTotal += grossPerPortion * portions;
    current.netTotal += netPerPortion * portions;
    current.lossTotal = current.grossTotal - current.netTotal;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => b.grossPerPortion - a.grossPerPortion);
}

