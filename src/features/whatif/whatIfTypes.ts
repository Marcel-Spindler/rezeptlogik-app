// What-If Rechner – Domänen-Typen (flache Zutaten, Sub-Rezept-Aggregate, Bedarfs-Zeilen).

export type Direction = "forward" | "reverse";
export type SubRecipeScenario = "missing-meals" | "finished-coverage" | "raw-coverage" | "underweight-unit" | "rti-gap";
export type YieldSource = "csv" | "computed" | "override" | "fallback";

export interface FlatIngredient {
  ingredientId: string;
  ingredientName: string;
  subRecipeId: string;
  subRecipePath: string[];
  grossQty: number;
  netQty: number;
  uom: string;
  defaultYield?: number;
  /**
   * Gesamt-Fertigware-Faktor der Zutat: `fertig_g = grossQty × effectiveYield`.
   * Deckt ab: Zutaten-Trimmung (netQty/grossQty) × Lokal-Yield des eigenen
   * Sub-Rezepts × alle Eltern-Sub-Rezept-Lokal-Yields (→ raw bis Endteller).
   * Bei aktivem Override = der getippte Wert (ersetzt alles).
   */
  effectiveYield: number;
  /** trimRatio × localYield des eigenen Sub-Rezepts (ohne Eltern). */
  ownYieldFactor: number;
  /** Produkt der Lokal-Yields aller Eltern-Sub-Rezepte (1 auf Top-Level). */
  ancestorYieldFactor: number;
  hasOverride: boolean;
  yieldSource: YieldSource;
  yieldMissing: boolean;
  pricePerKg?: number;
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
  /**
   * Netto-/Fertigware-Ausgabe dieses Sub-Rezepts pro Meal.
   * = MSKUs `Sub-Recipe N Quantity` (grams), sonst geschätzt (statedFromMsku=false).
   */
  subtreeNetPerPortion: number;
  /** Plattierte Ausgabe des Subs in g (== subtreeNetPerPortion). */
  statedOutputG: number;
  /** Σ getrimmte Zutatenmasse (netQty) + Σ Kind-statedOutputG (Eingang dieses Kochschritts). */
  ownGrossInput: number;
  /** statedOutputG / ownGrossInput — der reale Kochyield genau dieses Sub-Rezepts. */
  localYield: number;
  /** Produkt der Lokal-Yields aller Eltern (1 auf Top-Level). */
  ancestorYieldFactor: number;
  /** true = subtreeNetPerPortion stammt direkt aus MSKU; false = geschätzt (each/fehlt). */
  statedFromMsku: boolean;
  avgYield?: number;
  ingredients: FlatIngredient[];
  childSubRecipes: SubRecipeAggregate[];
  instructions?: string;
}

export interface IngredientNeed {
  key: string;
  ingredientId: string;
  ingredientName: string;
  uom: string;
  grossPerPortion: number;
  netPerPortion: number;
  grossTotal: number;
  netTotal: number;
  lossTotal: number;
  lossPercent: number;
  costLoss?: number;
}

export type SubRecipeIngredientNeed = IngredientNeed;
export type FullIngredientNeed = IngredientNeed;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

