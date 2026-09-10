// Gemeinsame Meal-Fortschritts-Logik für Postblast Live Monitor UND das
// geteilte Plating Dashboard — damit beide dieselben Zahlen zeigen.
import type { MealProgress } from "./postblastMatch";
import { netPlateable, platedForMeal, type NetPlateable } from "./plateableNet";
import type { RecipeWeightLookup } from "./parsers/parseExportRecipes";
import { recipeWeightKey } from "./parsers/parseExportRecipes";

// ── Ehrlicher Fortschritt ────────────────────────────────────────────────────
// Die große Prozentzahl darf NICHT `Σ actualKg / Σ plannedKg` sein: ein
// überproduziertes Sub-Rezept gleicht im Schnitt ein fehlendes aus → 100 %,
// obwohl eine Komponente fehlt. Ehrlicher Fortschritt = das SCHWÄCHSTE
// Sub-Rezept. Fehlt ein Sub ganz → 0 %.
export function honestMealProgress(meal: MealProgress): { pct: number; bottleneckSub: string | null } {
  const bySub = new Map<string, { actual: number; planned: number }>();
  for (const wo of meal.workOrders) {
    if (!wo.hasPlan || wo.plannedKg <= 0) continue;
    const e = bySub.get(wo.subRecipe) ?? { actual: 0, planned: 0 };
    e.actual += wo.actualKg;
    e.planned += wo.plannedKg;
    bySub.set(wo.subRecipe, e);
  }
  if (bySub.size === 0) return { pct: meal.progressPct, bottleneckSub: null };

  let min = Infinity;
  let sub: string | null = null;
  for (const [name, e] of bySub) {
    const p = Math.min(100, (e.actual / e.planned) * 100);
    if (p < min) { min = p; sub = name; }
  }
  return { pct: min === Infinity ? meal.progressPct : min, bottleneckSub: min < 99 ? sub : null };
}

// ── Brutto platierbar (konsolidiert) ─────────────────────────────────────────
// Primär: Gramm/Portion (export-recipes.csv). Fallback: Planverhältnis. Gibt
// null bei zu wenig Daten. Ein Sub-Rezept mit Plan aber 0 kg (nicht im Chiller)
// blockiert (→ 0). Identisch zur Logik, die vorher 3× dupliziert war.
export function grossPlateable(
  meal: MealProgress,
  recipeWeights: RecipeWeightLookup | null,
): { meals: number; exact: boolean; bottleneckSubRecipe: string | null } | null {
  const bySub = new Map<string, {
    actualKg: number; plannedKgSum: number; plannedWO: number; totalWO: number;
    recipeCode: string; blockingZero: boolean;
  }>();
  for (const wo of meal.workOrders) {
    const e = bySub.get(wo.subRecipe) ?? { actualKg: 0, plannedKgSum: 0, plannedWO: 0, totalWO: 0, recipeCode: wo.recipeCode, blockingZero: false };
    e.actualKg += wo.actualKg;
    e.totalWO++;
    if (wo.hasPlan && wo.plannedKg > 0) { e.plannedKgSum += wo.plannedKg; e.plannedWO++; }
    if (wo.hasPlan && wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) e.blockingZero = true;
    bySub.set(wo.subRecipe, e);
  }
  for (const e of bySub.values()) if (e.actualKg > 0) e.blockingZero = false;

  let minMeals = Infinity;
  let bottleneck: string | null = null;
  let found = 0;
  let anyExact = false;

  for (const [name, e] of bySub) {
    const grams = recipeWeights?.gramsPerPortion.get(recipeWeightKey(e.recipeCode, name));
    if (grams && grams > 0) {
      if (e.actualKg === 0 && !e.blockingZero) continue;
      const m = e.blockingZero ? 0 : Math.floor(e.actualKg / (grams / 1000));
      anyExact = true;
      found++;
      if (m < minMeals) { minMeals = m; bottleneck = name; }
    } else if (e.plannedWO > 0 && meal.plannedMeals > 0) {
      if (e.blockingZero) { found++; if (0 < minMeals) { minMeals = 0; bottleneck = name; } continue; }
      const estTotal = (e.plannedKgSum / e.plannedWO) * e.totalWO;
      const m = estTotal > 0 ? Math.floor((e.actualKg / estTotal) * meal.plannedMeals) : 0;
      found++;
      if (m < minMeals) { minMeals = m; bottleneck = name; }
    } else if (e.blockingZero) {
      found++;
      if (0 < minMeals) { minMeals = 0; bottleneck = name; }
    }
  }

  if (found === 0) return null;
  const meals = minMeals === Infinity ? 0 : Math.max(0, minMeals);
  return { meals, exact: anyExact, bottleneckSubRecipe: meals < (meal.plannedMeals || Infinity) ? bottleneck : null };
}

// ── Alles zusammen: was das Panel je Meal braucht ───────────────────────────
export interface MealReadiness {
  net: NetPlateable | null;
  /** true = gesamte produzierte Menge ist plaitiert, es gibt nichts mehr zu tun. */
  finished: boolean;
  /** Prozentzahl für die große Anzeige — ehrlich (schwächstes Sub), 100 nur wenn fertig. */
  displayPct: number;
  bottleneckSub: string | null;
  exact: boolean;
}

export function mealReadiness(
  meal: MealProgress,
  recipeWeights: RecipeWeightLookup | null,
  plaitedByCode: Map<string, number> | undefined,
): MealReadiness {
  const gross = grossPlateable(meal, recipeWeights);
  const net = gross ? netPlateable(meal, gross.meals, platedForMeal(plaitedByCode, meal.recipeCode)) : null;
  const isCritical = meal.criticalWOs.length > 0;
  const allWOsDone = meal.completedWOs === meal.totalWOs;

  const finished = !!net?.fullyPlated
    || (allWOsDone && meal.progressPct >= 99.5 && (net?.netMeals ?? 0) === 0 && !isCritical);

  const honest = honestMealProgress(meal);
  const displayPct = finished ? 100
    : Math.min(honest.pct, allWOsDone && !isCritical ? 100 : 99);

  return { net, finished, displayPct, bottleneckSub: honest.bottleneckSub, exact: gross?.exact ?? false };
}
