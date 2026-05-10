import { useEffect, useMemo, useState } from "react";
import { loadData } from "./dataSource";
import { loadPlanningTruthDataset, type PlanningTruthDataset } from "./planningTruthData";

export type PlanningRole = "factory" | "hybrid" | "supplied";

interface DumpSheet {
  title?: string;
  values?: string[][];
}

interface DumpFile {
  sheets?: DumpSheet[];
}

export interface PlanningSheetWorkOrder {
  sourceTab: string;
  priority: number;
  dateNeeded: string;
  hotKitchenDay: string;
  subRecipeName: string;
  cookMethods: string[];
  targetPortions: number;
  status: string;
  allergens: string[];
  comments: string;
}

export interface PlanningSheetPlatingRow {
  sourceTab: string;
  platingDay: string;
  totalAmount: number;
  nordics: number;
  bnl: number;
  germany: number;
}

export interface PlanningRecipeIntel {
  recipeCode: string;
  recipeDigitKey: string;
  recipeName: string;
  planningRole: PlanningRole;
  aliases: string[];
  weeks: string[];
  workOrders: PlanningSheetWorkOrder[];
  platingRows: PlanningSheetPlatingRow[];
  uniqueSubRecipes: string[];
  methods: string[];
  allergens: string[];
  statuses: Array<{ status: string; count: number }>;
  totalTargetPortions: number;
  forecastTotal: number;
  forecastByMarket: { bnl: number; nordics: number; germany: number };
  forecastSlotCount: number;
  pdlBoxCount: number;
  pdlPortions: number;
  pdlProductionDates: string[];
  pdlLanes: Array<{ name: string; count: number }>;
  gaps: {
    targetVsForecast: number;
    platingVsForecast: number;
    pdlVsForecast: number;
  };
}

export interface PlanningWeekIntel {
  week: string;
  hasTruthData: boolean;
  recipes: string[];
  workOrderCount: number;
  totalTargetPortions: number;
  platingTotal: number;
  forecastTotal: number;
  forecastByMarket: { bnl: number; nordics: number; germany: number };
  pdlBoxCount: number;
  pdlPortions: number;
  truthRecipeCount: number;
  matchedRecipeCount: number;
  factoryRecipeCount: number;
  hybridRecipeCount: number;
  suppliedRecipeCount: number;
  factoryPdlBoxCount: number;
  hybridPdlBoxCount: number;
  suppliedPdlBoxCount: number;
  factoryPdlPortions: number;
  hybridPdlPortions: number;
  suppliedPdlPortions: number;
  methods: Array<{ name: string; count: number }>;
  dueDays: Array<{ day: string; count: number }>;
}

export interface PlanningOasisDataset {
  recipes: Record<string, PlanningRecipeIntel>;
  weeks: Record<string, PlanningWeekIntel>;
}

let planningOasisPromise: Promise<PlanningOasisDataset> | null = null;

function normalizeCell(value: unknown): string {
  return String(value ?? "").trim();
}

function parseNum(value: unknown): number {
  const raw = normalizeCell(value).replace(/\./g, "").replace(/,/g, ".");
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : 0;
}

function extractWeek(title: string): string | null {
  const match = title.match(/(20\d{2})-W(\d{1,2})/i);
  if (!match) return null;
  return `${match[1]}-W${match[2].padStart(2, "0")}`;
}

function extractRecipeCode(raw: string): string | null {
  const strict = raw.match(/\b((?:FE|FV)\d{4}[A-Z0-9]?)\b/i);
  if (strict) return strict[1].toUpperCase();
  const fallback = raw.match(/\b(F\d{5}[A-Z0-9]?)\b/i);
  return fallback ? fallback[1].toUpperCase() : null;
}

function recipeDigitKey(raw: string): string {
  const match = normalizeCell(raw).toUpperCase().match(/(?:FE|FV)?(\d{4})[A-Z0-9]?/);
  return match?.[1] ?? normalizeCell(raw).toUpperCase();
}

