import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SHIFT_MIN, getSubRecipeMassProfile, tokenToStation } from "./equipment";
import { getActiveScenario, getWeekState, loadPlannerStorage } from "./planner";
import type { DataBundle, DetailedSubRecipe, GrossIngredient, Market, Recipe, RecipeStructure, Station, SubRecipe, WeekRecipe, ProcessSpec, CookSchedule, ShelfLifeInfo } from "./types";
import { STATIONS } from "./types";
import type { UiLocale } from "./i18n";

interface EtTrackerRow {
  recipeCode: string | null;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  cookMethods: string;
  targetPortions: number;
}

interface BibleHint {
  subRecipeKey: string;
  subRecipeName: string;
  equipment: string;
  capacityKg: number;
  sourceSheet: string;
}

interface SupervisorHint {
  subRecipeKey: string;
  subRecipeName: string;
  equipment: string | null;
  capacityKg: number | null;
  minutesPerBatch: number | null;
  sourceSheet: string;
}

interface CalcRow {
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  baseTargetPortions: number;
  targetPortions: number;
  splitPercent: number;
  demandKg: number;
  demandRawKg: number;
  eachCount: number;
  yieldRatio?: number;
  capacityKg: number | null;
  batches: number | null;
  equipment: string;
  station: string;
  activeMin: number | null;
  requiredDevices: number | null;
  tubCount: number;
  avgKgPerTub: number;
  tubType: string;
  basis: "supervisor" | "bible" | "process-spec" | "unknown";
}

interface IngredientCalcRow {
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  ingredientId: string;
  ingredientName: string;
  ingredientCategory: string;
  uom: string;
  perPortion: number;
  qtyWithLoss: number;
  qtyNoLoss: number;
  effectiveYield: number;
  yieldSource: "override" | "detail" | "fallback";
  selectedQty: number;
  selectedMode: "with-loss" | "no-loss";
  tubs: number | null;
  kgEq: number | null;
  nominalTubKg: number;
}

interface IngredientTubDeltaRow {
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  tubsWithLoss: number;
  tubsNoLoss: number;
  tubsDelta: number;
  items: number;
}

interface EquipmentAgg {
  equipment: string;
  totalKg: number;
  activeMin: number;
  requiredDevices: number;
  totalTubs: number;
  rows: number;
}

interface BuildRowsOptions {
  totalScale: number;
  recipeSplitPctByCode: Record<string, number>;
  subSplitPctByKey: Record<string, number>;
  plannedOnly: boolean;
  plannedRecipeCodes: Set<string>;
  plannedSubKeys: Set<string>;
  tubBasis: "finished-kg" | "raw-kg" | "ea";
  rawFactorPct: number;
  eaPerPortion: number;
  eaPerTub: number;
}

type TubProfile = {
  type: string;
  nominalKg: number;
};

type YieldMode = "with-loss" | "no-loss";

const WHATIF_YIELD_OVERRIDE_PREFIX = "rezeptlogik_v1_yield_override_";

function fmtNum(value: number, digits = 0) {
  return value.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function norm(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseFloatSafe(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number | null | undefined, fallback = 100): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(200, value));
}

function clampPositive(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function uomToKgEquivalent(quantity: number, uom: string): number | null {
  const token = norm(uom);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (token === "g" || token === "gram" || token === "grams") return quantity / 1000;
  if (token === "kg" || token === "kilogram" || token === "kilograms") return quantity;
  if (token === "ml") return quantity / 1000;
  if (token === "l" || token === "liter" || token === "litre") return quantity;
  return null;
}

function isEachUom(uom: string): boolean {
  const token = norm(uom);
  return token === "ea" || token === "each" || token === "pcs" || token === "pc" || token === "piece" || token === "pieces";
}

function subRecipeIngredientRows(recipe: Recipe, sub: SubRecipe): Array<{
  ingredientId: string;
  ingredientName: string;
  ingredientCategory: string;
  uom: string;
  perPortion: number;
}> {
  const key = norm(sub.name);
  const map = new Map<string, {
    ingredientId: string;
    ingredientName: string;
    ingredientCategory: string;
    uom: string;
    perPortion: number;
  }>();

  for (const list of Object.values(recipe.grossIngredients)) {
    if (!list) continue;
    for (const item of list) {
      const matches = [item.subRecipe1, item.subRecipe2, item.subRecipe3]
        .some((name) => norm(name) === key);
      if (!matches) continue;
      const rowKey = `${item.ingredientId || item.ingredient}|${item.uom}`;
      const existing = map.get(rowKey) ?? {
        ingredientId: item.ingredientId || "-",
        ingredientName: item.ingredient || "-",
        ingredientCategory: item.ingredientCategory || "-",
        uom: item.uom || "-",
        perPortion: 0,
      };
      existing.perPortion += item.grossQuantityPerPortion || 0;
      map.set(rowKey, existing);
    }
  }

  return [...map.values()].sort((a, b) => b.perPortion - a.perPortion);
}

function readWhatIfYieldOverrides(): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof window === "undefined") return out;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(WHATIF_YIELD_OVERRIDE_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      const value = parseFloatSafe(raw);
      if (!value || value <= 0 || value > 1) continue;
      const suffix = key.substring(WHATIF_YIELD_OVERRIDE_PREFIX.length);
      out.set(suffix, value);
    }
  } catch {
    return out;
  }
  return out;
}

function collectStructureYield(node: DetailedSubRecipe, target: Map<string, number>): void {
  for (const ingredient of node.ingredients) {
    if (!ingredient.id) continue;
    const value = ingredient.yieldPct;
    if (value == null || !Number.isFinite(value) || value <= 0 || value > 1) continue;
    target.set(`${node.id}__${ingredient.id}`, value);
  }
  for (const child of node.subRecipes) collectStructureYield(child, target);
}

function recipeYieldLookup(structure: RecipeStructure | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!structure) return map;
  for (const roots of Object.values(structure.markets)) {
    if (!roots) continue;
    for (const root of roots) collectStructureYield(root, map);
  }
  return map;
}

function ingredientRowTubsByMode(
  row: IngredientCalcRow,
  mode: YieldMode,
  tubBasis: "finished-kg" | "raw-kg" | "ea",
  eaPerTub: number
): number | null {
  const qty = mode === "with-loss" ? row.qtyWithLoss : row.qtyNoLoss;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const eaPerTubSafe = clampPositive(eaPerTub, 1);
  if (tubBasis === "ea" || isEachUom(row.uom)) {
    return Math.ceil(qty / eaPerTubSafe);
  }
  const kgEq = uomToKgEquivalent(qty, row.uom);
  if (kgEq == null || kgEq <= 0) return null;
  return Math.ceil(kgEq / Math.max(0.1, row.nominalTubKg));
}

function inferTubProfile(equipmentRaw: string, capacityKg: number | null): TubProfile {
  if (capacityKg && capacityKg > 0) {
    if (capacityKg <= 8) return { type: "Kleinwanne", nominalKg: capacityKg };
    if (capacityKg <= 15) return { type: "Mittelwanne", nominalKg: capacityKg };
    if (capacityKg <= 30) return { type: "Grosswanne", nominalKg: capacityKg };
    return { type: "Bulk-Wanne", nominalKg: capacityKg };
  }

  const equipment = norm(equipmentRaw);
  if (equipment.includes("braiser")) return { type: "Grosswanne", nominalKg: 25 };
  if (equipment.includes("middle") || equipment.includes("kitchen")) return { type: "Mittelwanne", nominalKg: 12 };
  if (equipment.includes("mixer")) return { type: "Mittelwanne", nominalKg: 10 };
  if (equipment.includes("marinade") || equipment.includes("brine")) return { type: "Kleinwanne", nominalKg: 8 };
  return { type: "Standardwanne", nominalKg: 10 };
}

