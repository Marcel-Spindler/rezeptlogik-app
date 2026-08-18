import type { DataBundle, MealCatalogEntry, WeekRecipe } from "../../core/types";
import { codeDigits } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";

export type Locale = "DE" | "DKSE" | "NL" | "FR";
export type CatalogScope = "week" | "future" | "all";
export type SortKey = "name" | "calories" | "weight" | "cuisine";

export const field = (entry: MealCatalogEntry, sheet: string, name: string) =>
  entry.sheets?.[sheet]?.[name] ?? "";

const first = (...values: string[]) => values.find(Boolean) ?? "";

export const titleOf = (entry: MealCatalogEntry) =>
  first(
    field(entry, "Meal DB_Culinary", "Meal Name"),
    field(entry, "Verden Meal Database", "Meal Name"),
    field(entry, "DE", "Meal Name DE"),
    entry.mealId,
  );

export const subtitleOf = (entry: MealCatalogEntry) =>
  first(
    field(entry, "Meal DB_Culinary", "Sub Name"),
    field(entry, "Verden Meal Database", "Meal Descriptor"),
  );

const TAG_FIELDS = ["SPICY?", "KETO", "CAL SMART", "CALORIE SMART", "P+", "ATHLETE", "MEDI", "VEGETARIAN", "VEGAN", "LACTOSE FREE", "SOURCE OF FIBER"];

export function tagsOf(entry: MealCatalogEntry): string[] {
  const sources = [entry.sheets?.["Meal DB_Culinary"], entry.sheets?.["Verden Meal Database"]];
  return TAG_FIELDS.filter(tag => sources.some(source => /^(yes|true|x|1)$/i.test(source?.[tag] ?? "")));
}

export function metric(entry: MealCatalogEntry, name: string): string {
  return first(field(entry, "Meal DB_Nutrition", name), field(entry, "Verden Meal Database", name));
}

export function label(value: string) {
  return value.replace(/\s*\(\d+\)$/, "").replace(/\s+/g, " ").trim();
}

export function localFields(entry: MealCatalogEntry, locale: Locale): Record<string, string> {
  const fields = entry.sheets?.[locale] ?? {};
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      !/^Meal Name \(EN\)|^Sub Name \(EN\)|^Legal Name \(EN\)|^Ingredient declaration \(EN\)|^Meal Story \(EN\)/i.test(key),
    ),
  );
}

export function findWeekMatches(entry: MealCatalogEntry, data: DataBundle, week: string): WeekRecipe[] {
  const digits = codeDigits(entry.mealId);
  return data.weekRecipes
    .filter(recipe => recipe.hfWeek === week && (recipe.code === entry.mealId || codeDigits(recipe.code) === digits))
    .sort((a, b) => getBaseVerdenVolume(b) - getBaseVerdenVolume(a));
}

/** Pre-built index: mealId → Set of weeks where this meal has production matches. */
export function buildWeekIndex(meals: MealCatalogEntry[], data: DataBundle): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const recipesByWeek = new Map<string, WeekRecipe[]>();
  for (const recipe of data.weekRecipes) {
    const list = recipesByWeek.get(recipe.hfWeek);
    if (list) list.push(recipe);
    else recipesByWeek.set(recipe.hfWeek, [recipe]);
  }
  for (const meal of meals) {
    const digits = codeDigits(meal.mealId);
    const weeks = new Set<string>();
    for (const [week, recipes] of recipesByWeek) {
      if (recipes.some(r => r.code === meal.mealId || codeDigits(r.code) === digits)) {
        weeks.add(week);
      }
    }
    if (weeks.size > 0) index.set(meal.mealId, weeks);
  }
  return index;
}

export function sortMeals(meals: MealCatalogEntry[], key: SortKey): MealCatalogEntry[] {
  switch (key) {
    case "name":
      return [...meals].sort((a, b) => titleOf(a).localeCompare(titleOf(b), "de"));
    case "calories":
      return [...meals].sort((a, b) => (parseFloat(metric(b, "CALORIES")) || 0) - (parseFloat(metric(a, "CALORIES")) || 0));
    case "weight":
      return [...meals].sort((a, b) => (parseFloat(metric(b, "MEAL WEIGHT (g)")) || 0) - (parseFloat(metric(a, "MEAL WEIGHT (g)")) || 0));
    case "cuisine":
      return [...meals].sort((a, b) => field(a, "Meal DB_Culinary", "CUISINE").localeCompare(field(b, "Meal DB_Culinary", "CUISINE"), "de"));
  }
}