function splitMethods(raw: string): string[] {
  return raw
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function tallyStrings(values: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));
}

function isProducedInVerden(recipeCode: string, totals: { BENL?: number; DKSE?: number; DE?: number }): boolean {
  const code = normalizeCell(recipeCode).toUpperCase();
  if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
  return (totals.BENL ?? 0) + (totals.DKSE ?? 0) + (totals.DE ?? 0) > 0;
}

function inferPlanningRole(intel: {
  recipeDigitKey: string;
  recipeCode: string;
  aliases: string[];
  workOrders: PlanningSheetWorkOrder[];
  platingRows: PlanningSheetPlatingRow[];
  pdlPortions: number;
}, producedDigits: Set<string>): PlanningRole {
  const hasOperationalSignal = intel.workOrders.length > 0 || intel.platingRows.length > 0;
  const hasMasterSignal = producedDigits.has(intel.recipeDigitKey)
    || [intel.recipeCode, ...intel.aliases].some((code) => /^(FE|FV)\d{4}/i.test(code));
  const hasPdlSignal = intel.pdlPortions > 0;
  if (hasMasterSignal && hasPdlSignal && !hasOperationalSignal) return "hybrid";
  if (hasOperationalSignal || hasMasterSignal) return "factory";
  return "supplied";
}