function tokenize(value: string): string[] {
  return norm(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function extractRecipeCode(recipeName: string, recipeId: string): string | null {
  const source = `${recipeName} ${recipeId}`;
  const match = source.match(/(F[EV]\d{4}[A-Z])/i);
  return match ? match[1].toUpperCase() : null;
}

function toCells(rowValues: unknown): string[] {
  if (!Array.isArray(rowValues)) return [];
  return rowValues.map((cell) => String(cell ?? "").trim());
}

function detectHeaderRow(rows: string[][], expected: RegExp[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonEmpty = row.filter((cell) => cell.length > 0).length;
    if (nonEmpty < 3) continue;
    const text = row.join(" | ").toLowerCase();
    const hitScore = expected.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
    const score = hitScore * 10 + nonEmpty;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function findHeaderIndex(headers: string[], candidates: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    if (candidates.some((regex) => regex.test(header))) return i;
  }
  return -1;
}

async function parseEtTracker(file: File): Promise<EtTrackerRow[]> {
  const exceljs = await import("exceljs");
  const workbook = new exceljs.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const sheet = workbook.worksheets.find((candidate) => /et\s*tracker/i.test(candidate.name));
  if (!sheet) throw new Error("Kein ET-Tracker-Sheet gefunden.");

  const sampleRows: string[][] = [];
  for (let i = 1; i <= Math.min(80, sheet.rowCount); i++) {
    sampleRows.push(toCells(sheet.getRow(i).values));
  }

  const headerIndex = detectHeaderRow(sampleRows, [/recipe id/i, /recipe name/i, /sub\s*recipe/i, /target\s*portions/i]);
  if (headerIndex < 0) throw new Error("Header im ET-Tracker konnte nicht erkannt werden.");

  const headers = sampleRows[headerIndex];
  const recipeIdIdx = findHeaderIndex(headers, [/recipe\s*id/i]);
  const recipeNameIdx = findHeaderIndex(headers, [/recipe\s*name/i]);
  const subRecipeIdx = findHeaderIndex(headers, [/sub\s*recipe\s*name/i, /^sub\s*recipe/i]);
  const targetIdx = findHeaderIndex(headers, [/target\s*portions/i]);
  const methodsIdx = findHeaderIndex(headers, [/cook\s*methods?/i]);

  if (recipeNameIdx < 0 || subRecipeIdx < 0 || targetIdx < 0) {
    throw new Error("Pflichtspalten im ET-Tracker fehlen (Recipe Name, Sub Recipe Name, Target Portions).");
  }

  const rows: EtTrackerRow[] = [];
  for (let i = headerIndex + 2; i <= sheet.rowCount; i++) {
    const cells = toCells(sheet.getRow(i).values);
    const recipeName = cells[recipeNameIdx] ?? "";
    const subRecipeName = cells[subRecipeIdx] ?? "";
    const target = parseFloatSafe(cells[targetIdx]);
    if (!recipeName || !subRecipeName || !target || target <= 0) continue;

    const recipeId = recipeIdIdx >= 0 ? cells[recipeIdIdx] ?? "" : "";
    rows.push({
      recipeCode: extractRecipeCode(recipeName, recipeId),
      recipeId,
      recipeName,
      subRecipeName,
      cookMethods: methodsIdx >= 0 ? cells[methodsIdx] ?? "" : "",
      targetPortions: target,
    });
  }

  return rows;
}

async function parseBreakdownSupervisor(file: File): Promise<Map<string, SupervisorHint>> {
  const exceljs = await import("exceljs");
  const workbook = new exceljs.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const sheet = workbook.worksheets.find((candidate) => /breakdown\s*_?\s*supervisor/i.test(candidate.name));
  if (!sheet) return new Map();

  const sampleRows: string[][] = [];
  for (let i = 1; i <= Math.min(100, sheet.rowCount); i++) {
    sampleRows.push(toCells(sheet.getRow(i).values));
  }

  const headerIndex = detectHeaderRow(sampleRows, [/sub\s*recipe/i, /equip|machine/i, /cap|kg|batch/i]);
  if (headerIndex < 0) return new Map();

  const headers = sampleRows[headerIndex];
  const subRecipeIdx = findHeaderIndex(headers, [/sub\s*recipe/i, /sku\s*sub/i, /component/i]);
  const equipmentIdx = findHeaderIndex(headers, [/equip|machine|tool/i]);
  const capacityIdx = findHeaderIndex(headers, [/max.*kg/i, /capacit/i, /batch\s*size/i, /kg/i]);
  const minutesIdx = findHeaderIndex(headers, [/min|minute|time|duration|cycle/i]);

  if (subRecipeIdx < 0) return new Map();

  const hints = new Map<string, SupervisorHint>();
  for (let i = headerIndex + 2; i <= sheet.rowCount; i++) {
    const cells = toCells(sheet.getRow(i).values);
    const subRecipeName = cells[subRecipeIdx] ?? "";
    if (!subRecipeName) continue;

    const key = norm(subRecipeName);
    if (!key) continue;

    const equipment = equipmentIdx >= 0 ? (cells[equipmentIdx] || null) : null;
    const capacityKg = capacityIdx >= 0 ? parseFloatSafe(cells[capacityIdx]) : null;
    const minutesPerBatch = minutesIdx >= 0 ? parseFloatSafe(cells[minutesIdx]) : null;

    const nextHint: SupervisorHint = {
      subRecipeKey: key,
      subRecipeName,
      equipment,
      capacityKg,
      minutesPerBatch,
      sourceSheet: sheet.name,
    };

    const existing = hints.get(key);
    const nextQuality = (nextHint.equipment ? 1 : 0) + (nextHint.capacityKg ? 1 : 0) + (nextHint.minutesPerBatch ? 1 : 0);
    const existingQuality = existing
      ? (existing.equipment ? 1 : 0) + (existing.capacityKg ? 1 : 0) + (existing.minutesPerBatch ? 1 : 0)
      : -1;
    if (!existing || nextQuality >= existingQuality) {
      hints.set(key, nextHint);
    }
  }

  return hints;
}

async function parseBibles(file: File): Promise<Map<string, BibleHint>> {
  const exceljs = await import("exceljs");
  const workbook = new exceljs.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const hints = new Map<string, BibleHint>();

  for (const sheet of workbook.worksheets) {
    if (!/(braiser|middle\s*-?\s*kitchen)/i.test(sheet.name)) continue;

    const sampleRows: string[][] = [];
    for (let i = 1; i <= Math.min(60, sheet.rowCount); i++) {
      sampleRows.push(toCells(sheet.getRow(i).values));
    }

    const headerIndex = detectHeaderRow(sampleRows, [/sub\s*recipe|sku/i, /max|capacity/i, /kg/i]);
    if (headerIndex < 0) continue;

    const headers = sampleRows[headerIndex];
    const subRecipeIdx = findHeaderIndex(headers, [/sub\s*recipe/i, /sku\s*sub/i]);
    const capacityIdx = findHeaderIndex(headers, [/max.*kg/i, /capacity.*kg/i, /raw.*kg/i]);
    const machineIdx = findHeaderIndex(headers, [/machin|equipment/i]);

    if (subRecipeIdx < 0 || capacityIdx < 0) continue;

    let lastEquipment = /middle\s*-?\s*kitchen/i.test(sheet.name) ? "Middle Kitchen" : "Braiser";

    for (let i = headerIndex + 2; i <= sheet.rowCount; i++) {
      const cells = toCells(sheet.getRow(i).values);
      const subRecipeName = cells[subRecipeIdx] ?? "";
      const capacity = parseFloatSafe(cells[capacityIdx]);
      const machine = machineIdx >= 0 ? cells[machineIdx] ?? "" : "";
      if (machine) lastEquipment = machine;
      if (!subRecipeName || !capacity || capacity <= 0) continue;

      const key = norm(subRecipeName);
      if (!key) continue;

      const existing = hints.get(key);
      const nextHint: BibleHint = {
        subRecipeKey: key,
        subRecipeName,
        equipment: lastEquipment,
        capacityKg: capacity,
        sourceSheet: sheet.name,
      };

      if (!existing || nextHint.capacityKg < existing.capacityKg) {
        hints.set(key, nextHint);
      }
    }
  }

  return hints;
}

function uniqueSubRecipes(recipe: Recipe): SubRecipe[] {
  const byId = new Map<string, SubRecipe>();
  for (const market of Object.values(recipe.markets)) {
    if (!market) continue;
    for (const sub of market.subRecipes) {
      if (!byId.has(sub.id)) byId.set(sub.id, sub);
    }
  }
  return [...byId.values()];
}

function resolveSubRecipe(recipe: Recipe, rawName: string): SubRecipe | null {
  const needle = norm(rawName);
  if (!needle) return null;
  const list = uniqueSubRecipes(recipe);

  const exact = list.find((sub) => norm(sub.name) === needle);
  if (exact) return exact;

  let best: { score: number; sub: SubRecipe } | null = null;
  for (const sub of list) {
    const candidate = norm(sub.name);
    if (!candidate) continue;
    const lenScore = candidate.includes(needle) || needle.includes(candidate)
      ? Math.min(candidate.length, needle.length) / Math.max(candidate.length, needle.length)
      : 0;
    const tokenScore = overlapScore(candidate, needle);
    const score = Math.max(lenScore, tokenScore * 0.95);
    if (!best || score > best.score) best = { score, sub };
  }
  return best && best.score >= 0.35 ? best.sub : null;
}

function resolveBibleHint(map: Map<string, BibleHint>, subRecipeName: string): BibleHint | null {
  const key = norm(subRecipeName);
  if (!key) return null;
  const direct = map.get(key);
  if (direct) return direct;

  for (const hint of map.values()) {
    if (hint.subRecipeKey.includes(key) || key.includes(hint.subRecipeKey)) return hint;
  }
  return null;
}

function resolveSupervisorHint(map: Map<string, SupervisorHint>, subRecipeName: string): SupervisorHint | null {
  const key = norm(subRecipeName);
  if (!key) return null;
  const direct = map.get(key);
  if (direct) return direct;

  let best: { score: number; hint: SupervisorHint } | null = null;
  for (const hint of map.values()) {
    const score = overlapScore(hint.subRecipeKey, key);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { score, hint };
  }
  return best && best.score >= 0.4 ? best.hint : null;
}

function stationFromCookMethods(cookMethods: string): Station | null {
  const tokens = cookMethods
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const station = tokenToStation(token);
    if (station) return station;
  }
  return null;
}

function buildRows(
  data: DataBundle,
  week: string,
  upliftPercent: number,
  etRows: EtTrackerRow[],
  bibleHints: Map<string, BibleHint>,
  supervisorHints: Map<string, SupervisorHint>,
  options: BuildRowsOptions
): CalcRow[] {
  const weekRecipes = new Map<string, WeekRecipe>();
  for (const row of data.weekRecipes) {
    if (row.hfWeek !== week) continue;
    const code = row.code.toUpperCase();
    if (!weekRecipes.has(code)) weekRecipes.set(code, row);
  }

  const portionFactor = 1 + upliftPercent / 100;
  const rawFactor = clampPositive(options.rawFactorPct, 100) / 100;
  const eaPerPortion = clampPositive(options.eaPerPortion, 1);
  const eaPerTub = clampPositive(options.eaPerTub, 1);
  const rows: CalcRow[] = [];

  for (const et of etRows) {
    if (!et.recipeCode) continue;
    const weekRecipe = weekRecipes.get(et.recipeCode);
    const recipe = data.recipes[et.recipeCode];
    if (!weekRecipe || !recipe) continue;

    const sub = resolveSubRecipe(recipe, et.subRecipeName);
    if (!sub) continue;

    const mass = getSubRecipeMassProfile(sub, recipe);
    if (mass.planningGramsPerPortion <= 0) continue;

    const baseTargetPortions = et.targetPortions * portionFactor;
    const recipeSplitPct = clampPercent(options.recipeSplitPctByCode[weekRecipe.code], 100);
    const subKey = `${weekRecipe.code}::${sub.id}`;
    const subSplitPct = clampPercent(options.subSplitPctByKey[subKey], 100);
    let plannedFactor = 1;
    if (options.plannedOnly) {
      const isSubPlanned = options.plannedSubKeys.has(subKey);
      const isRecipePlanned = options.plannedRecipeCodes.has(weekRecipe.code);
      plannedFactor = isSubPlanned || isRecipePlanned ? 1 : 0;
    }
    const splitPercent = (recipeSplitPct * subSplitPct) / 100;
    const totalFactor = options.totalScale * (splitPercent / 100) * plannedFactor;
    const targetPortions = baseTargetPortions * totalFactor;
    if (targetPortions <= 0) continue;
    const demandKg = (targetPortions * mass.planningGramsPerPortion) / 1000;
    const demandRawKg = demandKg * rawFactor;
    const eachCount = targetPortions * eaPerPortion;

    const spec = data.processSpecs?.[sub.id];
    const supervisorHint = resolveSupervisorHint(supervisorHints, sub.name);
    const bibleHint = resolveBibleHint(bibleHints, sub.name);
    const station = stationFromCookMethods(et.cookMethods) ?? (spec?.primaryStation && STATIONS.includes(spec.primaryStation as Station)
      ? (spec.primaryStation as Station)
      : null);

    const capacityKg = supervisorHint?.capacityKg ?? bibleHint?.capacityKg ?? spec?.batchSizeKg ?? null;
    let batches: number | null = null;
    if (options.tubBasis === "ea") {
      batches = Math.ceil(eachCount / eaPerTub);
    } else {
      const kgDemand = options.tubBasis === "raw-kg" ? demandRawKg : demandKg;
      batches = capacityKg && capacityKg > 0 ? Math.ceil(kgDemand / capacityKg) : null;
    }

    let activeMin: number | null = null;
    if (batches && batches > 0) {
      const minutesPerBatch = supervisorHint?.minutesPerBatch ?? (
        spec
          ? (station
            ? (spec.minutesPerBatch[station] ?? 0)
            : STATIONS.reduce((sum, entry) => sum + (spec.minutesPerBatch[entry] ?? 0), 0))
          : 0
      );
      if (minutesPerBatch > 0) activeMin = minutesPerBatch * batches;
    }

    const requiredDevices = activeMin != null && activeMin > 0
      ? Math.max(1, Math.ceil(activeMin / DEFAULT_SHIFT_MIN))
      : null;

    const equipmentName = supervisorHint?.equipment ?? bibleHint?.equipment ?? station ?? spec?.primaryStation ?? "Unbekannt";
    const tubProfile = inferTubProfile(equipmentName, capacityKg);
    const fallbackTubs = options.tubBasis === "ea"
      ? Math.max(1, Math.ceil(eachCount / eaPerTub))
      : Math.max(1, Math.ceil((options.tubBasis === "raw-kg" ? demandRawKg : demandKg) / tubProfile.nominalKg));
    const tubCount = batches ?? fallbackTubs;
    const avgKgPerTub = tubCount > 0
      ? (options.tubBasis === "raw-kg" ? demandRawKg : demandKg) / tubCount
      : 0;

    rows.push({
      recipeCode: weekRecipe.code,
      recipeName: weekRecipe.recipeName,
      subRecipeId: sub.id,
      subRecipeName: sub.name,
      baseTargetPortions,
      targetPortions,
      splitPercent,
      demandKg,
      demandRawKg,
      eachCount,
      yieldRatio: mass.yieldRatio,
      capacityKg,
      batches,
      equipment: equipmentName,
      station: station ?? spec?.primaryStation ?? "-",
      activeMin,
      requiredDevices,
      tubCount,
      avgKgPerTub,
      tubType: tubProfile.type,
      basis: supervisorHint ? "supervisor" : bibleHint ? "bible" : spec?.batchSizeKg ? "process-spec" : "unknown",
    });
  }

  return rows.sort((a, b) => (b.activeMin ?? 0) - (a.activeMin ?? 0));
}

// ═══════════════════════════════════════════════════════════════════════════
// WANNEN-RECHNER – Rezeptstil mit Meal/Sub/SubSub und kg + Wannen
// ═══════════════════════════════════════════════════════════════════════════

const WANNEN: { label: string; kg: number }[] = [
  { label: "2 kg", kg: 2 },
  { label: "5 kg", kg: 5 },
  { label: "10 kg", kg: 10 },
  { label: "15 kg", kg: 15 },
  { label: "25 kg", kg: 25 },
  { label: "40 kg", kg: 40 },
];

const MARKET_PRIO_NEW: Market[] = ["DE", "BENL", "DKSE"];
const BREAKDOWN_OVERRIDE_STORAGE_KEY = "rezeptlogik_v1_breakdown_item_overrides";

interface WR_RecipeEntry {
  code: string;
  name: string;
  portions: number;
  mode: "fertig" | "roh";
}

interface WR_IngRow {
  ingredientId: string;
  name: string;
  category: string;
  uom: string;
  overrideKey: string;
  totalQty: number;
  totalKg: number | null;
  pieceKgHint: number | null;
  inferredPcsPerTray: number | null;
}

interface WR_PathAgg {
  sub1: string;
  sub2: string;
  sub3: string;
  rows: WR_IngRow[];
  totalKg: number;
  capacityKgHint: number | null;
  equipmentHint: string | null;
}

interface WR_MealAgg {
  code: string;
  name: string;
  mode: "fertig" | "roh";
  portionsInput: number;
  portionsEffective: number;
  paths: WR_PathAgg[];
  totalKg: number;
}

interface WRCapacityHint {
  subRecipeKey: string;
  subRecipeName: string;
  capacityKg: number;
  equipment: string | null;
}

interface WRTrayHint {
  key: string;
  pcsPerTray: number;
}

interface WROverride {
  qty?: number;
  kg?: number;
  pcsPerTray?: number;
}

function wrToKg(qty: number, uom: string): number | null {
  const u = uom.toLowerCase().trim();
  if (u === "g" || u === "grams" || u === "gram") return qty / 1000;
  if (u === "kg") return qty;
  if (u === "ml") return qty / 1000;
  if (u === "l" || u === "liter" || u === "litre") return qty;
  return null;
}

function wrCatBadge(cat: string): string {
  const c = (cat || "").toUpperCase();
  if (c === "PRO") return "bg-amber-100 text-amber-800";
  if (c === "SPI") return "bg-red-100 text-red-800";
  if (c === "PHF") return "bg-sky-100 text-sky-800";
  if (c === "DRY") return "bg-lime-100 text-lime-800";
  return "bg-slate-100 text-slate-500";
}

function wrTubCellCls(count: number): string {
  if (count <= 0) return "text-slate-300";
  if (count <= 4) return "bg-emerald-50 text-emerald-700 font-semibold ring-1 ring-emerald-200 rounded-lg";
  if (count <= 9) return "bg-amber-50 text-amber-700 rounded-lg";
  return "bg-slate-100 text-slate-400 rounded-lg";
}

function wrFmtKg(kg: number): string {
  return kg.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " kg";
}

function wrFmtQty(qty: number, uom: string): string {
  return Number(qty.toFixed(1)).toLocaleString("de-DE") + " " + uom;
}

function wrSafeFilePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function wrTsvSafe(value: unknown): string {
  return String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

function wrNumExport(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return "";
  return Number(value.toFixed(digits)).toString();
}

function wrParseNumberLoose(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const m = text.replace(/\./g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function wrParseKgLoose(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = wrParseNumberLoose(text);
  if (n == null || n <= 0) return null;
  const token = text.toLowerCase();
  if (token.includes(" g") || token.includes("gram")) return n / 1000;
  return n;
}

function wrParsePcs(value: unknown): number | null {
  const text = String(value ?? "").trim().toLowerCase();
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*pcs/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function wrFindHeader(rows: string[][], patterns: RegExp[]): number {
  return detectHeaderRow(rows, patterns);
}

function wrCol(headers: string[], patterns: RegExp[]): number {
  return findHeaderIndex(headers, patterns);
}

function wrSheetRows(sheet: { values?: unknown[] }): string[][] {
  if (!Array.isArray(sheet.values)) return [];
  return sheet.values.map((r) => toCells(r));
}

function wrBuildHintsFromDumps(master: unknown, bibles: unknown): {
  capacityHints: Map<string, WRCapacityHint>;
  pieceWeightKg: Map<string, number>;
  trayHints: WRTrayHint[];
} {
  const capacityHints = new Map<string, WRCapacityHint>();
  const pieceWeightKg = new Map<string, number>();
  const trayHints: WRTrayHint[] = [];

  const upsertCapacity = (name: string, capacityKg: number | null, equipment: string | null) => {
    const key = norm(name);
    if (!key || !capacityKg || capacityKg <= 0) return;
    const next: WRCapacityHint = {
      subRecipeKey: key,
      subRecipeName: name,
      capacityKg,
      equipment,
    };
    const existing = capacityHints.get(key);
    if (!existing || next.capacityKg < existing.capacityKg) {
      capacityHints.set(key, next);
    }
  };

  const masterSheets = Array.isArray((master as { sheets?: unknown[] })?.sheets)
    ? ((master as { sheets: Array<{ title?: string; values?: unknown[] }> }).sheets)
    : [];

  for (const sheet of masterSheets) {
    const title = String(sheet.title ?? "");
    const rows = wrSheetRows(sheet);
    if (/bd_master|breakdown_sup|bd_supervisors/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 40), [/sub\s*recipe/i, /bible\s*ref/i, /kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const subIdx = wrCol(headers, [/sub\s*recipe/i]);
        const subSubIdx = wrCol(headers, [/sub\s*-?sub\s*recipe/i]);
        const totalIdx = wrCol(headers, [/total\s*size.*kg/i]);
        const refIdx = wrCol(headers, [/bible\s*ref/i]);
        const breakdownIdx = wrCol(headers, [/batch\s*breakdown.*kg/i]);
        const areaIdx = wrCol(headers, [/area\s*associated/i, /^area/i]);
        if (subIdx >= 0 || subSubIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            const sub = (subIdx >= 0 ? row[subIdx] : "") || (subSubIdx >= 0 ? row[subSubIdx] : "");
            const subKey = norm(sub);
            if (!subKey) continue;
            const refKg = refIdx >= 0 ? wrParseKgLoose(row[refIdx]) : null;
            const totalKg = totalIdx >= 0 ? wrParseKgLoose(row[totalIdx]) : null;
            const breakdownKg = breakdownIdx >= 0 ? wrParseKgLoose(row[breakdownIdx]) : null;
            const capacityKg = refKg ?? breakdownKg ?? totalKg;
            const equipment = areaIdx >= 0 ? (row[areaIdx] || null) : null;
            upsertCapacity(sub, capacityKg, equipment);
          }
        }
      }
    }

    if (/^bible$/i.test(title.trim())) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/sku/i, /gewicht|weight/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku/i]);
        const wIdx = wrCol(headers, [/gewicht|weight/i]);
        if (skuIdx >= 0 && wIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            const skuRaw = row[skuIdx] ?? "";
            const skuKey = norm(skuRaw);
            if (!skuKey) continue;
            const grams = wrParseNumberLoose(row[wIdx]);
            if (!grams || grams <= 0) continue;
            const kg = grams / 1000;
            pieceWeightKg.set(skuKey, kg);
            const shortLabel = norm(String(skuRaw).split("/")[0]);
            if (shortLabel && !pieceWeightKg.has(shortLabel)) pieceWeightKg.set(shortLabel, kg);
          }
        }
      }
    }

    if (/middle-kitchen/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku\s*subrecipes/i]);
        const capIdx = wrCol(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "MIDDLE-KITCHEN");
          }
        }
      }
    }

    if (/braiser/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/subrecipe\s*sku/i]);
        const capIdx = wrCol(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "BRAISER");
          }
        }
      }
    }
  }

  const bibleSheets = Array.isArray((bibles as { sheets?: unknown[] })?.sheets)
    ? ((bibles as { sheets: Array<{ title?: string; values?: unknown[] }> }).sheets)
    : [];

  for (const sheet of bibleSheets) {
    const title = String(sheet.title ?? "");
    const rows = wrSheetRows(sheet);
    if (/protein-debox/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/protein\s*type/i, /cut/i, /est\.?\s*pieces/i, /tray\s*spec/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const proteinIdx = wrCol(headers, [/protein\s*type/i]);
        const cutIdx = wrCol(headers, [/^cut/i]);
        const trayIdx = wrCol(headers, [/tray\s*spec/i]);
        const piecesIdx = wrCol(headers, [/est\.?\s*pieces/i]);
        const weightIdx = wrCol(headers, [/weight.*kg/i]);
        for (let i = headerIdx + 1; i < rows.length; i += 1) {
          const row = rows[i];
          const cut = cutIdx >= 0 ? String(row[cutIdx] ?? "").trim() : "";
          const protein = proteinIdx >= 0 ? String(row[proteinIdx] ?? "").trim() : "";
          const label = cut || protein;
          if (!label) continue;

          const pieces = piecesIdx >= 0 ? wrParseNumberLoose(row[piecesIdx]) : null;
          const pcsFromTray = trayIdx >= 0 ? wrParsePcs(row[trayIdx]) : null;
          const trayPcs = pcsFromTray ?? pieces;
          if (trayPcs && trayPcs > 0) {
            trayHints.push({ key: norm(label), pcsPerTray: trayPcs });
            if (protein && cut) trayHints.push({ key: norm(`${protein} ${cut}`), pcsPerTray: trayPcs });
          }

          const rowWeight = weightIdx >= 0 ? wrParseKgLoose(row[weightIdx]) : null;
          if (rowWeight && pieces && pieces > 0) {
            pieceWeightKg.set(norm(label), rowWeight / pieces);
          }
        }
      }
      continue;
    }

    if (/veggie-debox/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/item_/i, /capacity\s*wanne/i, /kg\s*product.*gn/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const itemIdx = wrCol(headers, [/item_/i]);
        const capIdx = wrCol(headers, [/capacity\s*wanne/i]);
        const kgPerGnIdx = wrCol(headers, [/kg\s*product.*gn/i]);
        const trayCntIdx = wrCol(headers, [/max\.?\s*tray/i]);
        for (let i = headerIdx + 1; i < rows.length; i += 1) {
          const row = rows[i];
          const item = itemIdx >= 0 ? String(row[itemIdx] ?? "").trim() : "";
          if (!item) continue;
          upsertCapacity(item, capIdx >= 0 ? wrParseKgLoose(row[capIdx]) : null, "VEGGIE-DEBOX");
          const trayPcs = trayCntIdx >= 0 ? wrParseNumberLoose(row[trayCntIdx]) : null;
          if (trayPcs && trayPcs > 0) trayHints.push({ key: norm(item), pcsPerTray: trayPcs });
          const kgPerGn = kgPerGnIdx >= 0 ? wrParseKgLoose(row[kgPerGnIdx]) : null;
          if (kgPerGn && kgPerGn > 0) pieceWeightKg.set(norm(item), kgPerGn);
        }
      }
      continue;
    }

    if (/braiser\s*bible/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/subrecipe\s*sku/i]);
        const capIdx = wrCol(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "BRAISER");
          }
        }
      }
      continue;
    }

    if (/middle-kitchen\s*bible/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku\s*subrecipes/i]);
        const capIdx = wrCol(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "MIDDLE-KITCHEN");
          }
        }
      }
    }
  }

  return { capacityHints, pieceWeightKg, trayHints };
}

