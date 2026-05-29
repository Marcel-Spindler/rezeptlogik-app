/**
 * What-if & Diff – DATA-DRIVEN Yield-Verlust-Rechner
 *
 * 1. Meal-Auswahl aus aktueller KW
 * 2. Voller Rezept-Drilldown: Meal → Sub-Rezepte → Ingredients
 * 3. ECHTER Yield-% pro Zutat aus export-sub-recipes-by-recipe-detailed.csv
 *    (Spalte "Sub-Recipe Yield %", z.B. 0.7011 = 70,11% Output)
 * 4. Per-Ingredient-Override → localStorage (Meals wiederholen sich → bleibt persistent)
 * 5. Forward (Portionen → Rohware) & Reverse (Rohware → max. Portionen), IMMER yield-aware
 * 6. Plating-Anweisungen aus recipe.markets[m].subRecipes[].instructions
 *
 * Persistenz-Key: rezeptlogik_v1_yield_override_<ingredientId>__<subRecipeId>
 */

import { useEffect, useMemo, useState } from "react";
import type {
  DataBundle,
  Recipe,
  WeekRecipe,
  Market,
  RecipeStructure,
  DetailedSubRecipe
} from "./types";
import type { UiLocale } from "./i18n";
import { tl } from "./i18n";
import { usePlanningOasisData } from "./planningOasisData";

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

type Direction = "forward" | "reverse";
type SubRecipeScenario = "missing-meals" | "finished-coverage" | "raw-coverage" | "underweight-unit";

interface FlatIngredient {
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

interface SubRecipeAggregate {
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

interface SubRecipeIngredientNeed {
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

const LS_PREFIX = "rezeptlogik_v1_yield_override_";

function overrideKey(ingredientId: string, subRecipeId: string): string {
  return `${LS_PREFIX}${ingredientId || "noId"}__${subRecipeId || "noSub"}`;
}

function saveOverride(ingredientId: string, subRecipeId: string, value: number | null): void {
  try {
    const k = overrideKey(ingredientId, subRecipeId);
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, String(value));
  } catch { /* quota */ }
}

function listAllOverrides(): Array<{ ingredientId: string; subRecipeId: string; value: number; key: string }> {
  const out: Array<{ ingredientId: string; subRecipeId: string; value: number; key: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LS_PREFIX)) continue;
      const tail = key.substring(LS_PREFIX.length);
      const [ingId, subId] = tail.split("__");
      const v = parseFloat(localStorage.getItem(key) || "");
      if (!isNaN(v)) out.push({ ingredientId: ingId || "", subRecipeId: subId || "", value: v, key });
    }
  } catch { /* */ }
  return out;
}

function fmt(n: number, decimals = 0): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("de-DE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function fmtMass(grams: number): string {
  if (!isFinite(grams)) return "—";
  if (grams === 0) return "0 g";
  if (Math.abs(grams) >= 1000) return `${fmt(grams / 1000, 2)} kg`;
  return `${fmt(grams, grams < 10 ? 2 : 0)} g`;
}

function parseNumInput(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, "."));
  return isNaN(n) ? 0 : n;
}

function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  const total = (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0);
  return total > 0;
}

function getBaseVolume(r: WeekRecipe): number {
  return r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE;
}

function getStructureForRecipe(structure: RecipeStructure | undefined): DetailedSubRecipe[] {
  if (!structure) return [];
  for (const m of ["DE", "BENL", "DKSE"] as Market[]) {
    const arr = structure.markets[m];
    if (arr && arr.length > 0) return arr;
  }
  return [];
}