function loadPlanningOasisDataset(): Promise<PlanningOasisDataset> {
  if (!planningOasisPromise) {
    planningOasisPromise = Promise.all([
      fetch(`/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json?ts=${Date.now()}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error("GSheet-Dump für Planning OASE nicht gefunden.");
          const dump = await res.json() as DumpFile | DumpSheet[];
          return Array.isArray(dump) ? dump : dump.sheets ?? [];
        }),
      loadPlanningTruthDataset(),
      loadData(),
    ]).then(([sheets, truth, appData]) => buildDataset(sheets, truth, appData));
  }
  return planningOasisPromise;
}

function buildDataset(sheets: DumpSheet[], truth: PlanningTruthDataset, appData: Awaited<ReturnType<typeof loadData>>): PlanningOasisDataset {
  const recipes = new Map<string, PlanningRecipeIntel>();
  const aliases = new Map<string, PlanningRecipeIntel>();
  const weekRecipeSet = new Map<string, Set<string>>();
  const weekMethods = new Map<string, string[]>();
  const weekDueDays = new Map<string, string[]>();
  const weekTargets = new Map<string, number>();
  const weekPlating = new Map<string, number>();
  const weekWorkOrders = new Map<string, number>();
  const producedDigits = new Set(
    (appData.weekRecipes ?? [])
      .filter((recipe) => isProducedInVerden(recipe.code, recipe.verdenVolume))
      .map((recipe) => recipeDigitKey(recipe.code))
      .filter(Boolean)
  );

  const ensureRecipe = (recipeCode: string, recipeName: string, week: string | null): PlanningRecipeIntel => {
    const normalizedCode = normalizeCell(recipeCode).toUpperCase();
    const digitKey = recipeDigitKey(normalizedCode);
    const existing = aliases.get(normalizedCode) ?? recipes.get(digitKey);
    if (existing) {
      if (normalizedCode && !existing.aliases.includes(normalizedCode)) existing.aliases.push(normalizedCode);
      if (!existing.recipeName && recipeName) existing.recipeName = recipeName;
      if (!existing.recipeCode.startsWith("FV") && normalizedCode.startsWith("FV")) existing.recipeCode = normalizedCode;
      if (week && !existing.weeks.includes(week)) existing.weeks.push(week);
      aliases.set(normalizedCode, existing);
      return existing;
    }

    const truthRecipe = truth.recipesByDigit[digitKey];
    const next: PlanningRecipeIntel = {
      recipeCode: truthRecipe?.recipeCode || normalizedCode,
      recipeDigitKey: digitKey,
      recipeName: recipeName || truthRecipe?.recipeName || normalizedCode,
      planningRole: producedDigits.has(digitKey) ? "factory" : "hybrid",
      aliases: truthRecipe?.aliases ? [...truthRecipe.aliases] : (normalizedCode ? [normalizedCode] : []),
      weeks: week ? [week] : [],
      workOrders: [],
      platingRows: [],
      uniqueSubRecipes: [],
      methods: [],
      allergens: [],
      statuses: [],
      totalTargetPortions: 0,
      forecastTotal: truthRecipe?.forecastTotal ?? 0,
      forecastByMarket: truthRecipe?.forecastByMarket ?? { bnl: 0, nordics: 0, germany: 0 },
      forecastSlotCount: truthRecipe?.forecastSlots.length ?? 0,
      pdlBoxCount: truthRecipe?.pdlBoxCount ?? 0,
      pdlPortions: truthRecipe?.pdlPortions ?? 0,
      pdlProductionDates: truthRecipe?.pdlProductionDates ?? [],
      pdlLanes: truthRecipe?.pdlLanes ?? [],
      gaps: {
        targetVsForecast: 0,
        platingVsForecast: 0,
        pdlVsForecast: 0,
      },
    };
    if (normalizedCode && !next.aliases.includes(normalizedCode)) next.aliases.push(normalizedCode);
    recipes.set(digitKey, next);
    for (const alias of next.aliases) aliases.set(alias, next);
    return next;
  };

  for (const sheet of sheets) {
    const title = normalizeCell(sheet.title);
    const rows = Array.isArray(sheet.values) ? sheet.values : [];
    const week = extractWeek(title);

    if ((/^KET-/i.test(title) || /^Verden-/i.test(title)) && rows.length >= 3) {
      for (const row of rows.slice(2)) {
        const recipeName = normalizeCell(row[10]);
        const recipeCode = extractRecipeCode(recipeName);
        if (!recipeCode) continue;
        const intel = ensureRecipe(recipeCode, recipeName, week);
        const workOrder: PlanningSheetWorkOrder = {
          sourceTab: title,
          priority: parseNum(row[1]),
          dateNeeded: normalizeCell(row[7]),
          hotKitchenDay: normalizeCell(row[6]),
          subRecipeName: normalizeCell(row[11]),
          cookMethods: splitMethods(normalizeCell(row[13])),
          targetPortions: parseNum(row[15]),
          status: normalizeCell(row[19]) || normalizeCell(row[17]) || "Unbekannt",
          allergens: normalizeCell(row[24]).split(",").map((item) => item.trim()).filter(Boolean),
          comments: normalizeCell(row[23]),
        };
        intel.workOrders.push(workOrder);
        intel.totalTargetPortions += workOrder.targetPortions;
        if (workOrder.subRecipeName && !intel.uniqueSubRecipes.includes(workOrder.subRecipeName)) {
          intel.uniqueSubRecipes.push(workOrder.subRecipeName);
        }
        pushUnique(intel.methods, workOrder.cookMethods);
        pushUnique(intel.allergens, workOrder.allergens);

        if (week) {
          if (!weekRecipeSet.has(week)) weekRecipeSet.set(week, new Set());
          weekRecipeSet.get(week)?.add(intel.recipeCode);
          weekTargets.set(week, (weekTargets.get(week) ?? 0) + workOrder.targetPortions);
          weekWorkOrders.set(week, (weekWorkOrders.get(week) ?? 0) + 1);
          if (!weekMethods.has(week)) weekMethods.set(week, []);
          weekMethods.get(week)?.push(...workOrder.cookMethods);
          if (workOrder.hotKitchenDay) {
            if (!weekDueDays.has(week)) weekDueDays.set(week, []);
            weekDueDays.get(week)?.push(workOrder.hotKitchenDay);
          }
        }
      }
    }

    if (/^LinePlating\s+W\d+/i.test(title) && rows.length >= 3) {
      const lineWeek = week ?? extractWeek(`2026-${title.replace(/^LinePlating\s+/i, "")}`);
      for (const row of rows.slice(2)) {
        const recipeName = normalizeCell(row[1]);
        const recipeCode = extractRecipeCode(recipeName);
        if (!recipeCode) continue;
        const intel = ensureRecipe(recipeCode, recipeName, lineWeek);
        const platingRow: PlanningSheetPlatingRow = {
          sourceTab: title,
          platingDay: normalizeCell(row[0]),
          totalAmount: parseNum(row[3]),
          nordics: parseNum(row[4]),
          bnl: normalizeCell(row[5]).toUpperCase() === "X" ? 0 : parseNum(row[5]),
          germany: parseNum(row[6]),
        };
        intel.platingRows.push(platingRow);
        if (lineWeek) {
          if (!weekRecipeSet.has(lineWeek)) weekRecipeSet.set(lineWeek, new Set());
          weekRecipeSet.get(lineWeek)?.add(intel.recipeCode);
          weekPlating.set(lineWeek, (weekPlating.get(lineWeek) ?? 0) + platingRow.totalAmount);
        }
      }
    }
  }

  for (const [digitKey, truthRecipe] of Object.entries(truth.recipesByDigit)) {
    if (recipes.has(digitKey)) continue;
    const next: PlanningRecipeIntel = {
      recipeCode: truthRecipe.recipeCode,
      recipeDigitKey: digitKey,
      recipeName: truthRecipe.recipeName || truthRecipe.recipeCode,
      planningRole: producedDigits.has(digitKey) ? "hybrid" : "supplied",
      aliases: [...truthRecipe.aliases],
      weeks: [],
      workOrders: [],
      platingRows: [],
      uniqueSubRecipes: [],
      methods: [],
      allergens: [],
      statuses: [],
      totalTargetPortions: 0,
      forecastTotal: truthRecipe.forecastTotal,
      forecastByMarket: truthRecipe.forecastByMarket,
      forecastSlotCount: truthRecipe.forecastSlots.length,
      pdlBoxCount: truthRecipe.pdlBoxCount,
      pdlPortions: truthRecipe.pdlPortions,
      pdlProductionDates: truthRecipe.pdlProductionDates,
      pdlLanes: truthRecipe.pdlLanes,
      gaps: {
        targetVsForecast: -truthRecipe.forecastTotal,
        platingVsForecast: -truthRecipe.forecastTotal,
        pdlVsForecast: truthRecipe.pdlPortions - truthRecipe.forecastTotal,
      },
    };
    recipes.set(digitKey, next);
    for (const alias of next.aliases) aliases.set(alias, next);
  }

  for (const intel of recipes.values()) {
    intel.planningRole = inferPlanningRole(intel, producedDigits);
    intel.statuses = tallyStrings(intel.workOrders.map((item) => item.status)).map((item) => ({ status: item.name, count: item.count }));
    intel.weeks.sort();
    intel.aliases.sort((a, b) => a.localeCompare(b, "de"));
    intel.uniqueSubRecipes.sort((a, b) => a.localeCompare(b, "de"));
    intel.methods.sort((a, b) => a.localeCompare(b, "de"));
    intel.allergens.sort((a, b) => a.localeCompare(b, "de"));
    const platingTotal = intel.platingRows.reduce((sum, row) => sum + row.totalAmount, 0);
    intel.gaps = {
      targetVsForecast: intel.totalTargetPortions - intel.forecastTotal,
      platingVsForecast: platingTotal - intel.forecastTotal,
      pdlVsForecast: intel.pdlPortions - intel.forecastTotal,
    };
  }

  const weeks: Record<string, PlanningWeekIntel> = {};
  const allWeeks = new Set<string>([...weekRecipeSet.keys(), ...Object.keys(truth.weeks)]);
  for (const week of [...allWeeks].sort()) {
    const recipeSet = weekRecipeSet.get(week) ?? new Set<string>();
    const truthWeek = truth.weeks[week];
    const weekRecipeCodes = new Set<string>([...recipeSet, ...(truthWeek?.recipes ?? [])]);
    const matchedRecipeCount = truthWeek
      ? Array.from(recipeSet).filter((code) => truthWeek.recipes.some((truthCode) => recipeDigitKey(truthCode) === recipeDigitKey(code))).length
      : 0;
    const weekRecipeIntels = Array.from(weekRecipeCodes)
      .map((recipeCode) => recipes.get(recipeDigitKey(recipeCode)))
      .filter((intel): intel is PlanningRecipeIntel => Boolean(intel));
    const factoryWeekRecipes = weekRecipeIntels.filter((intel) => intel.planningRole === "factory");
    const hybridWeekRecipes = weekRecipeIntels.filter((intel) => intel.planningRole === "hybrid");
    const suppliedWeekRecipes = weekRecipeIntels.filter((intel) => intel.planningRole === "supplied");
    weeks[week] = {
      week,
      hasTruthData: Boolean(truthWeek),
      recipes: Array.from(recipeSet).sort((a, b) => a.localeCompare(b, "de")),
      workOrderCount: weekWorkOrders.get(week) ?? 0,
      totalTargetPortions: weekTargets.get(week) ?? 0,
      platingTotal: weekPlating.get(week) ?? 0,
      forecastTotal: truthWeek?.forecastTotal ?? 0,
      forecastByMarket: truthWeek?.forecastByMarket ?? { bnl: 0, nordics: 0, germany: 0 },
      pdlBoxCount: truthWeek?.pdlBoxCount ?? 0,
      pdlPortions: truthWeek?.pdlPortions ?? 0,
      truthRecipeCount: truthWeek?.recipes.length ?? 0,
      matchedRecipeCount,
      factoryRecipeCount: factoryWeekRecipes.length,
      hybridRecipeCount: hybridWeekRecipes.length,
      suppliedRecipeCount: suppliedWeekRecipes.length,
      factoryPdlBoxCount: truthWeek ? factoryWeekRecipes.reduce((sum, intel) => sum + intel.pdlBoxCount, 0) : 0,
      hybridPdlBoxCount: truthWeek ? hybridWeekRecipes.reduce((sum, intel) => sum + intel.pdlBoxCount, 0) : 0,
      suppliedPdlBoxCount: truthWeek ? suppliedWeekRecipes.reduce((sum, intel) => sum + intel.pdlBoxCount, 0) : 0,
      factoryPdlPortions: truthWeek ? factoryWeekRecipes.reduce((sum, intel) => sum + intel.pdlPortions, 0) : 0,
      hybridPdlPortions: truthWeek ? hybridWeekRecipes.reduce((sum, intel) => sum + intel.pdlPortions, 0) : 0,
      suppliedPdlPortions: truthWeek ? suppliedWeekRecipes.reduce((sum, intel) => sum + intel.pdlPortions, 0) : 0,
      methods: tallyStrings(weekMethods.get(week) ?? []).slice(0, 8),
      dueDays: tallyStrings(weekDueDays.get(week) ?? []).slice(0, 8).map((item) => ({ day: item.name, count: item.count })),
    };
  }

  const recipeIndex = Object.fromEntries(
    Array.from(recipes.values())
      .flatMap((intel) => {
        const keys = new Set<string>([intel.recipeCode, intel.recipeDigitKey, ...intel.aliases]);
        return Array.from(keys).filter(Boolean).map((key) => [key, intel] as const);
      })
      .sort(([left], [right]) => left.localeCompare(right, "de"))
  );

  return {
    recipes: recipeIndex,
    weeks,
  };
}

export function usePlanningOasisData(): {
  data: PlanningOasisDataset | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<PlanningOasisDataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPlanningOasisDataset()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    data,
    loading: !data && !error,
    error,
  };
}

export function useRecipePlanningIntel(recipeCode: string | null | undefined): PlanningRecipeIntel | null {
  const { data } = usePlanningOasisData();
  return useMemo(() => {
    if (!data || !recipeCode) return null;
    return data.recipes[recipeCode] ?? data.recipes[recipeDigitKey(recipeCode)] ?? null;
  }, [data, recipeCode]);
}