function wrResolveCapacityHint(map: Map<string, WRCapacityHint>, sub1: string, sub2: string, sub3: string): WRCapacityHint | null {
  const keys = [norm(sub3), norm(sub2), norm(sub1)].filter(Boolean);
  for (const key of keys) {
    const direct = map.get(key);
    if (direct) return direct;
  }
  for (const key of keys) {
    for (const hint of map.values()) {
      if (hint.subRecipeKey.includes(key) || key.includes(hint.subRecipeKey)) return hint;
    }
  }
  return null;
}

function wrLookupPieceKg(pieceMap: Map<string, number>, ingredientName: string, ingredientId: string): number | null {
  const keys = [norm(ingredientName), norm(ingredientId), norm(String(ingredientName).split("/")[0])].filter(Boolean);
  for (const key of keys) {
    const direct = pieceMap.get(key);
    if (direct) return direct;
  }
  for (const key of keys) {
    for (const [k, v] of pieceMap) {
      if (k.includes(key) || key.includes(k)) return v;
    }
  }
  return null;
}

function wrLookupTrayPcs(trayHints: WRTrayHint[], ingredientName: string): number | null {
  const key = norm(ingredientName);
  if (!key) return null;
  let best: { score: number; pcs: number } | null = null;
  for (const hint of trayHints) {
    const score = overlapScore(hint.key, key);
    if (score < 0.45) continue;
    if (!best || score > best.score) best = { score, pcs: hint.pcsPerTray };
  }
  return best ? best.pcs : null;
}

