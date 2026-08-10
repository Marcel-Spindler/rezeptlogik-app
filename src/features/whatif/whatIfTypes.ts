// What-If Rechner – Domänen-Typen (flache Zutaten, Sub-Rezept-Aggregate, Bedarfs-Zeilen).

export type Direction = "forward" | "reverse";
export type SubRecipeScenario = "missing-meals" | "finished-coverage" | "raw-coverage" | "underweight-unit";

export interface FlatIngredient {
  ingredientId: string;
  ingredientName: string;
  subRecipeId: string;
  subRecipePath: string[];
  grossQty: number;
  netQty: number;
  uom: string;
  defaultYield?: number;
  effectiveYield: number;
  hasOverride: boolean;
}

export interface SubRecipeAggregate {
  subRecipeId: string;
  name: string;
  categories: string;
  path: string[];
  depth: number;
  totalGrossPerPortion: number;
  totalNetPerPortion: number;
  subtreeGrossPerPortion: number;
  subtreeNetPerPortion: number;
  avgYield?: number;
  ingredients: FlatIngredient[];
  childSubRecipes: SubRecipeAggregate[];
  instructions?: string;
}

export interface SubRecipeIngredientNeed {
  key: string;
  ingredientId: string;
  ingredientName: string;
  uom: string;
  grossPerPortion: number;
  netPerPortion: number;
  grossTotal: number;
  netTotal: number;
  lossTotal: number;
}

export interface FullIngredientNeed {
  key: string;
  ingredientId: string;
  ingredientName: string;
  uom: string;
  grossPerPortion: number;
  netPerPortion: number;
  grossTotal: number;
  netTotal: number;
  lossTotal: number;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