function buildInstructionsMap(recipe: Recipe | undefined): Map<string, string> {
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

function aggregateSubRecipe(
  node: DetailedSubRecipe,
  parentPath: string[],
  depth: number,
  overrides: Map<string, number>,
  instructionsMap: Map<string, string>
): SubRecipeAggregate {
  const path = [...parentPath, node.name];

  const ingredients: FlatIngredient[] = node.ingredients.map(ing => {
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

  const childSubRecipes = node.subRecipes.map(child =>
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

function flattenIngredients(agg: SubRecipeAggregate): FlatIngredient[] {
  return [
    ...agg.ingredients,
    ...agg.childSubRecipes.flatMap(flattenIngredients)
  ];
}

function flattenSubRecipes(agg: SubRecipeAggregate): SubRecipeAggregate[] {
  return [agg, ...agg.childSubRecipes.flatMap(flattenSubRecipes)];
}

function aggregateSubRecipeIngredientNeeds(ingredients: FlatIngredient[], portions: number): SubRecipeIngredientNeed[] {
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

// ────────────────────────────────────────────────────────────
// GLOBAL INGREDIENT INDEX (über alle Meals der KW)
// ────────────────────────────────────────────────────────────

interface IngredientHit {
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

function collectIngredientsFromNode(
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

function scrollToIngredientRow(ingredientId: string, subRecipeId: string): void {
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

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

export function WhatIfView({
  data,
  week,
  upliftPercent,
  locale
}: {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  locale: UiLocale;
}): JSX.Element {

  const { data: oasisData } = usePlanningOasisData();
  const weekIntel = oasisData?.weeks[week] ?? null;

  const weekMeals = useMemo(() => {
    const activeWeekRecipes = data.weekRecipes
      .filter((r) => r.hfWeek === week && isProducedInVerden(r));
    
    const uniqueRecipes: WeekRecipe[] = [];
    const seen = new Set<string>();
    for (const r of activeWeekRecipes) {
      if (!seen.has(r.code)) {
        seen.add(r.code);
        uniqueRecipes.push(r);
      }
    }
    return uniqueRecipes.sort((a, b) => getBaseVolume(b) - getBaseVolume(a) || a.code.localeCompare(b.code, "de"));
  }, [data.recipes, data.weekRecipes, week]);
  
  type MealChoice = {
    code: string;
    recipeName: string;
    basePortions: number;
    weekMeal?: WeekRecipe;
  };
  
  const mealChoices = useMemo(() => {
    return weekMeals
      .map((meal) => ({
        code: meal.code,
        recipeName: meal.recipeName,
        basePortions: getBaseVolume(meal),
        weekMeal: meal,
      }))
      .sort((a, b) => b.basePortions - a.basePortions || a.code.localeCompare(b.code, "de"));
  }, [weekMeals]);

  const [selectedCode, setSelectedCode] = useState<string | null>(
    mealChoices[0]?.code ?? null
  );
  useEffect(() => {
    if (mealChoices.length > 0 && !mealChoices.find(m => m.code === selectedCode)) {
      setSelectedCode(mealChoices[0].code);
    }
  }, [mealChoices, selectedCode]);

  const selectedMealChoice = mealChoices.find(m => m.code === selectedCode) ?? null;
  const selectedMeal: WeekRecipe | undefined = selectedMealChoice?.weekMeal;
  const selectedRecipe: Recipe | undefined = selectedCode ? data.recipes[selectedCode] ?? data.recipes[selectedCode.replace(/^[A-Z]{2}/, "")] : undefined;
  const selectedStructure: RecipeStructure | undefined = selectedCode ? data.structures?.[selectedCode] : undefined;

  const [overrideTick, setOverrideTick] = useState(0);
  const overrides = useMemo(() => {
    const m = new Map<string, number>();
    listAllOverrides().forEach(o => m.set(`${o.ingredientId}__${o.subRecipeId}`, o.value));
    return m;
  }, [overrideTick]);

  const instructionsMap = useMemo(
    () => buildInstructionsMap(selectedRecipe),
    [selectedRecipe]
  );

  const aggregateRoots: SubRecipeAggregate[] = useMemo(() => {
    const subs = getStructureForRecipe(selectedStructure);
    return subs.map(s => aggregateSubRecipe(s, [], 0, overrides, instructionsMap));
  }, [selectedStructure, overrides, instructionsMap]);

  const allIngredients: FlatIngredient[] = useMemo(
    () => aggregateRoots.flatMap(flattenIngredients),
    [aggregateRoots]
  );
  const allSubs: SubRecipeAggregate[] = useMemo(
    () => aggregateRoots.flatMap(flattenSubRecipes),
    [aggregateRoots]
  );

  const [selectedSubRecipeId, setSelectedSubRecipeId] = useState<string | null>(null);
  useEffect(() => {
    if (allSubs.length === 0) {
      setSelectedSubRecipeId(null);
      return;
    }
    if (!selectedSubRecipeId || !allSubs.some(sub => sub.subRecipeId === selectedSubRecipeId)) {
      setSelectedSubRecipeId(allSubs[0].subRecipeId);
    }
  }, [allSubs, selectedSubRecipeId]);

  const selectedSubRecipe = useMemo(
    () => allSubs.find(sub => sub.subRecipeId === selectedSubRecipeId) ?? null,
    [allSubs, selectedSubRecipeId]
  );

  // ── Globaler Zutaten-Index über ALLE Meals der KW ───────────────────
  const globalIngredientIndex: IngredientHit[] = useMemo(() => {
    const out: IngredientHit[] = [];
    for (const m of weekMeals) {
      const struct = data.structures?.[m.code];
      const subs = getStructureForRecipe(struct);
      for (const root of subs) {
        collectIngredientsFromNode(root, [], m.code, m.recipeName, out);
      }
    }
    return out;
  }, [weekMeals, data.structures]);

  const [searchTerm, setSearchTerm] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const searchGroups = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (q.length < 2) return [] as Array<{ name: string; ingredientId: string; hits: IngredientHit[]; recipeCount: number }>;
    const tokens = q.split(/\s+/).filter(Boolean);
    const matched = globalIngredientIndex.filter(h => {
      const hay = `${h.ingredientName} ${h.ingredientId} ${h.subRecipeName} ${h.recipeName} ${h.recipeCode}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
    // Gruppieren nach Ingredient (Name+Id), damit man sieht in wie vielen Rezepten sie vorkommt
    const map = new Map<string, IngredientHit[]>();
    for (const h of matched) {
      const k = `${h.ingredientName.toLowerCase()}__${h.ingredientId}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(h);
    }
    return Array.from(map.entries()).map(([_, hits]) => ({
      name: hits[0].ingredientName,
      ingredientId: hits[0].ingredientId,
      hits,
      recipeCount: new Set(hits.map(h => h.recipeCode)).size
    })).sort((a, b) => b.hits.length - a.hits.length).slice(0, 40);
  }, [searchTerm, globalIngredientIndex]);

  function jumpToIngredient(hit: IngredientHit): void {
    if (hit.recipeCode !== selectedCode) {
      setSelectedCode(hit.recipeCode);
    }
    scrollToIngredientRow(hit.ingredientId, hit.subRecipeId);
  }

  const [direction, setDirection] = useState<Direction>("forward");
  const basePortions = selectedMeal ? getBaseVolume(selectedMeal) : 0;
  const selectedMealBasePortions = selectedMealChoice?.basePortions ?? 0;
  const upliftedPortions = Math.round(selectedMealBasePortions * (1 + upliftPercent / 100));
  const [targetPortions, setTargetPortions] = useState<number>(upliftedPortions || 1000);
  const [subRecipeScenario, setSubRecipeScenario] = useState<SubRecipeScenario>("missing-meals");
  const [subRecipeMissingMeals, setSubRecipeMissingMeals] = useState<number>(1000);
  const [subRecipeAvailableFinishedGoods, setSubRecipeAvailableFinishedGoods] = useState<number>(0);
  const [subRecipeAvailableRawware, setSubRecipeAvailableRawware] = useState<number>(0);
  const [underweightIngredientKey, setUnderweightIngredientKey] = useState<string | null>(null);
  const [underweightTargetMeals, setUnderweightTargetMeals] = useState<number>(upliftedPortions || 1000);
  const [underweightActualUnitWeight, setUnderweightActualUnitWeight] = useState<number>(0);
  const [underweightAvailableUnits, setUnderweightAvailableUnits] = useState<number>(upliftedPortions || 0);
  const [subRecipeExportLoading, setSubRecipeExportLoading] = useState(false);
  useEffect(() => {
    setTargetPortions(upliftedPortions || 1000);
    setSubRecipeMissingMeals(upliftedPortions || 1000);
    setSubRecipeAvailableFinishedGoods(0);
    setSubRecipeAvailableRawware(0);
    setUnderweightTargetMeals(upliftedPortions || 1000);
    setUnderweightAvailableUnits(upliftedPortions || 0);
    setUnderweightActualUnitWeight(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upliftedPortions, selectedCode]);

  const selectedSubRecipeIngredients = useMemo(
    () => selectedSubRecipe ? flattenIngredients(selectedSubRecipe) : [],
    [selectedSubRecipe]
  );

  const selectedSubRecipeNeeds = useMemo(
    () => aggregateSubRecipeIngredientNeeds(selectedSubRecipeIngredients, subRecipeMissingMeals),
    [selectedSubRecipeIngredients, subRecipeMissingMeals]
  );

  useEffect(() => {
    if (selectedSubRecipeNeeds.length === 0) {
      setUnderweightIngredientKey(null);
      return;
    }
    if (!underweightIngredientKey || !selectedSubRecipeNeeds.some(need => need.key === underweightIngredientKey)) {
      setUnderweightIngredientKey(selectedSubRecipeNeeds[0].key);
    }
  }, [selectedSubRecipeNeeds, underweightIngredientKey]);

  const selectedSubRecipeMissingTotals = useMemo(() => {
    if (!selectedSubRecipe) return null;
    const grossTotal = selectedSubRecipe.subtreeGrossPerPortion * subRecipeMissingMeals;
    const netTotal = selectedSubRecipe.subtreeNetPerPortion * subRecipeMissingMeals;
    return {
      grossTotal,
      netTotal,
      lossTotal: grossTotal - netTotal
    };
  }, [selectedSubRecipe, subRecipeMissingMeals]);

  const selectedSubRecipeFinishedCoverage = useMemo(() => {
    if (!selectedSubRecipe || selectedSubRecipe.subtreeNetPerPortion <= 0) return null;
    const coverableMeals = Math.floor(subRecipeAvailableFinishedGoods / selectedSubRecipe.subtreeNetPerPortion);
    const usedFinishedGoods = coverableMeals * selectedSubRecipe.subtreeNetPerPortion;
    return {
      coverableMeals,
      usedFinishedGoods,
      leftoverFinishedGoods: subRecipeAvailableFinishedGoods - usedFinishedGoods,
      equivalentRawware: coverableMeals * selectedSubRecipe.subtreeGrossPerPortion
    };
  }, [selectedSubRecipe, subRecipeAvailableFinishedGoods]);

  const selectedSubRecipeRawCoverage = useMemo(() => {
    if (!selectedSubRecipe || selectedSubRecipe.subtreeGrossPerPortion <= 0) return null;
    const coverableMeals = Math.floor(subRecipeAvailableRawware / selectedSubRecipe.subtreeGrossPerPortion);
    const usedRawware = coverableMeals * selectedSubRecipe.subtreeGrossPerPortion;
    return {
      coverableMeals,
      usedRawware,
      leftoverRawware: subRecipeAvailableRawware - usedRawware,
      equivalentFinishedGoods: coverableMeals * selectedSubRecipe.subtreeNetPerPortion,
      lossTotal: usedRawware - (coverableMeals * selectedSubRecipe.subtreeNetPerPortion)
    };
  }, [selectedSubRecipe, subRecipeAvailableRawware]);

  const selectedUnderweightIngredient = useMemo(
    () => selectedSubRecipeNeeds.find(need => need.key === underweightIngredientKey) ?? null,
    [selectedSubRecipeNeeds, underweightIngredientKey]
  );

  const underweightCoverage = useMemo(() => {
    if (!selectedUnderweightIngredient || selectedUnderweightIngredient.grossPerPortion <= 0 || underweightActualUnitWeight <= 0) {
      return null;
    }
    const requiredPerMeal = selectedUnderweightIngredient.grossPerPortion;
    const exactUnitsPerMeal = requiredPerMeal / underweightActualUnitWeight;
    const unitsNeededPerMeal = Math.ceil(exactUnitsPerMeal);
    const totalAvailableWeight = underweightAvailableUnits * underweightActualUnitWeight;
    const totalRequiredWeight = underweightTargetMeals * requiredPerMeal;
    const maxMealsByPieces = unitsNeededPerMeal > 0 ? Math.floor(underweightAvailableUnits / unitsNeededPerMeal) : 0;
    const maxMealsByWeight = Math.floor(totalAvailableWeight / requiredPerMeal);
    const requiredUnitsForTarget = underweightTargetMeals * unitsNeededPerMeal;
    return {
      requiredPerMeal,
      exactUnitsPerMeal,
      unitsNeededPerMeal,
      totalAvailableWeight,
      totalRequiredWeight,
      maxMealsByPieces,
      maxMealsByWeight,
      missingMeals: Math.max(0, underweightTargetMeals - maxMealsByPieces),
      missingUnits: Math.max(0, requiredUnitsForTarget - underweightAvailableUnits),
      missingWeight: Math.max(0, totalRequiredWeight - totalAvailableWeight),
      requiredUnitsForTarget,
      surplusWeightPerMeal: Math.max(0, unitsNeededPerMeal * underweightActualUnitWeight - requiredPerMeal),
    };
  }, [selectedUnderweightIngredient, underweightActualUnitWeight, underweightAvailableUnits, underweightTargetMeals]);

  const showSubRecipeMissingTotals = subRecipeScenario === "missing-meals" && !!selectedSubRecipeMissingTotals && subRecipeMissingMeals > 0;
  const showSubRecipeFinishedCoverage = subRecipeScenario === "finished-coverage" && !!selectedSubRecipeFinishedCoverage && subRecipeAvailableFinishedGoods > 0;
  const showSubRecipeRawCoverage = subRecipeScenario === "raw-coverage" && !!selectedSubRecipeRawCoverage && subRecipeAvailableRawware > 0;
  const showUnderweightCoverage = subRecipeScenario === "underweight-unit" && !!underweightCoverage && underweightAvailableUnits > 0 && underweightActualUnitWeight > 0;

  const [reverseIngredientKey, setReverseIngredientKey] = useState<string | null>(null);
  const [reverseRawGrams, setReverseRawGrams] = useState<number>(10000);

  useEffect(() => {
    if (allIngredients.length > 0) {
      const sorted = [...allIngredients].sort((a, b) => b.grossQty - a.grossQty);
      const top = sorted[0];
      setReverseIngredientKey(`${top.ingredientId}__${top.subRecipeId}`);
    } else {
      setReverseIngredientKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, allIngredients.length]);

  const reverseIngredient = useMemo(
    () => allIngredients.find(i => `${i.ingredientId}__${i.subRecipeId}` === reverseIngredientKey),
    [allIngredients, reverseIngredientKey]
  );

  const forwardRows = useMemo(() => {
    return allIngredients.map(ing => {
      const totalGross = ing.grossQty * targetPortions;
      const totalNet = totalGross * ing.effectiveYield;
      const lossGrams = totalGross - totalNet;
      const lossPercent = totalGross > 0 ? (lossGrams / totalGross) * 100 : 0;
      return { ing, totalGross, totalNet, lossGrams, lossPercent };
    });
  }, [allIngredients, targetPortions]);

  const forwardTotals = useMemo(() => {
    const totalGross = forwardRows.reduce((s, r) => s + r.totalGross, 0);
    const totalNet = forwardRows.reduce((s, r) => s + r.totalNet, 0);
    return {
      totalGross,
      totalNet,
      lossGrams: totalGross - totalNet,
      lossPercent: totalGross > 0 ? ((totalGross - totalNet) / totalGross) * 100 : 0
    };
  }, [forwardRows]);

  const reverseResult = useMemo(() => {
    if (!reverseIngredient || reverseIngredient.grossQty <= 0) return null;
    const maxPortions = Math.floor(reverseRawGrams / reverseIngredient.grossQty);
    const usedRaw = maxPortions * reverseIngredient.grossQty;
    const usableNet = usedRaw * reverseIngredient.effectiveYield;
    const lossGrams = usedRaw - usableNet;
    return { maxPortions, usedRaw, usableNet, lossGrams, leftover: reverseRawGrams - usedRaw };
  }, [reverseIngredient, reverseRawGrams]);

  function setIngredientOverride(ingredientId: string, subRecipeId: string, value: number | null): void {
    saveOverride(ingredientId, subRecipeId, value);
    setOverrideTick(t => t + 1);
  }

  function clearAllOverrides(): void {
    listAllOverrides().forEach(o => {
      try { localStorage.removeItem(o.key); } catch { /* */ }
    });
    setOverrideTick(t => t + 1);
  }

  async function exportSubRecipeCalculation(): Promise<void> {
    if (!selectedSubRecipe) return;
    setSubRecipeExportLoading(true);
    try {
      const exceljs = await import("exceljs");
      const WorkbookClass = exceljs.Workbook || (exceljs as any).default?.Workbook;
      const workbook = new WorkbookClass();
      workbook.creator = "Rezeptlogik Verden";
      workbook.created = new Date();

      const border = {
        top: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
        bottom: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
        left: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
        right: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
      };

      const overview = workbook.addWorksheet("Übersicht", { views: [{ showGridLines: false }] });
      overview.columns = [{ width: 28 }, { width: 24 }, { width: 20 }, { width: 20 }];

      overview.mergeCells("A1:D1");
      const title = overview.getCell("A1");
      title.value = `Subrezept-Rechner · ${selectedSubRecipe.name}`;
      title.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
      title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
      title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      overview.getRow(1).height = 28;

      const metaRows: Array<[string, string | number, string | number, string | number]> = [
        ["Woche", week, "Meal", selectedCode ?? ""],
        ["Subrezept", selectedSubRecipe.name, "Pfad", selectedSubRecipe.path.join(" -> ")],
        ["Aktives Szenario", subRecipeScenario, "", ""],
        ["Fehlende Meals", subRecipeMissingMeals, "Brutto pro Meal (g)", Number(selectedSubRecipe.subtreeGrossPerPortion.toFixed(2))],
        ["Vorhandene Fertigware (g)", subRecipeAvailableFinishedGoods, "Fertigware pro Meal (g)", Number(selectedSubRecipe.subtreeNetPerPortion.toFixed(2))],
        ["Vorhandene Rohware (g)", subRecipeAvailableRawware, "", ""],
        ["Unter-Grammatur Ziel-Meals", underweightTargetMeals, "Stueck-Istgewicht (g)", Number(underweightActualUnitWeight.toFixed(2))],
        ["Unter-Grammatur Stueck verfuegbar", underweightAvailableUnits, "Artikel", selectedUnderweightIngredient?.ingredientName ?? ""],
      ];

      for (const rowData of metaRows) {
        const row = overview.addRow(rowData);
        row.eachCell((cell, col) => {
          cell.border = border;
          cell.alignment = { vertical: "middle", horizontal: col % 2 === 1 ? "left" : "right" };
          if (col === 1 || col === 3) {
            cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
          }
        });
      }

      overview.addRow([]);
      const summaryHeader = overview.addRow(["Bereich", "Kennzahl", "Wert", "Einheit"]);
      summaryHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
        cell.border = border;
      });

      const summaryRows: Array<[string, string, number, string]> = [];
      if (selectedSubRecipeMissingTotals) {
        summaryRows.push(["Fehlmenge", "Rohware", Number(selectedSubRecipeMissingTotals.grossTotal.toFixed(2)), "g"]);
        summaryRows.push(["Fehlmenge", "Fertigware", Number(selectedSubRecipeMissingTotals.netTotal.toFixed(2)), "g"]);
        summaryRows.push(["Fehlmenge", "Verlust", Number(selectedSubRecipeMissingTotals.lossTotal.toFixed(2)), "g"]);
      }
      if (selectedSubRecipeFinishedCoverage) {
        summaryRows.push(["Reverse Fertigware", "Meals möglich", selectedSubRecipeFinishedCoverage.coverableMeals, "Meals"]);
        summaryRows.push(["Reverse Fertigware", "Genutzte Fertigware", Number(selectedSubRecipeFinishedCoverage.usedFinishedGoods.toFixed(2)), "g"]);
        summaryRows.push(["Reverse Fertigware", "Rohware-Äquivalent", Number(selectedSubRecipeFinishedCoverage.equivalentRawware.toFixed(2)), "g"]);
        summaryRows.push(["Reverse Fertigware", "Rest Fertigware", Number(selectedSubRecipeFinishedCoverage.leftoverFinishedGoods.toFixed(2)), "g"]);
      }
      if (selectedSubRecipeRawCoverage) {
        summaryRows.push(["Reverse Rohware", "Meals möglich", selectedSubRecipeRawCoverage.coverableMeals, "Meals"]);
        summaryRows.push(["Reverse Rohware", "Genutzte Rohware", Number(selectedSubRecipeRawCoverage.usedRawware.toFixed(2)), "g"]);
        summaryRows.push(["Reverse Rohware", "Fertigware daraus", Number(selectedSubRecipeRawCoverage.equivalentFinishedGoods.toFixed(2)), "g"]);
        summaryRows.push(["Reverse Rohware", "Verlust daraus", Number(selectedSubRecipeRawCoverage.lossTotal.toFixed(2)), "g"]);
        summaryRows.push(["Reverse Rohware", "Rest Rohware", Number(selectedSubRecipeRawCoverage.leftoverRawware.toFixed(2)), "g"]);
      }
      if (underweightCoverage && selectedUnderweightIngredient) {
        summaryRows.push(["Unter-Grammatur", "Soll je Meal", Number(underweightCoverage.requiredPerMeal.toFixed(2)), selectedUnderweightIngredient.uom]);
        summaryRows.push(["Unter-Grammatur", "Stück je Meal", underweightCoverage.unitsNeededPerMeal, "Stück"]);
        summaryRows.push(["Unter-Grammatur", "Meals möglich", underweightCoverage.maxMealsByPieces, "Meals"]);
        summaryRows.push(["Unter-Grammatur", "Fehlende Meals", underweightCoverage.missingMeals, "Meals"]);
        summaryRows.push(["Unter-Grammatur", "Fehlende Stück", underweightCoverage.missingUnits, "Stück"]);
        summaryRows.push(["Unter-Grammatur", "Fehlende Gramm", Number(underweightCoverage.missingWeight.toFixed(2)), "g"]);
      }

      summaryRows.forEach(rowData => {
        const row = overview.addRow(rowData);
        row.eachCell(cell => {
          cell.border = border;
          cell.alignment = { vertical: "middle", horizontal: "left" };
        });
      });

      const ingredientsSheet = workbook.addWorksheet("Zutaten", { views: [{ state: "frozen", ySplit: 1 }] });
      ingredientsSheet.columns = [
        { width: 34 },
        { width: 20 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 15 },
        { width: 12 },
      ];

      const ingredientHeader = ingredientsSheet.addRow([
        "Zutat",
        "SKU",
        "Brutto/Meal",
        "Netto/Meal",
        "Rohware Fehlmenge",
        "Fertigware Fehlmenge",
        "Verlust",
        "Einheit",
      ]);
      ingredientHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
        cell.border = border;
      });

      selectedSubRecipeNeeds.forEach(need => {
        const row = ingredientsSheet.addRow([
          need.ingredientName,
          need.ingredientId,
          Number(need.grossPerPortion.toFixed(2)),
          Number(need.netPerPortion.toFixed(2)),
          Number(need.grossTotal.toFixed(2)),
          Number(need.netTotal.toFixed(2)),
          Number(need.lossTotal.toFixed(2)),
          need.uom,
        ]);
        row.eachCell((cell, col) => {
          cell.border = border;
          cell.alignment = { vertical: "middle", horizontal: col >= 3 && col <= 7 ? "right" : "left" };
        });
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${week}_${selectedCode}_${selectedSubRecipe.name.replace(/[^a-z0-9]+/gi, "_")}_subrecipe.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setSubRecipeExportLoading(false);
    }
  }

  const overrideCount = overrides.size;

  if (!selectedRecipe) {
    return (
      <div className="card p-6">
        <h2 className="text-xl font-bold">{tl(locale, "What-if & Diff")}</h2>
        <p className="mt-2 text-slate-500">
          {tl(locale, "Keine Rezepte in dieser Woche.")}
        </p>
      </div>
    );
  }

  const hasStructure = aggregateRoots.length > 0;

  return (
    <div className="space-y-4">

      {/* HEADER */}
      <div className="card p-5 bg-gradient-to-r from-indigo-50 to-violet-50 border-2 border-indigo-200">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              🧮 What-if & Yield-Verlust-Rechner
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Daten-getrieben aus <code className="px-1 bg-white rounded text-xs">export-sub-recipes-by-recipe-detailed.csv</code> ·
              Yield-% pro Zutat · Forward & Reverse · Persistente Overrides
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-xs">
            <div className="px-3 py-1 bg-white rounded-full ring-1 ring-indigo-300">
              <strong>{overrideCount}</strong> aktive Yield-Overrides
            </div>
            {overrideCount > 0 && (
              <button
                onClick={() => { if (confirm(`${overrideCount} Yield-Overrides löschen?`)) clearAllOverrides(); }}
                className="text-red-600 hover:text-red-800 underline"
              >
                Alle Overrides löschen
              </button>
            )}
          </div>
        </div>
      </div>

      {/* GLOBAL INGREDIENT SEARCH */}
      <div className="card p-4 bg-gradient-to-r from-fuchsia-50 to-pink-50 border-2 border-fuchsia-200">
        <label className="block text-xs font-bold uppercase tracking-wide text-fuchsia-700 mb-2">
          🔎 Zutat suchen (über alle Meals dieser KW · {globalIngredientIndex.length} Zutaten indiziert)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setShowSearch(true); }}
            onFocus={() => setShowSearch(true)}
            placeholder="z.B. Lachs, Kartoffel, Sahne, Knoblauch …"
            className="flex-1 rounded-lg border-2 border-fuchsia-300 px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-fuchsia-400"
          />
          {searchTerm && (
            <button
              onClick={() => { setSearchTerm(""); setShowSearch(false); }}
              className="btn text-xs"
            >
              ✕ Leeren
            </button>
          )}
        </div>

        {showSearch && searchTerm.trim().length >= 2 && (
          <div className="mt-3 max-h-96 overflow-y-auto bg-white rounded-lg ring-1 ring-fuchsia-200 divide-y divide-slate-100">
            {searchGroups.length === 0 && (
              <div className="p-3 text-sm text-slate-500">
                Keine Zutat gefunden für „{searchTerm}". Tipp: Mehrere Wörter werden alle gesucht (UND-Verknüpfung).
              </div>
            )}
            {searchGroups.map(grp => (
              <div key={grp.ingredientId} className="p-2">
                <div className="flex items-center justify-between gap-2 px-2 py-1">
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-fuchsia-900 truncate">{grp.name}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{grp.ingredientId}</div>
                  </div>
                  <div className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-800 font-bold">
                    {grp.recipeCount} Rezept{grp.recipeCount !== 1 ? "e" : ""} · {grp.hits.length} Vorkommen
                  </div>
                </div>
                {grp.recipeCount === 1 ? (
                  // Nur ein Rezept → direkt großer Klick
                  <button
                    onClick={() => { jumpToIngredient(grp.hits[0]); setShowSearch(false); }}
                    className="mt-1 w-full text-left px-2 py-2 rounded bg-fuchsia-50 hover:bg-fuchsia-100 text-xs flex items-center gap-2"
                  >
                    <span className="font-mono text-fuchsia-700 font-bold">{grp.hits[0].recipeCode}</span>
                    <span className="flex-1 truncate">{grp.hits[0].recipeName}</span>
                    <span className="text-slate-500">in „{grp.hits[0].subRecipeName}"</span>
                    <span className="font-mono text-emerald-700">
                      {grp.hits[0].yieldPct !== undefined ? `${(grp.hits[0].yieldPct * 100).toFixed(2)}%` : "—"}
                    </span>
                    <span className="font-mono text-indigo-700">{fmt(grp.hits[0].grossQty, 2)} {grp.hits[0].uom}</span>
                  </button>
                ) : (
                  // Mehrere Rezepte → Liste zur Auswahl
                  <div className="mt-1 space-y-1">
                    {grp.hits.map((hit, idx) => (
                      <button
                        key={`${hit.recipeCode}-${hit.subRecipeId}-${idx}`}
                        onClick={() => { jumpToIngredient(hit); setShowSearch(false); }}
                        className="w-full text-left px-2 py-1.5 rounded bg-slate-50 hover:bg-fuchsia-100 text-xs flex items-center gap-2"
                      >
                        <span className="font-mono text-fuchsia-700 font-bold shrink-0">{hit.recipeCode}</span>
                        <span className="flex-1 truncate">{hit.recipeName}</span>
                        <span className="text-slate-500 truncate" title={hit.subRecipePath.join(" → ")}>
                          „{hit.subRecipeName}"
                        </span>
                        <span className="font-mono text-emerald-700 shrink-0">
                          {hit.yieldPct !== undefined ? `${(hit.yieldPct * 100).toFixed(2)}%` : "—"}
                        </span>
                        <span className="font-mono text-indigo-700 shrink-0">{fmt(hit.grossQty, 2)} {hit.uom}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MEAL SELECTOR */}
      <div className="card p-4">
        <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
          Meal auswählen (KW {week})
        </label>
        <select
          value={selectedCode || ""}
          onChange={e => setSelectedCode(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium"
        >
          {mealChoices.map(m => (
            <option key={m.code} value={m.code}>
              {m.code} · {m.recipeName} · ({fmt(m.basePortions)} Portionen)
            </option>
          ))}
        </select>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="bg-slate-50 p-2 rounded">
            <div className="text-slate-500 uppercase font-semibold">Basis Verden</div>
            <div className="text-lg font-bold tabular-nums">{fmt(basePortions)}</div>
          </div>
          <div className="bg-emerald-50 p-2 rounded">
            <div className="text-slate-500 uppercase font-semibold">Mit Uplift ({upliftPercent}%)</div>
            <div className="text-lg font-bold tabular-nums text-emerald-700">{fmt(upliftedPortions)}</div>
          </div>
          <div className="bg-blue-50 p-2 rounded">
            <div className="text-slate-500 uppercase font-semibold">Sub-Rezepte</div>
            <div className="text-lg font-bold tabular-nums text-blue-700">{allSubs.length}</div>
          </div>
          <div className="bg-violet-50 p-2 rounded">
            <div className="text-slate-500 uppercase font-semibold">Zutaten</div>
            <div className="text-lg font-bold tabular-nums text-violet-700">{allIngredients.length}</div>
          </div>
        </div>
      </div>

      {!hasStructure && (
        <div className="card p-6 bg-amber-50 border border-amber-300 text-amber-900">
          <strong>⚠ Keine detaillierte Struktur für dieses Rezept verfügbar.</strong>
          <p className="mt-1 text-sm">
            Die Datei <code>export-sub-recipes-by-recipe-detailed.csv</code> enthält keine Zeilen für{" "}
            <code>{selectedCode}</code>. Bitte CSV neu importieren mit <code>npm run import:local</code>.
          </p>
        </div>
      )}

      {hasStructure && (
        <>
          {/* DIRECTION TOGGLE */}
          <div className="card p-4">
            <div className="flex gap-2">
              <button
                onClick={() => setDirection("forward")}
                className={`flex-1 px-4 py-3 rounded-lg font-bold text-sm transition-all ${
                  direction === "forward"
                    ? "bg-indigo-600 text-white shadow-md"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                → Forward · Portionen → Rohware
              </button>
              <button
                onClick={() => setDirection("reverse")}
                className={`flex-1 px-4 py-3 rounded-lg font-bold text-sm transition-all ${
                  direction === "reverse"
                    ? "bg-violet-600 text-white shadow-md"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                ← Reverse · Rohware → max. Portionen
              </button>
            </div>
          </div>

          {/* FORWARD */}
          {direction === "forward" && (
            <div className="card p-5 bg-gradient-to-br from-indigo-50/50 to-white">
              <h3 className="text-lg font-bold text-slate-800 mb-3">
                Forward: {fmt(targetPortions)} Portionen → Rohware-Bedarf
              </h3>
              <div className="flex items-center gap-3 mb-4">
                <input
                  type="number"
                  value={targetPortions}
                  onChange={e => setTargetPortions(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                  min="0"
                  step="100"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                />
                <button
                  onClick={() => setTargetPortions(basePortions)}
                  className="btn text-xs"
                >
                  Basis ({fmt(basePortions)})
                </button>
                <button
                  onClick={() => setTargetPortions(upliftedPortions)}
                  className="btn btn-primary text-xs"
                >
                  Uplift ({fmt(upliftedPortions)})
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryTile label="Gesamt Rohware (Brutto)" value={fmtMass(forwardTotals.totalGross)} tone="indigo" />
                <SummaryTile label="Davon Fertigware (Netto)" value={fmtMass(forwardTotals.totalNet)} tone="emerald" />
                <SummaryTile label="Yield-Verlust" value={fmtMass(forwardTotals.lossGrams)} tone="red" />
                <SummaryTile label="Verlust-%" value={`${fmt(forwardTotals.lossPercent, 2)}%`} tone="amber" />
              </div>
            </div>
          )}

          {/* REVERSE */}
          {direction === "reverse" && (
            <div className="card p-5 bg-gradient-to-br from-violet-50/50 to-white">
              <h3 className="text-lg font-bold text-slate-800 mb-3">
                Reverse: Wieviele Portionen aus X Rohware?
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Ingredient</label>
                  <select
                    value={reverseIngredientKey || ""}
                    onChange={e => setReverseIngredientKey(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {allIngredients.map(ing => {
                      const k = `${ing.ingredientId}__${ing.subRecipeId}`;
                      return (
                        <option key={k} value={k}>
                          {ing.ingredientName} · ({fmt(ing.grossQty, 2)} {ing.uom}/Portion · Yield {(ing.effectiveYield * 100).toFixed(2)}%)
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Verfügbare Rohware (Gramm)</label>
                  <input
                    type="number"
                    value={reverseRawGrams}
                    onChange={e => setReverseRawGrams(Math.max(0, parseNumInput(e.target.value)))}
                    min="0"
                    step="100"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                  />
                </div>

                {reverseResult && reverseIngredient && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                    <SummaryTile label="Max. Portionen" value={fmt(reverseResult.maxPortions)} tone="violet" />
                    <SummaryTile label="Verbrauchte Rohware" value={fmtMass(reverseResult.usedRaw)} tone="indigo" />
                    <SummaryTile label="Davon Fertigware" value={fmtMass(reverseResult.usableNet)} tone="emerald" />
                    <SummaryTile label="Übrig (Reststoff)" value={fmtMass(reverseResult.leftover)} tone="slate" />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card p-5 bg-gradient-to-br from-sky-50/70 to-white border border-sky-200">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Subrezept-Rechner</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Für ein einzelnes Subrezept: Szenario wählen und dann gezielt den passenden Rechenweg starten statt alle Fälle parallel zu füllen.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Du kannst jetzt auch Unter-Grammatur rechnen: zum Beispiel Artikelgewicht pro Stück gegen erforderliche Grammatur pro Meal, inklusive Frage, wie viele Meals mit den vorhandenen Stücken wirklich noch gehen.
                </p>
              </div>
              {selectedSubRecipe && (
                <div className="rounded-xl bg-white px-3 py-2 text-xs ring-1 ring-sky-200">
                  <div className="font-bold text-sky-900">{selectedSubRecipe.name}</div>
                  <div className="mt-1 text-slate-500">{selectedSubRecipe.path.join(" → ")}</div>
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {([
                ["missing-meals", "Fehlende Meals", "Wie viel Rohware/Fertigware brauche ich für X fehlende Meals?"],
                ["finished-coverage", "Fertigware vorhanden", "Wie viele Meals deckt vorhandene Fertigware noch ab?"],
                ["raw-coverage", "Rohware vorhanden", "Wie viele Meals deckt vorhandene Rohware noch ab?"],
                ["underweight-unit", "Unter-Grammatur / Stückgewicht", "Wie weit komme ich mit Artikeln, die pro Stück zu leicht sind?"],
              ] as Array<[SubRecipeScenario, string, string]>).map(([scenario, title, text]) => {
                const active = subRecipeScenario === scenario;
                return (
                  <button
                    key={scenario}
                    onClick={() => setSubRecipeScenario(scenario)}
                    className={`rounded-xl border px-4 py-3 text-left transition-all ${
                      active
                        ? "border-sky-400 bg-sky-100 shadow-sm ring-2 ring-sky-200"
                        : "border-slate-200 bg-white hover:border-sky-200 hover:bg-sky-50"
                    }`}
                  >
                    <div className="text-sm font-bold text-slate-800">{title}</div>
                    <div className="mt-1 text-xs text-slate-500">{text}</div>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                  Subrezept auswählen
                </label>
                <select
                  value={selectedSubRecipeId || ""}
                  onChange={e => setSelectedSubRecipeId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {allSubs.map(sub => (
                    <option key={sub.subRecipeId} value={sub.subRecipeId}>
                      {`${"· ".repeat(sub.depth)}${sub.name}`} ({fmt(sub.subtreeGrossPerPortion, 1)} g brutto/Meal)
                    </option>
                  ))}
                </select>
              </div>
              {subRecipeScenario === "missing-meals" && (
                <>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Fehlende Meals
                    </label>
                    <input
                      type="number"
                      value={subRecipeMissingMeals}
                      onChange={e => setSubRecipeMissingMeals(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                      min="0"
                      step="10"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                    />
                  </div>
                  <div className="flex items-end justify-start gap-2">
                    <button onClick={() => void exportSubRecipeCalculation()} disabled={subRecipeExportLoading} className="btn text-xs disabled:opacity-60">
                      {subRecipeExportLoading ? "Exportiert ..." : "Export Excel"}
                    </button>
                    <button
                      onClick={() => {
                        const text = selectedSubRecipeNeeds
                          .map(row => `${row.ingredientName}\t${row.ingredientId}\t${fmt(row.grossTotal, 2)}\t${row.uom}`)
                          .join("\n");
                        navigator.clipboard.writeText(text);
                      }}
                      className="btn text-xs"
                    >
                      Rohware kopieren
                    </button>
                  </div>
                </>
              )}
              {subRecipeScenario === "finished-coverage" && (
                <>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Vorhandene Fertigware (g)
                    </label>
                    <input
                      type="number"
                      value={subRecipeAvailableFinishedGoods}
                      onChange={e => setSubRecipeAvailableFinishedGoods(Math.max(0, parseNumInput(e.target.value)))}
                      min="0"
                      step="100"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                    />
                  </div>
                  <div className="flex items-end">
                    <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
                      Rechnet die vorhandene Netto-/Fertigware direkt in deckbare Meals des gewählten Subrezepts zurück.
                    </div>
                  </div>
                </>
              )}
              {subRecipeScenario === "raw-coverage" && (
                <>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Vorhandene Rohware (g)
                    </label>
                    <input
                      type="number"
                      value={subRecipeAvailableRawware}
                      onChange={e => setSubRecipeAvailableRawware(Math.max(0, parseNumInput(e.target.value)))}
                      min="0"
                      step="100"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                    />
                  </div>
                  <div className="flex items-end">
                    <div className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-800 ring-1 ring-indigo-200">
                      Rechnet Brutto-/Rohware auf die maximal tragbaren Meals und die daraus entstehende Fertigware zurück.
                    </div>
                  </div>
                </>
              )}
              {subRecipeScenario === "underweight-unit" && (
                <>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Zutat / Artikel
                    </label>
                    <select
                      value={underweightIngredientKey || ""}
                      onChange={e => setUnderweightIngredientKey(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      {selectedSubRecipeNeeds.map(need => (
                        <option key={need.key} value={need.key}>
                          {need.ingredientName} ({fmt(need.grossPerPortion, 2)} {need.uom}/Meal)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                      Für Stückartikel mit Untergewicht: Ist-Gewicht pro Stück eingeben, verfügbare Stückzahl setzen und direkt sehen, wie viele Meals real noch machbar sind.
                    </div>
                  </div>
                </>
              )}
            </div>

            {subRecipeScenario === "missing-meals" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => setSubRecipeMissingMeals(1000)} className="btn text-xs">1.000 Meals</button>
                <button onClick={() => setSubRecipeMissingMeals(basePortions)} className="btn text-xs">Basis ({fmt(basePortions)})</button>
                <button onClick={() => setSubRecipeMissingMeals(upliftedPortions)} className="btn btn-primary text-xs">Uplift ({fmt(upliftedPortions)})</button>
              </div>
            )}

            {subRecipeScenario === "underweight-unit" && (
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                    Ziel-Meals
                  </label>
                  <input
                    type="number"
                    value={underweightTargetMeals}
                    onChange={e => setUnderweightTargetMeals(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                    min="0"
                    step="10"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                    Ist-Gewicht pro Stück (g)
                  </label>
                  <input
                    type="number"
                    value={underweightActualUnitWeight}
                    onChange={e => setUnderweightActualUnitWeight(Math.max(0, parseNumInput(e.target.value)))}
                    min="0"
                    step="1"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                    Verfügbare Stück
                  </label>
                  <input
                    type="number"
                    value={underweightAvailableUnits}
                    onChange={e => setUnderweightAvailableUnits(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                    min="0"
                    step="1"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                  />
                </div>
                <div className="lg:col-span-3 flex flex-wrap gap-2">
                  <button onClick={() => setUnderweightTargetMeals(1000)} className="btn text-xs">1.000 Meals</button>
                  <button onClick={() => setUnderweightTargetMeals(basePortions)} className="btn text-xs">Basis ({fmt(basePortions)})</button>
                  <button onClick={() => setUnderweightTargetMeals(upliftedPortions)} className="btn btn-primary text-xs">Uplift ({fmt(upliftedPortions)})</button>
                  <button onClick={() => setUnderweightAvailableUnits(underweightTargetMeals)} className="btn text-xs">Stück = Meals</button>
                </div>
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
              <SummaryTile label="Brutto pro Meal" value={selectedSubRecipe ? fmtMass(selectedSubRecipe.subtreeGrossPerPortion) : "—"} tone="sky" />
              <SummaryTile label="Fertigware pro Meal" value={selectedSubRecipe ? fmtMass(selectedSubRecipe.subtreeNetPerPortion) : "—"} tone="emerald" />
              {showSubRecipeMissingTotals && <SummaryTile label="Rohware für Fehlmenge" value={fmtMass(selectedSubRecipeMissingTotals.grossTotal)} tone="indigo" />}
              {showSubRecipeMissingTotals && <SummaryTile label="Fertigware für Fehlmenge" value={fmtMass(selectedSubRecipeMissingTotals.netTotal)} tone="violet" />}
              {showSubRecipeMissingTotals && <SummaryTile label="Verlust für Fehlmenge" value={fmtMass(selectedSubRecipeMissingTotals.lossTotal)} tone="red" />}
            </div>

            {showSubRecipeFinishedCoverage && (
              selectedSubRecipeFinishedCoverage.coverableMeals > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <SummaryTile label="Meals aus Fertigware" value={fmt(selectedSubRecipeFinishedCoverage.coverableMeals)} tone="amber" />
                  <SummaryTile label="Genutzte Fertigware" value={fmtMass(selectedSubRecipeFinishedCoverage.usedFinishedGoods)} tone="emerald" />
                  <SummaryTile label="Rest Fertigware" value={fmtMass(selectedSubRecipeFinishedCoverage.leftoverFinishedGoods)} tone="slate" />
                  <SummaryTile label="Rohware-Äquivalent" value={fmtMass(selectedSubRecipeFinishedCoverage.equivalentRawware)} tone="indigo" />
                </div>
              ) : (
                <div className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
                  Die eingegebene Fertigware reicht noch nicht für 1 Meal. Benötigt pro Meal: {selectedSubRecipe ? fmtMass(selectedSubRecipe.subtreeNetPerPortion) : "—"} Fertigware.
                </div>
              )
            )}

            {showSubRecipeRawCoverage && (
              selectedSubRecipeRawCoverage.coverableMeals > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-5">
                  <SummaryTile label="Meals aus Rohware" value={fmt(selectedSubRecipeRawCoverage.coverableMeals)} tone="amber" />
                  <SummaryTile label="Genutzte Rohware" value={fmtMass(selectedSubRecipeRawCoverage.usedRawware)} tone="indigo" />
                  <SummaryTile label="Fertigware daraus" value={fmtMass(selectedSubRecipeRawCoverage.equivalentFinishedGoods)} tone="emerald" />
                  <SummaryTile label="Verlust daraus" value={fmtMass(selectedSubRecipeRawCoverage.lossTotal)} tone="red" />
                  <SummaryTile label="Rest Rohware" value={fmtMass(selectedSubRecipeRawCoverage.leftoverRawware)} tone="slate" />
                </div>
              ) : (
                <div className="mt-3 rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800 ring-1 ring-indigo-200">
                  Die eingegebene Rohware reicht noch nicht für 1 Meal. Benötigt pro Meal: {selectedSubRecipe ? fmtMass(selectedSubRecipe.subtreeGrossPerPortion) : "—"} Rohware.
                </div>
              )
            )}

            {showUnderweightCoverage && selectedUnderweightIngredient && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-5">
                  <SummaryTile label="Soll je Meal" value={`${fmt(underweightCoverage.requiredPerMeal, 2)} ${selectedUnderweightIngredient.uom}`} tone="sky" />
                  <SummaryTile label="Stück je Meal" value={fmt(underweightCoverage.unitsNeededPerMeal)} tone="amber" />
                  <SummaryTile label="Meals möglich" value={fmt(underweightCoverage.maxMealsByPieces)} tone="emerald" />
                  <SummaryTile label="Fehlende Meals" value={fmt(underweightCoverage.missingMeals)} tone="red" />
                  <SummaryTile label="Fehlende Stück" value={fmt(underweightCoverage.missingUnits)} tone="violet" />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <SummaryTile label="Verfügbare Gramm gesamt" value={fmtMass(underweightCoverage.totalAvailableWeight)} tone="indigo" />
                  <SummaryTile label="Soll für Ziel-Meals" value={fmtMass(underweightCoverage.totalRequiredWeight)} tone="amber" />
                  <SummaryTile label="Meals nach Gewicht" value={fmt(underweightCoverage.maxMealsByWeight)} tone="slate" />
                  <SummaryTile label="Überfüllung je Meal" value={fmtMass(underweightCoverage.surplusWeightPerMeal)} tone="sky" />
                </div>
                <div className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
                  <strong>{selectedUnderweightIngredient.ingredientName}</strong>: Soll sind {fmt(underweightCoverage.requiredPerMeal, 2)} {selectedUnderweightIngredient.uom} pro Meal.
                  Bei {fmt(underweightActualUnitWeight, 2)} g pro Stück brauchst du rechnerisch {fmt(underweightCoverage.exactUnitsPerMeal, 2)} Stück,
                  praktisch also {fmt(underweightCoverage.unitsNeededPerMeal)} Stück je Meal.
                  Mit {fmt(underweightAvailableUnits)} verfügbaren Stücken kommst du real auf {fmt(underweightCoverage.maxMealsByPieces)} Meals.
                </div>
                {underweightCoverage.maxMealsByPieces === 0 && (
                  <div className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
                    Mit dem aktuellen Stückgewicht und der verfügbaren Stückzahl reicht es noch nicht für 1 vollständiges Meal dieser Zutat.
                  </div>
                )}
              </>
            )}

            {subRecipeScenario === "missing-meals" && selectedSubRecipeNeeds.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-slate-200">
                <div className="bg-slate-100 px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-600">
                  Rohwarenbedarf für die fehlenden Meals
                </div>
                <div className="max-h-80 overflow-auto bg-white">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Zutat</th>
                        <th className="px-3 py-2 text-right">Brutto/Meal</th>
                        <th className="px-3 py-2 text-right">Rohware</th>
                        <th className="px-3 py-2 text-right">Fertigware</th>
                        <th className="px-3 py-2 text-right">Verlust</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedSubRecipeNeeds.map(row => (
                        <tr key={row.key}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-800">{row.ingredientName}</div>
                            <div className="text-[10px] font-mono text-slate-400">{row.ingredientId}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(row.grossPerPortion, 2)} {row.uom}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">{fmt(row.grossTotal, 2)} {row.uom}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700">{fmt(row.netTotal, 2)} {row.uom}</td>
                          <td className="px-3 py-2 text-right font-mono text-rose-700">{fmt(row.lossTotal, 2)} {row.uom}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* SUB-RECIPE TREE */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-lg font-bold text-slate-800">
                Rezept-Baum · Yield-% pro Zutat (klick zum Überschreiben)
              </h3>
              <div className="text-xs text-slate-500">
                💡 Overrides bleiben auch in zukünftigen KWs erhalten
              </div>
            </div>
            <div className="space-y-3">
              {aggregateRoots.map(root => (
                <SubRecipeAggregateView
                  key={root.subRecipeId}
                  agg={root}
                  targetPortions={direction === "forward" ? targetPortions : 1}
                  showForward={direction === "forward"}
                  selectedSubRecipeId={selectedSubRecipeId}
                  onSelectSubRecipe={setSelectedSubRecipeId}
                  onOverride={setIngredientOverride}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ════════════════════════════════════════════════════════════════════════════

function SummaryTile({ label, value, tone }: {
  label: string;
  value: string;
  tone: "indigo" | "emerald" | "red" | "amber" | "violet" | "slate" | "sky";
}): JSX.Element {
  const tones: Record<string, string> = {
    indigo: "bg-indigo-100 text-indigo-900 ring-indigo-300",
    emerald: "bg-emerald-100 text-emerald-900 ring-emerald-300",
    red: "bg-red-100 text-red-900 ring-red-300",
    amber: "bg-amber-100 text-amber-900 ring-amber-300",
    violet: "bg-violet-100 text-violet-900 ring-violet-300",
    sky: "bg-sky-100 text-sky-900 ring-sky-300",
    slate: "bg-slate-100 text-slate-900 ring-slate-300"
  };
  return (
    <div className={`rounded-xl ring-1 px-3 py-2 ${tones[tone]}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-extrabold font-mono tabular-nums">{value}</div>
    </div>
  );
}

function SubRecipeAggregateView({
  agg,
  targetPortions,
  showForward,
  selectedSubRecipeId,
  onSelectSubRecipe,
  onOverride
}: {
  agg: SubRecipeAggregate;
  targetPortions: number;
  showForward: boolean;
  selectedSubRecipeId: string | null;
  onSelectSubRecipe: (subRecipeId: string) => void;
  onOverride: (ingredientId: string, subRecipeId: string, value: number | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [showInstructions, setShowInstructions] = useState(false);

  const depthColors = ["border-l-indigo-500", "border-l-violet-500", "border-l-fuchsia-500", "border-l-rose-500"];
  const borderColor = depthColors[Math.min(agg.depth, depthColors.length - 1)];
  const isSelected = agg.subRecipeId === selectedSubRecipeId;

  const totalGrossForRun = agg.subtreeGrossPerPortion * targetPortions;
  const yieldDisplay = agg.avgYield !== undefined ? `Ø ${(agg.avgYield * 100).toFixed(2)}%` : "—";
  const totalNetForRun = agg.subtreeNetPerPortion * targetPortions;

  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 ${borderColor} bg-white ${isSelected ? "ring-2 ring-sky-300" : ""}`}>
      <button
        onClick={() => {
          onSelectSubRecipe(agg.subRecipeId);
          setOpen(o => !o);
        }}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-slate-50 rounded-t-xl"
      >
        <span className="text-xs font-bold text-slate-400 mt-1 shrink-0">
          {open ? "▼" : "▶"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-slate-800">{agg.name}</div>
          {agg.categories && (
            <div className="text-[11px] text-slate-500 mt-0.5">{agg.categories}</div>
          )}
          {agg.path.length > 1 && (
            <div className="text-[10px] text-slate-400 mt-0.5">
              Pfad: {agg.path.slice(0, -1).join(" → ")}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 text-right">
          <div className="text-[10px] uppercase font-bold text-slate-400">Direkte Zutaten</div>
          <div className="text-xs font-bold">{agg.ingredients.length}</div>
          {showForward && agg.totalGrossPerPortion > 0 && (
            <>
              <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Brutto/Portion direkt</div>
              <div className="text-xs font-mono">{fmt(agg.totalGrossPerPortion, 1)} g</div>
              <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Brutto inkl. Kinder</div>
              <div className="text-xs font-mono text-indigo-700">{fmt(agg.subtreeGrossPerPortion, 1)} g</div>
              <div className="text-[10px] text-emerald-600 font-mono">@ {yieldDisplay}</div>
            </>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 p-3 space-y-2">
          {agg.instructions && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-2">
              <button
                onClick={() => setShowInstructions(s => !s)}
                className="flex items-center gap-2 text-xs font-bold text-yellow-900"
              >
                <span>{showInstructions ? "▼" : "▶"}</span>
                <span>📋 Plating- / Cook-Anweisungen</span>
              </button>
              {showInstructions && (
                <pre className="mt-2 text-[11px] text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                  {agg.instructions}
                </pre>
              )}
            </div>
          )}

          {showForward && agg.subtreeGrossPerPortion > 0 && targetPortions > 0 && (
            <div className="bg-indigo-50/50 rounded-lg p-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Σ Brutto inkl. Kinder · {fmt(targetPortions)} P.</div>
                <div className="font-mono font-bold text-indigo-700">{fmtMass(totalGrossForRun)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Σ Netto (nach Yield)</div>
                <div className="font-mono font-bold text-emerald-700">{fmtMass(totalNetForRun)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Verlust</div>
                <div className="font-mono font-bold text-red-600">{fmtMass(totalGrossForRun - totalNetForRun)}</div>
              </div>
            </div>
          )}

          {agg.ingredients.length > 0 && (
            <div className="space-y-1">
              {agg.ingredients.map((ing, i) => (
                <IngredientYieldRow
                  key={`${ing.ingredientId}-${i}`}
                  ing={ing}
                  targetPortions={targetPortions}
                  showForward={showForward}
                  onOverride={onOverride}
                />
              ))}
            </div>
          )}

          {agg.childSubRecipes.length > 0 && (
            <div className="ml-4 space-y-2 mt-2">
              {agg.childSubRecipes.map(child => (
                <SubRecipeAggregateView
                  key={child.subRecipeId}
                  agg={child}
                  targetPortions={targetPortions}
                  showForward={showForward}
                  selectedSubRecipeId={selectedSubRecipeId}
                  onSelectSubRecipe={onSelectSubRecipe}
                  onOverride={onOverride}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IngredientYieldRow({
  ing,
  targetPortions,
  showForward,
  onOverride
}: {
  ing: FlatIngredient;
  targetPortions: number;
  showForward: boolean;
  onOverride: (ingredientId: string, subRecipeId: string, value: number | null) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [tempValue, setTempValue] = useState<string>((ing.effectiveYield * 100).toFixed(2));

  const totalGross = ing.grossQty * (showForward ? targetPortions : 1);
  const totalNet = totalGross * ing.effectiveYield;
  const lossGrams = totalGross - totalNet;

  function commit(): void {
    const pct = parseNumInput(tempValue);
    if (pct < 0.01 || pct > 100) {
      setTempValue((ing.effectiveYield * 100).toFixed(2));
      setEditing(false);
      return;
    }
    onOverride(ing.ingredientId, ing.subRecipeId, pct / 100);
    setEditing(false);
  }

  function reset(): void {
    onOverride(ing.ingredientId, ing.subRecipeId, null);
    setEditing(false);
  }

  return (
    <div
      id={`ing-row-${ing.ingredientId}__${ing.subRecipeId}`}
      className={`rounded-lg px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs transition-shadow ${
        ing.hasOverride ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"
      }`}
    >
      <div className="col-span-5 min-w-0">
        <div className="font-medium text-slate-800 truncate" title={ing.ingredientName}>
          {ing.ingredientName}
        </div>
        <div className="text-[10px] text-slate-400 font-mono truncate">
          {ing.ingredientId}
        </div>
      </div>

      <div className="col-span-2 text-right">
        <div className="text-[10px] uppercase text-slate-400 font-bold">Brutto/P.</div>
        <div className="font-mono">{fmt(ing.grossQty, 2)} {ing.uom}</div>
      </div>

      <div className="col-span-2 text-center">
        {editing ? (
          <div className="flex gap-1 items-center justify-center">
            <input
              type="number"
              value={tempValue}
              onChange={e => setTempValue(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
              autoFocus
              min="0.01"
              max="100"
              step="0.01"
              className="w-16 rounded border border-amber-400 px-1 py-0.5 text-xs font-mono"
            />
            <span className="text-xs">%</span>
          </div>
        ) : (
          <button
            onClick={() => { setTempValue((ing.effectiveYield * 100).toFixed(2)); setEditing(true); }}
            className={`px-2 py-1 rounded font-mono font-bold ${
              ing.hasOverride
                ? "bg-amber-200 text-amber-900 ring-1 ring-amber-400"
                : ing.defaultYield !== undefined
                  ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                  : "bg-slate-200 text-slate-500 hover:bg-slate-300"
            }`}
            title={ing.hasOverride
              ? `Override aktiv. Default war: ${ing.defaultYield !== undefined ? (ing.defaultYield * 100).toFixed(2) + "%" : "—"}`
              : ing.defaultYield !== undefined
                ? "Yield aus CSV (klick zum Überschreiben)"
                : "Kein Yield in CSV → angenommen 100% (klick zum Setzen)"
            }
          >
            {(ing.effectiveYield * 100).toFixed(2)}%
            {ing.hasOverride && " ✏"}
          </button>
        )}
      </div>

      <div className="col-span-2 text-right">
        {showForward && targetPortions > 0 && (
          <>
            <div className="text-[10px] uppercase text-slate-400 font-bold">Σ Rohware</div>
            <div className="font-mono font-bold text-indigo-700">{fmtMass(totalGross)}</div>
            <div className="text-[10px] text-red-600 font-mono">−{fmtMass(lossGrams)} Verlust</div>
          </>
        )}
        {!showForward && (
          <>
            <div className="text-[10px] uppercase text-slate-400 font-bold">Netto/P.</div>
            <div className="font-mono">{fmt(totalNet, 2)} {ing.uom}</div>
          </>
        )}
      </div>

      <div className="col-span-1 text-right">
        {ing.hasOverride && !editing && (
          <button
            onClick={reset}
            className="text-[10px] text-red-600 hover:text-red-800 underline"
            title="Override entfernen, zurück zu CSV-Default"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