export function BreakdownEquipmentView({
  data,
  week,
  upliftPercent,
  locale: _locale,
}: {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  locale: UiLocale;
}) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<WR_RecipeEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, WROverride>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(BREAKDOWN_OVERRIDE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, WROverride>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [capacityHints, setCapacityHints] = useState<Map<string, WRCapacityHint>>(new Map());
  const [pieceWeightKg, setPieceWeightKg] = useState<Map<string, number>>(new Map());
  const [trayHints, setTrayHints] = useState<WRTrayHint[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(BREAKDOWN_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // ignore quota/private mode issues
    }
  }, [overrides]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        const parsed = wrBuildHintsFromDumps(masterDump, biblesDump);
        setCapacityHints(parsed.capacityHints);
        setPieceWeightKg(parsed.pieceWeightKg);
        setTrayHints(parsed.trayHints);
      } catch {
        // optional hints only; calculator still works without these files
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const weekRecipes = useMemo(
    () => data.weekRecipes.filter((r) => r.hfWeek === week),
    [data.weekRecipes, week],
  );

  const selectedCodes = useMemo(() => new Set(entries.map((e) => e.code)), [entries]);

  const needle = search.trim().toLowerCase();
  const suggestions = useMemo(() => {
    const unselected = weekRecipes.filter((r) => !selectedCodes.has(r.code));
    if (!needle) return unselected.slice(0, 12);
    return unselected
      .filter(
        (r) =>
          r.recipeName.toLowerCase().includes(needle) ||
          r.code.toLowerCase().includes(needle) ||
          (r.preference || "").toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [needle, weekRecipes, selectedCodes]);

  function addRecipe(wr: WeekRecipe) {
    setEntries((prev) => [
      ...prev,
      {
        code: wr.code,
        name: wr.recipeName,
        portions: wr.totalVerdenVolume > 0 ? wr.totalVerdenVolume : 500,
        mode: "fertig",
      },
    ]);
    setSearch("");
  }

  function removeRecipe(code: string) {
    setEntries((prev) => prev.filter((e) => e.code !== code));
  }

  function patchEntry(code: string, patch: Partial<WR_RecipeEntry>) {
    setEntries((prev) => prev.map((e) => (e.code === code ? { ...e, ...patch } : e)));
  }

  function patchOverride(overrideKey: string, patch: Partial<WROverride>) {
    setOverrides((prev) => {
      const existing = prev[overrideKey] ?? {};
      const next = { ...existing, ...patch };

      const hasQty = typeof next.qty === "number" && Number.isFinite(next.qty) && next.qty >= 0;
      const hasKg = typeof next.kg === "number" && Number.isFinite(next.kg) && next.kg >= 0;
      const hasPcs = typeof next.pcsPerTray === "number" && Number.isFinite(next.pcsPerTray) && next.pcsPerTray > 0;

      if (!hasQty) delete next.qty;
      if (!hasKg) delete next.kg;
      if (!hasPcs) delete next.pcsPerTray;

      if (!next.qty && next.qty !== 0 && !next.kg && next.kg !== 0 && !next.pcsPerTray) {
        if (!prev[overrideKey]) return prev;
        const clone = { ...prev };
        delete clone[overrideKey];
        return clone;
      }

      return { ...prev, [overrideKey]: next };
    });
  }

  function downloadTextFile(fileName: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBinaryFile(fileName: string, content: ArrayBuffer, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function rowTrayCount(row: WR_IngRow): number | null {
    if (row.totalKg != null) return null;
    if (!isEachUom(row.uom) || !row.inferredPcsPerTray || row.inferredPcsPerTray <= 0) return null;
    if (row.totalQty <= 0) return null;
    return Math.ceil(row.totalQty / row.inferredPcsPerTray);
  }

  function rowTubCountByWanne(row: WR_IngRow, wanneKg: number): number | null {
    if (row.totalKg == null || row.totalKg <= 0) return null;
    return Math.ceil(row.totalKg / wanneKg);
  }

  function wrFindSubRecipeSpec(subRecipeName: string): { spec?: ProcessSpec; schedule?: CookSchedule } {
    if (!subRecipeName) return {};
    const normalized = norm(subRecipeName);
    for (const spec of Object.values(data.processSpecs ?? {})) {
      if (spec && norm(spec.name) === normalized) return { spec };
    }
    return {};
  }

  function wrFindShelfLife(ingredientName: string): ShelfLifeInfo | undefined {
    if (!ingredientName || !data.shelfLifeBySku) return undefined;
    const normalized = norm(ingredientName);
    for (const info of Object.values(data.shelfLifeBySku)) {
      if (info && (norm(info.skuName) === normalized || norm(info.skuCode) === normalized)) return info;
    }
    return undefined;
  }

  function wrShelfLifeStatus(info?: ShelfLifeInfo): string {
    if (!info) return "";
    const days = info.totalShelfLifeDays ?? 0;
    if (info.skuName && info.skuName.toLowerCase().includes("fisch")) return `Fisch: ${days} Tage`;
    return `${days} Tage`;
  }

  function mealExportRows(meal: WR_MealAgg): Array<Record<string, string | number>> {
    const rows: Array<Record<string, string | number>> = [];
    for (const path of meal.paths) {
      const { spec } = wrFindSubRecipeSpec(path.sub1);
      for (const row of path.rows) {
        const shelfLife = wrFindShelfLife(row.name);
        const out: Record<string, string | number> = {
          week,
          mealCode: meal.code,
          mealName: meal.name,
          mode: meal.mode,
          portionsInput: meal.portionsInput,
          portionsEffective: Number(meal.portionsEffective.toFixed(2)),
          mealTotalKg: Number(meal.totalKg.toFixed(3)),
          sub1: path.sub1,
          sub2: path.sub2,
          sub3: path.sub3,
          pathTotalKg: Number(path.totalKg.toFixed(3)),
          bibleCapacityKg: path.capacityKgHint ?? "",
          equipmentHint: path.equipmentHint ?? "",
          ingredientId: row.ingredientId,
          ingredientName: row.name,
          category: row.category,
          uom: row.uom,
          totalQty: Number(row.totalQty.toFixed(3)),
          totalKg: row.totalKg == null ? "" : Number(row.totalKg.toFixed(3)),
          pcsPerTray: row.inferredPcsPerTray ?? "",
          trayCount: rowTrayCount(row) ?? "",
          batchSizeKg: spec?.batchSizeKg ?? "",
          batchUom: spec?.batchUom ?? "",
          shelfLifeDays: shelfLife?.totalShelfLifeDays ?? "",
          shelfLifeStatus: wrShelfLifeStatus(shelfLife),
          overrideKey: row.overrideKey,
          overrideQty: overrides[row.overrideKey]?.qty ?? "",
          overrideKg: overrides[row.overrideKey]?.kg ?? "",
          overridePcsPerTray: overrides[row.overrideKey]?.pcsPerTray ?? "",
        };
        for (const w of WANNEN) {
          out[`wannen_${w.label}`] = rowTubCountByWanne(row, w.kg) ?? "";
        }
        rows.push(out);
      }
    }
    return rows;
  }

  async function importMealJson(file: File): Promise<void> {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);

      // Validierung
      if (payload.exportType !== "rezeptlogik-breakdown-meal") {
        throw new Error("Ungültiger Export-Typ");
      }
      if (!payload.meal?.code || !payload.overrides) {
        throw new Error("Ungültige Export-Struktur (Meal oder Overrides fehlen)");
      }

      const mealCode = payload.meal.code;
      const importedOverrides = payload.overrides as Record<string, WROverride>;

      // Woche prüfen (nur Warnung, kein Fehler)
      if (payload.week && payload.week !== week) {
        const msg = `⚠️ Export ist von Woche ${payload.week}, aktuell: ${week}. Trotzdem laden?`;
        if (!window.confirm(msg)) return;
      }

      // Overrides in State übernehmen (nur für das Meal)
      setOverrides((prev) => {
        const next = { ...prev };
        for (const [key, val] of Object.entries(importedOverrides)) {
          next[key] = val;
        }
        return next;
      });

      alert(`✅ ${mealCode} geladen: ${Object.keys(importedOverrides).length} Einstellungen wiederhergestellt`);
    } catch (err) {
      alert(`❌ Fehler beim Importieren: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleImportJsonClick(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        await importMealJson(file);
      }
    };
    input.click();
  }

  function mealExportPayload(meal: WR_MealAgg) {
    const mealOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key.startsWith(`${meal.code}::`)),
    );

    return {
      exportType: "rezeptlogik-breakdown-meal",
      exportedAt: new Date().toISOString(),
      week,
      upliftPercent,
      meal: {
        code: meal.code,
        name: meal.name,
        mode: meal.mode,
        portionsInput: meal.portionsInput,
        portionsEffective: meal.portionsEffective,
        totalKg: meal.totalKg,
      },
      settings: {
        wannen: WANNEN,
      },
      overrides: mealOverrides,
      rows: mealExportRows(meal),
      paths: meal.paths.map((path) => ({
        sub1: path.sub1,
        sub2: path.sub2,
        sub3: path.sub3,
        totalKg: path.totalKg,
        capacityKgHint: path.capacityKgHint,
        equipmentHint: path.equipmentHint,
        rows: path.rows.map((row) => ({
          ingredientId: row.ingredientId,
          name: row.name,
          category: row.category,
          uom: row.uom,
          overrideKey: row.overrideKey,
          totalQty: row.totalQty,
          totalKg: row.totalKg,
          pcsPerTray: row.inferredPcsPerTray,
          trayCount: rowTrayCount(row),
          tubsBySize: Object.fromEntries(
            WANNEN.map((w) => [
              w.label,
              rowTubCountByWanne(row, w.kg),
            ]),
          ),
        })),
      })),
    };
  }

  function exportMealJson(meal: WR_MealAgg): void {
    const payload = mealExportPayload(meal);
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.json`;
    downloadTextFile(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function exportAllMealsJson(): void {
    const payload = {
      exportType: "rezeptlogik-breakdown-all-meals",
      exportedAt: new Date().toISOString(),
      week,
      upliftPercent,
      meals: mealAggs.map((meal) => mealExportPayload(meal)),
    };
    const fileName = `breakdown-${week}-all-meals.json`;
    downloadTextFile(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function exportMealsTsv(meals: WR_MealAgg[], fileName: string): void {
    const tsvHeaders = [
      "Week",
      "Meal Code",
      "Meal Name",
      "Mode",
      "Portions Input",
      "Portions Effective",
      "Meal Total Kg",
      "Sub1",
      "Sub2",
      "Sub3",
      "Path Total Kg",
      "Bible Capacity Kg",
      "Equipment",
      "Ingredient ID",
      "Ingredient",
      "Category",
      "UOM",
      "Total Qty",
      "Total Kg",
      "PCS/Tray",
      "Tray Count",
      "Batch Size (Kg)",
      "Shelf Life (Days)",
      "Shelf Life Info",
      ...WANNEN.map((w) => `Wannen ${w.label}`),
      "Override Qty",
      "Override Kg",
      "Override PCS/Tray",
    ];

    const tsvRows: string[] = [];
    for (const meal of meals) {
      for (const row of mealExportRows(meal)) {
        const values = [
          wrTsvSafe(row.week),
          wrTsvSafe(row.mealCode),
          wrTsvSafe(row.mealName),
          wrTsvSafe(row.mode),
          wrTsvSafe(row.portionsInput),
          wrTsvSafe(row.portionsEffective),
          wrTsvSafe(row.mealTotalKg),
          wrTsvSafe(row.sub1),
          wrTsvSafe(row.sub2),
          wrTsvSafe(row.sub3),
          wrTsvSafe(row.pathTotalKg),
          wrTsvSafe(row.bibleCapacityKg),
          wrTsvSafe(row.equipmentHint),
          wrTsvSafe(row.ingredientId),
          wrTsvSafe(row.ingredientName),
          wrTsvSafe(row.category),
          wrTsvSafe(row.uom),
          wrTsvSafe(row.totalQty),
          wrTsvSafe(row.totalKg),
          wrTsvSafe(row.pcsPerTray),
          wrTsvSafe(row.trayCount),
          wrTsvSafe(row.batchSizeKg),
          wrTsvSafe(row.shelfLifeDays),
          wrTsvSafe(row.shelfLifeStatus),
          ...WANNEN.map((w) => wrTsvSafe(row[`wannen_${w.label}`])),
          wrTsvSafe(row.overrideQty),
          wrTsvSafe(row.overrideKg),
          wrTsvSafe(row.overridePcsPerTray),
        ];
        tsvRows.push(values.join("\t"));
      }
    }

    const tsv = [tsvHeaders.join("\t"), ...tsvRows].join("\n");
    downloadTextFile(fileName, "\uFEFF" + tsv, "text/tab-separated-values;charset=utf-8");
  }

  async function exportMealsExcel(meals: WR_MealAgg[], fileName: string): Promise<void> {
    const { Workbook } = await import("exceljs");
    const wb = new Workbook();
    wb.creator = "rezeptlogik-app";
    wb.created = new Date();
    const ws = wb.addWorksheet("Breakdown");

    const headers = [
      "Week",
      "Meal Code",
      "Meal Name",
      "Mode",
      "Portions Input",
      "Portions Effective",
      "Meal Total Kg",
      "Sub1",
      "Sub2",
      "Sub3",
      "Path Total Kg",
      "Bible Capacity Kg",
      "Equipment",
      "Ingredient ID",
      "Ingredient",
      "Category",
      "UOM",
      "Total Qty",
      "Total Kg",
      "PCS/Tray",
      "Tray Count",
      "Batch Size (Kg)",
      "Shelf Life (Days)",
      "Shelf Life Info",
      ...WANNEN.map((w) => `Wannen ${w.label}`),
      "Override Qty",
      "Override Kg",
      "Override PCS/Tray",
    ];

    ws.addRow(headers);

    for (const meal of meals) {
      for (const row of mealExportRows(meal)) {
        ws.addRow([
          row.week,
          row.mealCode,
          row.mealName,
          row.mode,
          row.portionsInput,
          row.portionsEffective,
          row.mealTotalKg,
          row.sub1,
          row.sub2,
          row.sub3,
          row.pathTotalKg,
          row.bibleCapacityKg,
          row.equipmentHint,
          row.ingredientId,
          row.ingredientName,
          row.category,
          row.uom,
          row.totalQty,
          row.totalKg,
          row.pcsPerTray,
          row.trayCount,
          row.batchSizeKg,
          row.shelfLifeDays,
          row.shelfLifeStatus,
          ...WANNEN.map((w) => row[`wannen_${w.label}`]),
          row.overrideQty,
          row.overrideKg,
          row.overridePcsPerTray,
        ]);
      }
    }

    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.columns.forEach((col, idx) => {
      if (idx === 1) col.width = 12;
      else if (idx === 2 || idx === 3) col.width = 18;
      else if (idx >= 8 && idx <= 15) col.width = 16;
      else col.width = 13;
    });

    const buffer = await wb.xlsx.writeBuffer();
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const out = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    downloadBinaryFile(fileName, out, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  function exportMealsPdf(meals: WR_MealAgg[], title: string): void {
    const sections = meals.map((meal) => {
      const rowsHtml = mealExportRows(meal)
        .map((row) => {
          const tubCells = WANNEN.map((w) => `<td>${wrTsvSafe(row[`wannen_${w.label}`])}</td>`).join("");
          const hasShelfLife = row.shelfLifeStatus && String(row.shelfLifeStatus).length > 0;
          const isFish = String(row.shelfLifeStatus || "").toLowerCase().includes("fisch");
          const bgStyle = isFish ? "background-color: #fef3c7;" : hasShelfLife ? "background-color: #fecaca;" : "";
          
          return `<tr style="${bgStyle}">
            <td>${wrTsvSafe(row.sub1)}</td>
            <td>${wrTsvSafe(row.sub2)}</td>
            <td>${wrTsvSafe(row.sub3)}</td>
            <td>${wrTsvSafe(row.ingredientId)}</td>
            <td>${wrTsvSafe(row.ingredientName)}</td>
            <td>${wrTsvSafe(row.uom)}</td>
            <td>${wrTsvSafe(row.totalQty)}</td>
            <td>${wrTsvSafe(row.totalKg)}</td>
            <td>${wrTsvSafe(row.pcsPerTray)}</td>
            <td>${wrTsvSafe(row.trayCount)}</td>
            <td>${wrTsvSafe(row.batchSizeKg)}</td>
            <td>${wrTsvSafe(row.shelfLifeStatus)}</td>
            ${tubCells}
          </tr>`;
        })
        .join("");

      return `
        <section>
          <h2>${wrTsvSafe(meal.code)} - ${wrTsvSafe(meal.name)}</h2>
          <p>Mode: ${wrTsvSafe(meal.mode)} | Portionen Input: ${wrNumExport(meal.portionsInput, 0)} | Effektiv: ${wrNumExport(meal.portionsEffective, 2)} | Total: ${wrNumExport(meal.totalKg, 3)} kg</p>
          <table>
            <thead>
              <tr>
                <th>Sub1</th><th>Sub2</th><th>Sub3</th><th>ID</th><th>Artikel</th><th>UOM</th><th>Qty</th><th>Kg</th><th>PCS/Tray</th><th>Tray</th><th>Batch (Kg)</th><th>Haltbarkeit</th>
                ${WANNEN.map((w) => `<th>${w.label}</th>`).join("")}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </section>
      `;
    }).join("");

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${wrTsvSafe(title)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; color: #0f172a; }
  h1 { margin: 0 0 4px 0; font-size: 18px; }
  h2 { margin: 18px 0 6px 0; font-size: 14px; }
  p { margin: 0 0 8px 0; font-size: 11px; color: #334155; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: bold; }
  tr[style*="background-color"] { font-weight: 500; }
  @media print { section { page-break-inside: avoid; } }
</style>
</head>
<body>
  <h1>${wrTsvSafe(title)}</h1>
  <p>Woche: ${wrTsvSafe(week)} | Export: ${new Date().toLocaleString("de-DE")}</p>
  <p style="font-size: 9px; color: #666;">
    Gelb = Fisch-Artikel (9 Tage MHD) | Rot = Weitere Haltbarkeits-Info (13 Tage MHD)
  </p>
  ${sections}
</body>
</html>`;

    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 120);
  }

  function exportMealSettings(meal: WR_MealAgg): void {
    exportMealJson(meal);
  }

  function exportMealGsheet(meal: WR_MealAgg): void {
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.tsv`;
    exportMealsTsv([meal], fileName);
  }

  async function exportMealExcel(meal: WR_MealAgg): Promise<void> {
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.xlsx`;
    await exportMealsExcel([meal], fileName);
  }

  function exportMealPdf(meal: WR_MealAgg): void {
    exportMealsPdf([meal], `Breakdown ${week} ${meal.code} ${meal.name}`);
  }

  function exportAllMealsSettings(): void {
    exportAllMealsJson();
  }

  function exportAllMealsGsheet(): void {
    const fileName = `breakdown-${week}-all-meals.tsv`;
    exportMealsTsv(mealAggs, fileName);
  }

  async function exportAllMealsExcel(): Promise<void> {
    const fileName = `breakdown-${week}-all-meals.xlsx`;
    await exportMealsExcel(mealAggs, fileName);
  }

  function exportAllMealsPdf(): void {
    exportMealsPdf(mealAggs, `Breakdown ${week} Alle Meals`);
  }

  const mealAggs = useMemo<WR_MealAgg[]>(() => {
    const result: WR_MealAgg[] = [];

    for (const entry of entries) {
      const recipe = data.recipes[entry.code];
      if (!recipe) continue;

      const portionsEffective =
        entry.mode === "fertig"
          ? entry.portions * (1 + upliftPercent / 100)
          : entry.portions;

      let grossList: GrossIngredient[] | undefined;
      for (const mkt of MARKET_PRIO_NEW) {
        const list = recipe.grossIngredients[mkt];
        if (list && list.length > 0) {
          grossList = list;
          break;
        }
      }
      if (!grossList) {
        result.push({
          code: entry.code,
          name: entry.name,
          mode: entry.mode,
          portionsInput: entry.portions,
          portionsEffective,
          paths: [],
          totalKg: 0,
        });
        continue;
      }

      const pathMap = new Map<string, Map<string, WR_IngRow>>();
      for (const item of grossList) {
        const sub1 = item.subRecipe1?.trim() || "Ohne Sub-Rezept";
        const sub2 = item.subRecipe2?.trim() || "—";
        const sub3 = item.subRecipe3?.trim() || "—";
        const pathKey = `${sub1}||${sub2}||${sub3}`;
        if (!pathMap.has(pathKey)) pathMap.set(pathKey, new Map());

        const ingMap = pathMap.get(pathKey)!;
        const ingKey = `${item.ingredientId || item.ingredient}||${item.uom}`;
        const overrideKey = `${entry.code}::${pathKey}::${ingKey}`;
        const addQ = (item.grossQuantityPerPortion || 0) * portionsEffective;
        const baseKg = wrToKg(addQ, item.uom);
        const pieceKg = baseKg == null && isEachUom(item.uom)
          ? wrLookupPieceKg(pieceWeightKg, item.ingredient || "", item.ingredientId || "")
          : null;
        const addK = baseKg ?? (pieceKg != null ? addQ * pieceKg : null);
        const prev = ingMap.get(ingKey);
        if (prev) {
          prev.totalQty += addQ;
          if (prev.totalKg !== null && addK !== null) prev.totalKg += addK;
          else if (addK === null) prev.totalKg = null;
        } else {
          ingMap.set(ingKey, {
            ingredientId: item.ingredientId || "-",
            name: item.ingredient || "-",
            category: item.ingredientCategory || "—",
            uom: item.uom,
            overrideKey,
            totalQty: addQ,
            totalKg: addK,
            pieceKgHint: pieceKg,
            inferredPcsPerTray: isEachUom(item.uom)
              ? wrLookupTrayPcs(trayHints, item.ingredient || "")
              : null,
          });
        }
      }

      const paths: WR_PathAgg[] = [];
      for (const [pathKey, ingMap] of pathMap) {
        const [sub1, sub2, sub3] = pathKey.split("||");
        const rows = Array.from(ingMap.values()).map((row) => {
          const ov = overrides[row.overrideKey];
          const qty = ov?.qty != null && ov.qty >= 0 ? ov.qty : row.totalQty;

          let kg = row.totalKg;
          if (ov?.qty != null && ov.qty >= 0) {
            const fromUom = wrToKg(qty, row.uom);
            if (fromUom != null) kg = fromUom;
            else if (row.pieceKgHint != null) kg = qty * row.pieceKgHint;
          }
          if (ov?.kg != null && ov.kg >= 0) kg = ov.kg;

          return {
            ...row,
            totalQty: qty,
            totalKg: kg,
            inferredPcsPerTray: ov?.pcsPerTray != null && ov.pcsPerTray > 0
              ? ov.pcsPerTray
              : row.inferredPcsPerTray,
          };
        }).sort(
          (a, b) => (b.totalKg ?? 0) - (a.totalKg ?? 0),
        );
        const totalKg = rows.reduce((sum, row) => sum + (row.totalKg ?? 0), 0);
        const hint = wrResolveCapacityHint(capacityHints, sub1, sub2, sub3);
        paths.push({
          sub1,
          sub2,
          sub3,
          rows,
          totalKg,
          capacityKgHint: hint?.capacityKg ?? null,
          equipmentHint: hint?.equipment ?? null,
        });
      }

      paths.sort((a, b) => b.totalKg - a.totalKg);
      const totalKg = paths.reduce((sum, p) => sum + p.totalKg, 0);
      result.push({
        code: entry.code,
        name: entry.name,
        mode: entry.mode,
        portionsInput: entry.portions,
        portionsEffective,
        paths,
        totalKg,
      });
    }

    return result.sort((a, b) => b.totalKg - a.totalKg);
  }, [entries, data.recipes, upliftPercent, capacityHints, pieceWeightKg, trayHints, overrides]);

  const totalKgAll = mealAggs.reduce((sum, meal) => sum + meal.totalKg, 0);
  const totalPathCount = mealAggs.reduce((sum, meal) => sum + meal.paths.length, 0);

  return (
    <div className="space-y-4 pb-10">
      <div className="card p-4">
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-800">Meal-Auswahl</span>
            {entries.length > 0 && (
              <span className="text-[11px] bg-verden-50 text-verden-800 px-2 py-0.5 rounded-full tabular-nums">
                {entries.length} Meals
              </span>
            )}
          </div>
          <span className="text-slate-400 text-xs">{panelOpen ? "▾" : "▸"}</span>
        </button>

        {panelOpen && (
          <div className="mt-3 border-t border-slate-100 pt-3 space-y-3">
            {weekRecipes.length === 0 ? (
              <p className="text-sm text-slate-500">Keine Rezepte für Woche {week}.</p>
            ) : (
              <>
                <input
                  type="search"
                  placeholder="Rezept oder Code suchen ..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
                />
                {suggestions.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                    {suggestions.map((wr) => (
                      <button
                        key={wr.code}
                        onClick={() => addRecipe(wr)}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
                      >
                        <div className="text-[10px] font-mono text-slate-500">{wr.code}</div>
                        <div className="text-sm font-semibold text-slate-800 leading-snug truncate">{wr.recipeName}</div>
                        <div className="text-[11px] text-slate-500 tabular-nums">
                          {wr.totalVerdenVolume.toLocaleString("de-DE")} Portionen
                          {wr.preference ? ` · ${wr.preference}` : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {needle && suggestions.length === 0 && (
                  <p className="text-sm text-slate-400">Kein Rezept gefunden.</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => {
            const effective =
              entry.mode === "fertig"
                ? Math.round(entry.portions * (1 + upliftPercent / 100))
                : entry.portions;
            return (
              <div key={entry.code} className="card p-3 flex flex-wrap items-center gap-3 border-l-4 border-l-indigo-400">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-[10px] font-mono text-slate-400">{entry.code}</div>
                  <div className="text-sm font-semibold text-slate-800 leading-snug">{entry.name}</div>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {entry.mode === "fertig" ? "Fertigware" : "Rohware"} · effektiv {effective.toLocaleString("de-DE")} Portionen
                  </div>
                </div>

                <div className="flex rounded-lg ring-1 ring-slate-300 overflow-hidden text-xs shrink-0">
                  <button
                    onClick={() => patchEntry(entry.code, { mode: "fertig" })}
                    className={`px-3 py-2 ${entry.mode === "fertig" ? "bg-indigo-600 text-white" : "bg-white text-slate-600"}`}
                  >
                    Fertigware
                  </button>
                  <button
                    onClick={() => patchEntry(entry.code, { mode: "roh" })}
                    className={`px-3 py-2 ${entry.mode === "roh" ? "bg-indigo-600 text-white" : "bg-white text-slate-600"}`}
                  >
                    Rohware
                  </button>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={entry.portions}
                    onChange={(e) => patchEntry(entry.code, { portions: Math.max(0, Number(e.target.value)) })}
                    className="w-24 rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-sm text-center tabular-nums"
                  />
                  <span className="text-xs text-slate-500">Portionen</span>
                </div>

                <button
                  onClick={() => removeRecipe(entry.code)}
                  aria-label="Rezept entfernen"
                  className="text-slate-300 hover:text-rose-500 text-xl leading-none"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {mealAggs.length > 0 && (
        <div className="space-y-3">
          <div className="card p-3 flex flex-wrap items-center justify-between gap-2 bg-[linear-gradient(135deg,_rgba(14,165,233,0.08),_rgba(248,250,252,1)_36%,_rgba(16,185,129,0.08))]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-slate-800">Wannen-Rechnung (Meal → Sub → SubSub)</span>
              <span className="text-[11px] bg-white text-slate-700 px-2 py-0.5 rounded-full ring-1 ring-slate-200 tabular-nums">
                {wrFmtKg(totalKgAll)} gesamt
              </span>
              <span className="text-[11px] bg-white text-slate-600 px-2 py-0.5 rounded-full ring-1 ring-slate-200 tabular-nums">
                {totalPathCount} Sub-Pfade
              </span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <button
                onClick={exportAllMealsSettings}
                className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                title="Alle Meals als JSON exportieren"
              >
                Export JSON
              </button>
              <button
                onClick={() => { void exportAllMealsExcel(); }}
                className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                title="Alle Meals als Excel exportieren"
              >
                Export Excel
              </button>
              <button
                onClick={exportAllMealsGsheet}
                className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                title="Alle Meals als TSV für Google Sheets exportieren"
              >
                Export GSheet
              </button>
              <button
                onClick={exportAllMealsPdf}
                className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                title="Alle Meals als druckbare PDF-Ansicht exportieren"
              >
                Export PDF
              </button>
              <div className="border-l border-slate-300" />
              <button
                onClick={handleImportJsonClick}
                className="text-[10px] bg-emerald-50 px-2 py-0.5 rounded ring-1 ring-emerald-300 text-emerald-700 hover:bg-emerald-100"
                title="JSON-Export laden (Einstellungen wiederherstellen)"
              >
                Import JSON
              </button>
              {WANNEN.map((w) => (
                <span key={w.kg} className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-200 text-slate-600">
                  {w.label}
                </span>
              ))}
            </div>
          </div>

          {mealAggs.map((meal) => (
            <div key={meal.code} className="card p-3 space-y-3 border-l-4 border-l-indigo-400">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div>
                  <div className="text-[10px] font-mono text-slate-500">{meal.code}</div>
                  <div className="text-sm font-semibold text-slate-800 leading-snug">{meal.name}</div>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    Input {meal.portionsInput.toLocaleString("de-DE")} · effektiv {Math.round(meal.portionsEffective).toLocaleString("de-DE")} · {meal.mode === "fertig" ? "Fertigware" : "Rohware"}
                  </div>
                </div>
                <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full tabular-nums">
                  {wrFmtKg(meal.totalKg)}
                </span>
                <div className="flex items-center gap-1 flex-wrap">
                  <button
                    onClick={() => exportMealSettings(meal)}
                    className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                    title="Dieses Meal als JSON exportieren"
                  >
                    JSON
                  </button>
                  <button
                    onClick={() => { void exportMealExcel(meal); }}
                    className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                    title="Dieses Meal als Excel exportieren"
                  >
                    Excel
                  </button>
                  <button
                    onClick={() => exportMealGsheet(meal)}
                    className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                    title="Dieses Meal als TSV für Google Sheets exportieren"
                  >
                    GSheet
                  </button>
                  <button
                    onClick={() => exportMealPdf(meal)}
                    className="text-[10px] bg-white px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50"
                    title="Dieses Meal als druckbare PDF-Ansicht exportieren"
                  >
                    PDF
                  </button>
                  <div className="border-l border-slate-300" />
                  <button
                    onClick={handleImportJsonClick}
                    className="text-[10px] bg-emerald-50 px-2 py-0.5 rounded ring-1 ring-emerald-300 text-emerald-700 hover:bg-emerald-100"
                    title="JSON-Export für dieses Meal laden"
                  >
                    Import
                  </button>
                </div>
              </div>

              {meal.paths.length === 0 ? (
                <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-500">
                  Keine Zutaten-Daten für dieses Meal gefunden.
                </div>
              ) : (
                meal.paths.map((path, idx) => (
                  <div key={`${meal.code}-${idx}`} className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-100">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-indigo-500">Sub1</span>
                      <span className="text-xs font-semibold text-slate-800">{path.sub1}</span>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-violet-500 ml-2">Sub2</span>
                      <span className="text-xs text-slate-700">{path.sub2}</span>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-fuchsia-500 ml-2">Sub3</span>
                      <span className="text-xs text-slate-700">{path.sub3}</span>
                      {path.capacityKgHint != null && (
                        <span className="text-[10px] bg-white ring-1 ring-slate-200 rounded-full px-2 py-0.5 text-slate-600">
                          Bible Ref {wrFmtKg(path.capacityKgHint)}
                        </span>
                      )}
                      {path.equipmentHint && (
                        <span className="text-[10px] bg-white ring-1 ring-slate-200 rounded-full px-2 py-0.5 text-slate-600">
                          {path.equipmentHint}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-slate-500 tabular-nums">{wrFmtKg(path.totalKg)}</span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Artikel</th>
                            <th className="text-right px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Gesamt kg</th>
                            {WANNEN.map((w) => (
                              <th
                                key={w.kg}
                                className="text-center px-2 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap"
                              >
                                {w.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {path.rows.map((row, i) => (
                            <tr key={row.overrideKey || `${row.ingredientId}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${wrCatBadge(row.category)}`}>
                                    {row.category}
                                  </span>
                                  <span className="text-sm text-slate-800 leading-snug">{row.name}</span>
                                  <span className="text-[10px] font-mono text-slate-400">{row.ingredientId}</span>
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.1}
                                    value={overrides[row.overrideKey]?.qty ?? ""}
                                    placeholder={`Menge (${row.uom})`}
                                    onChange={(e) => {
                                      const value = e.target.value.trim();
                                      patchOverride(row.overrideKey, { qty: value === "" ? undefined : Number(value) });
                                    }}
                                    className="w-28 rounded-md border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
                                    title="Individuelle Mengen-Override"
                                  />
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.1}
                                    value={overrides[row.overrideKey]?.kg ?? ""}
                                    placeholder="kg Override"
                                    onChange={(e) => {
                                      const value = e.target.value.trim();
                                      patchOverride(row.overrideKey, { kg: value === "" ? undefined : Number(value) });
                                    }}
                                    className="w-24 rounded-md border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
                                    title="Individuelle kg-Override"
                                  />
                                  <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={overrides[row.overrideKey]?.pcsPerTray ?? ""}
                                    placeholder="PCS/Tray"
                                    onChange={(e) => {
                                      const value = e.target.value.trim();
                                      patchOverride(row.overrideKey, { pcsPerTray: value === "" ? undefined : Number(value) });
                                    }}
                                    className="w-24 rounded-md border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600"
                                    title="Individuelle PCS pro Tray"
                                  />
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 whitespace-nowrap">
                                {row.totalKg !== null ? wrFmtKg(row.totalKg) : wrFmtQty(row.totalQty, row.uom)}
                              </td>
                              {WANNEN.map((w) => {
                                if (row.totalKg === null || row.totalKg <= 0) {
                                  const pcsPerTray = row.inferredPcsPerTray ?? wrLookupTrayPcs(trayHints, row.name);
                                  const canUseTray = pcsPerTray != null && isEachUom(row.uom) && row.totalQty > 0;
                                  return (
                                    <td key={w.kg} className="px-2 py-2.5 text-center">
                                      <span className="text-[11px] text-slate-300">
                                        {canUseTray && w.kg === WANNEN[0].kg
                                          ? `Tray x${Math.ceil(row.totalQty / (pcsPerTray as number))}`
                                          : "—"}
                                      </span>
                                    </td>
                                  );
                                }
                                const count = Math.ceil(row.totalKg / w.kg);
                                return (
                                  <td key={w.kg} className="px-2 py-2.5 text-center">
                                    <span className={`inline-block min-w-[34px] px-1.5 py-0.5 text-sm tabular-nums ${wrTubCellCls(count)}`}>
                                      ×{count}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}

      {entries.length > 0 && mealAggs.length === 0 && (
        <div className="card p-6 text-center text-slate-500">
          Keine Zutaten-Daten für die ausgewählten Rezepte gefunden.
        </div>
      )}

      {entries.length === 0 && (
        <div className="card p-6 text-center">
          <p className="text-sm text-slate-500">Wähle oben Meals aus und gib die gewünschte Stückzahl ein.</p>
          <p className="text-xs text-slate-400 mt-1">
            Fertigware = Zielportionen (Uplift addiert) · Rohware = direkt gerechnet
          </p>
        </div>
      )}
    </div>
  );
}

  // ─── Legacy-Implementierung (nicht mehr aktiv, bleibt zur Referenz) ───────────
  function _BreakdownEquipmentViewLegacy({
  data,
  week,
  upliftPercent,
  locale,
}: {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  locale: UiLocale;
}) {
  const [masterFileName, setMasterFileName] = useState<string>("");
  const [bibleFileName, setBibleFileName] = useState<string>("");
  const [etRows, setEtRows] = useState<EtTrackerRow[]>([]);
  const [bibleHints, setBibleHints] = useState<Map<string, BibleHint>>(new Map());
  const [supervisorHints, setSupervisorHints] = useState<Map<string, SupervisorHint>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualTotalEnabled, setManualTotalEnabled] = useState(false);
  const [manualTotalInput, setManualTotalInput] = useState<string>("");
  const [recipeSplitPctByCode, setRecipeSplitPctByCode] = useState<Record<string, number>>({});
  const [subSplitPctByKey, setSubSplitPctByKey] = useState<Record<string, number>>({});
  const [plannerScenarioId, setPlannerScenarioId] = useState<string>("__active__");
  const [plannedOnly, setPlannedOnly] = useState(false);
  const [plannerReloadTick, setPlannerReloadTick] = useState(0);
  const [tubBasis, setTubBasis] = useState<"finished-kg" | "raw-kg" | "ea">("finished-kg");
  const [rawFactorPctInput, setRawFactorPctInput] = useState<string>("110");
  const [eaPerPortionInput, setEaPerPortionInput] = useState<string>("1");
  const [eaPerTubInput, setEaPerTubInput] = useState<string>("120");
  const [ingredientYieldMode, setIngredientYieldMode] = useState<YieldMode>("with-loss");
  const [yieldReloadTick, setYieldReloadTick] = useState(0);

  const plannerWeekInfo = useMemo(() => {
    void plannerReloadTick;
    const storage = loadPlannerStorage();
    const weekState = getWeekState(storage, week);
    const active = getActiveScenario(storage, week);
    const selected = plannerScenarioId === "__active__"
      ? active
      : (weekState.scenarios.find((item) => item.id === plannerScenarioId) ?? active);
    return {
      scenarios: weekState.scenarios,
      active,
      selected,
    };
  }, [week, plannerScenarioId, plannerReloadTick]);

  const plannedLookup = useMemo(() => {
    const recipeCodes = new Set<string>();
    const subKeys = new Set<string>();
    for (const assignment of Object.values(plannerWeekInfo.selected.assignments)) {
      const recipeCode = assignment.recipeCode?.toUpperCase?.() ?? assignment.recipeCode;
      if (!recipeCode) continue;
      if (assignment.subRecipeId) {
        subKeys.add(`${recipeCode}::${assignment.subRecipeId}`);
      } else {
        recipeCodes.add(recipeCode);
      }
    }
    return { recipeCodes, subKeys };
  }, [plannerWeekInfo.selected]);

  const baseTotalPortions = useMemo(() => {
    const portionFactor = 1 + upliftPercent / 100;
    return etRows.reduce((sum, row) => sum + row.targetPortions * portionFactor, 0);
  }, [etRows, upliftPercent]);

  const manualTotal = parseFloatSafe(manualTotalInput);
  const rawFactorPct = clampPositive(parseFloatSafe(rawFactorPctInput), 100);
  const eaPerPortion = clampPositive(parseFloatSafe(eaPerPortionInput), 1);
  const eaPerTub = clampPositive(parseFloatSafe(eaPerTubInput), 1);
  const totalScale = manualTotalEnabled && manualTotal && manualTotal > 0 && baseTotalPortions > 0
    ? manualTotal / baseTotalPortions
    : 1;

  const calcRows = useMemo(
    () => buildRows(data, week, upliftPercent, etRows, bibleHints, supervisorHints, {
      totalScale,
      recipeSplitPctByCode,
      subSplitPctByKey,
      plannedOnly,
      plannedRecipeCodes: plannedLookup.recipeCodes,
      plannedSubKeys: plannedLookup.subKeys,
      tubBasis,
      rawFactorPct,
      eaPerPortion,
      eaPerTub,
    }),
    [
      data,
      week,
      upliftPercent,
      etRows,
      bibleHints,
      supervisorHints,
      totalScale,
      recipeSplitPctByCode,
      subSplitPctByKey,
      plannedOnly,
      plannedLookup,
      tubBasis,
      rawFactorPct,
      eaPerPortion,
      eaPerTub,
    ]
  );

  const recipeSplitRows = useMemo(() => {
    const byRecipe = new Map<string, { recipeName: string; basePortions: number }>();
    for (const row of calcRows) {
      const existing = byRecipe.get(row.recipeCode) ?? { recipeName: row.recipeName, basePortions: 0 };
      existing.basePortions += row.baseTargetPortions;
      byRecipe.set(row.recipeCode, existing);
    }
    return [...byRecipe.entries()]
      .map(([recipeCode, value]) => ({ recipeCode, ...value }))
      .sort((a, b) => b.basePortions - a.basePortions)
      .slice(0, 30);
  }, [calcRows]);

  const yieldOverrides = useMemo(() => {
    void yieldReloadTick;
    return readWhatIfYieldOverrides();
  }, [yieldReloadTick]);

  const yieldByRecipeCode = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const row of calcRows) {
      if (map.has(row.recipeCode)) continue;
      map.set(row.recipeCode, recipeYieldLookup(data.structures?.[row.recipeCode]));
    }
    return map;
  }, [calcRows, data.structures]);

  const ingredientRows = useMemo<IngredientCalcRow[]>(() => {
    const rows: IngredientCalcRow[] = [];
    const eaPerTubSafe = clampPositive(eaPerTub, 1);

    for (const subRow of calcRows) {
      const recipe = data.recipes[subRow.recipeCode];
      if (!recipe) continue;

      const sub: SubRecipe = {
        id: subRow.subRecipeId,
        name: subRow.subRecipeName,
        category: "",
      };
      const ingredients = subRecipeIngredientRows(recipe, sub);
      if (ingredients.length === 0) continue;

      const fallbackYield = subRow.yieldRatio && Number.isFinite(subRow.yieldRatio) && subRow.yieldRatio > 0
        ? Math.min(1, subRow.yieldRatio)
        : 1;
      const recipeYield = yieldByRecipeCode.get(subRow.recipeCode) ?? new Map<string, number>();
      const nominalTubKg = inferTubProfile(subRow.equipment, subRow.capacityKg).nominalKg;

      for (const ingredient of ingredients) {
        const yieldKey = `${subRow.subRecipeId}__${ingredient.ingredientId}`;
        const overrideYield = yieldOverrides.get(yieldKey);
        const detailYield = recipeYield.get(yieldKey);
        const effectiveYield = overrideYield && overrideYield > 0 && overrideYield <= 1
          ? overrideYield
          : detailYield && detailYield > 0 && detailYield <= 1
            ? detailYield
            : fallbackYield;
        const yieldSource: "override" | "detail" | "fallback" = overrideYield && overrideYield > 0 && overrideYield <= 1
          ? "override"
          : detailYield && detailYield > 0 && detailYield <= 1
            ? "detail"
            : "fallback";

        const qtyWithLoss = ingredient.perPortion * subRow.targetPortions;
        const qtyNoLoss = qtyWithLoss * effectiveYield;
        const selectedQty = ingredientYieldMode === "with-loss" ? qtyWithLoss : qtyNoLoss;
        const kgEq = uomToKgEquivalent(selectedQty, ingredient.uom);

        let tubs: number | null = null;
        if (tubBasis === "ea" || isEachUom(ingredient.uom)) {
          tubs = Math.ceil(selectedQty / eaPerTubSafe);
        } else if (kgEq != null && kgEq > 0) {
          tubs = Math.ceil(kgEq / Math.max(0.1, nominalTubKg));
        }

        rows.push({
          recipeCode: subRow.recipeCode,
          recipeName: subRow.recipeName,
          subRecipeId: subRow.subRecipeId,
          subRecipeName: subRow.subRecipeName,
          ingredientId: ingredient.ingredientId,
          ingredientName: ingredient.ingredientName,
          ingredientCategory: ingredient.ingredientCategory,
          uom: ingredient.uom,
          perPortion: ingredient.perPortion,
          qtyWithLoss,
          qtyNoLoss,
          effectiveYield,
          yieldSource,
          selectedQty,
          selectedMode: ingredientYieldMode,
          tubs,
          kgEq,
          nominalTubKg,
        });
      }
    }

    return rows
      .filter((row) => row.selectedQty > 0)
      .sort((a, b) => (b.tubs ?? 0) - (a.tubs ?? 0) || b.selectedQty - a.selectedQty);
  }, [calcRows, data.recipes, ingredientYieldMode, tubBasis, eaPerTub, yieldByRecipeCode, yieldOverrides]);

  const summary = useMemo(() => {
    const byEquipment = new Map<string, EquipmentAgg>();

    for (const row of calcRows) {
      const key = row.equipment;
      const existing = byEquipment.get(key) ?? {
        equipment: key,
        totalKg: 0,
        activeMin: 0,
        requiredDevices: 0,
        totalTubs: 0,
        rows: 0,
      };
      existing.totalKg += row.demandKg;
      existing.activeMin += row.activeMin ?? 0;
      existing.totalTubs += row.tubCount;
      existing.rows += 1;
      byEquipment.set(key, existing);
    }

    for (const value of byEquipment.values()) {
      value.requiredDevices = value.activeMin > 0 ? Math.ceil(value.activeMin / DEFAULT_SHIFT_MIN) : 0;
    }

    return [...byEquipment.values()].sort((a, b) => b.activeMin - a.activeMin || b.totalKg - a.totalKg);
  }, [calcRows]);

  const kpis = useMemo(() => {
    const totalKg = calcRows.reduce((sum, row) => sum + row.demandKg, 0);
    const totalRawKg = calcRows.reduce((sum, row) => sum + row.demandRawKg, 0);
    const totalEach = calcRows.reduce((sum, row) => sum + row.eachCount, 0);
    const totalActiveMin = calcRows.reduce((sum, row) => sum + (row.activeMin ?? 0), 0);
    const totalDevices = summary.reduce((sum, row) => sum + row.requiredDevices, 0);
    const totalTubs = calcRows.reduce((sum, row) => sum + row.tubCount, 0);
    const ingredientTubs = ingredientRows.reduce((sum, row) => sum + (row.tubs ?? 0), 0);
    const ingredientTubsWithLoss = ingredientRows.reduce((sum, row) => {
      const tubs = ingredientRowTubsByMode(row, "with-loss", tubBasis, eaPerTub);
      return sum + (tubs ?? 0);
    }, 0);
    const ingredientTubsNoLoss = ingredientRows.reduce((sum, row) => {
      const tubs = ingredientRowTubsByMode(row, "no-loss", tubBasis, eaPerTub);
      return sum + (tubs ?? 0);
    }, 0);
    return {
      totalKg,
      totalRawKg,
      totalEach,
      totalActiveMin,
      totalDevices,
      totalTubs,
      ingredientTubs,
      ingredientTubsWithLoss,
      ingredientTubsNoLoss,
    };
  }, [calcRows, summary, ingredientRows, tubBasis, eaPerTub]);

  const ingredientTubDeltaRows = useMemo<IngredientTubDeltaRow[]>(() => {
    const grouped = new Map<string, IngredientTubDeltaRow>();
    for (const row of ingredientRows) {
      const key = `${row.recipeCode}::${row.subRecipeId}`;
      const entry = grouped.get(key) ?? {
        recipeCode: row.recipeCode,
        recipeName: row.recipeName,
        subRecipeId: row.subRecipeId,
        subRecipeName: row.subRecipeName,
        tubsWithLoss: 0,
        tubsNoLoss: 0,
        tubsDelta: 0,
        items: 0,
      };
      entry.tubsWithLoss += ingredientRowTubsByMode(row, "with-loss", tubBasis, eaPerTub) ?? 0;
      entry.tubsNoLoss += ingredientRowTubsByMode(row, "no-loss", tubBasis, eaPerTub) ?? 0;
      entry.items += 1;
      grouped.set(key, entry);
    }

    const rows = [...grouped.values()];
    for (const row of rows) row.tubsDelta = row.tubsWithLoss - row.tubsNoLoss;
    return rows
      .filter((row) => row.tubsDelta !== 0)
      .sort((a, b) => Math.abs(b.tubsDelta) - Math.abs(a.tubsDelta) || b.tubsWithLoss - a.tubsWithLoss)
      .slice(0, 120);
  }, [ingredientRows, tubBasis, eaPerTub]);

  async function handleMasterUpload(file: File) {
    setBusy("master");
    setError(null);
    try {
      const [trackerRows, parsedSupervisor] = await Promise.all([
        parseEtTracker(file),
        parseBreakdownSupervisor(file),
      ]);
      setEtRows(trackerRows);
      setSupervisorHints(parsedSupervisor);
      setMasterFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleBibleUpload(file: File) {
    setBusy("bible");
    setError(null);
    try {
      const parsed = await parseBibles(file);
      setBibleHints(parsed);
      setBibleFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const title = locale === "de"
    ? "Breakdown-Wannen- & Equipment-Rechner"
    : locale === "nl"
      ? "Breakdown-equipmentcalculator"
      : "Breakdown equipment calculator";

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h2 className="text-xl font-bold">{title} · {week}</h2>
        <p className="mt-1 text-xs text-slate-500">
          {locale === "de"
            ? "Lädt ET-Tracker + Bible-Datei, matched gegen Rezeptlogik/PFEI und berechnet Wannenbedarf, Chargen, Equipment-Last, aktive Minuten und empfohlene Geräte je 8h-Schicht."
            : "Loads ET tracker + Bible file, matches against Rezeptlogik/PFEI and calculates demand per equipment including active minutes and recommended devices per 8h shift."}
        </p>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 text-sm">
            <div className="font-semibold">1) Master/Tracker</div>
            <div className="mt-1 text-xs text-slate-500">[NEW] MASTER+SUPERVISORS WORKLOAD PLANNING.xlsx</div>
            <input
              type="file"
              accept=".xlsx"
              className="mt-2 w-full text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleMasterUpload(file);
              }}
            />
            {masterFileName && (
              <div className="mt-1 text-[11px] text-emerald-700">
                {masterFileName} · {fmtNum(etRows.length)} ET-Zeilen · {fmtNum(supervisorHints.size)} Supervisor-Hints
              </div>
            )}
          </label>

          <label className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 text-sm">
            <div className="font-semibold">2) Bibles</div>
            <div className="mt-1 text-xs text-slate-500">Bibles_K_Operations_Manager_Supervisors (1).xlsx</div>
            <input
              type="file"
              accept=".xlsx"
              className="mt-2 w-full text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleBibleUpload(file);
              }}
            />
            {bibleFileName && <div className="mt-1 text-[11px] text-emerald-700">{bibleFileName} · {fmtNum(bibleHints.size)} Kapazitäts-Maps</div>}
          </label>
        </div>

        <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 space-y-3">
          <div className="text-sm font-semibold text-slate-700">Szenario, Total-Size und Split</div>

          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4 text-xs">
            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Planner-Szenario</div>
              <select
                value={plannerScenarioId}
                onChange={(event) => setPlannerScenarioId(event.target.value)}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              >
                <option value="__active__">Aktiv ({plannerWeekInfo.active.name})</option>
                {plannerWeekInfo.scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="rounded bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200"
                onClick={() => setPlannerReloadTick((tick) => tick + 1)}
              >
                Szenarien neu laden
              </button>
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Planner-Filter</div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={plannedOnly}
                  onChange={(event) => setPlannedOnly(event.target.checked)}
                />
                <span>Nur geplante Meals/Subrecipes rechnen</span>
              </div>
              <div className="text-[11px] text-slate-500">
                Geplant: {fmtNum(plannedLookup.recipeCodes.size)} Meals + {fmtNum(plannedLookup.subKeys.size)} Sub-Assignments
              </div>
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Total-Size Override</div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={manualTotalEnabled}
                  onChange={(event) => setManualTotalEnabled(event.target.checked)}
                />
                <span>Manuelle Gesamt-Portionen</span>
              </div>
              <input
                type="number"
                min={0}
                step={1}
                value={manualTotalInput}
                onChange={(event) => setManualTotalInput(event.target.value)}
                placeholder="z. B. 185000"
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
                disabled={!manualTotalEnabled}
              />
            </label>

            <div className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2">
              <div className="font-semibold text-slate-600 text-xs">Basis / Skalierung</div>
              <div className="mt-1 text-[11px] text-slate-600">ET-Basis: {fmtNum(baseTotalPortions, 0)} Portionen</div>
              <div className="text-[11px] text-slate-600">Aktive Skalierung: {fmtNum(totalScale * 100, 1)}%</div>
              <div className="text-[11px] text-slate-600">Szenario: {plannerWeekInfo.selected.name}</div>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4 text-xs">
            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Artikel-Yield</div>
              <select
                value={ingredientYieldMode}
                onChange={(event) => setIngredientYieldMode(event.target.value as YieldMode)}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              >
                <option value="with-loss">mit Verlust (Brutto/Rohware)</option>
                <option value="no-loss">ohne Verlust (Yield-adjusted)</option>
              </select>
              <div className="text-[11px] text-slate-500">Quelle: Override aus What-if, sonst `yieldPct` aus Detailstruktur, sonst Fallback.</div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">Overrides: {fmtNum(yieldOverrides.size)}</span>
                <button
                  type="button"
                  className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200"
                  onClick={() => setYieldReloadTick((tick) => tick + 1)}
                >
                  Yield neu laden
                </button>
              </div>
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Wannen-Basis</div>
              <select
                value={tubBasis}
                onChange={(event) => setTubBasis(event.target.value as "finished-kg" | "raw-kg" | "ea")}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              >
                <option value="finished-kg">Fertigware (kg)</option>
                <option value="raw-kg">Rohware (kg)</option>
                <option value="ea">EA / Stück</option>
              </select>
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">Rohware-Faktor %</div>
              <input
                type="number"
                min={1}
                max={300}
                step={1}
                value={rawFactorPctInput}
                onChange={(event) => setRawFactorPctInput(event.target.value)}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              />
              <div className="text-[11px] text-slate-500">100 = gleich Fertigware, 110 = 10% Rohaufschlag</div>
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">EA je Portion</div>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={eaPerPortionInput}
                onChange={(event) => setEaPerPortionInput(event.target.value)}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              />
            </label>

            <label className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2 space-y-1">
              <div className="font-semibold text-slate-600">EA je Wanne</div>
              <input
                type="number"
                min={1}
                step={1}
                value={eaPerTubInput}
                onChange={(event) => setEaPerTubInput(event.target.value)}
                className="w-full rounded border-slate-300 ring-1 ring-slate-300 px-2 py-1 text-xs"
              />
            </label>
          </div>

          {recipeSplitRows.length > 0 && (
            <div className="rounded-lg bg-white ring-1 ring-slate-200 p-2">
              <div className="text-xs font-semibold text-slate-600 mb-2">Meal-Split % (Top 30 nach Volumen)</div>
              <div className="grid gap-1 md:grid-cols-2 lg:grid-cols-3">
                {recipeSplitRows.map((row) => (
                  <label key={row.recipeCode} className="flex items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1">
                    <span className="text-[11px] text-slate-600 truncate">{row.recipeCode} · {row.recipeName}</span>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      step={1}
                      value={recipeSplitPctByCode[row.recipeCode] ?? 100}
                      onChange={(event) => {
                        const value = clampPercent(parseFloatSafe(event.target.value), 100);
                        setRecipeSplitPctByCode((prev) => ({ ...prev, [row.recipeCode]: value }));
                      }}
                      className="w-16 rounded border-slate-300 ring-1 ring-slate-300 px-1 py-0.5 text-right text-[11px]"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {busy && <div className="mt-2 text-xs text-sky-700">Datei wird verarbeitet …</div>}
        {error && <div className="mt-2 text-xs text-rose-700">Fehler: {error}</div>}

        <div className="mt-3 grid grid-cols-2 md:grid-cols-9 gap-2 text-xs">
          <Stat label="Subrecipes" value={fmtNum(calcRows.length)} />
          <Stat label="Fertigware kg" value={fmtNum(kpis.totalKg, 1)} accent />
          <Stat label="Rohware kg" value={fmtNum(kpis.totalRawKg, 1)} />
          <Stat label="EA Σ" value={fmtNum(kpis.totalEach, 0)} />
          <Stat label="Wannen Σ" value={fmtNum(kpis.totalTubs, 0)} accent={kpis.totalTubs > 0} />
          <Stat label="Wannen ArtikelΣ" value={fmtNum(kpis.ingredientTubs, 0)} />
          <Stat label="Artikel mit Verlust" value={fmtNum(kpis.ingredientTubsWithLoss, 0)} />
          <Stat label="Artikel ohne Verlust" value={fmtNum(kpis.ingredientTubsNoLoss, 0)} />
          <Stat label="Geräte-Empf." value={fmtNum(kpis.totalDevices)} accent={kpis.totalDevices > 0} />
        </div>

        <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
          <div className="text-sm font-semibold text-slate-700">Yield-Delta je Subrecipe (mit Verlust vs. ohne Verlust)</div>
          <div className="mt-1 text-[11px] text-slate-500">
            Zeigt, wie stark sich die Wannenanzahl je Subrecipe durch reale Yield-Verluste veraendert.
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="uppercase tracking-wide text-slate-500">
                <tr className="border-b">
                  <th className="text-left py-1.5 pr-2">Rezept</th>
                  <th className="text-left py-1.5 pr-2">Subrecipe</th>
                  <th className="text-right py-1.5 pr-2">Artikel</th>
                  <th className="text-right py-1.5 pr-2">mit Verlust</th>
                  <th className="text-right py-1.5 pr-2">ohne Verlust</th>
                  <th className="text-right py-1.5">Delta</th>
                </tr>
              </thead>
              <tbody>
                {ingredientTubDeltaRows.map((row) => (
                  <tr key={`${row.recipeCode}-${row.subRecipeId}`} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">
                      <div className="font-mono text-[10px] text-slate-500">{row.recipeCode}</div>
                      <div className="text-slate-700">{row.recipeName}</div>
                    </td>
                    <td className="py-1.5 pr-2">{row.subRecipeName}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.items)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.tubsWithLoss)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.tubsNoLoss)}</td>
                    <td className={`py-1.5 text-right tabular-nums font-semibold ${row.tubsDelta > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                      {row.tubsDelta > 0 ? "+" : ""}{fmtNum(row.tubsDelta)}
                    </td>
                  </tr>
                ))}
                {ingredientTubDeltaRows.length === 0 && (
                  <tr>
                    <td className="py-2 text-slate-500" colSpan={6}>Kein Yield-Delta sichtbar (mit/ohne Verlust aktuell gleich).</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Equipment-Summary</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">Equipment</th>
                <th className="text-right py-1.5 pr-2">Fertig kg</th>
                <th className="text-right py-1.5 pr-2">Wannen</th>
                <th className="text-right py-1.5 pr-2">aktive Min</th>
                <th className="text-right py-1.5 pr-2">Geräte</th>
                <th className="text-right py-1.5">Subrecipes</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((item) => (
                <tr key={item.equipment} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-medium">{item.equipment}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(item.totalKg, 1)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(item.totalTubs)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(item.activeMin, 0)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(item.requiredDevices)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(item.rows)}</td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr>
                  <td className="py-3 text-slate-500" colSpan={6}>Bitte beide Excel-Dateien laden.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Subrecipe-Details</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">Rezept</th>
                <th className="text-left py-1.5 pr-2">Subrecipe</th>
                <th className="text-right py-1.5 pr-2">Split %</th>
                <th className="text-right py-1.5 pr-2">Base Portions</th>
                <th className="text-right py-1.5 pr-2">Portions</th>
                <th className="text-right py-1.5 pr-2">Fertig kg</th>
                <th className="text-right py-1.5 pr-2">Roh kg</th>
                <th className="text-right py-1.5 pr-2">EA</th>
                <th className="text-right py-1.5 pr-2">Cap kg</th>
                <th className="text-right py-1.5 pr-2">Batches</th>
                <th className="text-right py-1.5 pr-2">Wannen</th>
                <th className="text-right py-1.5 pr-2">Ø kg/Wanne</th>
                <th className="text-left py-1.5 pr-2">Wannentyp</th>
                <th className="text-left py-1.5 pr-2">Station</th>
                <th className="text-left py-1.5 pr-2">Equipment</th>
                <th className="text-right py-1.5 pr-2">aktive Min</th>
                <th className="text-right py-1.5">Geräte</th>
              </tr>
            </thead>
            <tbody>
              {calcRows.slice(0, 300).map((row, index) => (
                <tr key={`${row.recipeCode}-${row.subRecipeName}-${index}`} className="border-b last:border-0">
                  <td className="py-1.5 pr-2">
                    <div className="font-mono text-[10px] text-slate-500">{row.recipeCode}</div>
                    <div className="text-slate-700">{row.recipeName}</div>
                  </td>
                  <td className="py-1.5 pr-2">{row.subRecipeName}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <input
                      type="number"
                      min={0}
                      max={200}
                      step={1}
                      value={subSplitPctByKey[`${row.recipeCode}::${row.subRecipeId}`] ?? 100}
                      onChange={(event) => {
                        const key = `${row.recipeCode}::${row.subRecipeId}`;
                        const value = clampPercent(parseFloatSafe(event.target.value), 100);
                        setSubSplitPctByKey((prev) => ({ ...prev, [key]: value }));
                      }}
                      className="w-16 rounded border-slate-300 ring-1 ring-slate-300 px-1 py-0.5 text-right text-[11px]"
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">{fmtNum(row.baseTargetPortions, 0)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.targetPortions, 0)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.demandKg, 1)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.demandRawKg, 1)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.eachCount, 0)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.capacityKg != null ? fmtNum(row.capacityKg, 1) : "-"}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.batches != null ? fmtNum(row.batches) : "-"}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(row.tubCount)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.avgKgPerTub, 1)}</td>
                  <td className="py-1.5 pr-2">{row.tubType}</td>
                  <td className="py-1.5 pr-2">{row.station}</td>
                  <td className="py-1.5 pr-2">
                    {row.equipment}
                    <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] bg-slate-100 text-slate-600">{row.basis}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.activeMin != null ? fmtNum(row.activeMin, 0) : "-"}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.requiredDevices != null ? fmtNum(row.requiredDevices) : "-"}</td>
                </tr>
              ))}
              {calcRows.length === 0 && (
                <tr>
                  <td className="py-3 text-slate-500" colSpan={17}>Noch keine berechneten Subrecipes verfügbar.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Artikel-Details je Subrecipe</h3>
        <div className="text-[11px] text-slate-500 mb-2">
          Exakte Zutateneinzelrechnung pro Subrezept. Modus: {ingredientYieldMode === "with-loss" ? "mit Verlust" : "ohne Verlust"}.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">Rezept</th>
                <th className="text-left py-1.5 pr-2">Subrecipe</th>
                <th className="text-left py-1.5 pr-2">Artikel</th>
                <th className="text-left py-1.5 pr-2">Kat.</th>
                <th className="text-right py-1.5 pr-2">pro Portion</th>
                <th className="text-right py-1.5 pr-2">Yield %</th>
                <th className="text-left py-1.5 pr-2">Yield-Quelle</th>
                <th className="text-right py-1.5 pr-2">mit Verlust</th>
                <th className="text-right py-1.5 pr-2">ohne Verlust</th>
                <th className="text-right py-1.5 pr-2">aktiv</th>
                <th className="text-right py-1.5 pr-2">kgEq</th>
                <th className="text-right py-1.5 pr-2">Wannen</th>
                <th className="text-left py-1.5">UOM</th>
              </tr>
            </thead>
            <tbody>
              {ingredientRows.slice(0, 600).map((row, idx) => (
                <tr key={`${row.recipeCode}-${row.subRecipeId}-${row.ingredientId}-${idx}`} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-mono text-[10px] text-slate-500">{row.recipeCode}</td>
                  <td className="py-1.5 pr-2">{row.subRecipeName}</td>
                  <td className="py-1.5 pr-2">
                    <div className="font-medium text-slate-700">{row.ingredientName}</div>
                    <div className="font-mono text-[10px] text-slate-400">{row.ingredientId}</div>
                  </td>
                  <td className="py-1.5 pr-2">{row.ingredientCategory}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.perPortion, 3)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.effectiveYield * 100, 2)}</td>
                  <td className="py-1.5 pr-2">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${row.yieldSource === "override" ? "bg-fuchsia-100 text-fuchsia-700" : row.yieldSource === "detail" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-600"}`}>
                      {row.yieldSource}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.qtyWithLoss, 2)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(row.qtyNoLoss, 2)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(row.selectedQty, 2)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{row.kgEq != null ? fmtNum(row.kgEq, 3) : "-"}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{row.tubs != null ? fmtNum(row.tubs) : "-"}</td>
                  <td className="py-1.5">{row.uom}</td>
                </tr>
              ))}
              {ingredientRows.length === 0 && (
                <tr>
                  <td className="py-3 text-slate-500" colSpan={13}>Keine artikelgenauen Werte verfügbar (Gross-Ingredients oder Subrecipe-Matching prüfen).</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-black tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
