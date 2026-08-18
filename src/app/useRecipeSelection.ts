// Leitet aus dem geladenen DataBundle + der aktuellen Auswahl (Woche, Suche, Uplift)
// alles ab, was Sidebar und Hauptansicht brauchen: Rezeptliste der Woche, Suchtreffer,
// Summen, Vorwochenvergleich und das aktive Rezept.
import { useMemo } from "react";
import { adjustedPortions, isProducedInVerden } from "../lib/helpers";
import { getBaseVerdenVolume } from "../lib/equipment";
import type { DataBundle, Recipe, WeekRecipe } from "../core/types";

const EMPTY_WEEKS: string[] = [];
const EMPTY_RECIPES: WeekRecipe[] = [];
const EMPTY_RECIPES_BY_CODE: Record<string, Recipe> = {};

export interface WeekTotals {
  BENL: number;
  DKSE: number;
  DE: number;
  base: number;
}

export interface WeekDelta {
  deltaPortions: number;
  newCodes: string[];
  droppedCodes: string[];
}

export interface RecipeSelection {
  weeks: string[];
  weekRecipes: WeekRecipe[];
  recipesByCode: Record<string, Recipe>;
  recipesOfWeek: WeekRecipe[];
  filteredRecipes: WeekRecipe[];
  activeRecipe: WeekRecipe | undefined;
  totals: WeekTotals;
  plannedTotal: number;
  prevWeek: string | null;
  prevWeekRecipes: WeekRecipe[];
  weekDelta: WeekDelta | null;
}

function producedRecipesOfWeek(weekRecipes: WeekRecipe[], week: string, upliftPercent: number): WeekRecipe[] {
  const seen = new Set<string>();
  return weekRecipes
    .filter(r => r.hfWeek === week && isProducedInVerden(r))
    .filter(r => (seen.has(r.code) ? false : (seen.add(r.code), true)))
    .sort((a, b) =>
      adjustedPortions(getBaseVerdenVolume(b), upliftPercent) -
      adjustedPortions(getBaseVerdenVolume(a), upliftPercent)
    );
}

function buildRecipeSearchHaystack(wr: WeekRecipe, recipe: Recipe | undefined): string {
  const parts: string[] = [wr.code, wr.recipeName, wr.preference];
  if (recipe) {
    parts.push(recipe.baseName);
    for (const md of Object.values(recipe.markets)) {
      parts.push(md.recipeNameLocal, md.msku, md.allergens ?? "");
      for (const sub of md.subRecipes) parts.push(sub.id, sub.name);
      for (const ing of md.ingredients) parts.push(ing.ingredientId, ing.name);
    }
    for (const grossRows of Object.values(recipe.grossIngredients)) {
      for (const g of grossRows ?? []) parts.push(g.ingredientId, g.ingredient);
    }
  }
  return parts.join(" ").toLowerCase();
}

function weekTotals(recipes: WeekRecipe[]): WeekTotals {
  return recipes.reduce<WeekTotals>((acc, r) => {
    acc.BENL += r.verdenVolume.BENL;
    acc.DKSE += r.verdenVolume.DKSE;
    acc.DE += r.verdenVolume.DE;
    acc.base += getBaseVerdenVolume(r);
    return acc;
  }, { BENL: 0, DKSE: 0, DE: 0, base: 0 });
}

function computeWeekDelta(current: WeekRecipe[], previous: WeekRecipe[], currentBase: number): WeekDelta | null {
  if (!previous.length) return null;
  const prevCodes = new Set(previous.map(r => r.code));
  const currCodes = new Set(current.map(r => r.code));
  const prevBase = previous.reduce((sum, r) => sum + getBaseVerdenVolume(r), 0);
  return {
    deltaPortions: currentBase - prevBase,
    newCodes: current.filter(r => !prevCodes.has(r.code)).map(r => r.code),
    droppedCodes: previous.filter(r => !currCodes.has(r.code)).map(r => r.code),
  };
}

export function useRecipeSelection(
  data: DataBundle | null,
  selectedWeek: string,
  selectedRecipe: string | null,
  upliftPercent: number,
  searchText: string,
): RecipeSelection {
  // Stabile Referenzen, damit die Memos unten nicht bei jedem Render neu laufen,
  // wenn sich nur selectedWeek/searchText/upliftPercent ändern, nicht aber data.
  const weeks = useMemo(() => data?.weeks ?? EMPTY_WEEKS, [data]);
  const weekRecipes = useMemo(() => data?.weekRecipes ?? EMPTY_RECIPES, [data]);
  const recipesByCode = useMemo(() => data?.recipes ?? EMPTY_RECIPES_BY_CODE, [data]);

  const recipesOfWeek = useMemo(
    () => producedRecipesOfWeek(weekRecipes, selectedWeek, upliftPercent),
    [weekRecipes, selectedWeek, upliftPercent]
  );

  const haystackMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of recipesOfWeek) map.set(r.code, buildRecipeSearchHaystack(r, recipesByCode[r.code]));
    return map;
  }, [recipesOfWeek, recipesByCode]);

  const searchNeedle = searchText.trim().toLowerCase();
  const filteredRecipes = useMemo(() => {
    if (!searchNeedle) return recipesOfWeek;
    return recipesOfWeek.filter(r => (haystackMap.get(r.code) ?? "").includes(searchNeedle));
  }, [recipesOfWeek, searchNeedle, haystackMap]);

  const totals = useMemo(() => weekTotals(recipesOfWeek), [recipesOfWeek]);
  const plannedTotal = adjustedPortions(totals.base, upliftPercent);

  const prevWeek = useMemo(() => {
    const idx = weeks.indexOf(selectedWeek);
    return idx > 0 ? weeks[idx - 1] : null;
  }, [weeks, selectedWeek]);

  const prevWeekRecipes = useMemo(
    () => (prevWeek ? producedRecipesOfWeek(weekRecipes, prevWeek, 0) : []),
    [weekRecipes, prevWeek]
  );

  const weekDelta = useMemo(
    () => computeWeekDelta(recipesOfWeek, prevWeekRecipes, totals.base),
    [recipesOfWeek, prevWeekRecipes, totals.base]
  );

  const activeRecipe: WeekRecipe | undefined =
    filteredRecipes.find(r => r.code === selectedRecipe) ??
    filteredRecipes[0] ??
    recipesOfWeek.find(r => r.code === selectedRecipe) ??
    recipesOfWeek[0];

  return {
    weeks, weekRecipes, recipesByCode, recipesOfWeek, filteredRecipes, activeRecipe,
    totals, plannedTotal, prevWeek, prevWeekRecipes, weekDelta,
  };
}
