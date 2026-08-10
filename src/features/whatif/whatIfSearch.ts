// What-If Rechner – Volltext-Zutatensuche über den Aggregat-Baum + Scroll-zu-Zeile.
import type { DetailedSubRecipe } from "../../core/types";

// ────────────────────────────────────────────────────────────
// GLOBAL INGREDIENT INDEX (über alle Meals der KW)
// ────────────────────────────────────────────────────────────

export interface IngredientHit {
  ingredientId: string;
  ingredientName: string;
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  subRecipePath: string[];
  grossQty: number;
  uom: string;
  yieldPct?: number;
}

export function collectIngredientsFromNode(
  node: DetailedSubRecipe,
  parentNames: string[],
  recipeCode: string,
  recipeName: string,
  out: IngredientHit[]
): void {
  const path = [...parentNames, node.name];
  for (const ing of node.ingredients) {
    out.push({
      ingredientId: ing.id,
      ingredientName: ing.name,
      recipeCode,
      recipeName,
      subRecipeId: node.id,
      subRecipeName: node.name,
      subRecipePath: path,
      grossQty: ing.grossQty,
      uom: ing.uom,
      yieldPct: ing.yieldPct
    });
  }
  for (const child of node.subRecipes) {
    collectIngredientsFromNode(child, path, recipeCode, recipeName, out);
  }
}

export function scrollToIngredientRow(ingredientId: string, subRecipeId: string): void {
  // mehrere Frames warten, bis Re-Render fertig ist
  setTimeout(() => {
    const id = `ing-row-${ingredientId}__${subRecipeId}`;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-4", "ring-fuchsia-400");
      setTimeout(() => el.classList.remove("ring-4", "ring-fuchsia-400"), 2200);
    }
  }, 120);
}

