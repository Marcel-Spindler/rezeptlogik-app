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

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

type Direction = "forward" | "reverse";

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
  avgYield?: number;
  ingredients: FlatIngredient[];
  childSubRecipes: SubRecipeAggregate[];
  instructions?: string;
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
  const totalNet = ingredients.reduce((s, x) => s + x.netQty, 0);
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

  const weekMeals = useMemo(() => {
    return data.weekRecipes
      .filter(r => r.hfWeek === week)
      .filter(isProducedInVerden)
      .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
      .sort((a, b) => getBaseVolume(b) - getBaseVolume(a));
  }, [data.weekRecipes, week]);

  const [selectedCode, setSelectedCode] = useState<string | null>(
    weekMeals[0]?.code ?? null
  );
  useEffect(() => {
    if (weekMeals.length > 0 && !weekMeals.find(m => m.code === selectedCode)) {
      setSelectedCode(weekMeals[0].code);
    }
  }, [weekMeals, selectedCode]);

  const selectedMeal: WeekRecipe | undefined = weekMeals.find(m => m.code === selectedCode);
  const selectedRecipe: Recipe | undefined = selectedCode ? data.recipes[selectedCode] : undefined;
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

  const [direction, setDirection] = useState<Direction>("forward");
  const basePortions = selectedMeal ? getBaseVolume(selectedMeal) : 0;
  const upliftedPortions = Math.round(basePortions * (1 + upliftPercent / 100));
  const [targetPortions, setTargetPortions] = useState<number>(upliftedPortions || 1000);
  useEffect(() => {
    setTargetPortions(upliftedPortions || 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upliftedPortions, selectedCode]);

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

  const overrideCount = overrides.size;

  if (!selectedMeal || !selectedRecipe) {
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
          {weekMeals.map(m => (
            <option key={m.code} value={m.code}>
              {m.code} · {m.recipeName} · ({fmt(getBaseVolume(m))} Portionen)
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
  tone: "indigo" | "emerald" | "red" | "amber" | "violet" | "slate";
}): JSX.Element {
  const tones: Record<string, string> = {
    indigo: "bg-indigo-100 text-indigo-900 ring-indigo-300",
    emerald: "bg-emerald-100 text-emerald-900 ring-emerald-300",
    red: "bg-red-100 text-red-900 ring-red-300",
    amber: "bg-amber-100 text-amber-900 ring-amber-300",
    violet: "bg-violet-100 text-violet-900 ring-violet-300",
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
  onOverride
}: {
  agg: SubRecipeAggregate;
  targetPortions: number;
  showForward: boolean;
  onOverride: (ingredientId: string, subRecipeId: string, value: number | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [showInstructions, setShowInstructions] = useState(false);

  const depthColors = ["border-l-indigo-500", "border-l-violet-500", "border-l-fuchsia-500", "border-l-rose-500"];
  const borderColor = depthColors[Math.min(agg.depth, depthColors.length - 1)];

  const totalGrossForRun = agg.totalGrossPerPortion * targetPortions;
  const yieldDisplay = agg.avgYield !== undefined ? `Ø ${(agg.avgYield * 100).toFixed(2)}%` : "—";
  const totalNetForRun = agg.avgYield !== undefined ? totalGrossForRun * agg.avgYield : 0;

  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 ${borderColor} bg-white`}>
      <button
        onClick={() => setOpen(o => !o)}
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
              <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Brutto/Portion</div>
              <div className="text-xs font-mono">{fmt(agg.totalGrossPerPortion, 1)} g</div>
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

          {showForward && agg.totalGrossPerPortion > 0 && targetPortions > 0 && (
            <div className="bg-indigo-50/50 rounded-lg p-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Σ Brutto · {fmt(targetPortions)} P.</div>
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
    <div className={`rounded-lg px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs ${
      ing.hasOverride ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"
    }`}>
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
