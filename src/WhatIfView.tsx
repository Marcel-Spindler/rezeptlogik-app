/**
 * WhatIfView.tsx – DATA-DRIVEN Yield-Verlust-Rechner
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
import type { DataBundle, Recipe, RecipeStructure, WeekRecipe } from "./core/types";
import type { UiLocale } from "./lib/i18n";
import { tl } from "./lib/i18n";
import { usePlanningOasisData } from "./lib/planningOasisData";

import type { Direction, FlatIngredient, SubRecipeAggregate, SubRecipeScenario, YieldSource } from "./features/whatif/whatIfTypes";
import { saveOverride, listAllOverrides } from "./features/whatif/whatIfOverrides";
import { fmt, fmtMass, parseNumInput } from "./features/whatif/whatIfFormat";
import {
  isProducedInVerden, getBaseVolume, getStructureForRecipe, buildInstructionsMap, aggregateSubRecipe,
  flattenIngredients, flattenSubRecipes, aggregateSubRecipeIngredientNeeds, aggregateRecipeIngredientNeeds,
  findBottlenecks,
} from "./features/whatif/whatIfAggregate";
import type { IngredientHit } from "./features/whatif/whatIfSearch";
import { collectIngredientsFromNode, scrollToIngredientRow } from "./features/whatif/whatIfSearch";
import { SummaryTile, SubRecipeAggregateView } from "./features/whatif/WhatIfWidgets";
import { useRtiMonitor } from "./features/gsheet-monitor/useGSheetMonitor";

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

  const { data: _oasisData } = usePlanningOasisData();

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
  }, [data.weekRecipes, week]);
  
  // @ts-expect-error unused
  type _MealChoice = {
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
    // overrideTick isn't read in the body — it's a bump-to-recompute signal for
    // listAllOverrides()'s localStorage read, which React can't track reactively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const [recipeExportLoading, setRecipeExportLoading] = useState(false);

  // ── Rohwarenbedarf-Tabelle: Yield-Cap + Sortierung ─────────────────────
  const [yieldCapEnabled, setYieldCapEnabled] = useState(false);
  type NeedsSortBy = 'gross' | 'loss' | 'losspct';
  const [needsSortBy, setNeedsSortBy] = useState<NeedsSortBy>('gross');

  // ── Batch-Korrekturfaktor (global auf alle Yields) ─────────────────────
  const [batchCorrectionPct, setBatchCorrectionPct] = useState(0);
  const correctionMultiplier = 1 + batchCorrectionPct / 100;

  // ── Szenario-Vergleich ─────────────────────────────────────────────────
  interface SavedScenario {
    label: string;
    targetPortions: number;
    totalGross: number;
    totalNet: number;
    lossGrams: number;
    lossPercent: number;
    timestamp: number;
  }
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([]);

  // ── Multi-Meal Aggregation ─────────────────────────────────────────────
  // prepared for multi-meal feature
  const [_multiMealMode, _setMultiMealMode] = useState(false);
  const [_selectedMealCodes, _setSelectedMealCodes] = useState<Set<string>>(new Set());

  // ── Gewichtskontrolle ──────────────────────────────────────────────────
  const [weightControlTarget, setWeightControlTarget] = useState(0);
  const [weightControlActual, setWeightControlActual] = useState(0);
  const [weightControlDone, setWeightControlDone] = useState(0);
  const [weightControlTotal, setWeightControlTotal] = useState(0);

  // ── RTI-Gap Szenario ───────────────────────────────────────────────────
  const [rtiPlannedMeals, setRtiPlannedMeals] = useState<number>(0);
  const [rtiActualMeals, setRtiActualMeals] = useState<number>(0);
  const [rtiSubRecipeHoldings, setRtiSubRecipeHoldings] = useState<Map<string, number>>(new Map());

  // ── RTI Live-Daten aus Google Sheet ────────────────────────────────────
  const rtiMonitor = useRtiMonitor();
  const rtiLiveData = rtiMonitor.data;

  // Auto-Fill RTI-Daten wenn das aktuelle Meal im Sheet gefunden wird
  useEffect(() => {
    if (!rtiLiveData || !selectedCode || subRecipeScenario !== "rti-gap") return;
    const mealBlock = rtiLiveData.meals.find(m => m.mealCode === selectedCode);
    if (!mealBlock) return;
    setRtiPlannedMeals(mealBlock.plannedTarget);
    setRtiActualMeals(mealBlock.actuals);
  }, [rtiLiveData, selectedCode, subRecipeScenario]);
  useEffect(() => {
    setTargetPortions(upliftedPortions || 1000);
    setSubRecipeMissingMeals(upliftedPortions || 1000);
    setSubRecipeAvailableFinishedGoods(0);
    setSubRecipeAvailableRawware(0);
    setUnderweightTargetMeals(upliftedPortions || 1000);
    setUnderweightAvailableUnits(upliftedPortions || 0);
    setUnderweightActualUnitWeight(0);
  }, [upliftedPortions, selectedCode]);

  // ancestorYieldFactor des gewählten Subs → macht die Subrezept-Rechnung sub-lokal
  // (Summe der Netto-Mengen == MSKU-Ausgabemenge des Subs).
  const selectedSubAncestorDivisor = selectedSubRecipe?.ancestorYieldFactor ?? 1;

  const selectedSubRecipeIngredients = useMemo(() => {
    const ings = selectedSubRecipe ? flattenIngredients(selectedSubRecipe) : [];
    if (!yieldCapEnabled) return ings;
    // Cap auf 100 % sub-lokal: effektiver Faktor / Eltern-Faktor darf nicht > 1
    const cap = selectedSubAncestorDivisor;
    return ings.map(ing => (ing.effectiveYield / (cap > 0 ? cap : 1) > 1
      ? { ...ing, effectiveYield: cap }
      : ing));
  }, [selectedSubRecipe, yieldCapEnabled, selectedSubAncestorDivisor]);

  const selectedSubRecipeNeeds = useMemo(() => {
    const needs = aggregateSubRecipeIngredientNeeds(selectedSubRecipeIngredients, subRecipeMissingMeals, selectedSubAncestorDivisor);
    if (needsSortBy === 'loss') return [...needs].sort((a, b) => b.lossTotal - a.lossTotal);
    if (needsSortBy === 'losspct') return [...needs].sort((a, b) => b.lossPercent - a.lossPercent);
    return needs;
  }, [selectedSubRecipeIngredients, subRecipeMissingMeals, needsSortBy, selectedSubAncestorDivisor]);

  const ingredientYieldInfo = useMemo(() => {
    const div = selectedSubAncestorDivisor > 0 ? selectedSubAncestorDivisor : 1;
    const map = new Map<string, { yieldSource: YieldSource; yieldMissing: boolean; effectiveYield: number }>();
    for (const ing of selectedSubRecipeIngredients) {
      const key = `${ing.ingredientId}__${ing.uom}`;
      // sub-lokaler effektiver Yield (konsistent mit selectedSubRecipeNeeds)
      const localEff = ing.hasOverride ? ing.effectiveYield : ing.effectiveYield / div;
      const existing = map.get(key);
      if (!existing || localEff > existing.effectiveYield) {
        map.set(key, { yieldSource: ing.yieldSource, yieldMissing: ing.yieldMissing, effectiveYield: localEff });
      }
    }
    return map;
  }, [selectedSubRecipeIngredients, selectedSubAncestorDivisor]);

  const fullRecipeNeeds = useMemo(
    () => aggregateRecipeIngredientNeeds(allIngredients, targetPortions),
    [allIngredients, targetPortions]
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
      const correctedYield = Math.min(Math.max(ing.effectiveYield * correctionMultiplier, 0.01), 2);
      const totalNet = totalGross * correctedYield;
      const lossGrams = totalGross - totalNet;
      const lossPercent = totalGross > 0 ? (lossGrams / totalGross) * 100 : 0;
      return { ing, totalGross, totalNet, lossGrams, lossPercent };
    });
  }, [allIngredients, targetPortions, correctionMultiplier]);

  const forwardTotals = useMemo(() => {
    const totalGross = forwardRows.reduce((s, r) => s + r.totalGross, 0);
    // Netto = Σ MSKU-Plattiermenge je Top-Level-Sub (exakt), × Batch-Korrektur.
    // Fallback auf Blätter-Summe wenn keine Aggregat-Struktur vorliegt.
    const statedNetPerPortion = aggregateRoots.reduce((s, r) => s + r.subtreeNetPerPortion, 0);
    const totalNet = statedNetPerPortion > 0
      ? statedNetPerPortion * targetPortions * correctionMultiplier
      : forwardRows.reduce((s, r) => s + r.totalNet, 0);
    return {
      totalGross,
      totalNet,
      lossGrams: totalGross - totalNet,
      lossPercent: totalGross > 0 ? ((totalGross - totalNet) / totalGross) * 100 : 0
    };
  }, [forwardRows, aggregateRoots, targetPortions, correctionMultiplier]);

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

  async function exportFullRecipeCalculation(): Promise<void> {
    if (!selectedMeal || !selectedCode) return;
    setRecipeExportLoading(true);
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

      const overview = workbook.addWorksheet("Uebersicht", { views: [{ showGridLines: false }] });
      overview.columns = [{ width: 28 }, { width: 24 }, { width: 22 }, { width: 22 }];

      overview.mergeCells("A1:D1");
      const title = overview.getCell("A1");
      title.value = `What-if Gesamt-Export · ${selectedCode}`;
      title.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
      title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
      title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      overview.getRow(1).height = 28;

      const metaRows: Array<[string, string | number, string, string | number]> = [
        ["Woche", week, "Meal", selectedCode],
        ["Rezept", selectedMeal.recipeName, "Portionen Ziel", targetPortions],
        ["Basis Verden", Math.round(basePortions), "Uplift", `${upliftPercent}%`],
        ["Portionen mit Uplift", upliftedPortions, "Yield Overrides", overrideCount],
        ["Sub-Rezepte", allSubs.length, "Zutaten Positionen", allIngredients.length],
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
      const totalsHeader = overview.addRow(["Bereich", "Kennzahl", "Wert", "Einheit"]);
      totalsHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
        cell.border = border;
      });

      const totalsRows: Array<[string, string, number, string]> = [
        ["Gesamt", "Rohware (Brutto)", Number(forwardTotals.totalGross.toFixed(2)), "g"],
        ["Gesamt", "Fertigware (Netto)", Number(forwardTotals.totalNet.toFixed(2)), "g"],
        ["Gesamt", "Yield-Verlust", Number(forwardTotals.lossGrams.toFixed(2)), "g"],
        ["Gesamt", "Verlustquote", Number(forwardTotals.lossPercent.toFixed(2)), "%"],
      ];
      totalsRows.forEach(rowData => {
        const row = overview.addRow(rowData);
        row.eachCell(cell => {
          cell.border = border;
          cell.alignment = { vertical: "middle", horizontal: "left" };
        });
      });

      const subSheet = workbook.addWorksheet("Subrezepte", { views: [{ state: "frozen", ySplit: 1 }] });
      subSheet.columns = [
        { width: 8 },
        { width: 32 },
        { width: 60 },
        { width: 16 },
        { width: 16 },
        { width: 16 },
        { width: 16 },
        { width: 16 },
        { width: 12 },
      ];

      const subHeader = subSheet.addRow([
        "Ebene",
        "Sub-Rezept",
        "Pfad",
        "Brutto/Meal",
        "Netto/Meal",
        "Rohware gesamt",
        "Fertigware gesamt",
        "Verlust gesamt",
        "Avg Yield %",
      ]);
      subHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0369A1" } };
        cell.border = border;
      });

      allSubs.forEach(sub => {
        const grossTotal = sub.subtreeGrossPerPortion * targetPortions;
        const netTotal = sub.subtreeNetPerPortion * targetPortions;
        const row = subSheet.addRow([
          sub.depth,
          sub.name,
          sub.path.join(" -> "),
          Number(sub.subtreeGrossPerPortion.toFixed(2)),
          Number(sub.subtreeNetPerPortion.toFixed(2)),
          Number(grossTotal.toFixed(2)),
          Number(netTotal.toFixed(2)),
          Number((grossTotal - netTotal).toFixed(2)),
          sub.avgYield ? Number((sub.avgYield * 100).toFixed(2)) : "",
        ]);
        row.eachCell((cell, col) => {
          cell.border = border;
          cell.alignment = { vertical: "middle", horizontal: col >= 4 ? "right" : "left" };
        });
      });

      const ingredientsSheet = workbook.addWorksheet("Rohware Gesamt", { views: [{ state: "frozen", ySplit: 1 }] });
      ingredientsSheet.columns = [
        { width: 36 },
        { width: 24 },
        { width: 16 },
        { width: 16 },
        { width: 18 },
        { width: 18 },
        { width: 16 },
        { width: 12 },
      ];

      const ingredientHeader = ingredientsSheet.addRow([
        "Zutat",
        "SKU",
        "Brutto/Meal",
        "Netto/Meal",
        "Rohware gesamt",
        "Fertigware gesamt",
        "Verlust gesamt",
        "Einheit",
      ]);
      ingredientHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
        cell.border = border;
      });

      fullRecipeNeeds.forEach(need => {
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

      const bySubSheet = workbook.addWorksheet("Rohware nach Subrezept", { views: [{ state: "frozen", ySplit: 1 }] });
      bySubSheet.columns = [
        { width: 32 },
        { width: 60 },
        { width: 34 },
        { width: 24 },
        { width: 16 },
        { width: 16 },
        { width: 18 },
        { width: 18 },
        { width: 16 },
        { width: 12 },
      ];

      const bySubHeader = bySubSheet.addRow([
        "Sub-Rezept",
        "Pfad",
        "Zutat",
        "SKU",
        "Brutto/Meal",
        "Netto/Meal",
        "Rohware gesamt",
        "Fertigware gesamt",
        "Verlust gesamt",
        "Einheit",
      ]);
      bySubHeader.eachCell(cell => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
        cell.border = border;
      });

      allSubs.forEach(sub => {
        sub.ingredients.forEach(ing => {
          const grossPerPortion = ing.grossQty;
          const netPerPortion = ing.grossQty * ing.effectiveYield;
          const grossTotal = grossPerPortion * targetPortions;
          const netTotal = netPerPortion * targetPortions;
          const row = bySubSheet.addRow([
            sub.name,
            sub.path.join(" -> "),
            ing.ingredientName,
            ing.ingredientId,
            Number(grossPerPortion.toFixed(2)),
            Number(netPerPortion.toFixed(2)),
            Number(grossTotal.toFixed(2)),
            Number(netTotal.toFixed(2)),
            Number((grossTotal - netTotal).toFixed(2)),
            ing.uom,
          ]);
          row.eachCell((cell, col) => {
            cell.border = border;
            cell.alignment = { vertical: "middle", horizontal: col >= 5 && col <= 9 ? "right" : "left" };
          });
        });
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${week}_${selectedCode}_what_if_gesamt.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setRecipeExportLoading(false);
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
  const noIngredientData = !data.structures || Object.keys(data.structures).length === 0;

  return (
    <div className="space-y-4">
      {noIngredientData && (
        <div className="card p-4 bg-amber-50 border border-amber-300 text-amber-900 flex items-start gap-3">
          <span className="text-xl">⚠</span>
          <div>
            <div className="font-semibold">Zutaten-Daten fehlen</div>
            <div className="text-sm mt-0.5">
              Die Sub-Rezept- und Zutaten-Strukturen sind noch nicht geladen.
              Bitte <code className="bg-amber-100 px-1 rounded">npm run import:local</code> ausführen und die Seite neu laden.
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="card p-5 bg-gradient-to-r from-indigo-50 to-violet-50 border-2 border-indigo-200">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              🧮 What-if & Yield-Verlust-Rechner
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Daten-getrieben aus <code className="px-1 bg-white rounded text-xs">export-sub-recipes-by-recipe-detailed.csv</code> ·
              Netto = MSKU-Plattiermenge je Sub-Rezept (verschachtelte Yields kompoundiert) ·
              Forward &amp; Reverse · Persistente Overrides
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

        {/* Batch-Korrekturfaktor */}
        <div className="mt-4 p-3 bg-white/60 rounded-lg">
          <div className="flex items-center gap-4">
            <label className="text-xs font-bold uppercase text-slate-600 whitespace-nowrap">
              Batch-Korrektur
            </label>
            <input
              type="range"
              min="-15"
              max="15"
              step="0.5"
              value={batchCorrectionPct}
              onChange={e => setBatchCorrectionPct(parseFloat(e.target.value))}
              className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-slate-200"
            />
            <span className={`text-sm font-mono font-bold min-w-[4rem] text-right ${
              batchCorrectionPct === 0 ? "text-slate-500" : batchCorrectionPct > 0 ? "text-emerald-700" : "text-red-700"
            }`}>
              {batchCorrectionPct > 0 ? "+" : ""}{batchCorrectionPct.toFixed(1)}%
            </span>
            {batchCorrectionPct !== 0 && (
              <button onClick={() => setBatchCorrectionPct(0)} className="text-xs text-slate-500 hover:text-red-600 underline">
                Reset
              </button>
            )}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            Passt alle Yield-Werte um diesen Faktor an (z.B. -5% = Praxis zeigt mehr Verlust als theoretisch)
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

      {/* YIELD AUDIT PANEL */}
      {allIngredients.length > 0 && (() => {
        const auditItems = allIngredients.filter(i => i.yieldMissing || i.yieldSource === "computed");
        const estimatedSubs = allSubs.filter(s => !s.statedFromMsku);
        // MSKU-Gegenprobe: Σ Blätter-Endteller-Netto vs. Σ Top-Level-Plattiermenge
        const sumStatedTop = aggregateRoots.reduce((s, r) => s + r.subtreeNetPerPortion, 0);
        const sumLeafFinal = allIngredients.reduce((s, i) => s + i.grossQty * i.effectiveYield, 0);
        const crossDeltaPct = sumStatedTop > 0 ? ((sumLeafFinal - sumStatedTop) / sumStatedTop) * 100 : 0;
        const crossWarn = Math.abs(crossDeltaPct) > 3;
        if (auditItems.length === 0 && estimatedSubs.length === 0 && !crossWarn) return null;
        return (
          <details className="card border-2 border-orange-200 bg-orange-50/50">
            <summary className="p-4 cursor-pointer flex items-center gap-3 flex-wrap">
              <span className="text-orange-600 font-bold">⚠ Yield-Audit</span>
              {auditItems.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-orange-200 text-orange-800 font-bold">
                  {auditItems.length} Zutaten ohne echten Yield
                </span>
              )}
              {estimatedSubs.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-bold">
                  {estimatedSubs.length} Sub-Rezepte geschätzt (each)
                </span>
              )}
              <span className="text-xs text-slate-500 flex-1">
                — Netto/Portion je Sub-Rezept kommt sonst direkt aus MSKU
              </span>
            </summary>
            <div className="px-4 pb-4 space-y-3">
              {/* MSKU-Gegenprobe */}
              <div className={`rounded-lg px-3 py-2 text-xs ring-1 ${crossWarn ? "bg-amber-50 ring-amber-300 text-amber-900" : "bg-emerald-50 ring-emerald-300 text-emerald-900"}`}>
                <strong>MSKU-Gegenprobe:</strong>{" "}
                Σ Zutaten-Endteller-Netto {fmtMass(sumLeafFinal)} vs. Σ MSKU-Plattiermenge {fmtMass(sumStatedTop)}{" "}
                (Δ {crossDeltaPct >= 0 ? "+" : ""}{fmt(crossDeltaPct, 1)} %).{" "}
                {crossWarn
                  ? "Abweichung > 3 % — meist durch each-Sub-Rezepte oder MSKU-Inkonsistenz."
                  : "Im Rahmen."}
              </div>

              {estimatedSubs.length > 0 && (
                <div className="rounded-lg ring-1 ring-amber-200 bg-white overflow-auto max-h-40">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-amber-100 text-[10px] uppercase tracking-wide text-amber-700">
                      <tr>
                        <th className="px-3 py-2 text-left">Geschätztes Sub-Rezept (each)</th>
                        <th className="px-3 py-2 text-right">Brutto/Meal</th>
                        <th className="px-3 py-2 text-right">Netto/Meal (geschätzt)</th>
                        <th className="px-3 py-2 text-right">Yield</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-amber-100">
                      {estimatedSubs.map(s => (
                        <tr key={s.subRecipeId}>
                          <td className="px-3 py-2 font-medium">{s.name}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtMass(s.subtreeGrossPerPortion)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtMass(s.subtreeNetPerPortion)}</td>
                          <td className="px-3 py-2 text-right font-mono">{s.avgYield ? `${(s.avgYield * 100).toFixed(1)}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {auditItems.length > 0 && (
              <div className="max-h-60 overflow-auto rounded-lg ring-1 ring-orange-200 bg-white">
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-orange-100 text-[10px] uppercase tracking-wide text-orange-700">
                    <tr>
                      <th className="px-3 py-2 text-left">Zutat</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-right">Brutto</th>
                      <th className="px-3 py-2 text-right">Netto (Daten)</th>
                      <th className="px-3 py-2 text-center">Status</th>
                      <th className="px-3 py-2 text-center">Kette</th>
                      <th className="px-3 py-2 text-center">Eff. Yield</th>
                      <th className="px-3 py-2 text-center">Aktion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {auditItems.map((ing, idx) => (
                      <tr key={`${ing.ingredientId}-${ing.subRecipeId}-${idx}`}>
                        <td className="px-3 py-2 font-medium">{ing.ingredientName}</td>
                        <td className="px-3 py-2 text-slate-500">{ing.subRecipePath[ing.subRecipePath.length - 1]}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(ing.grossQty, 2)} {ing.uom}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(ing.netQty, 2)} {ing.uom}</td>
                        <td className="px-3 py-2 text-center">
                          {ing.yieldMissing
                            ? <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold">Fehlt</span>
                            : <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">Berechnet</span>
                          }
                        </td>
                        <td className="px-3 py-2 text-center font-mono" title="Produkt der Eltern-Sub-Rezept-Yields">
                          {ing.ancestorYieldFactor < 0.999 ? `×${(ing.ancestorYieldFactor * 100).toFixed(0)}%` : "—"}
                        </td>
                        <td className="px-3 py-2 text-center font-mono">{(ing.effectiveYield * 100).toFixed(2)}%</td>
                        <td className="px-3 py-2 text-center">
                          {ing.yieldSource === "computed" && (
                            <button
                              onClick={() => setIngredientOverride(ing.ingredientId, ing.subRecipeId, ing.effectiveYield)}
                              className="text-[10px] text-blue-700 hover:text-blue-900 underline"
                            >
                              Übernehmen
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          </details>
        );
      })()}

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
                <button
                  onClick={() => void exportFullRecipeCalculation()}
                  disabled={recipeExportLoading || targetPortions <= 0 || allSubs.length === 0}
                  className="btn text-xs disabled:opacity-60"
                >
                  {recipeExportLoading ? "Exportiert ..." : "Gesamt-Export Excel"}
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryTile label="Gesamt Rohware (Brutto)" value={fmtMass(forwardTotals.totalGross)} tone="indigo" />
                <SummaryTile label="Davon Fertigware (Netto)" value={fmtMass(forwardTotals.totalNet)} tone="emerald" />
                <SummaryTile label="Yield-Verlust" value={fmtMass(forwardTotals.lossGrams)} tone="red" />
                <SummaryTile label="Verlust-%" value={`${fmt(forwardTotals.lossPercent, 2)}%`} tone="amber" />
              </div>

              {/* Szenario-Vergleich */}
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => {
                    if (savedScenarios.length >= 3) return;
                    setSavedScenarios(prev => [...prev, {
                      label: `Szenario ${prev.length + 1} (${fmt(targetPortions)} P.)`,
                      targetPortions,
                      totalGross: forwardTotals.totalGross,
                      totalNet: forwardTotals.totalNet,
                      lossGrams: forwardTotals.lossGrams,
                      lossPercent: forwardTotals.lossPercent,
                      timestamp: Date.now()
                    }]);
                  }}
                  disabled={savedScenarios.length >= 3}
                  className="btn text-xs disabled:opacity-50"
                >
                  Szenario merken ({savedScenarios.length}/3)
                </button>
                {savedScenarios.length > 0 && (
                  <button onClick={() => setSavedScenarios([])} className="text-xs text-red-600 hover:underline">
                    Alle löschen
                  </button>
                )}
              </div>

              {savedScenarios.length > 0 && (
                <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">Szenario</th>
                        <th className="px-3 py-2 text-right">Portionen</th>
                        <th className="px-3 py-2 text-right">Rohware</th>
                        <th className="px-3 py-2 text-right">Fertigware</th>
                        <th className="px-3 py-2 text-right">Verlust</th>
                        <th className="px-3 py-2 text-right">Verlust-%</th>
                        {savedScenarios.length > 1 && <th className="px-3 py-2 text-right">Δ Rohware vs. #1</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {savedScenarios.map((sc, idx) => (
                        <tr key={sc.timestamp}>
                          <td className="px-3 py-2 font-medium">{sc.label}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(sc.targetPortions)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtMass(sc.totalGross)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtMass(sc.totalNet)}</td>
                          <td className="px-3 py-2 text-right font-mono text-red-600">{fmtMass(sc.lossGrams)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(sc.lossPercent, 2)}%</td>
                          {savedScenarios.length > 1 && (
                            <td className="px-3 py-2 text-right font-mono font-bold">
                              {idx === 0 ? "—" : (
                                <span className={sc.totalGross - savedScenarios[0].totalGross > 0 ? "text-red-600" : "text-emerald-600"}>
                                  {sc.totalGross - savedScenarios[0].totalGross > 0 ? "+" : ""}{fmtMass(sc.totalGross - savedScenarios[0].totalGross)}
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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

                {/* Engpass-Analyse */}
                {reverseIngredient && reverseResult && reverseResult.maxPortions > 0 && (
                  <div className="mt-4 p-3 bg-violet-50 rounded-lg ring-1 ring-violet-200">
                    <div className="text-xs font-bold uppercase text-violet-700 mb-2">
                      Top-Engpass-Zutaten (limitieren Portionen)
                    </div>
                    <div className="space-y-1">
                      {(() => {
                        const availMap = new Map<string, number>();
                        availMap.set(reverseIngredient.ingredientId, reverseRawGrams);
                        const bottlenecks = findBottlenecks(allIngredients, availMap);
                        if (bottlenecks.length === 0) return <div className="text-xs text-slate-500">Keine Engpass-Daten (nur 1 Zutat bewertet)</div>;
                        return bottlenecks.map((bn, idx) => (
                          <div key={bn.ingredientId} className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${bn.isLimiting ? "bg-red-100 ring-1 ring-red-300" : "bg-white"}`}>
                            <span className="font-bold text-slate-600 w-4">#{idx + 1}</span>
                            <span className="flex-1 font-medium truncate">{bn.ingredientName}</span>
                            <span className="font-mono text-violet-700">{fmt(bn.maxPortions)} Portionen</span>
                            <span className="font-mono text-slate-500">(je {fmt(bn.grossPerPortion, 1)}g/P.)</span>
                            {bn.isLimiting && <span className="px-1.5 py-0.5 rounded bg-red-200 text-red-800 font-bold text-[10px]">LIMIT</span>}
                          </div>
                        ));
                      })()}
                    </div>
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

            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {([
                ["missing-meals", "Fehlende Meals", "Wie viel Rohware/Fertigware brauche ich für X fehlende Meals?"],
                ["finished-coverage", "Fertigware vorhanden", "Wie viele Meals deckt vorhandene Fertigware noch ab?"],
                ["raw-coverage", "Rohware vorhanden", "Wie viele Meals deckt vorhandene Rohware noch ab?"],
                ["underweight-unit", "Unter-Grammatur / Stückgewicht", "Wie weit komme ich mit Artikeln, die pro Stück zu leicht sind?"],
                ["rti-gap", "RTI / Sub-Lücke", "Welche Subrezepte fehlen noch um das Main-Meal fertigzustellen?"],
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
              {subRecipeScenario === "rti-gap" && (
                <>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Geplante Meals (Target)
                      {rtiLiveData && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold normal-case">Live</span>}
                    </label>
                    <input
                      type="number"
                      value={rtiPlannedMeals}
                      onChange={e => setRtiPlannedMeals(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                      min="0"
                      step="100"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                      Bereits produziert (Actuals)
                      {rtiLiveData && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold normal-case">Live</span>}
                    </label>
                    <input
                      type="number"
                      value={rtiActualMeals}
                      onChange={e => setRtiActualMeals(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                      min="0"
                      step="100"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-mono font-bold"
                    />
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

            {/* RTI-GAP ERGEBNIS */}
            {subRecipeScenario === "rti-gap" && rtiPlannedMeals > 0 && selectedSubRecipe && (() => {
              const gap = Math.max(0, rtiPlannedMeals - rtiActualMeals);
              if (gap === 0) return (
                <div className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                  Alle Meals produziert — kein Rückstand.
                </div>
              );

              // Pro Sub-Rezept: Bedarf für die fehlenden Meals und was bereits "on hold" liegt
              const subNeeds = allSubs.map(sub => {
                const requiredForGap = sub.subtreeGrossPerPortion * gap;
                const holding = rtiSubRecipeHoldings.get(sub.subRecipeId) ?? 0;
                const stillNeeded = Math.max(0, requiredForGap - holding);
                const coverableMeals = sub.subtreeGrossPerPortion > 0
                  ? Math.floor(holding / sub.subtreeGrossPerPortion)
                  : 0;
                const pctCovered = requiredForGap > 0 ? ((holding / requiredForGap) * 100) : 0;
                return { sub, requiredForGap, holding, stillNeeded, coverableMeals, pctCovered };
              }).filter(x => x.requiredForGap > 0);

              const totalRequired = subNeeds.reduce((s, x) => s + x.requiredForGap, 0);
              const totalHolding = subNeeds.reduce((s, x) => s + x.holding, 0);
              const totalStillNeeded = subNeeds.reduce((s, x) => s + x.stillNeeded, 0);

              return (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-5">
                    <SummaryTile label="Geplant" value={fmt(rtiPlannedMeals)} tone="sky" />
                    <SummaryTile label="Produziert" value={fmt(rtiActualMeals)} tone="emerald" />
                    <SummaryTile label="Delta (fehlt)" value={fmt(gap)} tone="red" />
                    <SummaryTile label="Rohware benötigt" value={fmtMass(totalRequired)} tone="indigo" />
                    <SummaryTile label="Noch zu produzieren" value={fmtMass(totalStillNeeded)} tone="amber" />
                  </div>

                  <div className="mt-3 text-xs font-bold uppercase text-slate-500 mb-1">
                    Vorhandene Fertigware je Sub-Rezept (optional eintragen)
                  </div>
                  <div className="mt-1 max-h-60 overflow-auto rounded-lg ring-1 ring-slate-200 bg-white">
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Sub-Rezept</th>
                          <th className="px-3 py-2 text-right">Bedarf (g)</th>
                          <th className="px-3 py-2 text-center">Vorhanden (g)</th>
                          <th className="px-3 py-2 text-right">Fehlt noch (g)</th>
                          <th className="px-3 py-2 text-right">Meals gedeckt</th>
                          <th className="px-3 py-2 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {subNeeds.map(({ sub, requiredForGap, holding, stillNeeded, coverableMeals, pctCovered }) => (
                          <tr key={sub.subRecipeId} className={pctCovered >= 100 ? "bg-emerald-50" : stillNeeded > 0 ? "bg-red-50/30" : ""}>
                            <td className="px-3 py-2 font-medium">{sub.name}</td>
                            <td className="px-3 py-2 text-right font-mono">{fmtMass(requiredForGap)}</td>
                            <td className="px-3 py-2 text-center">
                              <input
                                type="number"
                                value={holding || ""}
                                onChange={e => {
                                  const val = Math.max(0, parseNumInput(e.target.value));
                                  setRtiSubRecipeHoldings(prev => {
                                    const next = new Map(prev);
                                    next.set(sub.subRecipeId, val);
                                    return next;
                                  });
                                }}
                                min="0"
                                step="100"
                                placeholder="0"
                                className="w-20 rounded border border-slate-300 px-1 py-0.5 text-xs font-mono text-right"
                              />
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-bold text-red-700">{fmtMass(stillNeeded)}</td>
                            <td className="px-3 py-2 text-right font-mono">{fmt(coverableMeals)} / {fmt(gap)}</td>
                            <td className="px-3 py-2 text-center">
                              {pctCovered >= 100
                                ? <span className="px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-800 font-bold">OK</span>
                                : pctCovered > 0
                                  ? <span className="px-1.5 py-0.5 rounded bg-amber-200 text-amber-800 font-bold">{fmt(pctCovered, 0)}%</span>
                                  : <span className="px-1.5 py-0.5 rounded bg-red-200 text-red-800 font-bold">FEHLT</span>
                              }
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totalHolding > 0 && (
                    <div className="mt-3 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200">
                      <strong>Zusammenfassung:</strong> Für die fehlenden {fmt(gap)} Meals werden {fmtMass(totalRequired)} Rohware benötigt.
                      {totalHolding > 0 && ` Davon sind bereits ${fmtMass(totalHolding)} als Fertigware vorhanden.`}
                      {totalStillNeeded > 0 && ` Es fehlen noch ${fmtMass(totalStillNeeded)}.`}
                    </div>
                  )}
                </>
              );
            })()}

            {subRecipeScenario === "missing-meals" && selectedSubRecipeNeeds.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-slate-200">
                <div className="bg-slate-100 px-3 py-2 flex flex-wrap items-center gap-3">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
                    Rohwarenbedarf für die fehlenden Meals
                  </span>
                  <label className="flex items-center gap-1.5 cursor-pointer ml-auto">
                    <input
                      type="checkbox"
                      checked={yieldCapEnabled}
                      onChange={e => setYieldCapEnabled(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-[11px] text-slate-600 font-medium">Yield max. 100%</span>
                  </label>
                  <div className="flex items-center gap-1 text-[11px] text-slate-500">
                    <span className="font-semibold">Sortierung:</span>
                    {(["gross", "loss", "losspct"] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setNeedsSortBy(s)}
                        className={`px-2 py-0.5 rounded ${needsSortBy === s ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}
                      >
                        {s === "gross" ? "Rohware" : s === "loss" ? "Verlust abs." : "Verlust %"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="max-h-80 overflow-auto bg-white">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Zutat</th>
                        <th className="px-3 py-2 text-right">Brutto/Meal</th>
                        <th className="px-3 py-2 text-right">Rohware</th>
                        <th className="px-3 py-2 text-right">Fertigware</th>
                        <th className="px-3 py-2 text-right">Verlust / Gewinn</th>
                        <th className="px-3 py-2 text-right">%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedSubRecipeNeeds.map(row => {
                        const yieldInfo = ingredientYieldInfo.get(row.key);
                        const isGain = row.lossTotal < 0;
                        const lossColor = isGain ? "text-emerald-600" : "text-rose-700";
                        const lossPctColor = isGain ? "text-emerald-600" : Math.abs(row.lossPercent) > 15 ? "text-rose-700 font-bold" : "text-slate-600";
                        return (
                          <tr key={row.key}>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-slate-800">{row.ingredientName}</span>
                                {yieldInfo?.yieldMissing && (
                                  <span title="Kein Yield in Daten – Fallback 100% verwendet" className="text-amber-500 text-xs">⚠</span>
                                )}
                                {!yieldInfo?.yieldMissing && yieldInfo?.yieldSource === "computed" && (
                                  <span title="Yield berechnet aus netQty/grossQty" className="text-slate-400 text-[10px]">~</span>
                                )}
                                {yieldInfo?.yieldSource === "override" && (
                                  <span title="Manueller Yield-Override aktiv" className="text-violet-500 text-xs">✎</span>
                                )}
                                {isGain && !yieldCapEnabled && (
                                  <span title={`Yield ${((yieldInfo?.effectiveYield ?? 1) * 100).toFixed(1)}% > 100% – Massengewinn`} className="text-emerald-600 text-[10px] font-bold">↑</span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-slate-400">{row.ingredientId}</div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{fmt(row.grossPerPortion, 2)} {row.uom}</td>
                            <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">{fmt(row.grossTotal, 2)} {row.uom}</td>
                            <td className="px-3 py-2 text-right font-mono text-emerald-700">{fmt(row.netTotal, 2)} {row.uom}</td>
                            <td className={`px-3 py-2 text-right font-mono ${lossColor}`}>
                              {isGain ? "+" : ""}{fmt(isGain ? -row.lossTotal : row.lossTotal, 2)} {row.uom}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono text-xs ${lossPctColor}`}>
                              {isGain ? "+" : ""}{fmt(isGain ? -row.lossPercent : row.lossPercent, 1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* GEWICHTSKONTROLLE */}
          <details className="card border-2 border-teal-200 bg-teal-50/30">
            <summary className="p-4 cursor-pointer flex items-center gap-3">
              <span className="text-teal-700 font-bold">⚖ Gewichtskontrolle (Produktion)</span>
              <span className="text-xs text-slate-500">Live-Check: Ist-Gewicht vs. Soll während der Produktion</span>
            </summary>
            <div className="px-4 pb-4 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Soll-Gewicht / Meal (g)</label>
                  <input
                    type="number"
                    value={weightControlTarget}
                    onChange={e => setWeightControlTarget(Math.max(0, parseNumInput(e.target.value)))}
                    min="0"
                    step="1"
                    className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Ist-Gewicht (letzte Probe, g)</label>
                  <input
                    type="number"
                    value={weightControlActual}
                    onChange={e => setWeightControlActual(Math.max(0, parseNumInput(e.target.value)))}
                    min="0"
                    step="0.1"
                    className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Bisher produziert (Meals)</label>
                  <input
                    type="number"
                    value={weightControlDone}
                    onChange={e => setWeightControlDone(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                    min="0"
                    step="1"
                    className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Ziel-Meals gesamt</label>
                  <input
                    type="number"
                    value={weightControlTotal}
                    onChange={e => setWeightControlTotal(Math.max(0, Math.floor(parseNumInput(e.target.value))))}
                    min="0"
                    step="10"
                    className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              {weightControlTarget > 0 && weightControlActual > 0 && weightControlTotal > 0 && (() => {
                const deviation = weightControlActual - weightControlTarget;
                const deviationPct = (deviation / weightControlTarget) * 100;
                const remaining = Math.max(0, weightControlTotal - weightControlDone);
                const projectedUsage = (weightControlDone * weightControlActual) + (remaining * weightControlActual);
                const plannedUsage = weightControlTotal * weightControlTarget;
                const overUnder = projectedUsage - plannedUsage;
                const tone = Math.abs(deviationPct) < 2 ? "emerald" : Math.abs(deviationPct) < 5 ? "amber" : "red";
                return (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <SummaryTile label="Abweichung" value={`${deviation >= 0 ? "+" : ""}${fmt(deviation, 1)} g`} tone={tone} />
                    <SummaryTile label="Abweichung %" value={`${deviationPct >= 0 ? "+" : ""}${fmt(deviationPct, 2)}%`} tone={tone} />
                    <SummaryTile label="Restl. Meals" value={fmt(remaining)} tone="sky" />
                    <SummaryTile label="Progn. Gesamt-Verbrauch" value={fmtMass(projectedUsage)} tone="indigo" />
                    <SummaryTile
                      label={overUnder >= 0 ? "Mehr-Verbrauch" : "Einsparung"}
                      value={fmtMass(Math.abs(overUnder))}
                      tone={overUnder >= 0 ? "red" : "emerald"}
                    />
                  </div>
                );
              })()}
            </div>
          </details>

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
