import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle, DetailedSubRecipe, GrossIngredient, Ingredient, Market } from "./types";

type Props = {
  data: DataBundle;
  week: string;
};

type WmsPlatingStoredRow = {
  locationId: string;
  itemNumber: string;
  actualQty: number | null;
  lotNumber: string;
  huId: string;
  status: string;
  fifoDate: string | null;
  expirationDate: string | null;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsPlatingPayload = {
  ok: boolean;
  whId: string;
  week: string;
  wmsWeek: string;
  rangeStart: string;
  rangeEnd: string;
  limit: number;
  generatedAt: string;
  rows: WmsPlatingStoredRow[];
  error?: string;
};

type WmsSleevingTranRow = {
  von: string;
  nach: string;
  tranType: string;
  itemNumber: string;
  tranQty: number | null;
  startTranDate: string | null;
  endTranDate: string | null;
  kw: number | null;
  employeeId: string;
  description: string;
};

type WmsSleevingPayload = {
  ok: boolean;
  whId: string;
  week: string;
  wmsWeek: string;
  rangeStart: string;
  rangeEnd: string;
  limit: number;
  generatedAt: string;
  rows: WmsSleevingTranRow[];
  error?: string;
};

type WmsPlatingHistoryPayload = WmsSleevingPayload & {
  lookbackDays?: number;
};

type WmsInboundReceiptRow = {
  poNumber: string;
  itemNumber: string;
  qtyReceived: number | null;
  qtyDamaged: number | null;
  receiptDate: string | null;
  vendorCode: string;
  huId: string;
  lotNumber: string;
  expirationDate: string | null;
  shipmentNumber: string;
  tranStatus: string;
  status: string;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsInboundPayload = {
  ok: boolean;
  whId: string;
  week: string;
  wmsWeek: string;
  rangeStart: string;
  rangeEnd: string;
  limit: number;
  generatedAt: string;
  rows: WmsInboundReceiptRow[];
  error?: string;
};

type WmsStagingStoredRow = {
  locationId: string;
  itemNumber: string;
  actualQty: number | null;
  lotNumber: string;
  huId: string;
  status: string;
  fifoDate: string | null;
  expirationDate: string | null;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsStagingPayload = {
  ok: boolean;
  whId: string;
  week: string;
  wmsWeek: string;
  rangeStart: string;
  rangeEnd: string;
  limit: number;
  generatedAt: string;
  rows: WmsStagingStoredRow[];
  error?: string;
};

type WmsDeboxPayload = WmsStagingPayload;
type WmsPostblastPayload = WmsStagingPayload;

type WmsWorkordersRow = {
  woNumber: string;
  week: string;
  submealItemNumber: string;
  submealItemDescription: string;
  mealItemNumber: string;
  mealItemDescription: string;
  quantity: number | null;
  uom: string;
  plates: number | null;
  targetPerPlate: number | null;
  preBlastQuantity: number | null;
  preBlastLocation: string;
  status: string;
  expirationDate: string | null;
  productionTime: string | null;
  lastUpdated: string | null;
};

type WmsWorkordersPayload = {
  ok: boolean;
  rows: WmsWorkordersRow[];
  error?: string;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type PlannedSkuInfo = {
  sku: string;
  name: string;
  uom: string;
  category: string;
  plannedQty: number;
  recipes: Set<string>;
  source: "week-plan" | "catalog" | "shelf-life" | "wms-only";
};

type PlatingLocationRow = {
  key: string;
  location: string;
  area: "Line" | "Holding" | "Staging";
  sku: string;
  name: string;
  rawQty: number;
  pieces: number;
  kg: number;
  gramsPerPiece: number | null;
  unitNote: string;
  lots: Set<string>;
  hus: Set<string>;
  statuses: Set<string>;
  recipes: Set<string>;
  lastChange: string | null;
};

type SleevingSignal = "Eingang" | "Ausgang" | "Lost" | "Cycle Count" | "Hold" | "Intern";

type SleevingSummaryRow = {
  key: string;
  sku: string;
  name: string;
  inbound: number;
  outbound: number;
  lost: number;
  cycleDelta: number;
  hold: number;
  internal: number;
  eventCount: number;
  correctionPairs: number;
  employees: Set<string>;
  recipes: Set<string>;
  lastChange: string | null;
};

type InboundSummaryRow = {
  key: string;
  sku: string;
  name: string;
  received: number;
  damaged: number;
  poCount: number;
  huCount: number;
  lotCount: number;
  vendors: Set<string>;
  statuses: Set<string>;
  recipes: Set<string>;
  lastReceipt: string | null;
  nextExpiration: string | null;
};

type StagingSummaryRow = {
  key: string;
  location: string;
  sku: string;
  name: string;
  rawQty: number;
  lots: Set<string>;
  hus: Set<string>;
  statuses: Set<string>;
  recipes: Set<string>;
  fifoDate: string | null;
  expirationDate: string | null;
  lastChange: string | null;
};

type RecipeProcessRow = {
  key: string;
  recipe: string;
  deboxQty: number;
  postblastQty: number;
  deboxSkus: Set<string>;
  postblastSkus: Set<string>;
  deboxNames: Set<string>;
  postblastNames: Set<string>;
};

type CommandSkuRow = {
  key: string;
  sku: string;
  name: string;
  category: string;
  uom: string;
  plannedQty: number;
  plannedPieces: number;
  recipes: Set<string>;
  inboundReceived: number;
  inboundDamaged: number;
  deboxQty: number;
  postblastQty: number;
  platingLinePieces: number;
  platingHoldingPieces: number;
  platingHoldingKg: number;
  sleevingInbound: number;
  sleevingOutbound: number;
  sleevingLost: number;
  sleevingHold: number;
  stagingQty: number;
  matchSource: PlannedSkuInfo["source"];
  status: "kritisch" | "pruefen" | "laeuft" | "gedeckt" | "signal";
  statusText: string;
  riskScore: number;
};

type CommandRecipeRow = {
  key: string;
  recipe: string;
  name: string;
  plannedPieces: number;
  mainSkus: Set<string>;
  subSkus: Set<string>;
  mainOutputPieces: number;
  historicalOutputPieces: number;
  totalOutputPieces: number;
  holdingStandPieces: number;
  standPieces: number;
  subPlannedQty: number;
  subPostblastQty: number;
  subDeboxQty: number;
  subHoldingPieces: number;
  subSignalSharedCount: number;
  sleevingLost: number;
  sleevingHold: number;
  noMatchSignals: number;
  status: "kritisch" | "pruefen" | "laeuft" | "gedeckt" | "offen";
  statusText: string;
};

const LOCAL_PLATING_ENDPOINT = "/api/wms-plating";
const LOCAL_PLATING_HISTORY_ENDPOINT = "/api/wms-plating-history";
const LOCAL_SLEEVING_ENDPOINT = "/api/wms-sleeving";
const LOCAL_INBOUND_ENDPOINT = "/api/wms-inbound";
const LOCAL_STAGING_ENDPOINT = "/api/wms-staging";
const LOCAL_DEBOX_ENDPOINT = "/api/wms-debox";
const LOCAL_POSTBLAST_ENDPOINT = "/api/wms-postblast";
const LOCAL_WORKORDERS_ENDPOINT = "/api/wms-workorders";

function fmtNum(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function fmtQty(value: number | null | undefined, unit = "", digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  const maxDigits = abs >= 100 ? 0 : digits;
  const formatted = value.toLocaleString("de-DE", { maximumFractionDigits: maxDigits });
  return unit ? `${formatted} ${unit}` : formatted;
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mhdTone(expirationDate: string | null | undefined): string {
  if (!expirationDate) return "text-slate-400";
  const days = Math.floor((new Date(expirationDate).getTime() - Date.now()) / 86_400_000);
  if (days < 5) return "font-bold text-rose-700";
  if (days < 9) return "font-bold text-amber-600";
  return "text-emerald-700";
}

function mhdDaysLabel(expirationDate: string | null | undefined): string {
  if (!expirationDate) return "–";
  const days = Math.floor((new Date(expirationDate).getTime() - Date.now()) / 86_400_000);
  const dateStr = fmtDateTime(expirationDate);
  return `${dateStr} (${days}T)`;
}

function localDateIso(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 10);
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const out = new Date(week1Monday);
  out.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return out;
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// Convert "2026-W22" → "202622" (WMS workorders week format)
function toolWeekToWmsWeek(toolWeek: string): string {
  const m = toolWeek.match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return "";
  return `${m[1]}${m[2]}`;
}

function wmsWeekToToolWeek(wmsWeek: string): string {
  const m = wmsWeek.match(/^(20\d{2})(\d{2})$/);
  if (!m) return "";
  return `${m[1]}-W${m[2]}`;
}

// Build index: submealItemNumber → workorders rows for fast PLH lookup
function buildWorkordersIndex(rows: WmsWorkordersRow[]): Map<string, WmsWorkordersRow[]> {
  const map = new Map<string, WmsWorkordersRow[]>();
  for (const row of rows) {
    const key = row.submealItemNumber;
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function wmsRangeForToolWeek(toolWeek: string): { wmsWeek: string; rangeStart: string; rangeEnd: string } {
  const match = toolWeek.match(/^(20\d{2})-W(\d{2})$/);
  if (!match) {
    const today = localDateIso();
    return { wmsWeek: isoWeekLabel(new Date(`${today}T12:00:00Z`)), rangeStart: today, rangeEnd: today };
  }
  const start = isoWeekStart(Number(match[1]), Number(match[2]));
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    wmsWeek: isoWeekLabel(start),
    rangeStart: start.toISOString().slice(0, 10),
    rangeEnd: end.toISOString().slice(0, 10),
  };
}

function skuKey(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

function skuDefaultUom(sku: string, fallback = ""): string {
  const prefix = skuKey(sku).slice(0, 3);
  if (["SUB", "PTN", "PHF", "PRO", "SPI", "DRY", "DAI"].includes(prefix)) return "grams";
  if (["BEV", "SAU"].includes(prefix)) return "ml";
  if (["CON", "PCK", "LAB"].includes(prefix)) return "each";
  return fallback || "each";
}

function isSupportSku(sku: string, category = ""): boolean {
  const prefix = skuKey(sku || category).slice(0, 3);
  return ["BEV", "CON", "PCK", "LAB"].includes(prefix);
}

function isMassUom(uom: string): boolean {
  return ["g", "gr", "gram", "grams", "gramm", "kg", "kilogram", "kilograms"].includes(uom.trim().toLowerCase());
}

function cleanSkuName(name: string): string {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+\[PENDING CULINARY REVIEW\]/gi, "")
    .trim();
}

function isGenericSkuName(name: string, sku: string): boolean {
  const value = name.trim().toUpperCase();
  if (!value) return true;
  if (value === skuKey(sku)) return true;
  return /^(SUBRECIPE SKU|INGREDIENT SKU|PRIMARY PACKAGING|SECONDARY PACKAGING|DECREMENT|AUTO MOVE|UNKNOWN|-)$/.test(value);
}

function addPlannedSku(map: Map<string, PlannedSkuInfo>, row: {
  sku: string;
  name: string;
  uom: string;
  category?: string;
  qty: number;
  recipeCode: string;
}): void {
  const key = skuKey(row.sku);
  if (!key) return;
  const current = map.get(key) ?? {
    sku: key,
    name: cleanSkuName(row.name),
    uom: row.uom || skuDefaultUom(key),
    category: row.category ?? key.slice(0, 3),
    plannedQty: 0,
    recipes: new Set<string>(),
    source: "week-plan" as const,
  };
  current.name ||= cleanSkuName(row.name);
  current.uom ||= row.uom || skuDefaultUom(key);
  current.category ||= row.category ?? key.slice(0, 3);
  current.plannedQty += Number.isFinite(row.qty) ? row.qty : 0;
  if (row.recipeCode) current.recipes.add(row.recipeCode);
  current.source = "week-plan";
  map.set(key, current);
}

function addCatalogSku(map: Map<string, PlannedSkuInfo>, row: {
  sku: string;
  name: string;
  uom?: string;
  category?: string;
  recipeCode?: string;
}): void {
  const key = skuKey(row.sku);
  const name = cleanSkuName(row.name);
  if (!key || !name || isGenericSkuName(name, key)) return;
  const current = map.get(key) ?? {
    sku: key,
    name,
    uom: row.uom || skuDefaultUom(key),
    category: row.category ?? key.slice(0, 3),
    plannedQty: 0,
    recipes: new Set<string>(),
    source: "catalog" as const,
  };
  if (isGenericSkuName(current.name, key) || current.source !== "week-plan") current.name = name;
  current.uom ||= row.uom || skuDefaultUom(key);
  current.category ||= row.category ?? key.slice(0, 3);
  if (row.recipeCode) current.recipes.add(row.recipeCode);
  if (current.source !== "week-plan") current.source = "catalog";
  map.set(key, current);
}

function addDetailedSubRecipeCatalog(map: Map<string, PlannedSkuInfo>, node: DetailedSubRecipe, recipeCode: string): void {
  addCatalogSku(map, {
    sku: node.id,
    name: node.name,
    uom: node.uom || "grams",
    category: "SUB",
    recipeCode,
  });
  for (const ingredient of node.ingredients) {
    addCatalogSku(map, {
      sku: ingredient.id,
      name: ingredient.name,
      uom: ingredient.uom,
      category: ingredient.id.slice(0, 3),
      recipeCode,
    });
  }
  for (const child of node.subRecipes) addDetailedSubRecipeCatalog(map, child, recipeCode);
}

function buildPlannedSkuIndex(data: DataBundle, week: string): Map<string, PlannedSkuInfo> {
  const map = new Map<string, PlannedSkuInfo>();
  const markets: Market[] = ["BENL", "DKSE", "DE"];
  const weekRecipes = data.weekRecipes.filter((row) => row.hfWeek === week);
  const weekRecipeCodes = new Set(weekRecipes.map((row) => row.code));

  for (const weekRecipe of weekRecipes) {
    const recipe = data.recipes[weekRecipe.code];
    if (!recipe) continue;

    for (const market of markets) {
      const portions = weekRecipe.verdenVolume[market] ?? 0;
      if (portions <= 0) continue;
      const marketDetails = recipe.markets[market];

      if (marketDetails?.msku) {
        addPlannedSku(map, {
          sku: marketDetails.msku,
          name: marketDetails.recipeNameLocal || recipe.baseName || weekRecipe.recipeName,
          uom: "each",
          category: "MSKU",
          qty: portions,
          recipeCode: weekRecipe.code,
        });
      }

      for (const subRecipe of marketDetails?.subRecipes ?? []) {
        addPlannedSku(map, {
          sku: subRecipe.id,
          name: subRecipe.name,
          uom: subRecipe.yieldUom || "grams",
          category: "SUB",
          qty: portions * (subRecipe.yield ?? 0),
          recipeCode: weekRecipe.code,
        });
      }

      const grossRows = recipe.grossIngredients[market] ?? [];
      if (grossRows.length > 0) {
        for (const ingredient of grossRows as GrossIngredient[]) {
          addPlannedSku(map, {
            sku: ingredient.ingredientId,
            name: ingredient.ingredient,
            uom: ingredient.uom,
            category: ingredient.ingredientCategory,
            qty: ingredient.grossQuantityPerPortion * portions,
            recipeCode: weekRecipe.code,
          });
        }
        continue;
      }

      for (const ingredient of (marketDetails?.ingredients ?? []) as Ingredient[]) {
        addPlannedSku(map, {
          sku: ingredient.ingredientId,
          name: ingredient.name,
          uom: ingredient.uom,
          category: ingredient.ingredientCategory,
          qty: ingredient.quantityPerPortion * portions,
          recipeCode: weekRecipe.code,
        });
      }
    }
  }

  for (const [sku, shelf] of Object.entries(data.shelfLifeBySku ?? {})) {
    const key = skuKey(sku);
    if (!key || map.has(key)) continue;
    map.set(key, {
      sku: key,
      name: shelf.skuName,
      uom: skuDefaultUom(key),
      category: shelf.category ?? key.slice(0, 3),
      plannedQty: 0,
      recipes: new Set<string>(),
      source: "shelf-life",
    });
  }

  for (const recipe of Object.values(data.recipes)) {
    for (const market of markets) {
      const marketDetails = recipe.markets[market];
      if (marketDetails?.msku) {
        addCatalogSku(map, {
          sku: marketDetails.msku,
          name: marketDetails.recipeNameLocal || recipe.baseName,
          uom: "each",
          category: "MSKU",
          recipeCode: recipe.code,
        });
      }
      for (const subRecipe of marketDetails?.subRecipes ?? []) {
        addCatalogSku(map, {
          sku: subRecipe.id,
          name: subRecipe.name,
          uom: subRecipe.yieldUom || "grams",
          category: "SUB",
          recipeCode: recipe.code,
        });
      }
      for (const ingredient of marketDetails?.ingredients ?? []) {
        addCatalogSku(map, {
          sku: ingredient.ingredientId || ingredient.subRecipeId || "",
          name: ingredient.name || ingredient.subRecipeName || "",
          uom: ingredient.uom,
          category: ingredient.ingredientCategory,
          recipeCode: recipe.code,
        });
      }
      for (const ingredient of recipe.grossIngredients[market] ?? []) {
        addCatalogSku(map, {
          sku: ingredient.ingredientId,
          name: ingredient.ingredient,
          uom: ingredient.uom,
          category: ingredient.ingredientCategory,
          recipeCode: recipe.code,
        });
      }
    }
  }

  for (const structure of Object.values(data.structures ?? {})) {
    for (const marketNodes of Object.values(structure.markets)) {
      for (const node of marketNodes ?? []) addDetailedSubRecipeCatalog(map, node, structure.code);
    }
  }

  for (const info of map.values()) {
    info.recipes = new Set([...info.recipes].filter((recipeCode) => weekRecipeCodes.has(recipeCode)));
  }

  return map;
}

function skuInfoForSku(sku: string, index: Map<string, PlannedSkuInfo>): PlannedSkuInfo {
  const key = skuKey(sku);
  const found = index.get(key);
  if (found) return found;
  return {
    sku: key,
    name: key || "-",
    uom: skuDefaultUom(key),
    category: key.slice(0, 3),
    plannedQty: 0,
    recipes: new Set<string>(),
    source: "wms-only",
  };
}

function isPlatingLineLocation(location: string): boolean {
  return /^PLATING-LINE-0[1-3]$/i.test(String(location ?? "").trim());
}

function isPlatingHoldingLocation(location: string): boolean {
  return /^PLH-0[1-4]-0[1-9]$/i.test(String(location ?? "").trim());
}

function platingAreaForLocation(location: string): "Line" | "Holding" | "Staging" {
  const value = String(location ?? "").trim().toUpperCase();
  if (isPlatingLineLocation(value)) return "Line";
  if (isPlatingHoldingLocation(value) || value.includes("PLH")) return "Holding";
  return "Staging";
}

function plannedPiecesForRecipes(data: DataBundle, week: string, recipeCodes: Set<string>): number {
  if (recipeCodes.size === 0) return 0;
  return data.weekRecipes
    .filter((row) => row.hfWeek === week && recipeCodes.has(row.code))
    .reduce((sum, row) => sum + (row.verdenVolume.BENL ?? 0) + (row.verdenVolume.DKSE ?? 0) + (row.verdenVolume.DE ?? 0), 0);
}

function normalizeInstructionToken(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !["with", "more", "half", "diced", "batch", "inclusions", "toasted", "roasted", "compartment", "main", "bento"].includes(token));
}

function instructionLineScore(subName: string, line: string): number {
  const nameTokens = normalizeInstructionToken(subName);
  const lineTokens = new Set(normalizeInstructionToken(line));
  if (nameTokens.length === 0 || lineTokens.size === 0) return 0;
  let score = 0;
  for (const token of nameTokens) {
    if (lineTokens.has(token)) score += token.length >= 7 ? 2 : 1;
  }
  return score;
}

function gramsPerPieceFromPlatingInstructions(
  data: DataBundle,
  week: string,
  sku: string,
  recipeCodes: Set<string>,
): { gramsPerPiece: number | null; source: string } {
  const markets: Market[] = ["BENL", "DKSE", "DE"];
  const skuId = skuKey(sku);
  let weightedGrams = 0;
  let weightedPieces = 0;
  const sources = new Set<string>();

  for (const weekRecipe of data.weekRecipes.filter((row) => row.hfWeek === week && recipeCodes.has(row.code))) {
    const recipe = data.recipes[weekRecipe.code];
    if (!recipe) continue;
    for (const market of markets) {
      const portions = weekRecipe.verdenVolume[market] ?? 0;
      if (portions <= 0) continue;
      const marketDetails = recipe.markets[market];
      const targetSub = marketDetails?.subRecipes.find((subRecipe) => skuKey(subRecipe.id) === skuId);
      if (!marketDetails || !targetSub) continue;

      const instructionLines = marketDetails.subRecipes
        .flatMap((subRecipe) => String(subRecipe.instructions ?? "").split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => /=/.test(line) && /\d+(?:[.,]\d+)?\s*g\b/i.test(line) && !/net\s*weight/i.test(line));

      let best: { grams: number; score: number; line: string } | null = null;
      for (const line of instructionLines) {
        const amountMatch = line.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);
        if (!amountMatch) continue;
        const grams = Number(amountMatch[1].replace(",", "."));
        if (!Number.isFinite(grams) || grams <= 0) continue;
        const score = instructionLineScore(targetSub.name, line);
        if (score <= 0) continue;
        if (!best || score > best.score || (score === best.score && grams > best.grams)) best = { grams, score, line };
      }

      if (best) {
        weightedGrams += best.grams * portions;
        weightedPieces += portions;
        sources.add(`${weekRecipe.code}/${market}: ${fmtNum(best.grams, 1)}g`);
      }
    }
  }

  if (weightedPieces <= 0) return { gramsPerPiece: null, source: "" };
  return {
    gramsPerPiece: weightedGrams / weightedPieces,
    source: [...sources].slice(0, 3).join(", "),
  };
}

function finishedGramsPerPieceFromStructure(data: DataBundle, skuId: string): { grams: number; note: string } | null {
  const targetKey = skuKey(skuId);
  const massUoms = new Set(["grams", "g", "gram", "ml"]);

  function searchNode(node: DetailedSubRecipe): DetailedSubRecipe | null {
    if (skuKey(node.id) === targetKey) return node;
    for (const child of node.subRecipes) {
      const found = searchNode(child);
      if (found) return found;
    }
    return null;
  }

  let firstNode: DetailedSubRecipe | null = null;
  outer:
  for (const structure of Object.values(data.structures ?? {})) {
    for (const nodes of Object.values(structure.markets)) {
      for (const node of (nodes ?? [])) {
        const found = searchNode(node);
        if (found) { firstNode = found; break outer; }
      }
    }
  }
  if (!firstNode) return null;

  const uomLow = (firstNode.uom ?? "").trim().toLowerCase();
  if (massUoms.has(uomLow) && firstNode.quantity && firstNode.quantity > 0) {
    return { grams: firstNode.quantity, note: `${fmtNum(firstNode.quantity, 1)} g/Stk (Rezeptstruktur)` };
  }

  if (firstNode.ingredients && firstNode.ingredients.length > 0) {
    let totalFinishedGrams = 0;
    let yieldPct = 1;
    for (const ing of firstNode.ingredients) {
      if (!massUoms.has((ing.uom ?? "").trim().toLowerCase())) continue;
      const base = ing.netQty > 0 ? ing.netQty : ing.grossQty;
      const yf = ing.yieldPct && ing.yieldPct > 0 && ing.yieldPct <= 1 ? ing.yieldPct : 1;
      yieldPct = yf;
      totalFinishedGrams += base * yf;
    }
    if (totalFinishedGrams > 0) {
      const yieldLabel = yieldPct < 1 ? ` · ${fmtNum(yieldPct * 100, 1)}% Yield` : "";
      return { grams: totalFinishedGrams, note: `${fmtNum(totalFinishedGrams, 1)} g/Stk (Rohgew. × Yield${yieldLabel})` };
    }
  }
  return null;
}

function piecesFromPlhGrams(rawQty: number, info: PlannedSkuInfo, data: DataBundle, week: string): { pieces: number; gramsPerPiece: number | null; note: string } {
  if (rawQty <= 0) return { pieces: 0, gramsPerPiece: null, note: "PLH leer" };

  // 1. Plating-Anleitung: direkte Gramm-Angabe (für Batch-/Sauce-Artikel)
  const instructionRule = gramsPerPieceFromPlatingInstructions(data, week, info.sku, info.recipes);
  if (instructionRule.gramsPerPiece && instructionRule.gramsPerPiece > 0) {
    return {
      pieces: rawQty / instructionRule.gramsPerPiece,
      gramsPerPiece: instructionRule.gramsPerPiece,
      note: `${fmtNum(instructionRule.gramsPerPiece, 1)} g/Stk aus Plating-Anleitung${instructionRule.source ? ` (${instructionRule.source})` : ""}`,
    };
  }

  // 2. Rezeptstruktur: Rohgewicht × Yield = Fertiggewicht pro Stk (für ea/each-Artikel)
  const structureResult = finishedGramsPerPieceFromStructure(data, info.sku);
  if (structureResult) {
    return {
      pieces: rawQty / structureResult.grams,
      gramsPerPiece: structureResult.grams,
      note: structureResult.note,
    };
  }

  return { pieces: 0, gramsPerPiece: null, note: "keine g/Stk-Regel" };
}

function buildPlatingLocationRows(
  data: DataBundle,
  week: string,
  platingRows: WmsPlatingStoredRow[],
  plannedSkuIndex: Map<string, PlannedSkuInfo>,
): PlatingLocationRow[] {
  const map = new Map<string, PlatingLocationRow>();
  for (const row of platingRows) {
    const rawQty = Math.abs(Number(row.actualQty ?? 0));
    if (rawQty <= 0) continue;
    const location = row.locationId || "-";
    const area = platingAreaForLocation(location);
    const info = skuInfoForSku(row.itemNumber, plannedSkuIndex);
    const key = `${location}|${row.itemNumber}`;
    const converted = area === "Line"
      ? { pieces: rawQty, gramsPerPiece: null, note: "Actual Qty = Stk" }
      : piecesFromPlhGrams(rawQty, info, data, week);
    const current = map.get(key) ?? {
      key,
      location,
      area,
      sku: row.itemNumber,
      name: info.name || row.itemNumber || "-",
      rawQty: 0,
      pieces: 0,
      kg: 0,
      gramsPerPiece: converted.gramsPerPiece,
      unitNote: converted.note,
      lots: new Set<string>(),
      hus: new Set<string>(),
      statuses: new Set<string>(),
      recipes: new Set<string>(),
      lastChange: null,
    };
    current.rawQty += rawQty;
    current.pieces += converted.pieces;
    current.kg += area === "Line" ? 0 : rawQty / 1000;
    current.gramsPerPiece ??= converted.gramsPerPiece;
    if (current.unitNote === "keine g/Stk-Regel" && converted.note !== current.unitNote) current.unitNote = converted.note;
    if (row.lotNumber) current.lots.add(row.lotNumber);
    if (row.huId) current.hus.add(row.huId);
    if (row.status) current.statuses.add(row.status);
    for (const recipe of info.recipes) current.recipes.add(recipe);
    if (row.dbChangeCommitTime && (!current.lastChange || row.dbChangeCommitTime > current.lastChange)) current.lastChange = row.dbChangeCommitTime;
    map.set(key, current);
  }
  return Array.from(map.values()).sort((a, b) => {
    const areaOrder = { Line: 0, Holding: 1, Staging: 2 } satisfies Record<PlatingLocationRow["area"], number>;
    return areaOrder[a.area] - areaOrder[b.area] || a.location.localeCompare(b.location, "de") || b.pieces - a.pieces;
  });
}

function sleevingSignalForRow(row: WmsSleevingTranRow): SleevingSignal {
  const from = row.von.toUpperCase();
  const to = row.nach.toUpperCase();
  const type = row.tranType.trim();
  const description = row.description.toUpperCase();
  if (to.includes("LOST") || description.includes("LOST")) return "Lost";
  if (type === "800" || description.includes("CYCLE COUNT")) return "Cycle Count";
  if (type === "721" || description.includes("HOLD")) return "Hold";
  if (to.includes("SLEEV") && !from.includes("SLEEV")) return "Eingang";
  if (from.includes("SLEEV") && !to.includes("SLEEV")) return "Ausgang";
  return "Intern";
}

function buildSleevingCorrectionKeys(rows: WmsSleevingTranRow[]): Set<string> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    const signal = sleevingSignalForRow(row);
    if (signal !== "Lost" && signal !== "Cycle Count") continue;
    const qty = Math.abs(Number(row.tranQty ?? 0));
    const time = row.endTranDate || row.startTranDate || "";
    const key = `${skuKey(row.itemNumber)}|${qty}|${time}|${row.employeeId}`;
    const signals = candidates.get(key) ?? new Set<string>();
    signals.add(signal);
    candidates.set(key, signals);
  }
  const paired = new Set<string>();
  for (const [key, signals] of candidates) {
    if (signals.has("Lost") && signals.has("Cycle Count")) paired.add(key);
  }
  return paired;
}

function sleevingPairKey(row: WmsSleevingTranRow): string {
  const qty = Math.abs(Number(row.tranQty ?? 0));
  const time = row.endTranDate || row.startTranDate || "";
  return `${skuKey(row.itemNumber)}|${qty}|${time}|${row.employeeId}`;
}

function buildSleevingSummaryRows(
  rows: WmsSleevingTranRow[],
  plannedSkuIndex: Map<string, PlannedSkuInfo>,
): SleevingSummaryRow[] {
  const correctionPairs = buildSleevingCorrectionKeys(rows);
  const map = new Map<string, SleevingSummaryRow>();
  for (const row of rows) {
    const sku = skuKey(row.itemNumber);
    if (!sku) continue;
    const info = skuInfoForSku(sku, plannedSkuIndex);
    const current = map.get(sku) ?? {
      key: sku,
      sku,
      name: info.name || sku,
      inbound: 0,
      outbound: 0,
      lost: 0,
      cycleDelta: 0,
      hold: 0,
      internal: 0,
      eventCount: 0,
      correctionPairs: 0,
      employees: new Set<string>(),
      recipes: new Set<string>(),
      lastChange: null,
    };
    const qty = Number(row.tranQty ?? 0);
    const absQty = Math.abs(qty);
    const signal = sleevingSignalForRow(row);
    if (signal === "Eingang") current.inbound += absQty;
    if (signal === "Ausgang") current.outbound += absQty;
    if (signal === "Lost") current.lost += absQty;
    if (signal === "Cycle Count") current.cycleDelta += qty;
    if (signal === "Hold") current.hold += absQty;
    if (signal === "Intern") current.internal += absQty;
    if ((signal === "Lost" || signal === "Cycle Count") && correctionPairs.has(sleevingPairKey(row))) current.correctionPairs += 0.5;
    current.eventCount += 1;
    if (row.employeeId) current.employees.add(row.employeeId);
    for (const recipe of info.recipes) current.recipes.add(recipe);
    const change = row.endTranDate || row.startTranDate;
    if (change && (!current.lastChange || change > current.lastChange)) current.lastChange = change;
    map.set(sku, current);
  }
  return Array.from(map.values()).sort((a, b) => {
    const aSignal = a.inbound + a.outbound + a.lost + Math.abs(a.cycleDelta) + a.hold;
    const bSignal = b.inbound + b.outbound + b.lost + Math.abs(b.cycleDelta) + b.hold;
    return bSignal - aSignal || a.sku.localeCompare(b.sku, "de");
  });
}

function signalTone(signal: SleevingSignal): string {
  if (signal === "Lost") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (signal === "Cycle Count") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (signal === "Hold") return "bg-violet-50 text-violet-800 ring-violet-200";
  if (signal === "Eingang") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (signal === "Ausgang") return "bg-sky-50 text-sky-800 ring-sky-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function buildInboundSummaryRows(
  rows: WmsInboundReceiptRow[],
  plannedSkuIndex: Map<string, PlannedSkuInfo>,
): InboundSummaryRow[] {
  const map = new Map<string, InboundSummaryRow>();
  const detail = new Map<string, { pos: Set<string>; hus: Set<string>; lots: Set<string> }>();
  for (const row of rows) {
    const sku = skuKey(row.itemNumber);
    if (!sku) continue;
    const info = skuInfoForSku(sku, plannedSkuIndex);
    const current = map.get(sku) ?? {
      key: sku,
      sku,
      name: info.name || sku,
      received: 0,
      damaged: 0,
      poCount: 0,
      huCount: 0,
      lotCount: 0,
      vendors: new Set<string>(),
      statuses: new Set<string>(),
      recipes: new Set<string>(),
      lastReceipt: null,
      nextExpiration: null,
    };
    const sets = detail.get(sku) ?? { pos: new Set<string>(), hus: new Set<string>(), lots: new Set<string>() };
    current.received += Number(row.qtyReceived ?? 0);
    current.damaged += Number(row.qtyDamaged ?? 0);
    if (row.poNumber) sets.pos.add(row.poNumber);
    if (row.huId) sets.hus.add(row.huId);
    if (row.lotNumber) sets.lots.add(row.lotNumber);
    if (row.vendorCode) current.vendors.add(row.vendorCode);
    if (row.status) current.statuses.add(row.status);
    if (row.tranStatus) current.statuses.add(row.tranStatus);
    for (const recipe of info.recipes) current.recipes.add(recipe);
    if (row.receiptDate && (!current.lastReceipt || row.receiptDate > current.lastReceipt)) current.lastReceipt = row.receiptDate;
    if (row.expirationDate && (!current.nextExpiration || row.expirationDate < current.nextExpiration)) current.nextExpiration = row.expirationDate;
    current.poCount = sets.pos.size;
    current.huCount = sets.hus.size;
    current.lotCount = sets.lots.size;
    detail.set(sku, sets);
    map.set(sku, current);
  }
  return Array.from(map.values()).sort((a, b) => b.received - a.received || a.sku.localeCompare(b.sku, "de"));
}

function buildStagingSummaryRows(
  rows: WmsStagingStoredRow[],
  plannedSkuIndex: Map<string, PlannedSkuInfo>,
): StagingSummaryRow[] {
  const map = new Map<string, StagingSummaryRow>();
  for (const row of rows) {
    const qty = Math.abs(Number(row.actualQty ?? 0));
    if (qty <= 0) continue;
    const location = row.locationId || "-";
    const sku = skuKey(row.itemNumber);
    const key = `${location}|${sku}`;
    const info = skuInfoForSku(sku, plannedSkuIndex);
    const current = map.get(key) ?? {
      key,
      location,
      sku,
      name: info.name || sku || "-",
      rawQty: 0,
      lots: new Set<string>(),
      hus: new Set<string>(),
      statuses: new Set<string>(),
      recipes: new Set<string>(),
      fifoDate: null,
      expirationDate: null,
      lastChange: null,
    };
    current.rawQty += qty;
    if (row.lotNumber) current.lots.add(row.lotNumber);
    if (row.huId) current.hus.add(row.huId);
    if (row.status) current.statuses.add(row.status);
    for (const recipe of info.recipes) current.recipes.add(recipe);
    if (row.fifoDate && (!current.fifoDate || row.fifoDate < current.fifoDate)) current.fifoDate = row.fifoDate;
    if (row.expirationDate && (!current.expirationDate || row.expirationDate < current.expirationDate)) current.expirationDate = row.expirationDate;
    if (row.dbChangeCommitTime && (!current.lastChange || row.dbChangeCommitTime > current.lastChange)) current.lastChange = row.dbChangeCommitTime;
    map.set(key, current);
  }
  return Array.from(map.values()).sort((a, b) => a.location.localeCompare(b.location, "de") || b.rawQty - a.rawQty || a.sku.localeCompare(b.sku, "de"));
}

function buildRecipeProcessRows(deboxRows: StagingSummaryRow[], postblastRows: StagingSummaryRow[]): RecipeProcessRow[] {
  const map = new Map<string, RecipeProcessRow>();
  const touch = (recipe: string): RecipeProcessRow => {
    const key = recipe || "nicht im Plan";
    const current = map.get(key) ?? {
      key,
      recipe: key,
      deboxQty: 0,
      postblastQty: 0,
      deboxSkus: new Set<string>(),
      postblastSkus: new Set<string>(),
      deboxNames: new Set<string>(),
      postblastNames: new Set<string>(),
    };
    map.set(key, current);
    return current;
  };

  for (const row of deboxRows) {
    const recipes = row.recipes.size > 0 ? [...row.recipes] : ["nicht im Plan"];
    for (const recipe of recipes) {
      const current = touch(recipe);
      current.deboxQty += row.rawQty;
      if (row.sku) current.deboxSkus.add(row.sku);
      if (row.name) current.deboxNames.add(row.name);
    }
  }

  for (const row of postblastRows) {
    const recipes = row.recipes.size > 0 ? [...row.recipes] : ["nicht im Plan"];
    for (const recipe of recipes) {
      const current = touch(recipe);
      current.postblastQty += row.rawQty;
      if (row.sku) current.postblastSkus.add(row.sku);
      if (row.name) current.postblastNames.add(row.name);
    }
  }

  return Array.from(map.values()).sort((a, b) => (b.deboxQty + b.postblastQty) - (a.deboxQty + a.postblastQty) || a.recipe.localeCompare(b.recipe, "de"));
}

function weekRecipePieces(data: DataBundle, week: string): number {
  return data.weekRecipes
    .filter((row) => row.hfWeek === week)
    .reduce((sum, row) => sum + (row.verdenVolume.BENL ?? 0) + (row.verdenVolume.DKSE ?? 0) + (row.verdenVolume.DE ?? 0), 0);
}

function recipeSubDemandQty(data: DataBundle, week: string, recipeCode: string, sku: string): number {
  const weekRecipe = data.weekRecipes.find((row) => row.hfWeek === week && row.code === recipeCode);
  const recipe = data.recipes[recipeCode];
  if (!weekRecipe || !recipe) return 0;
  const markets: Market[] = ["BENL", "DKSE", "DE"];
  const skuId = skuKey(sku);
  const instructionRule = gramsPerPieceFromPlatingInstructions(data, week, skuId, new Set([recipeCode]));
  const gramsPerPiece = instructionRule.gramsPerPiece;
  let total = 0;
  for (const market of markets) {
    const portions = weekRecipe.verdenVolume[market] ?? 0;
    if (portions <= 0) continue;
    const subRecipe = recipe.markets[market]?.subRecipes.find((sub) => skuKey(sub.id) === skuId);
    if (!subRecipe) continue;
    if (gramsPerPiece && gramsPerPiece > 0) {
      total += portions * gramsPerPiece;
    } else {
      total += portions * Math.max(0, Number(subRecipe.yield ?? 1));
    }
  }
  return total;
}

function buildCommandSkuRows(
  data: DataBundle,
  week: string,
  plannedSkuIndex: Map<string, PlannedSkuInfo>,
  platingRows: PlatingLocationRow[],
  sleevingRows: SleevingSummaryRow[],
  inboundRows: InboundSummaryRow[],
  stagingRows: StagingSummaryRow[],
  deboxRows: StagingSummaryRow[],
  postblastRows: StagingSummaryRow[],
): CommandSkuRow[] {
  const keys = new Set<string>(plannedSkuIndex.keys());
  for (const row of platingRows) keys.add(skuKey(row.sku));
  for (const row of sleevingRows) keys.add(skuKey(row.sku));
  for (const row of inboundRows) keys.add(skuKey(row.sku));
  for (const row of stagingRows) keys.add(skuKey(row.sku));
  for (const row of deboxRows) keys.add(skuKey(row.sku));
  for (const row of postblastRows) keys.add(skuKey(row.sku));

  const totalBy = <T extends { sku: string }>(rows: T[], selector: (row: T) => number): Map<string, number> => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = skuKey(row.sku);
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + selector(row));
    }
    return map;
  };

  const linePiecesBySku = totalBy(platingRows.filter((row) => row.area === "Line"), (row) => row.pieces);
  const holdingPiecesBySku = totalBy(platingRows.filter((row) => row.area !== "Line"), (row) => row.pieces);
  const holdingKgBySku = totalBy(platingRows.filter((row) => row.area !== "Line"), (row) => row.kg);
  const inboundBySku = totalBy(inboundRows, (row) => row.received);
  const damagedBySku = totalBy(inboundRows, (row) => row.damaged);
  const stagingBySku = totalBy(stagingRows, (row) => row.rawQty);
  const deboxBySku = totalBy(deboxRows, (row) => row.rawQty);
  const postblastBySku = totalBy(postblastRows, (row) => row.rawQty);
  const sleevingInboundBySku = totalBy(sleevingRows, (row) => row.inbound);
  const sleevingOutboundBySku = totalBy(sleevingRows, (row) => row.outbound);
  const sleevingLostBySku = totalBy(sleevingRows, (row) => row.lost);
  const sleevingHoldBySku = totalBy(sleevingRows, (row) => row.hold);

  return [...keys].filter(Boolean).map((key) => {
    const info = skuInfoForSku(key, plannedSkuIndex);
    const plannedPieces = plannedPiecesForRecipes(data, week, info.recipes);
    const row: CommandSkuRow = {
      key,
      sku: key,
      name: info.name || key,
      category: info.category || key.slice(0, 3),
      uom: info.uom || skuDefaultUom(key),
      plannedQty: info.plannedQty,
      plannedPieces,
      recipes: new Set(info.recipes),
      inboundReceived: inboundBySku.get(key) ?? 0,
      inboundDamaged: damagedBySku.get(key) ?? 0,
      deboxQty: deboxBySku.get(key) ?? 0,
      postblastQty: postblastBySku.get(key) ?? 0,
      platingLinePieces: linePiecesBySku.get(key) ?? 0,
      platingHoldingPieces: holdingPiecesBySku.get(key) ?? 0,
      platingHoldingKg: holdingKgBySku.get(key) ?? 0,
      sleevingInbound: sleevingInboundBySku.get(key) ?? 0,
      sleevingOutbound: sleevingOutboundBySku.get(key) ?? 0,
      sleevingLost: sleevingLostBySku.get(key) ?? 0,
      sleevingHold: sleevingHoldBySku.get(key) ?? 0,
      stagingQty: stagingBySku.get(key) ?? 0,
      matchSource: info.source,
      status: "signal",
      statusText: "WMS-Signal",
      riskScore: 0,
    };

    const isMain = row.category === "MSKU";
    const isSub = row.sku.startsWith("SUB") || row.category === "SUB";
    const isSupport = isSupportSku(row.sku, row.category);
    const hasPlan = row.plannedQty > 0;
    const hasOutput = row.platingLinePieces > 0 || row.postblastQty > 0 || row.platingHoldingPieces > 0 || row.stagingQty > 0;
    const noMatch = row.matchSource === "wms-only" || row.recipes.size === 0;
    const lossSignal = row.sleevingLost + row.sleevingHold + row.inboundDamaged;
    const processSignal = row.platingLinePieces + row.postblastQty + row.platingHoldingPieces + row.deboxQty + row.sleevingInbound + row.sleevingOutbound;
    const inventorySignal = row.inboundReceived + row.stagingQty;

    if (noMatch && (processSignal > 0 || inventorySignal > 0)) {
      row.status = isSupport && processSignal <= 0 ? "pruefen" : "kritisch";
      row.statusText = isSupport && processSignal <= 0 ? "Support-Artikel ohne KW-Match" : "WMS ohne KW-Match";
      row.riskScore += isSupport && processSignal <= 0 ? 35 : 80;
    } else if (isMain && hasPlan) {
      const coverage = row.platingLinePieces / Math.max(1, row.plannedQty);
      if (coverage >= 0.98) {
        row.status = "gedeckt";
        row.statusText = "Main gedeckt";
      } else if (row.platingLinePieces > 0) {
        row.status = "laeuft";
        row.statusText = "Main laeuft";
        row.riskScore += Math.round((1 - coverage) * 45);
      } else {
        row.status = "kritisch";
        row.statusText = "Main ohne Output";
        row.riskScore += 70;
      }
    } else if (isSub && hasPlan) {
      if (row.postblastQty > 0 || row.platingHoldingPieces > 0 || row.stagingQty > 0) {
        row.status = "laeuft";
        row.statusText = "Sub im Prozess";
      } else {
        row.status = "pruefen";
        row.statusText = "Sub geplant ohne Signal";
        row.riskScore += 45;
      }
    } else if (hasPlan) {
      row.status = hasOutput || row.inboundReceived > 0 ? "laeuft" : "pruefen";
      row.statusText = hasOutput || row.inboundReceived > 0 ? "Artikel im Prozess" : "Geplant ohne Signal";
      if (!hasOutput && row.inboundReceived <= 0) row.riskScore += 30;
    }

    if (lossSignal > 0) {
      row.riskScore += 35;
      if (row.status !== "kritisch") {
        row.status = "pruefen";
        row.statusText = "Lost/Hold/Damaged";
      }
    }

    return row;
  }).sort((a, b) => b.riskScore - a.riskScore || b.plannedQty - a.plannedQty || a.sku.localeCompare(b.sku, "de"));
}

function buildCommandRecipeRows(data: DataBundle, week: string, skuRows: CommandSkuRow[], historyRows: WmsSleevingTranRow[] = []): CommandRecipeRow[] {
  const skuByKey = new Map(skuRows.map((row) => [row.sku, row]));
  const weekRows = data.weekRecipes.filter((row) => row.hfWeek === week);
  const selectedMainSkus = new Set<string>();
  for (const weekRecipe of weekRows) {
    const recipe = data.recipes[weekRecipe.code];
    const markets: Market[] = ["BENL", "DKSE", "DE"];
    for (const market of markets) {
      const msku = recipe?.markets[market]?.msku;
      if (msku) selectedMainSkus.add(skuKey(msku));
    }
  }

  const historyCreatedBySku = new Map<string, number>();
  const historyFallbackBySku = new Map<string, number>();
  for (const row of historyRows) {
    const sku = skuKey(row.itemNumber);
    if (!sku || !selectedMainSkus.has(sku)) continue;
    const from = String(row.von ?? "").toUpperCase();
    const to = String(row.nach ?? "").toUpperCase();
    const type = String(row.tranType ?? "").trim();
    const description = String(row.description ?? "").toUpperCase();
    const touchesPlatingLine = from.includes("PLATING-LINE") || to.includes("PLATING-LINE");
    const internalLineMove = from.includes("PLATING-LINE") && to.includes("PLATING-LINE");
    const correctionMove = type === "800" || type === "721" || description.includes("CYCLE COUNT") || description.includes("HOLD") || description.includes("LOST");
    if (!touchesPlatingLine || internalLineMove || correctionMove) continue;
    const qty = Math.abs(Number(row.tranQty ?? 0));
    if (qty <= 0) continue;
    const createdSignal = type === "651" || description.includes("LICENSE PLATE CREATED");
    const target = createdSignal ? historyCreatedBySku : historyFallbackBySku;
    target.set(sku, (target.get(sku) ?? 0) + qty);
  }
  const historyBySku = new Map<string, number>();
  for (const sku of selectedMainSkus) {
    historyBySku.set(sku, historyCreatedBySku.get(sku) ?? historyFallbackBySku.get(sku) ?? 0);
  }
  const skuDemandByRecipe = new Map<string, Map<string, number>>();
  const skuDemandTotal = new Map<string, number>();

  for (const weekRecipe of weekRows) {
    const recipe = data.recipes[weekRecipe.code];
    if (!recipe) continue;
    const subSkus = new Set<string>();
    const markets: Market[] = ["BENL", "DKSE", "DE"];
    for (const market of markets) {
      for (const subRecipe of recipe.markets[market]?.subRecipes ?? []) subSkus.add(skuKey(subRecipe.id));
    }
    for (const sku of subSkus) {
      const demand = recipeSubDemandQty(data, week, weekRecipe.code, sku);
      if (demand <= 0) continue;
      const byRecipe = skuDemandByRecipe.get(sku) ?? new Map<string, number>();
      byRecipe.set(weekRecipe.code, demand);
      skuDemandByRecipe.set(sku, byRecipe);
      skuDemandTotal.set(sku, (skuDemandTotal.get(sku) ?? 0) + demand);
    }
  }

  const recipeShareForSku = (recipeCode: string, sku: string): number => {
    const key = skuKey(sku);
    const total = skuDemandTotal.get(key) ?? 0;
    if (total <= 0) return 1;
    return (skuDemandByRecipe.get(key)?.get(recipeCode) ?? 0) / total;
  };

  return weekRows.map((weekRecipe) => {
    const recipe = data.recipes[weekRecipe.code];
    const mainSkus = new Set<string>();
    const subSkus = new Set<string>();
    const markets: Market[] = ["BENL", "DKSE", "DE"];
    for (const market of markets) {
      const details = recipe?.markets[market];
      if (details?.msku) mainSkus.add(skuKey(details.msku));
      for (const subRecipe of details?.subRecipes ?? []) subSkus.add(skuKey(subRecipe.id));
    }

    const plannedPieces = (weekRecipe.verdenVolume.BENL ?? 0) + (weekRecipe.verdenVolume.DKSE ?? 0) + (weekRecipe.verdenVolume.DE ?? 0);
    const mainRows = [...mainSkus].map((sku) => skuByKey.get(sku)).filter((row): row is CommandSkuRow => Boolean(row));
    const subRows = [...subSkus].map((sku) => skuByKey.get(sku)).filter((row): row is CommandSkuRow => Boolean(row));
    const allRows = [...mainRows, ...subRows];
    const mainOutputPieces = mainRows.reduce((sum, row) => sum + row.platingLinePieces, 0);
    const historicalOutputPieces = [...mainSkus].reduce((sum, sku) => sum + (historyBySku.get(sku) ?? 0), 0);
    const totalOutputPieces = mainOutputPieces + historicalOutputPieces;
    const subPostblastQty = subRows.reduce((sum, row) => sum + row.postblastQty * recipeShareForSku(weekRecipe.code, row.sku), 0);
    const subDeboxQty = subRows.reduce((sum, row) => sum + row.deboxQty * recipeShareForSku(weekRecipe.code, row.sku), 0);
    const subHoldingPieces = subRows.reduce((sum, row) => sum + row.platingHoldingPieces * recipeShareForSku(weekRecipe.code, row.sku), 0);
    const holdingSignals = subRows
      .map((row) => row.platingHoldingPieces * recipeShareForSku(weekRecipe.code, row.sku))
      .filter((pieces) => pieces > 0);
    const holdingStandPieces = holdingSignals.length > 0 ? Math.min(...holdingSignals) : 0;
    const standPieces = Math.max(totalOutputPieces, holdingStandPieces);
    const sleevingLost = allRows.reduce((sum, row) => sum + row.sleevingLost * (row.category === "MSKU" ? 1 : recipeShareForSku(weekRecipe.code, row.sku)), 0);
    const sleevingHold = allRows.reduce((sum, row) => sum + row.sleevingHold * (row.category === "MSKU" ? 1 : recipeShareForSku(weekRecipe.code, row.sku)), 0);
    const noMatchSignals = allRows.filter((row) => row.matchSource === "wms-only" || row.recipes.size === 0).length;
    const subSignalSharedCount = subRows.filter((row) => (skuDemandByRecipe.get(row.sku)?.size ?? row.recipes.size) > 1).length;
    const coverage = standPieces / Math.max(1, plannedPieces);
    let status: CommandRecipeRow["status"] = "offen";
    let statusText = "Noch kein Main-Output";
    if (plannedPieces <= 0) {
      status = "pruefen";
      statusText = "kein Bedarf";
    } else if (coverage >= 0.98) {
      status = "gedeckt";
      statusText = "Bedarf gedeckt";
    } else if (mainOutputPieces > 0) {
      status = "laeuft";
      statusText = "Plating laeuft";
    } else if (historicalOutputPieces > 0) {
      status = "laeuft";
      statusText = "Historie gebaut";
    } else if (subPostblastQty > 0 || subHoldingPieces > 0 || subDeboxQty > 0) {
      status = "pruefen";
      statusText = "Sub Meal Signal";
    }
    if (sleevingLost > 0 || sleevingHold > 0 || noMatchSignals > 0) {
      status = status === "gedeckt" ? "pruefen" : "kritisch";
      statusText = "Bewegung pruefen";
    }

    return {
      key: weekRecipe.code,
      recipe: weekRecipe.code,
      name: recipe?.baseName || weekRecipe.recipeName || weekRecipe.code,
      plannedPieces,
      mainSkus,
      subSkus,
      mainOutputPieces,
      historicalOutputPieces,
      totalOutputPieces,
      holdingStandPieces,
      standPieces,
      subPlannedQty: subRows.reduce((sum, row) => sum + row.plannedQty, 0),
      subPostblastQty,
      subDeboxQty,
      subHoldingPieces,
      subSignalSharedCount,
      sleevingLost,
      sleevingHold,
      noMatchSignals,
      status,
      statusText,
    };
  }).sort((a, b) => {
    const order: Record<CommandRecipeRow["status"], number> = { kritisch: 0, pruefen: 1, offen: 2, laeuft: 3, gedeckt: 4 };
    return order[a.status] - order[b.status] || b.plannedPieces - a.plannedPieces || a.recipe.localeCompare(b.recipe, "de");
  });
}

function commandStatusTone(status: CommandSkuRow["status"] | CommandRecipeRow["status"]): string {
  if (status === "kritisch") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (status === "pruefen" || status === "offen") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (status === "laeuft") return "bg-sky-50 text-sky-800 ring-sky-200";
  if (status === "gedeckt") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function exportMealCsv(
  recipeRow: CommandRecipeRow,
  mainSkuRows: CommandSkuRow[],
  subSkuRows: CommandSkuRow[],
  stagingRows: StagingSummaryRow[],
  sleevingRows: SleevingSummaryRow[],
  platingRows: PlatingLocationRow[],
  inboundRows: InboundSummaryRow[],
): void {
  const sep = ";";
  const lines: string[] = [];
  const section = (title: string) => { lines.push(""); lines.push(`# ${title}`); };
  const coverage = recipeRow.plannedPieces > 0 ? Math.round((recipeRow.standPieces / recipeRow.plannedPieces) * 100) : 0;
  lines.push(`# WMS Drill-Down Export`);
  lines.push(`# Rezept: ${recipeRow.recipe} | ${recipeRow.name}`);
  lines.push(`# Stand: ${new Date().toLocaleString("de-DE")}`);
  lines.push(`# Status: ${recipeRow.statusText} | Coverage: ${coverage}%`);
  section("Zusammenfassung");
  lines.push(["Kennzahl", "Wert"].join(sep));
  lines.push(["Geplant Stk", recipeRow.plannedPieces].join(sep));
  lines.push(["Aktuell Line Stk", recipeRow.mainOutputPieces].join(sep));
  lines.push(["Vorher gebaut Stk", recipeRow.historicalOutputPieces].join(sep));
  lines.push(["Gesamt Ist Stk", recipeRow.totalOutputPieces].join(sep));
  lines.push(["Stand Stk", recipeRow.standPieces].join(sep));
  lines.push(["Gap Stk", recipeRow.plannedPieces - recipeRow.standPieces].join(sep));
  lines.push(["Coverage %", coverage].join(sep));
  if (mainSkuRows.length > 0) {
    section("Main MSKU – Fertige Mahlzeiten");
    lines.push(["SKU", "Name", "Geplant Stk", "Line Stk", "Holding Stk", "Ist gesamt Stk", "Status"].join(sep));
    for (const row of mainSkuRows) {
      lines.push([row.sku, row.name, row.plannedPieces, row.platingLinePieces, row.platingHoldingPieces, row.platingLinePieces + row.platingHoldingPieces, row.statusText].join(sep));
    }
  }
  if (subSkuRows.length > 0) {
    section("Sub Rezepte & Zutaten");
    lines.push(["SKU", "Name", "Geplant", "Inbound g", "Debox g", "Postblast g", "Holding Stk", "Slv Eingang", "Lost", "Status"].join(sep));
    for (const row of subSkuRows) {
      lines.push([row.sku, row.name, row.plannedQty, row.inboundReceived, row.deboxQty, row.postblastQty, row.platingHoldingPieces, row.sleevingInbound, row.sleevingLost, row.statusText].join(sep));
    }
  }
  if (stagingRows.length > 0) {
    section("Staging Bestand");
    lines.push(["Location", "SKU", "Name", "Menge g", "MHD", "Letzte Aenderung"].join(sep));
    for (const row of stagingRows) {
      lines.push([row.location, row.sku, row.name, row.rawQty, row.expirationDate ?? "", row.lastChange ?? ""].join(sep));
    }
  }
  if (sleevingRows.length > 0) {
    section("Sleeving Netto-Bilanz");
    lines.push(["SKU", "Name", "Eingang", "Ausgang", "Lost", "Hold", "Netto"].join(sep));
    for (const row of sleevingRows) {
      lines.push([row.sku, row.name, row.inbound, row.outbound, row.lost, row.hold, row.inbound - row.outbound - row.lost].join(sep));
    }
  }
  if (platingRows.length > 0) {
    section("Plating Locations");
    lines.push(["Location", "Bereich", "SKU", "Stueck", "kg", "Letzte Aenderung"].join(sep));
    for (const row of platingRows) {
      lines.push([row.location, row.area, row.sku, Math.round(row.pieces), row.kg.toFixed(2), row.lastChange ?? ""].join(sep));
    }
  }
  if (inboundRows.length > 0) {
    section("Wareneingang");
    lines.push(["SKU", "Name", "Erhalten g", "Beschaedigt g", "POs", "Lots"].join(sep));
    for (const row of inboundRows) {
      lines.push([row.sku, row.name, row.received, row.damaged, row.poCount, row.lotCount].join(sep));
    }
  }
  const csv = lines.join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `wms-meal-${recipeRow.recipe}-${localDateIso()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function WmsLiveView({ data, week }: Props): JSX.Element {
  const [platingPayload, setPlatingPayload] = useState<WmsPlatingPayload | null>(null);
  const [platingHistoryPayload, setPlatingHistoryPayload] = useState<WmsPlatingHistoryPayload | null>(null);
  const [sleevingPayload, setSleevingPayload] = useState<WmsSleevingPayload | null>(null);
  const [inboundPayload, setInboundPayload] = useState<WmsInboundPayload | null>(null);
  const [stagingPayload, setStagingPayload] = useState<WmsStagingPayload | null>(null);
  const [deboxPayload, setDeboxPayload] = useState<WmsDeboxPayload | null>(null);
  const [postblastPayload, setPostblastPayload] = useState<WmsPostblastPayload | null>(null);
  const [workordersPayload, setWorkordersPayload] = useState<WmsWorkordersPayload | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(25000);
  const [search, setSearch] = useState("");
  const [sleevingSearch, setSleevingSearch] = useState("");
  const [inboundSearch, setInboundSearch] = useState("");
  const [stagingSearch, setStagingSearch] = useState("");
  const [deboxSearch, setDeboxSearch] = useState("");
  const [selectedRecipe, setSelectedRecipe] = useState<string | null>(null);
  const [compareRecipe, setCompareRecipe] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "meals" | "workorders" | "plating" | "sleeving" | "inbound" | "prozess">("overview");
  const detailRef = useRef<HTMLElement>(null);
  const toolRange = useMemo(() => wmsRangeForToolWeek(week), [week]);
  const plannedSkuIndex = useMemo(() => buildPlannedSkuIndex(data, week), [data, week]);

  const load = async (): Promise<void> => {
    setState("loading");
    setError(null);
    try {
      const params = new URLSearchParams({
        whId: "VF",
        week,
        limit: String(limit),
        ts: String(Date.now()),
      });
      const workordersParams = new URLSearchParams({ whId: "VF", limit: String(limit), ts: String(Date.now()) });
      const [platingResponse, platingHistoryResponse, sleevingResponse, inboundResponse, stagingResponse, deboxResponse, postblastResponse, workordersResponse] = await Promise.all([
        fetch(`${LOCAL_PLATING_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_PLATING_HISTORY_ENDPOINT}?${params.toString()}&lookbackDays=28`, { cache: "no-store" }),
        fetch(`${LOCAL_SLEEVING_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_INBOUND_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_STAGING_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_DEBOX_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_POSTBLAST_ENDPOINT}?${params.toString()}`, { cache: "no-store" }),
        fetch(`${LOCAL_WORKORDERS_ENDPOINT}?${workordersParams.toString()}`, { cache: "no-store" }),
      ]);
      if (!platingResponse.ok) throw new Error(`Plating Query HTTP ${platingResponse.status}`);
      if (!platingHistoryResponse.ok) throw new Error(`Plating History Query HTTP ${platingHistoryResponse.status}`);
      if (!sleevingResponse.ok) throw new Error(`Sleeving Query HTTP ${sleevingResponse.status}`);
      if (!inboundResponse.ok) throw new Error(`Inbound Query HTTP ${inboundResponse.status}`);
      if (!stagingResponse.ok) throw new Error(`Staging Query HTTP ${stagingResponse.status}`);
      if (!deboxResponse.ok) throw new Error(`Debox Query HTTP ${deboxResponse.status}`);
      if (!postblastResponse.ok) throw new Error(`Postblast Query HTTP ${postblastResponse.status}`);
      const platingJson = await platingResponse.json() as WmsPlatingPayload;
      const platingHistoryJson = await platingHistoryResponse.json() as WmsPlatingHistoryPayload;
      const sleevingJson = await sleevingResponse.json() as WmsSleevingPayload;
      const inboundJson = await inboundResponse.json() as WmsInboundPayload;
      const stagingJson = await stagingResponse.json() as WmsStagingPayload;
      const deboxJson = await deboxResponse.json() as WmsDeboxPayload;
      const postblastJson = await postblastResponse.json() as WmsPostblastPayload;
      const workordersJson = workordersResponse.ok ? await workordersResponse.json() as WmsWorkordersPayload : { ok: true, rows: [] };
      if (!platingJson.ok) throw new Error(platingJson.error ?? "Plating Query fehlgeschlagen");
      if (!platingHistoryJson.ok) throw new Error(platingHistoryJson.error ?? "Plating History Query fehlgeschlagen");
      if (!sleevingJson.ok) throw new Error(sleevingJson.error ?? "Sleeving Query fehlgeschlagen");
      if (!inboundJson.ok) throw new Error(inboundJson.error ?? "Inbound Query fehlgeschlagen");
      if (!stagingJson.ok) throw new Error(stagingJson.error ?? "Staging Query fehlgeschlagen");
      if (!deboxJson.ok) throw new Error(deboxJson.error ?? "Debox Query fehlgeschlagen");
      if (!postblastJson.ok) throw new Error(postblastJson.error ?? "Postblast Query fehlgeschlagen");
      setPlatingPayload(platingJson);
      setPlatingHistoryPayload(platingHistoryJson);
      setSleevingPayload(sleevingJson);
      setInboundPayload(inboundJson);
      setStagingPayload(stagingJson);
      setDeboxPayload(deboxJson);
      setPostblastPayload(postblastJson);
      setWorkordersPayload(workordersJson);
      setState("ready");
    } catch (loadError) {
      setPlatingPayload(null);
      setPlatingHistoryPayload(null);
      setSleevingPayload(null);
      setInboundPayload(null);
      setStagingPayload(null);
      setDeboxPayload(null);
      setPostblastPayload(null);
      setWorkordersPayload(null);
      setState("error");
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => {
    void load();
  }, [week]);

  const rawRows = platingPayload?.rows ?? [];
  const platingHistoryRawRows = platingHistoryPayload?.rows ?? [];
  const workordersRawRows = workordersPayload?.rows ?? [];
  const wmsWeekCode = useMemo(() => toolWeekToWmsWeek(week), [week]);
  const workordersIndex = useMemo(() => buildWorkordersIndex(workordersRawRows), [workordersRawRows]);

  // Workorders: kein -7d Shift — V_SUBMEAL_PRODUCTION hat eigene week-Spalte (z.B. "202622")
  // direkt nach Tool-KW filtern, kein Vorwoche-Fallback
  const workordersForWeek = useMemo(() => {
    if (workordersRawRows.length === 0) return [];
    const code = toolWeekToWmsWeek(week); // "2026-W22" → "202622"
    if (!code) return [];
    return workordersRawRows.filter((r) => r.week === code);
  }, [week, workordersRawRows]);

  // Gruppiert nach Meal für die UI
  type WorkordersMealGroup = {
    mealItemNumber: string;
    mealItemDescription: string;
    submeals: WmsWorkordersRow[];
    totalQtyG: number;
    matchedRecipe: string | null;
  };
  const workordersByMeal = useMemo((): WorkordersMealGroup[] => {
    const map = new Map<string, WorkordersMealGroup>();
    for (const row of workordersForWeek) {
      const key = row.mealItemNumber || row.mealItemDescription;
      const group = map.get(key) ?? {
        mealItemNumber: row.mealItemNumber,
        mealItemDescription: row.mealItemDescription,
        submeals: [],
        totalQtyG: 0,
        matchedRecipe: null,
      };
      group.submeals.push(row);
      group.totalQtyG += row.quantity ?? 0;
      if (!group.matchedRecipe) {
        const recipeCode = row.mealItemNumber?.match(/^(REC-\d{6}-\d-\d{3})$/)?.[1] ?? null;
        group.matchedRecipe = recipeCode;
      }
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => b.totalQtyG - a.totalQtyG);
  }, [workordersForWeek]);
  const sleevingRawRows = sleevingPayload?.rows ?? [];
  const inboundRawRows = inboundPayload?.rows ?? [];
  const stagingRawRows = stagingPayload?.rows ?? [];
  const deboxRawRows = deboxPayload?.rows ?? [];
  const postblastRawRows = postblastPayload?.rows ?? [];
  const rangeStart = platingPayload?.rangeStart ?? sleevingPayload?.rangeStart ?? inboundPayload?.rangeStart ?? stagingPayload?.rangeStart ?? deboxPayload?.rangeStart ?? postblastPayload?.rangeStart ?? toolRange.rangeStart;
  const rangeEnd = platingPayload?.rangeEnd ?? sleevingPayload?.rangeEnd ?? inboundPayload?.rangeEnd ?? stagingPayload?.rangeEnd ?? deboxPayload?.rangeEnd ?? postblastPayload?.rangeEnd ?? toolRange.rangeEnd;
  const historyRangeStart = platingHistoryPayload?.rangeStart ?? "-";
  const historyRangeEnd = platingHistoryPayload?.rangeEnd ?? "-";
  const wmsWeek = platingPayload?.wmsWeek ?? sleevingPayload?.wmsWeek ?? inboundPayload?.wmsWeek ?? stagingPayload?.wmsWeek ?? deboxPayload?.wmsWeek ?? postblastPayload?.wmsWeek ?? toolRange.wmsWeek;
  const platingRows = useMemo(
    () => buildPlatingLocationRows(data, week, rawRows, plannedSkuIndex),
    [data, plannedSkuIndex, rawRows, week],
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toUpperCase();
    if (!needle) return platingRows;
    return platingRows.filter((row) => [
      row.location,
      row.area,
      row.sku,
      row.name,
      [...row.recipes].join(" "),
      [...row.lots].join(" "),
      [...row.hus].join(" "),
      [...row.statuses].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [platingRows, search]);

  const sleevingSummaryRows = useMemo(
    () => buildSleevingSummaryRows(sleevingRawRows, plannedSkuIndex),
    [plannedSkuIndex, sleevingRawRows],
  );

  const filteredSleevingSummaryRows = useMemo(() => {
    const needle = sleevingSearch.trim().toUpperCase();
    if (!needle) return sleevingSummaryRows;
    return sleevingSummaryRows.filter((row) => [
      row.sku,
      row.name,
      [...row.recipes].join(" "),
      [...row.employees].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [sleevingSearch, sleevingSummaryRows]);

  const filteredSleevingEvents = useMemo(() => {
    const needle = sleevingSearch.trim().toUpperCase();
    const rows = sleevingRawRows.slice(0, 800);
    if (!needle) return rows;
    return rows.filter((row) => [
      row.von,
      row.nach,
      row.tranType,
      row.itemNumber,
      skuInfoForSku(row.itemNumber, plannedSkuIndex).name,
      row.employeeId,
      row.description,
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [plannedSkuIndex, sleevingRawRows, sleevingSearch]);
  const sleevingCorrectionKeys = useMemo(() => buildSleevingCorrectionKeys(sleevingRawRows), [sleevingRawRows]);

  const inboundSummaryRows = useMemo(
    () => buildInboundSummaryRows(inboundRawRows, plannedSkuIndex),
    [inboundRawRows, plannedSkuIndex],
  );

  const filteredInboundSummaryRows = useMemo(() => {
    const needle = inboundSearch.trim().toUpperCase();
    if (!needle) return inboundSummaryRows;
    return inboundSummaryRows.filter((row) => [
      row.sku,
      row.name,
      [...row.vendors].join(" "),
      [...row.statuses].join(" "),
      [...row.recipes].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [inboundSearch, inboundSummaryRows]);

  const filteredInboundEvents = useMemo(() => {
    const needle = inboundSearch.trim().toUpperCase();
    const rows = inboundRawRows.slice(0, 800);
    if (!needle) return rows;
    return rows.filter((row) => [
      row.poNumber,
      row.itemNumber,
      skuInfoForSku(row.itemNumber, plannedSkuIndex).name,
      row.vendorCode,
      row.huId,
      row.lotNumber,
      row.shipmentNumber,
      row.status,
      row.tranStatus,
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [inboundRawRows, inboundSearch, plannedSkuIndex]);

  const stagingSummaryRows = useMemo(
    () => buildStagingSummaryRows(stagingRawRows, plannedSkuIndex),
    [plannedSkuIndex, stagingRawRows],
  );

  const deboxSummaryRows = useMemo(
    () => buildStagingSummaryRows(deboxRawRows, plannedSkuIndex),
    [deboxRawRows, plannedSkuIndex],
  );

  const postblastSummaryRows = useMemo(
    () => buildStagingSummaryRows(postblastRawRows, plannedSkuIndex),
    [plannedSkuIndex, postblastRawRows],
  );

  const processRecipeRows = useMemo(
    () => buildRecipeProcessRows(deboxSummaryRows, postblastSummaryRows),
    [deboxSummaryRows, postblastSummaryRows],
  );

  const filteredStagingRows = useMemo(() => {
    const needle = stagingSearch.trim().toUpperCase();
    if (!needle) return stagingSummaryRows;
    return stagingSummaryRows.filter((row) => [
      row.location,
      row.sku,
      row.name,
      [...row.lots].join(" "),
      [...row.hus].join(" "),
      [...row.statuses].join(" "),
      [...row.recipes].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [stagingSearch, stagingSummaryRows]);

  const filteredDeboxRows = useMemo(() => {
    const needle = deboxSearch.trim().toUpperCase();
    if (!needle) return deboxSummaryRows;
    return deboxSummaryRows.filter((row) => [
      row.location,
      row.sku,
      row.name,
      [...row.lots].join(" "),
      [...row.hus].join(" "),
      [...row.statuses].join(" "),
      [...row.recipes].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [deboxSearch, deboxSummaryRows]);

  const filteredPostblastRows = useMemo(() => {
    const needle = deboxSearch.trim().toUpperCase();
    if (!needle) return postblastSummaryRows;
    return postblastSummaryRows.filter((row) => [
      row.location,
      row.sku,
      row.name,
      [...row.lots].join(" "),
      [...row.hus].join(" "),
      [...row.statuses].join(" "),
      [...row.recipes].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [deboxSearch, postblastSummaryRows]);

  const filteredProcessRecipeRows = useMemo(() => {
    const needle = deboxSearch.trim().toUpperCase();
    if (!needle) return processRecipeRows;
    return processRecipeRows.filter((row) => [
      row.recipe,
      [...row.deboxSkus].join(" "),
      [...row.postblastSkus].join(" "),
      [...row.deboxNames].join(" "),
      [...row.postblastNames].join(" "),
    ].some((value) => String(value ?? "").toUpperCase().includes(needle)));
  }, [deboxSearch, processRecipeRows]);

  const matchedPlatingRows = useMemo(() => platingRows.filter((row) => row.recipes.size > 0), [platingRows]);

  const kpis = useMemo(() => {
    const lineRows = matchedPlatingRows.filter((row) => row.area === "Line");
    const holdingRows = matchedPlatingRows.filter((row) => row.area === "Holding");
    return {
      rawRows: rawRows.length,
      linePieces: lineRows.reduce((sum, row) => sum + row.pieces, 0),
      holdingPieces: holdingRows.reduce((sum, row) => sum + row.pieces, 0),
      holdingKg: holdingRows.reduce((sum, row) => sum + row.kg, 0),
      skuCount: new Set(matchedPlatingRows.map((row) => row.sku).filter(Boolean)).size,
      locationCount: new Set(matchedPlatingRows.map((row) => row.location).filter(Boolean)).size,
      unmatched: platingRows.filter((row) => row.recipes.size === 0).length,
    };
  }, [matchedPlatingRows, platingRows, rawRows.length]);

  const sleevingKpis = useMemo(() => {
    return {
      rawRows: sleevingRawRows.length,
      inbound: sleevingSummaryRows.reduce((sum, row) => sum + row.inbound, 0),
      outbound: sleevingSummaryRows.reduce((sum, row) => sum + row.outbound, 0),
      lost: sleevingSummaryRows.reduce((sum, row) => sum + row.lost, 0),
      cycleDelta: sleevingSummaryRows.reduce((sum, row) => sum + row.cycleDelta, 0),
      hold: sleevingSummaryRows.reduce((sum, row) => sum + row.hold, 0),
      skuCount: sleevingSummaryRows.length,
      correctionPairs: sleevingSummaryRows.reduce((sum, row) => sum + row.correctionPairs, 0),
    };
  }, [sleevingRawRows.length, sleevingSummaryRows]);

  const inboundKpis = useMemo(() => {
    return {
      rawRows: inboundRawRows.length,
      received: inboundSummaryRows.reduce((sum, row) => sum + row.received, 0),
      damaged: inboundSummaryRows.reduce((sum, row) => sum + row.damaged, 0),
      skuCount: inboundSummaryRows.length,
      poCount: new Set(inboundRawRows.map((row) => row.poNumber).filter(Boolean)).size,
      vendorCount: new Set(inboundRawRows.map((row) => row.vendorCode).filter(Boolean)).size,
      huCount: new Set(inboundRawRows.map((row) => row.huId).filter(Boolean)).size,
    };
  }, [inboundRawRows, inboundSummaryRows]);

  const stagingKpis = useMemo(() => {
    return {
      rawRows: stagingRawRows.length,
      qty: stagingSummaryRows.reduce((sum, row) => sum + row.rawQty, 0),
      skuCount: new Set(stagingSummaryRows.map((row) => row.sku).filter(Boolean)).size,
      locationCount: new Set(stagingSummaryRows.map((row) => row.location).filter(Boolean)).size,
      huCount: stagingSummaryRows.reduce((sum, row) => sum + row.hus.size, 0),
      lotCount: stagingSummaryRows.reduce((sum, row) => sum + row.lots.size, 0),
      unmatched: stagingSummaryRows.filter((row) => row.recipes.size === 0).length,
    };
  }, [stagingRawRows.length, stagingSummaryRows]);

  const deboxKpis = useMemo(() => {
    const deboxQty = deboxSummaryRows.reduce((sum, row) => sum + row.rawQty, 0);
    const postblastQty = postblastSummaryRows.reduce((sum, row) => sum + row.rawQty, 0);
    return {
      deboxRows: deboxRawRows.length,
      postblastRows: postblastRawRows.length,
      deboxQty,
      postblastQty,
      deltaQty: postblastQty - deboxQty,
      deboxSkus: new Set(deboxSummaryRows.map((row) => row.sku).filter(Boolean)).size,
      postblastSkus: new Set(postblastSummaryRows.map((row) => row.sku).filter(Boolean)).size,
      recipes: processRecipeRows.filter((row) => row.recipe !== "nicht im Plan").length,
      unmatchedInput: deboxSummaryRows.filter((row) => row.recipes.size === 0).length,
      unmatchedOutput: postblastSummaryRows.filter((row) => row.recipes.size === 0).length,
    };
  }, [deboxRawRows.length, deboxSummaryRows, postblastRawRows.length, postblastSummaryRows, processRecipeRows]);

  const commandSkuRows = useMemo(
    () => buildCommandSkuRows(data, week, plannedSkuIndex, platingRows, sleevingSummaryRows, inboundSummaryRows, stagingSummaryRows, deboxSummaryRows, postblastSummaryRows),
    [data, deboxSummaryRows, inboundSummaryRows, plannedSkuIndex, platingRows, postblastSummaryRows, sleevingSummaryRows, stagingSummaryRows, week],
  );

  const commandRecipeRows = useMemo(
    () => buildCommandRecipeRows(data, week, commandSkuRows, platingHistoryRawRows),
    [commandSkuRows, data, platingHistoryRawRows, week],
  );

  const commandKpis = useMemo(() => {
    const hasWmsSignal = (row: CommandSkuRow) => row.inboundReceived + row.inboundDamaged + row.deboxQty + row.postblastQty + row.platingLinePieces + row.platingHoldingPieces + row.sleevingInbound + row.sleevingOutbound + row.sleevingLost + row.sleevingHold + row.stagingQty > 0;
    const plannedMainPieces = weekRecipePieces(data, week);
    const mainOutputPieces = commandRecipeRows.reduce((sum, row) => sum + row.mainOutputPieces, 0);
    const historicalMainPieces = commandRecipeRows.reduce((sum, row) => sum + row.historicalOutputPieces, 0);
    const totalMainPieces = mainOutputPieces + historicalMainPieces;
    const plannedSubQty = commandSkuRows
      .filter((row) => row.plannedQty > 0 && (row.category === "SUB" || row.sku.startsWith("SUB")))
      .reduce((sum, row) => sum + row.plannedQty, 0);
    const subPostblastQty = commandSkuRows
      .filter((row) => row.category === "SUB" || row.sku.startsWith("SUB"))
      .reduce((sum, row) => sum + row.postblastQty, 0);
    const subHoldingPieces = commandSkuRows
      .filter((row) => row.category === "SUB" || row.sku.startsWith("SUB"))
      .reduce((sum, row) => sum + row.platingHoldingPieces, 0);
    const criticalSkus = commandSkuRows.filter((row) => row.status === "kritisch").length;
    const checkSkus = commandSkuRows.filter((row) => row.status === "pruefen").length;
    return {
      plannedMainPieces,
      mainOutputPieces,
      historicalMainPieces,
      totalMainPieces,
      mainGapPieces: plannedMainPieces - totalMainPieces,
      mainCoverage: plannedMainPieces > 0 ? (totalMainPieces / plannedMainPieces) * 100 : 0,
      plannedSubQty,
      subPostblastQty,
      subHoldingPieces,
      criticalSkus,
      checkSkus,
      lost: commandSkuRows.reduce((sum, row) => sum + row.sleevingLost, 0),
      hold: commandSkuRows.reduce((sum, row) => sum + row.sleevingHold, 0),
      noMatch: commandSkuRows.filter((row) => hasWmsSignal(row) && (row.matchSource === "wms-only" || row.recipes.size === 0)).length,
    };
  }, [commandRecipeRows, commandSkuRows, data, week]);

  const commandWatchRows = useMemo(() => {
    return commandSkuRows
      .filter((row) => row.status === "kritisch" || row.status === "pruefen" || row.sleevingLost > 0 || row.sleevingHold > 0)
      .slice(0, 20);
  }, [commandSkuRows]);

  const weekBilanz = useMemo(() => {
    type BilanzStatus = "ok" | "warn" | "err" | "offen";

    // Plating
    const platingCoverage = commandKpis.mainCoverage;
    const platingStatus: BilanzStatus =
      commandKpis.plannedMainPieces === 0 ? "offen"
      : platingCoverage >= 98 ? "ok"
      : platingCoverage >= 75 ? "warn"
      : "err";

    // Sleeving
    const sleevingNet = sleevingKpis.inbound - sleevingKpis.outbound - sleevingKpis.lost;
    const sleevingLostRate = sleevingKpis.inbound > 0 ? (sleevingKpis.lost / sleevingKpis.inbound) * 100 : 0;
    const sleevingNetPct = sleevingKpis.inbound > 0 ? (Math.abs(sleevingNet) / sleevingKpis.inbound) * 100 : 0;
    const sleevingStatus: BilanzStatus =
      sleevingKpis.inbound === 0 ? "offen"
      : sleevingLostRate > 2 ? "err"
      : sleevingLostRate > 0.5 || sleevingNetPct > 10 ? "warn"
      : "ok";

    // Inbound
    const inboundDamageRate = inboundKpis.received > 0 ? (inboundKpis.damaged / inboundKpis.received) * 100 : 0;
    const inboundStatus: BilanzStatus =
      inboundKpis.received === 0 ? "offen"
      : inboundDamageRate > 5 ? "err"
      : inboundDamageRate > 1 ? "warn"
      : "ok";

    // Debox → Postblast
    const deboxDeltaPct = deboxKpis.deboxQty > 0 ? (deboxKpis.deltaQty / deboxKpis.deboxQty) * 100 : 0;
    const deboxStatus: BilanzStatus =
      deboxKpis.deboxQty === 0 && deboxKpis.postblastQty === 0 ? "offen"
      : deboxKpis.deltaQty < -(deboxKpis.deboxQty * 0.05) ? "err"
      : deboxKpis.deltaQty < 0 ? "warn"
      : "ok";

    // SKU-Signale
    const totalSkus = commandSkuRows.length;
    const skuStatus: BilanzStatus =
      totalSkus === 0 ? "offen"
      : commandKpis.criticalSkus > 5 ? "err"
      : commandKpis.criticalSkus > 0 || commandKpis.checkSkus > 5 ? "warn"
      : "ok";

    const statuses: BilanzStatus[] = [platingStatus, sleevingStatus, inboundStatus, deboxStatus, skuStatus];
    const overallStatus: BilanzStatus =
      statuses.includes("err") ? "err"
      : statuses.includes("warn") ? "warn"
      : statuses.every((s) => s === "ok") ? "ok"
      : "offen";

    return {
      platingStatus, platingCoverage, platingGap: commandKpis.mainGapPieces,
      platingPlanned: commandKpis.plannedMainPieces, platingActual: commandKpis.totalMainPieces,
      sleevingStatus, sleevingNet, sleevingLostRate,
      sleevingInbound: sleevingKpis.inbound, sleevingOutbound: sleevingKpis.outbound, sleevingLost: sleevingKpis.lost,
      inboundStatus, inboundDamageRate,
      inboundReceived: inboundKpis.received, inboundDamaged: inboundKpis.damaged,
      deboxStatus, deboxDelta: deboxKpis.deltaQty, deboxDeltaPct,
      deboxQty: deboxKpis.deboxQty, postblastQty: deboxKpis.postblastQty,
      skuStatus, criticalSkus: commandKpis.criticalSkus, checkSkus: commandKpis.checkSkus, totalSkus,
      overallStatus,
    };
  }, [commandKpis, commandSkuRows.length, deboxKpis, inboundKpis, sleevingKpis]);

  const mainCommandRows = useMemo(() => commandRecipeRows.slice(0, 18), [commandRecipeRows]);
  const subCommandRows = useMemo(() => commandSkuRows
    .filter((row) => row.category === "SUB" || row.sku.startsWith("SUB"))
    .sort((a, b) => b.riskScore - a.riskScore || b.plannedQty - a.plannedQty || a.name.localeCompare(b.name, "de"))
    .slice(0, 18), [commandSkuRows]);

  const selectedRecipeRow = useMemo(
    () => selectedRecipe ? (commandRecipeRows.find((r) => r.recipe === selectedRecipe) ?? null) : null,
    [commandRecipeRows, selectedRecipe],
  );

  const selectedMainSkuRows = useMemo(
    () => selectedRecipeRow ? commandSkuRows.filter((r) => selectedRecipeRow.mainSkus.has(r.sku)) : [],
    [commandSkuRows, selectedRecipeRow],
  );

  const selectedSubSkuRows = useMemo(
    () => selectedRecipeRow
      ? commandSkuRows.filter((r) => selectedRecipeRow.subSkus.has(r.sku)).sort((a, b) => b.riskScore - a.riskScore)
      : [],
    [commandSkuRows, selectedRecipeRow],
  );

  const selectedPlatingRows = useMemo(
    () => selectedRecipe ? platingRows.filter((r) => r.recipes.has(selectedRecipe)) : [],
    [platingRows, selectedRecipe],
  );

  const selectedSleevingRows = useMemo(
    () => selectedRecipe ? sleevingSummaryRows.filter((r) => r.recipes.has(selectedRecipe)) : [],
    [selectedRecipe, sleevingSummaryRows],
  );

  const selectedInboundRows = useMemo(
    () => selectedRecipe ? inboundSummaryRows.filter((r) => r.recipes.has(selectedRecipe)) : [],
    [inboundSummaryRows, selectedRecipe],
  );

  const selectedStagingRows = useMemo(
    () => selectedRecipe ? stagingSummaryRows.filter((r) => r.recipes.has(selectedRecipe)) : [],
    [selectedRecipe, stagingSummaryRows],
  );

  const selectedRecipePipeline = useMemo(() => {
    const hasInbound = selectedInboundRows.length > 0 || selectedSubSkuRows.some((row) => row.inboundReceived > 0 || row.inboundDamaged > 0);
    const hasStaging = selectedStagingRows.length > 0 || selectedSubSkuRows.some((row) => row.stagingQty > 0);
    const hasDebox = selectedRecipeRow?.subDeboxQty ? selectedRecipeRow.subDeboxQty > 0 : selectedSubSkuRows.some((row) => row.deboxQty > 0);
    const hasPostblast = selectedRecipeRow?.subPostblastQty ? selectedRecipeRow.subPostblastQty > 0 : selectedSubSkuRows.some((row) => row.postblastQty > 0);
    const hasSleeving = selectedSleevingRows.length > 0 || [...selectedMainSkuRows, ...selectedSubSkuRows].some((row) => row.sleevingInbound > 0 || row.sleevingOutbound > 0 || row.sleevingLost > 0 || row.sleevingHold > 0);
    const hasPlatingLine = selectedRecipeRow != null
      ? selectedRecipeRow.mainOutputPieces > 0 || selectedRecipeRow.historicalOutputPieces > 0 || selectedMainSkuRows.some((row) => row.platingLinePieces > 0)
      : false;
    const hasHolding = selectedRecipeRow != null
      ? selectedRecipeRow.historicalOutputPieces > 0 || selectedRecipeRow.subHoldingPieces > 0 || [...selectedMainSkuRows, ...selectedSubSkuRows].some((row) => row.platingHoldingPieces > 0)
      : false;

    return {
      hasInbound,
      hasStaging,
      hasDebox,
      hasPostblast,
      hasSleeving,
      hasPlatingLine,
      hasHolding,
    };
  }, [selectedInboundRows, selectedMainSkuRows, selectedRecipeRow, selectedSleevingRows, selectedStagingRows, selectedSubSkuRows]);

  const compareRecipeRow = useMemo(
    () => compareRecipe ? (commandRecipeRows.find((r) => r.recipe === compareRecipe) ?? null) : null,
    [commandRecipeRows, compareRecipe],
  );

  useEffect(() => {
    if (selectedRecipe && detailRef.current) {
      const el = detailRef.current;
      setTimeout(() => { el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
    }
  }, [selectedRecipe]);

  const matchedFilteredRows = filteredRows.filter((row) => row.recipes.size > 0);
  const maxPieces = Math.max(1, ...matchedFilteredRows.map((row) => row.pieces));
  const lineRows = matchedFilteredRows.filter((row) => row.area === "Line");
  const holdingRows = matchedFilteredRows.filter((row) => row.area !== "Line");

  const tabs: { id: typeof activeTab; label: string; badge?: number; color?: string }[] = [
    { id: "overview",   label: "Übersicht",   badge: commandKpis.criticalSkus > 0 ? commandKpis.criticalSkus : undefined, color: commandKpis.criticalSkus > 0 ? "rose" : undefined },
    { id: "meals",      label: "Meals",       badge: commandRecipeRows.length },
    { id: "workorders", label: "Workorders",  badge: workordersForWeek.length },
    { id: "plating",    label: "Plating",     badge: platingRows.length },
    { id: "sleeving",   label: "Sleeving",    badge: sleevingKpis.rawRows > 0 ? sleevingSummaryRows.length : undefined },
    { id: "inbound",    label: "Inbound",     badge: inboundKpis.rawRows > 0 ? inboundSummaryRows.length : undefined },
    { id: "prozess",    label: "Prozess",     badge: deboxKpis.deboxRows + deboxKpis.postblastRows > 0 ? processRecipeRows.length : undefined },
  ];

  return (
    <div className="space-y-4">
      {/* ── Immer sichtbar: Compact Header + Tab Bar ── */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-950 px-5 py-3 text-white">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-violet-200">WMS Live · VF</div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-base font-black">KW {week} · {wmsWeek}</span>
              <span className="text-xs text-slate-300">{rangeStart} – {rangeEnd}</span>
              {state === "loading" && <span className="text-xs font-bold text-sky-300 animate-pulse">Snowflake lädt…</span>}
              {state === "error"   && <span className="text-xs font-bold text-rose-300">{error}</span>}
              {state === "ready"   && (
                <span className="text-[11px] text-slate-400">
                  {fmtNum(kpis.rawRows)} Plating · {fmtNum(sleevingKpis.rawRows)} Slv · {fmtNum(inboundKpis.rawRows)} Inb · {fmtNum(deboxKpis.deboxRows + deboxKpis.postblastRows)} Db/PB · {fmtNum(workordersForWeek.length)} WO
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded-lg border border-white/20 bg-slate-900 px-2 py-1 text-xs font-bold text-white">
              <option value={5000}>5.000</option>
              <option value={25000}>25.000</option>
              <option value={50000}>50.000</option>
            </select>
            <button type="button" onClick={() => void load()} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-slate-100">
              Aktualisieren
            </button>
          </div>
        </div>
        {/* Tab Bar */}
        <div className="flex overflow-x-auto bg-slate-50">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-bold transition-colors ${
                  isActive
                    ? "border-violet-600 bg-white text-violet-700"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`}
              >
                {tab.label}
                {tab.badge != null && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none ${
                    isActive ? "bg-violet-100 text-violet-700" :
                    tab.color === "rose" ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600"
                  }`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Meal Navigator ── */}
      {activeTab === "meals" && (<>
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-950 px-5 py-4 text-white">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-violet-200">Meal-Navigator · KW {week}</div>
            <h2 className="text-lg font-black">{commandRecipeRows.length} Meals diese Woche · Anklicken für Drill-Down</h2>
          </div>
          {selectedRecipe && (
            <button type="button" onClick={() => setSelectedRecipe(null)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/20">
              Auswahl aufheben
            </button>
          )}
        </div>
        <div className="space-y-4 p-4">
          {(["kritisch", "pruefen", "offen", "laeuft", "gedeckt"] as const).map((groupStatus) => {
            const group = commandRecipeRows.filter((r) => r.status === groupStatus);
            if (group.length === 0) return null;
            const groupLabels: Record<typeof groupStatus, string> = {
              kritisch: "❌ Kritisch", pruefen: "⚠️ Prüfen", offen: "— Offen", laeuft: "🔵 Läuft", gedeckt: "✅ Gedeckt",
            };
            const groupHeaderCls: Record<typeof groupStatus, string> = {
              kritisch: "bg-rose-50 text-rose-800 border-rose-200",
              pruefen: "bg-amber-50 text-amber-800 border-amber-200",
              offen: "bg-slate-50 text-slate-700 border-slate-200",
              laeuft: "bg-sky-50 text-sky-800 border-sky-200",
              gedeckt: "bg-emerald-50 text-emerald-800 border-emerald-200",
            };
            return (
              <div key={groupStatus}>
                <div className={`mb-2 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 ${groupHeaderCls[groupStatus]}`}>
                  <span className="text-xs font-black">{groupLabels[groupStatus]}</span>
                  <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-bold">{group.length} Meals</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.map((recipe) => {
                    const positionNumber = commandRecipeRows.indexOf(recipe) + 1;
                    const isSelected = selectedRecipe === recipe.recipe;
                    const isCompare = compareRecipe === recipe.recipe;
                    const coverage = recipe.plannedPieces > 0 ? Math.min(100, (recipe.standPieces / recipe.plannedPieces) * 100) : 0;
                    return (
                      <button
                        key={recipe.recipe}
                        type="button"
                        title={`${recipe.recipe}: ${recipe.statusText} | Coverage ${Math.round(coverage)}% | Stand ${fmtNum(recipe.standPieces)} / ${fmtNum(recipe.plannedPieces)} Stk`}
                        onClick={() => { setSelectedRecipe(isSelected ? null : recipe.recipe); if (isSelected) setCompareRecipe(null); }}
                        className={`flex w-48 flex-col rounded-lg p-3 text-left ring-2 transition-all ${
                          isSelected ? "bg-violet-50 ring-violet-500" :
                          isCompare ? "bg-fuchsia-50 ring-fuchsia-400" :
                          "bg-white ring-slate-200 hover:bg-slate-50 hover:ring-slate-300"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-[9px] font-black text-slate-500">{positionNumber}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-[10px] font-bold text-slate-400">{recipe.recipe}</div>
                            <div className="truncate text-xs font-bold text-slate-900">{recipe.name || recipe.recipe}</div>
                          </div>
                        </div>
                        <div className="mt-2">
                          <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                            <span>{fmtNum(recipe.standPieces)} / {fmtNum(recipe.plannedPieces)} Stk</span>
                            <span className="font-bold">{fmtNum(coverage, 0)}%</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full ${coverage >= 98 ? "bg-emerald-500" : coverage >= 75 ? "bg-sky-400" : "bg-amber-400"}`}
                              style={{ width: `${Math.max(3, coverage)}%` }}
                            />
                          </div>
                        </div>
                        {recipe.noMatchSignals > 0 && (
                          <div className="mt-1.5 text-[10px] font-bold text-rose-600">{recipe.noMatchSignals} No-Match</div>
                        )}
                        {selectedRecipe && selectedRecipe !== recipe.recipe && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setCompareRecipe(isCompare ? null : recipe.recipe); }}
                            className={`mt-2 w-full rounded px-2 py-1 text-[10px] font-bold transition-colors ${
                              isCompare ? "bg-fuchsia-100 text-fuchsia-800" : "bg-slate-100 text-slate-600 hover:bg-fuchsia-50 hover:text-fuchsia-700"
                            }`}
                          >
                            {isCompare ? "✓ im Vergleich" : "+ Vergleich"}
                          </button>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Meal Detail Drill-Down ── */}
      {selectedRecipe && selectedRecipeRow && (
        <section ref={detailRef} className="card scroll-mt-4 overflow-hidden">
          <div className={`flex items-start justify-between gap-4 border-b p-5 text-white ${
            selectedRecipeRow.status === "kritisch" ? "bg-rose-900" :
            selectedRecipeRow.status === "pruefen" ? "bg-amber-900" :
            selectedRecipeRow.status === "laeuft" ? "bg-sky-900" :
            selectedRecipeRow.status === "gedeckt" ? "bg-emerald-900" : "bg-slate-800"
          }`}>
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest opacity-60">Meal Detail · {selectedRecipe}</div>
              <h3 className="mt-0.5 text-xl font-black">{selectedRecipeRow.name || selectedRecipe}</h3>
              <div className="mt-1 text-sm opacity-80">
                {selectedRecipeRow.status === "kritisch" && "❌ Kritisch – Produktion nicht gedeckt"}
                {selectedRecipeRow.status === "pruefen" && "⚠️ Prüfen – Abweichungen vorhanden"}
                {selectedRecipeRow.status === "laeuft" && "🔵 Läuft – Produktion im Gang"}
                {selectedRecipeRow.status === "gedeckt" && "✅ Gedeckt – Wochenziel erreicht"}
                {selectedRecipeRow.status === "offen" && "— Noch keine WMS-Aktivität"}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => exportMealCsv(selectedRecipeRow, selectedMainSkuRows, selectedSubSkuRows, selectedStagingRows, selectedSleevingRows, selectedPlatingRows, selectedInboundRows)}
                className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/30"
              >
                ↓ Export CSV
              </button>
              <button type="button" onClick={() => { setSelectedRecipe(null); setCompareRecipe(null); }} className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/30">
                × Schließen
              </button>
            </div>
          </div>

          {/* KPI-Leiste */}
          <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
            <WmsStat label="Geplant" value={fmtQty(selectedRecipeRow.plannedPieces, "Stk")} tone="slate" />
            <WmsStat label="Aktuell Line" value={fmtQty(selectedRecipeRow.mainOutputPieces, "Stk")} tone="emerald" />
            <WmsStat label="Vorher gebaut" value={fmtQty(selectedRecipeRow.historicalOutputPieces, "Stk")} tone="violet" />
            <WmsStat label="Stand gesamt" value={fmtQty(selectedRecipeRow.standPieces, "Stk")} tone="sky" />
            <WmsStat
              label="Gap"
              value={fmtQty(selectedRecipeRow.plannedPieces - selectedRecipeRow.standPieces, "Stk")}
              tone={(selectedRecipeRow.plannedPieces - selectedRecipeRow.standPieces) > 0 ? "amber" : "emerald"}
            />
            <WmsStat
              label="Coverage"
              value={`${fmtNum(selectedRecipeRow.plannedPieces > 0 ? (selectedRecipeRow.standPieces / selectedRecipeRow.plannedPieces) * 100 : 0, 1)}%`}
              tone={selectedRecipeRow.plannedPieces > 0 && selectedRecipeRow.standPieces >= selectedRecipeRow.plannedPieces * 0.98 ? "emerald" : "sky"}
            />
          </div>

          {/* Prozess-Pipeline */}
          <div className="border-b border-slate-100 bg-white px-5 py-3">
            <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">Produktions-Pipeline</div>
            <div className="flex flex-wrap items-center gap-1">
              {([
                { label: "Inbound",       active: selectedRecipePipeline.hasInbound },
                { label: "Staging",       active: selectedRecipePipeline.hasStaging },
                { label: "Debox",         active: selectedRecipePipeline.hasDebox },
                { label: "Postblast",     active: selectedRecipePipeline.hasPostblast },
                { label: "Sleeving",      active: selectedRecipePipeline.hasSleeving },
                { label: "Plating Line",  active: selectedRecipePipeline.hasPlatingLine },
                { label: "Holding/Fertig", active: selectedRecipePipeline.hasHolding },
              ] as const).map(({ label, active }, i, arr) => (
                <div key={label} className="flex items-center gap-1">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${
                    active ? "bg-emerald-50 text-emerald-800 ring-emerald-300" : "bg-slate-100 text-slate-400 ring-slate-200"
                  }`}>
                    {active ? "✓" : "○"} {label}
                  </span>
                  {i < arr.length - 1 && <span className="text-[10px] text-slate-300">→</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Main MSKU */}
          {selectedMainSkuRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Main MSKU – Fertige Mahlzeiten</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Geplant</th>
                      <th className="px-3 py-2 text-right">Line Stk</th>
                      <th className="px-3 py-2 text-right">Holding Stk</th>
                      <th className="px-3 py-2 text-right">Ist gesamt</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedMainSkuRows.map((row) => (
                      <tr key={row.key} className="bg-white">
                        <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-400">{row.sku}</td>
                        <td className="px-3 py-2 font-semibold text-slate-900">{row.name}</td>
                        <td className="px-3 py-2 text-right">{fmtNum(row.plannedPieces)} Stk</td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-700">{fmtNum(row.platingLinePieces)} Stk</td>
                        <td className="px-3 py-2 text-right text-violet-700">{fmtNum(row.platingHoldingPieces)} Stk</td>
                        <td className="px-3 py-2 text-right font-bold">{fmtNum(row.platingLinePieces + row.platingHoldingPieces)} Stk</td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${commandStatusTone(row.status)}`}>{row.statusText || row.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Sub Rezepte & Zutaten */}
          {selectedSubSkuRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Sub Rezepte & Zutaten ({selectedSubSkuRows.length})</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Geplant</th>
                      <th className="px-3 py-2 text-right">Inbound</th>
                      <th className="px-3 py-2 text-right">Debox</th>
                      <th className="px-3 py-2 text-right">Postblast</th>
                      <th className="px-3 py-2 text-left">Fortschritt</th>
                      <th className="px-3 py-2 text-right">Holding</th>
                      <th className="px-3 py-2 text-right">Slv Ein</th>
                      <th className="px-3 py-2 text-right">Lost</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedSubSkuRows.map((row) => (
                      <tr key={row.key} className="bg-white hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-400">{row.sku}</td>
                        <td className="max-w-[180px] truncate px-3 py-2 font-semibold text-slate-900" title={row.name}>{row.name}</td>
                        <td className="px-3 py-2 text-right text-slate-600">{fmtQty(row.plannedQty, row.uom === "grams" ? "g" : row.uom === "ml" ? "ml" : "")}</td>
                        <td className="px-3 py-2 text-right text-sky-700">{row.inboundReceived > 0 ? fmtQty(row.inboundReceived, "g") : "–"}</td>
                        <td className="px-3 py-2 text-right text-violet-700">{row.deboxQty > 0 ? fmtQty(row.deboxQty, "g") : "–"}</td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.postblastQty > 0 ? fmtQty(row.postblastQty, "g") : "–"}</td>
                        <td className="px-3 py-2">
                          {row.plannedQty > 0 ? (() => {
                            const pct = Math.min(100, (row.postblastQty / row.plannedQty) * 100);
                            return (
                              <div>
                                <div className="mb-0.5 h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
                                  <div className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : pct >= 75 ? "bg-sky-400" : "bg-amber-400"}`} style={{ width: `${Math.max(3, pct)}%` }} />
                                </div>
                                <div className="text-[9px] text-slate-400">{fmtNum(pct, 0)}%</div>
                              </div>
                            );
                          })() : <span className="text-slate-300">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right">{row.platingHoldingPieces > 0 ? fmtNum(row.platingHoldingPieces) : "–"}</td>
                        <td className="px-3 py-2 text-right">{row.sleevingInbound > 0 ? fmtNum(row.sleevingInbound) : "–"}</td>
                        <td className="px-3 py-2 text-right font-bold text-rose-700">{row.sleevingLost > 0 ? fmtNum(row.sleevingLost) : "–"}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-0.5">
                            <span className={`self-start rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${commandStatusTone(row.status)}`}>{row.statusText}</span>
                            {row.recipes.size > 1 && (
                              <span className="text-[9px] text-slate-400" title={`Dieser Sub-Artikel wird in ${row.recipes.size} Rezepten verwendet`}>🔗 {row.recipes.size} Recipes</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Staging */}
          {selectedStagingRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Staging – wartender Bestand ({selectedStagingRows.length} Positionen)</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Location</th>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Menge</th>
                      <th className="px-3 py-2 text-left">MHD</th>
                      <th className="px-3 py-2 text-left">Letzte Änderung</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedStagingRows.map((row) => (
                      <tr key={row.key} className="bg-white hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-600">{row.location}</td>
                        <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{row.sku}</td>
                        <td className="max-w-[180px] truncate px-3 py-2 text-slate-900" title={row.name}>{row.name}</td>
                        <td className="px-3 py-2 text-right font-bold">{fmtQty(row.rawQty, "g")}</td>
                        <td className={`px-3 py-2 ${mhdTone(row.expirationDate)}`}>{mhdDaysLabel(row.expirationDate)}</td>
                        <td className="px-3 py-2 text-slate-400">{fmtDateTime(row.lastChange)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Sleeving */}
          {selectedSleevingRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Sleeving – Netto-Bilanz ({selectedSleevingRows.length} SKUs)</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Eingang</th>
                      <th className="px-3 py-2 text-right">Ausgang</th>
                      <th className="px-3 py-2 text-right">Lost</th>
                      <th className="px-3 py-2 text-right">Hold</th>
                      <th className="px-3 py-2 text-right">Netto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedSleevingRows.map((row) => {
                      const net = row.inbound - row.outbound - row.lost;
                      return (
                        <tr key={row.key} className="bg-white hover:bg-slate-50">
                          <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-400">{row.sku}</td>
                          <td className="max-w-[200px] truncate px-3 py-2 text-slate-900" title={row.name}>{row.name}</td>
                          <td className="px-3 py-2 text-right font-bold text-emerald-700">{fmtNum(row.inbound)}</td>
                          <td className="px-3 py-2 text-right text-sky-700">{fmtNum(row.outbound)}</td>
                          <td className="px-3 py-2 text-right font-bold text-rose-700">{row.lost > 0 ? fmtNum(row.lost) : "–"}</td>
                          <td className="px-3 py-2 text-right text-amber-700">{row.hold > 0 ? fmtNum(row.hold) : "–"}</td>
                          <td className={`px-3 py-2 text-right font-bold ${net < 0 ? "text-rose-600" : "text-slate-700"}`}>
                            {net >= 0 ? "+" : ""}{fmtNum(net)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Plating Locations */}
          {selectedPlatingRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Plating Locations – aktueller Bestand ({selectedPlatingRows.length})</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Location</th>
                      <th className="px-3 py-2 text-left">Bereich</th>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-right">Stk</th>
                      <th className="px-3 py-2 text-right">kg</th>
                      <th className="px-3 py-2 text-left">Letzte Änderung</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedPlatingRows.map((row) => (
                      <tr key={row.key} className="bg-white hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-600">{row.location}</td>
                        <td className="px-3 py-2 text-slate-600">{row.area}</td>
                        <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{row.sku}</td>
                        <td className="px-3 py-2 text-right font-bold">{fmtNum(row.pieces)} Stk</td>
                        <td className="px-3 py-2 text-right text-slate-600">{row.kg > 0 ? fmtQty(row.kg, "kg") : "–"}</td>
                        <td className="px-3 py-2 text-slate-400">{fmtDateTime(row.lastChange)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Wareneingang */}
          {selectedInboundRows.length > 0 && (
            <div className="border-b border-slate-100 p-4">
              <h4 className="mb-3 text-sm font-black text-slate-900">Wareneingang ({selectedInboundRows.length} SKUs)</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Erhalten</th>
                      <th className="px-3 py-2 text-right">Beschädigt</th>
                      <th className="px-3 py-2 text-right">POs</th>
                      <th className="px-3 py-2 text-right">Lose</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedInboundRows.map((row) => (
                      <tr key={row.key} className="bg-white hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-[10px] font-bold text-slate-400">{row.sku}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 text-slate-900" title={row.name}>{row.name}</td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-700">{fmtQty(row.received, "g")}</td>
                        <td className="px-3 py-2 text-right font-bold text-rose-700">{row.damaged > 0 ? fmtQty(row.damaged, "g") : "–"}</td>
                        <td className="px-3 py-2 text-right">{fmtNum(row.poCount)}</td>
                        <td className="px-3 py-2 text-right">{fmtNum(row.lotCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {selectedMainSkuRows.length === 0 && selectedSubSkuRows.length === 0 && selectedStagingRows.length === 0 && selectedSleevingRows.length === 0 && selectedPlatingRows.length === 0 && selectedInboundRows.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">
              Noch keine WMS-Daten für dieses Meal – möglicherweise noch nicht gestartet oder Daten noch nicht geladen.
            </div>
          )}
        </section>
      )}

      {/* ── Vergleichs-Panel ── */}
      {compareRecipe && compareRecipeRow && selectedRecipe && selectedRecipeRow && (
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between gap-4 bg-fuchsia-950 px-5 py-4 text-white">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-fuchsia-200">Meal Vergleich</div>
              <h3 className="text-lg font-black">
                {selectedRecipeRow.name || selectedRecipe} <span className="opacity-40">vs</span> {compareRecipeRow.name || compareRecipe}
              </h3>
            </div>
            <button type="button" onClick={() => setCompareRecipe(null)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/20">
              × Vergleich beenden
            </button>
          </div>
          <div className="grid grid-cols-2 divide-x divide-slate-100">
            {([selectedRecipeRow, compareRecipeRow] as const).map((row, index) => {
              const cov = row.plannedPieces > 0 ? (row.standPieces / row.plannedPieces) * 100 : 0;
              const covPct = Math.min(100, cov);
              return (
                <div key={row.recipe} className={`p-4 ${index === 0 ? "bg-violet-50/40" : "bg-fuchsia-50/40"}`}>
                  <div className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">{index === 0 ? "Ausgewählt" : "Vergleich"}</div>
                  <div className="font-mono text-[11px] font-bold text-slate-400">{row.recipe}</div>
                  <div className="text-base font-black text-slate-900">{row.name}</div>
                  <div className="mt-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${commandStatusTone(row.status)}`}>{row.statusText}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
                      <div className="text-[10px] text-slate-400">Geplant</div>
                      <div className="font-mono text-lg font-black text-slate-900">{fmtNum(row.plannedPieces)}</div>
                    </div>
                    <div className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
                      <div className="text-[10px] text-slate-400">Ist gesamt</div>
                      <div className="font-mono text-lg font-black text-slate-900">{fmtNum(row.standPieces)}</div>
                    </div>
                    <div className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
                      <div className="text-[10px] text-slate-400">Aktuell Line</div>
                      <div className="font-mono text-sm font-black text-emerald-700">{fmtNum(row.mainOutputPieces)}</div>
                    </div>
                    <div className="rounded-lg bg-white p-2 ring-1 ring-slate-200">
                      <div className="text-[10px] text-slate-400">Vorher gebaut</div>
                      <div className="font-mono text-sm font-black text-violet-700">{fmtNum(row.historicalOutputPieces)}</div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between text-[11px] font-bold text-slate-600">
                      <span>Coverage</span>
                      <span className={covPct >= 98 ? "text-emerald-700" : covPct >= 75 ? "text-sky-600" : "text-amber-600"}>{fmtNum(cov, 1)}%</span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${covPct >= 98 ? "bg-emerald-500" : covPct >= 75 ? "bg-sky-400" : "bg-amber-400"}`}
                        style={{ width: `${Math.max(3, covPct)}%` }}
                      />
                    </div>
                  </div>
                  {(row.sleevingLost > 0 || row.noMatchSignals > 0 || row.subPostblastQty > 0) && (
                    <div className="mt-3 space-y-0.5 text-[11px] text-slate-500">
                      {row.subPostblastQty > 0 && <div>Sub Postblast: {fmtQty(row.subPostblastQty, "g")}</div>}
                      {row.sleevingLost > 0 && <div className="text-rose-600">Lost: {fmtNum(row.sleevingLost)}</div>}
                      {row.noMatchSignals > 0 && <div className="text-rose-600">No-Match: {fmtNum(row.noMatchSignals)}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      </>)}
      {activeTab === "overview" && (<>
      {/* ── Bestehende Header-Sektion ── */}
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-950 p-5 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-violet-200">WMS Live VF</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight">WMS Live Prozess-Dashboard</h2>
              <div className="mt-2 text-sm text-slate-200">
                Tool-KW {week} · WMS-Woche {wmsWeek} · {rangeStart} bis {rangeEnd} · getrennte Queries je Arbeitsschritt
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="rounded-lg border border-white/20 bg-slate-900 px-3 py-1.5 text-xs font-bold text-white"
              >
                <option value={5000}>5.000</option>
                <option value={25000}>25.000</option>
                <option value={50000}>50.000</option>
              </select>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-950 ring-1 ring-white/60 hover:bg-slate-100"
              >
                Aktualisieren
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="Line Stueck" value={fmtQty(kpis.linePieces, "Stk")} tone="emerald" />
          <WmsStat label="PLH Stueck" value={fmtQty(kpis.holdingPieces, "Stk")} tone="violet" />
          <WmsStat label="PLH kg" value={fmtQty(kpis.holdingKg, "kg")} tone="slate" />
          <WmsStat label="SKUs" value={fmtNum(kpis.skuCount)} tone="sky" />
          <WmsStat label="Locations" value={fmtNum(kpis.locationCount)} tone="amber" />
          <WmsStat label="No Match" value={fmtNum(kpis.unmatched)} tone="rose" />
        </div>

        <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          {state === "loading" && <span className="font-semibold text-sky-700">Snowflake Queries laufen...</span>}
          {state === "ready" && (
            <span>
              Geladen: <span className="font-semibold text-slate-700">{fmtDateTime(platingPayload?.generatedAt ?? sleevingPayload?.generatedAt ?? inboundPayload?.generatedAt ?? stagingPayload?.generatedAt)}</span>
              <span className="ml-2 font-semibold text-slate-600">{fmtNum(kpis.rawRows)} Plating · {fmtNum(platingHistoryRawRows.length)} Historie · {fmtNum(sleevingKpis.rawRows)} Sleeving · {fmtNum(inboundKpis.rawRows)} Inbound · {fmtNum(deboxKpis.deboxRows)} Debox · {fmtNum(deboxKpis.postblastRows)} Postblast · {fmtNum(stagingKpis.rawRows)} Staging · {fmtNum(plannedSkuIndex.size)} Tool-SKUs</span>
            </span>
          )}
          {state === "error" && <span className="font-semibold text-rose-700">{error}</span>}
        </div>
      </section>

      {/* ── Ramp-Up Verlauf ── */}
      {(() => {
        const rampWeeks = data.weeks.slice().sort();
        if (rampWeeks.length < 2) return null;

        // Live WMS-Daten aus Workorders aggregieren (alle KWs im Cache)
        // quantity = Produktionsvolumen in Gramm; mealItemNumber = eindeutiges Rezept
        const wmsRampMap = new Map<string, { meals: number; quantityKg: number }>();
        for (const row of workordersRawRows) {
          const toolW = wmsWeekToToolWeek(row.week);
          if (!toolW) continue;
          const entry = wmsRampMap.get(toolW) ?? { meals: 0, quantityKg: 0 };
          entry.quantityKg += (row.quantity ?? 0) / 1000;
          wmsRampMap.set(toolW, entry);
        }
        // Unique meals per WMS week
        const wmsMealSets = new Map<string, Set<string>>();
        for (const row of workordersRawRows) {
          const toolW = wmsWeekToToolWeek(row.week);
          if (!toolW || !row.mealItemNumber) continue;
          const s = wmsMealSets.get(toolW) ?? new Set<string>();
          s.add(row.mealItemNumber);
          wmsMealSets.set(toolW, s);
        }
        for (const [w, s] of wmsMealSets) {
          const entry = wmsRampMap.get(w) ?? { meals: 0, quantityKg: 0 };
          entry.meals = s.size;
          wmsRampMap.set(w, entry);
        }

        type RampRow = {
          w: string;
          planMeals: number;
          planPortions: number;
          wmsMeals: number | null;
          wmsQuantityKg: number | null;
          isCurrentWeek: boolean;
        };
        const rows: RampRow[] = rampWeeks.map((w) => {
          const wrs = data.weekRecipes.filter((r) => r.hfWeek === w);
          const planMeals = new Set(wrs.map((r) => r.code)).size;
          const planPortions = wrs.reduce((s, r) => s + (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0), 0);
          const wmsEntry = wmsRampMap.get(w) ?? null;
          return {
            w,
            planMeals,
            planPortions,
            wmsMeals: wmsEntry ? wmsEntry.meals : null,
            wmsQuantityKg: wmsEntry ? wmsEntry.quantityKg : null,
            isCurrentWeek: w === week,
          };
        });

        const hasWmsData = rows.some((r) => r.wmsMeals !== null);
        const maxMeals = Math.max(1, ...rows.map((r) => Math.max(r.planMeals, r.wmsMeals ?? 0)));
        const maxPortions = Math.max(1, ...rows.map((r) => Math.max(r.planPortions, r.wmsQuantityKg ?? 0)));
        const currentIdx = rows.findIndex((r) => r.isCurrentWeek);
        const prev = currentIdx > 0 ? rows[currentIdx - 1] : null;
        const curr = rows[currentIdx];
        // Delta: WMS wenn verfügbar, sonst Plan
        const mealsA = curr ? (curr.wmsMeals ?? curr.planMeals) : 0;
        const mealsB = prev ? (prev.wmsMeals ?? prev.planMeals) : 0;
        const platesA = curr ? (curr.wmsQuantityKg ?? curr.planPortions) : 0;
        const platesB = prev ? (prev.wmsQuantityKg ?? prev.planPortions) : 0;
        const mealsDelta = curr && prev ? mealsA - mealsB : null;
        const portionsDelta = curr && prev ? platesA - platesB : null;
        return (
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-violet-500">Ramp-Up Verlauf</div>
                <h3 className="text-base font-black text-slate-900">
                  Meal-Entwicklung über alle Wochen
                  {hasWmsData && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">WMS Live</span>}
                </h3>
              </div>
              {curr && (
                <div className="flex items-center gap-3 text-right">
                  {mealsDelta !== null && (
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${mealsDelta >= 0 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-rose-50 text-rose-800 ring-rose-200"}`}>
                      {mealsDelta >= 0 ? "▲" : "▼"} {Math.abs(mealsDelta)} Meals vs. Vorwoche
                    </span>
                  )}
                  {portionsDelta !== null && (
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${portionsDelta >= 0 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-rose-50 text-rose-800 ring-rose-200"}`}>
                      {portionsDelta >= 0 ? "▲" : "▼"} {fmtNum(Math.abs(Math.round(portionsDelta)))} {hasWmsData ? "kg" : "Portionen"}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="overflow-x-auto p-4">
              <div className="flex min-w-max items-end gap-2">
                {rows.map((row) => {
                  const planMealH = Math.max(4, Math.round((row.planMeals / maxMeals) * 80));
                  const planPortH = Math.max(4, Math.round((row.planPortions / maxPortions) * 80));
                  const wmsMealH = row.wmsMeals !== null ? Math.max(4, Math.round((row.wmsMeals / maxMeals) * 80)) : null;
                  const wmsVolH = row.wmsQuantityKg !== null ? Math.max(4, Math.round((row.wmsQuantityKg / maxPortions) * 80)) : null;
                  return (
                    <div key={row.w} className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2 ${row.isCurrentWeek ? "bg-violet-50 ring-2 ring-violet-400" : "bg-slate-50 ring-1 ring-slate-200"}`}>
                      <div className="flex items-end gap-0.5" style={{ height: 88 }}>
                        {/* Plan bars (lighter) */}
                        <div
                          className={`w-4 rounded-t transition-all ${row.isCurrentWeek ? "bg-violet-300" : "bg-violet-100"}`}
                          style={{ height: planMealH }}
                          title={`Plan: ${row.planMeals} Meals`}
                        />
                        <div
                          className={`w-4 rounded-t transition-all ${row.isCurrentWeek ? "bg-emerald-300" : "bg-emerald-100"}`}
                          style={{ height: planPortH }}
                          title={`Plan: ${fmtNum(Math.round(row.planPortions / 1000))}k Portionen`}
                        />
                        {/* WMS Live bars (bright) */}
                        {wmsMealH !== null && (
                          <div
                            className="w-4 rounded-t bg-amber-500 transition-all"
                            style={{ height: wmsMealH }}
                            title={`WMS: ${row.wmsMeals} Meals`}
                          />
                        )}
                        {wmsVolH !== null && (
                          <div
                            className="w-4 rounded-t bg-teal-500 transition-all"
                            style={{ height: wmsVolH }}
                            title={`WMS: ${fmtNum(Math.round(row.wmsQuantityKg ?? 0))} kg`}
                          />
                        )}
                      </div>
                      <div className={`text-[10px] font-black ${row.isCurrentWeek ? "text-violet-700" : "text-slate-500"}`}>{row.w.replace("2026-", "")}</div>
                      <div className="text-[10px] font-bold text-slate-600">
                        {row.wmsMeals !== null ? (
                          <span className="text-amber-700">{row.wmsMeals}M</span>
                        ) : (
                          <span className={row.isCurrentWeek ? "text-violet-900" : "text-slate-700"}>{row.planMeals}M</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {row.wmsQuantityKg !== null ? (
                          <span className="text-teal-700">{fmtNum(Math.round(row.wmsQuantityKg / 1000))}t</span>
                        ) : (
                          <span className={row.isCurrentWeek ? "text-emerald-800" : "text-slate-400"}>{fmtNum(Math.round(row.planPortions / 1000))}k</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-400">
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-300" /> Plan Meals</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-300" /> Plan Portionen</span>
                {hasWmsData && <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" /> WMS Meals (live)</span>}
                {hasWmsData && <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> WMS Volumen in Tonnen (live)</span>}
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-100 ring-1 ring-violet-400" /> Aktuelle KW</span>
              </div>
            </div>
          </section>
        );
      })()}

      <section className="card overflow-hidden">
        <div className={`flex items-center gap-4 border-b p-4 text-white ${weekBilanz.overallStatus === "ok" ? "bg-emerald-900" : weekBilanz.overallStatus === "warn" ? "bg-amber-900" : weekBilanz.overallStatus === "err" ? "bg-rose-900" : "bg-slate-800"}`}>
          <span className="text-3xl leading-none">
            {weekBilanz.overallStatus === "ok" ? "✅" : weekBilanz.overallStatus === "warn" ? "⚠️" : weekBilanz.overallStatus === "err" ? "❌" : "—"}
          </span>
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest opacity-70">Wochenbilanz · KW {week} · WMS {wmsWeek}</div>
            <div className="text-lg font-black">
              {weekBilanz.overallStatus === "ok" && "Woche nach Plan – alle Abteilungen stimmig"}
              {weekBilanz.overallStatus === "warn" && "Woche: Abweichungen prüfen"}
              {weekBilanz.overallStatus === "err" && "Woche: Kritische Abweichungen"}
              {weekBilanz.overallStatus === "offen" && "Woche: Daten werden geladen …"}
            </div>
          </div>
        </div>
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-slate-100 text-[11px] uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-bold">Abteilung</th>
              <th className="px-4 py-2 text-left font-bold">Kennzahlen der Woche</th>
              <th className="px-4 py-2 text-right font-bold">Bilanz</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <tr className="bg-white">
              <td className="px-4 py-3 font-semibold text-slate-900">Plating · Main Meals</td>
              <td className="px-4 py-3 text-xs text-slate-600">
                Bedarf {fmtNum(weekBilanz.platingPlanned)} Stk · Ist {fmtNum(weekBilanz.platingActual)} Stk · Gap {fmtNum(weekBilanz.platingGap)} Stk · Coverage {fmtNum(weekBilanz.platingCoverage, 1)}%
              </td>
              <td className="px-4 py-3 text-right"><BilanzBadge status={weekBilanz.platingStatus} /></td>
            </tr>
            <tr className="bg-slate-50">
              <td className="px-4 py-3 font-semibold text-slate-900">Sleeving · Netto-Bilanz</td>
              <td className="px-4 py-3 text-xs text-slate-600">
                Eingang {fmtNum(weekBilanz.sleevingInbound)} · Ausgang {fmtNum(weekBilanz.sleevingOutbound)} · Lost {fmtNum(weekBilanz.sleevingLost)} · Netto {weekBilanz.sleevingNet >= 0 ? "+" : ""}{fmtNum(weekBilanz.sleevingNet)} · Lost-Rate {fmtNum(weekBilanz.sleevingLostRate, 2)}%
              </td>
              <td className="px-4 py-3 text-right"><BilanzBadge status={weekBilanz.sleevingStatus} /></td>
            </tr>
            <tr className="bg-white">
              <td className="px-4 py-3 font-semibold text-slate-900">Wareneingang · Inbound</td>
              <td className="px-4 py-3 text-xs text-slate-600">
                Erhalten {fmtNum(weekBilanz.inboundReceived)} · Beschädigt {fmtNum(weekBilanz.inboundDamaged)} · Schadensquote {fmtNum(weekBilanz.inboundDamageRate, 2)}%
              </td>
              <td className="px-4 py-3 text-right"><BilanzBadge status={weekBilanz.inboundStatus} /></td>
            </tr>
            <tr className="bg-slate-50">
              <td className="px-4 py-3 font-semibold text-slate-900">Debox → Postblast</td>
              <td className="px-4 py-3 text-xs text-slate-600">
                Debox {fmtNum(weekBilanz.deboxQty)} · Postblast {fmtNum(weekBilanz.postblastQty)} · Delta {weekBilanz.deboxDelta >= 0 ? "+" : ""}{fmtNum(weekBilanz.deboxDelta)} ({weekBilanz.deboxDelta >= 0 ? "+" : ""}{fmtNum(weekBilanz.deboxDeltaPct, 1)}%)
              </td>
              <td className="px-4 py-3 text-right"><BilanzBadge status={weekBilanz.deboxStatus} /></td>
            </tr>
            <tr className="bg-white">
              <td className="px-4 py-3 font-semibold text-slate-900">SKU-Signale</td>
              <td className="px-4 py-3 text-xs text-slate-600">
                {fmtNum(weekBilanz.criticalSkus)} Kritisch · {fmtNum(weekBilanz.checkSkus)} Prüfen · {fmtNum(weekBilanz.totalSkus)} SKUs gesamt · {fmtNum(commandKpis.noMatch)} No-Match
              </td>
              <td className="px-4 py-3 text-right"><BilanzBadge status={weekBilanz.skuStatus} /></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Kommandozentrale</h3>
              <div className="mt-1 text-sm text-slate-500">
                Planer-KW {week} gegen WMS {wmsWeek}: Main Meals werden gegen aktuelle Plating-Line-Stueck plus Historie {historyRangeStart} bis {historyRangeEnd} gelesen.
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
              {fmtNum(commandSkuRows.length)} Artikel · {fmtNum(commandRecipeRows.length)} Main Meals
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="Main Bedarf" value={fmtQty(commandKpis.plannedMainPieces, "Stk")} tone="slate" />
          <WmsStat label="Aktuell Line" value={fmtQty(commandKpis.mainOutputPieces, "Stk")} tone="emerald" />
          <WmsStat label="Vorher gebaut" value={fmtQty(commandKpis.historicalMainPieces, "Stk")} tone="violet" />
          <WmsStat label="Main Gap" value={fmtQty(commandKpis.mainGapPieces, "Stk")} tone={commandKpis.mainGapPieces > 0 ? "amber" : "emerald"} />
          <WmsStat label="Coverage" value={`${fmtNum(commandKpis.mainCoverage, 1)}%`} tone={commandKpis.mainCoverage >= 98 ? "emerald" : "sky"} />
          <WmsStat label="Lost / Hold" value={`${fmtNum(commandKpis.lost)} / ${fmtNum(commandKpis.hold)}`} tone={commandKpis.lost + commandKpis.hold > 0 ? "rose" : "slate"} />
          <WmsStat label="No Match" value={fmtNum(commandKpis.noMatch)} tone={commandKpis.noMatch > 0 ? "rose" : "slate"} />
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
            <div className="border-b border-slate-100 p-3">
              <h4 className="text-sm font-black text-slate-900">Main Meals: Bedarf vs Output</h4>
              <div className="text-xs text-slate-500">Bedarf gegen aktuelle Plating-Line-Stueck plus vorher gebuchte Plating-Historie. So zaehlt auch, was vor der aktuellen WMS-Woche schon hergestellt wurde.</div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
                  <tr>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Main Meal</th>
                    <th className="px-3 py-2 text-right">Bedarf</th>
                    <th className="px-3 py-2 text-right">Ist gesamt</th>
                    <th className="px-3 py-2">Fortschritt</th>
                    <th className="px-3 py-2 text-right">Sub Signale</th>
                  </tr>
                </thead>
                <tbody>
                  {mainCommandRows.map((row) => {
                    const coverage = row.plannedPieces > 0 ? Math.min(100, (row.totalOutputPieces / row.plannedPieces) * 100) : 0;
                    return (
                      <tr key={row.key} className="odd:bg-white even:bg-slate-50/70 hover:bg-sky-50">
                        <td className="border-b border-slate-100 px-3 py-2">
                          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ${commandStatusTone(row.status)}`}>{row.statusText}</span>
                        </td>
                        <td className="max-w-[360px] border-b border-slate-100 px-3 py-2">
                          <div className="font-mono font-black text-slate-900">{row.recipe}</div>
                          <div className="truncate text-[11px] text-slate-500">{row.name}</div>
                          <div className="truncate font-mono text-[10px] text-slate-400">{[...row.mainSkus].slice(0, 3).join(", ") || "kein MSKU"}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">{fmtQty(row.plannedPieces, "Stk")}</td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono">
                          <div className="font-black text-emerald-800">{fmtQty(row.totalOutputPieces, "Stk")}</div>
                          <div className="text-[10px] font-semibold text-slate-400">aktuell {fmtNum(row.mainOutputPieces)} · vorher {fmtNum(row.historicalOutputPieces)}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2">
                          <div className="h-2 min-w-32 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${coverage >= 98 ? "bg-emerald-500" : coverage > 0 ? "bg-sky-500" : "bg-amber-500"}`} style={{ width: `${Math.max(3, coverage)}%` }} />
                          </div>
                          <div className="mt-1 text-[10px] font-bold text-slate-500">{fmtNum(coverage, 1)}%</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono text-[11px] text-slate-700">
                          <div className="font-black text-sky-800">PostB {fmtQty(row.subPostblastQty, "Qty")}</div>
                          <div className="font-black text-violet-800">PLH {fmtQty(row.subHoldingPieces, "Stk")}</div>
                          {row.subSignalSharedCount > 0 && (
                            <div className="mt-1 text-[10px] font-semibold text-slate-400">
                              anteilig aus {fmtNum(row.subSignalSharedCount)} Shared Subs
                            </div>
                          )}
                          {(row.sleevingLost > 0 || row.sleevingHold > 0) && <div className="font-black text-rose-700">L/H {fmtNum(row.sleevingLost)}/{fmtNum(row.sleevingHold)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {mainCommandRows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine Main Meals fuer diese Tool-KW.</div>}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-black text-slate-900">Sub Meals Monitor</h4>
                  <div className="text-xs text-slate-500">Geplante Gramm bleiben Gramm; PLH zeigt zusaetzlich Stueck aus Packanleitung.</div>
                </div>
                <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-800 ring-1 ring-violet-200">
                  Plan {fmtQty(commandKpis.plannedSubQty, "Qty")}
                </span>
              </div>
              <div className="mt-3 max-h-[300px] overflow-auto">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-slate-950 text-[11px] uppercase text-slate-200">
                    <tr>
                      <th className="px-3 py-2">Sub Meal</th>
                      <th className="px-3 py-2 text-right">Plan</th>
                      <th className="px-3 py-2 text-right">PostB</th>
                      <th className="px-3 py-2 text-right">PLH Stk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subCommandRows.map((row) => (
                      <tr key={row.key} className="odd:bg-white even:bg-slate-50/70">
                        <td className="max-w-[220px] border-b border-slate-100 px-3 py-2">
                          <div className="font-mono text-[11px] font-black text-slate-900">{row.sku}</div>
                          <div className="truncate text-[11px] text-slate-500">{row.name}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono">{fmtQty(row.plannedQty, row.uom || "Qty")}</td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-sky-800">{fmtQty(row.postblastQty, "Qty")}</td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-violet-800">{fmtQty(row.platingHoldingPieces, "Stk")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {subCommandRows.length === 0 && <EmptyBox text="Keine Sub-Meal-Signale fuer diese WMS-KW." />}
              </div>
            </div>

            <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-black text-slate-900">Artikel Watchlist</h4>
                  <div className="text-xs text-slate-500">Zeigt den konkreten WMS-Ausloeser: Prozess, Bestand, Eingang, Lost, Hold oder Damaged.</div>
                </div>
                <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-800 ring-1 ring-rose-200">
                  {fmtNum(commandKpis.criticalSkus)} kritisch · {fmtNum(commandKpis.checkSkus)} pruefen
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {commandWatchRows.slice(0, 8).map((row) => (
                  <div key={row.key} className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-black text-slate-500">{row.sku} · {row.category}</div>
                        <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
                        <div className="mt-1 text-[11px] text-slate-500">{[...row.recipes].slice(0, 3).join(", ") || "nicht in ausgewaehlter KW"} · {row.statusText}</div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ring-1 ${commandStatusTone(row.status)}`}>{row.status}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10px] font-bold">
                      <div className="rounded bg-slate-100 px-1 py-1 text-slate-700">Plan {fmtNum(row.plannedQty)}</div>
                      <div className="rounded bg-emerald-50 px-1 py-1 text-emerald-800">Line {fmtNum(row.platingLinePieces)}</div>
                      <div className="rounded bg-violet-50 px-1 py-1 text-violet-800">PLH {fmtNum(row.platingHoldingPieces)} Stk</div>
                      <div className="rounded bg-sky-50 px-1 py-1 text-sky-800">PostB {fmtNum(row.postblastQty)} Qty</div>
                      <div className="rounded bg-teal-50 px-1 py-1 text-teal-800">Inbound {fmtNum(row.inboundReceived)}</div>
                      <div className="rounded bg-amber-50 px-1 py-1 text-amber-800">Staging {fmtNum(row.stagingQty)}</div>
                      <div className="rounded bg-orange-50 px-1 py-1 text-orange-800">Debox {fmtNum(row.deboxQty)}</div>
                      <div className="rounded bg-rose-50 px-1 py-1 text-rose-800">L/H/D {fmtNum(row.sleevingLost)}/{fmtNum(row.sleevingHold)}/{fmtNum(row.inboundDamaged)}</div>
                    </div>
                  </div>
                ))}
                {commandWatchRows.length === 0 && <EmptyBox text="Keine kritischen Artikel nach aktueller Datenlage." />}
              </div>
            </div>
          </div>
        </div>
      </section>
      </>)}

      {activeTab === "plating" && (<>
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Plating Query Ergebnis</h3>
              <div className="mt-1 text-sm text-slate-500">
                PLATING-LINE-01/02/03: Actual Qty = Stueck. PLH/PLSTG: Gramm werden ueber g/Stk aus der Packanleitung in Stueck umgerechnet.
              </div>
            </div>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="SKU, Name, Location, Rezept..."
              className="w-80 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-2">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">Linien Output</h4>
                <div className="text-xs text-slate-500">PLATING-LINE-01/02/03</div>
              </div>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">
                {fmtQty(lineRows.reduce((sum, row) => sum + row.pieces, 0), "Stk")}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {lineRows.slice(0, 12).map((row) => <PlatingRowCard key={row.key} row={row} maxPieces={maxPieces} />)}
              {lineRows.length === 0 && <EmptyBox text="Keine Plating-Line-Zeilen fuer diese WMS-KW." />}
            </div>
          </div>

          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">PLH Holding</h4>
                <div className="text-xs text-slate-500">PLH/PLSTG · Gramm zu Stueck</div>
              </div>
              <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-800 ring-1 ring-violet-200">
                {fmtQty(holdingRows.reduce((sum, row) => sum + row.pieces, 0), "Stk")}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {holdingRows.slice(0, 12).map((row) => <PlatingRowCard key={row.key} row={row} maxPieces={maxPieces} />)}
              {holdingRows.length === 0 && <EmptyBox text="Keine PLH-/PLSTG-Zeilen fuer diese WMS-KW." />}
            </div>
          </div>
        </div>

        <div className="max-h-[620px] overflow-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
              <tr>
                <th className="px-3 py-2">Bereich</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Artikel</th>
                <th className="px-3 py-2 text-right">Rohmenge</th>
                <th className="px-3 py-2 text-right">Stueck</th>
                <th className="px-3 py-2">Regel</th>
                <th className="px-3 py-2">Lot / HU / Status</th>
                <th className="px-3 py-2">Rezept / Zeit</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.key} className="odd:bg-white even:bg-slate-50/70 hover:bg-violet-50">
                  <td className="border-b border-slate-100 px-3 py-2">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ${row.area === "Line" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : row.area === "Holding" ? "bg-violet-50 text-violet-800 ring-violet-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>{row.area}</span>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 font-mono font-black text-slate-800">{row.location}</td>
                  <td className="max-w-[340px] border-b border-slate-100 px-3 py-2">
                    <div className="font-mono font-black text-slate-900">{row.sku || "-"}</div>
                    <div className="truncate text-[11px] text-slate-500">{row.name}</div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right font-mono text-slate-700">
                    {row.area === "Line" ? fmtQty(row.rawQty, "Stk") : fmtQty(row.rawQty / 1000, "kg")}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">{fmtQty(row.pieces, "Stk")}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-slate-600">{row.unitNote}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                    <div>{fmtNum(row.lots.size)} Lots · {fmtNum(row.hus.size)} HUs</div>
                    <div className="text-[11px] text-slate-400">{[...row.statuses].slice(0, 2).join(", ") || "-"}</div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                    <div className="font-mono text-[11px]">{[...row.recipes].slice(0, 3).join(", ") || "nicht in ausgewaehlter KW"}</div>
                    <div className="text-[11px] text-slate-400">{fmtDateTime(row.lastChange)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine Plating-/PLH-Zeilen geladen.</div>}
        </div>
      </section>
      </>)}

      {activeTab === "sleeving" && (<>
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Sleeving Query Ergebnis</h3>
              <div className="mt-1 text-sm text-slate-500">
                T_TRAN_LOG separat: LOST und Cycle Count werden als Korrektur-/Verlustsignal gelesen, Hold als Statusbewegung, nicht als Output.
              </div>
            </div>
            <input
              value={sleevingSearch}
              onChange={(event) => setSleevingSearch(event.target.value)}
              placeholder="SKU, Name, Mitarbeiter, Beschreibung..."
              className="w-80 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="Nach Sleeving" value={fmtQty(sleevingKpis.inbound, "Stk")} tone="emerald" />
          <WmsStat label="Aus Sleeving" value={fmtQty(sleevingKpis.outbound, "Stk")} tone="sky" />
          <WmsStat label="Lost" value={fmtQty(sleevingKpis.lost, "Stk")} tone="rose" />
          <WmsStat label="Cycle Delta" value={fmtQty(sleevingKpis.cycleDelta, "Stk")} tone="amber" />
          <WmsStat label="Hold" value={fmtQty(sleevingKpis.hold, "Stk")} tone="violet" />
          <WmsStat label="Paare" value={fmtNum(sleevingKpis.correctionPairs)} tone="slate" />
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-[1fr_1.35fr]">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">Artikel-Signale</h4>
                <div className="text-xs text-slate-500">Top SKUs nach Bewegung, Lost, Hold und Cycle Count</div>
              </div>
              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                {fmtNum(sleevingKpis.skuCount)} SKUs
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {filteredSleevingSummaryRows.slice(0, 14).map((row) => (
                <SleevingSummaryCard
                  key={row.key}
                  row={row}
                  maxValue={Math.max(1, ...filteredSleevingSummaryRows.map((item) => item.inbound + item.outbound + item.lost + Math.abs(item.cycleDelta) + item.hold))}
                />
              ))}
              {filteredSleevingSummaryRows.length === 0 && <EmptyBox text="Keine Sleeving-Signale fuer diese WMS-KW." />}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
            <div className="border-b border-slate-100 p-3">
              <h4 className="text-sm font-black text-slate-900">Bewegungslogik</h4>
              <div className="text-xs text-slate-500">
                Beispiel 721 = Hold, 023 nach LOST = Verlust, 800 = Cycle Count. Gleiche SKU/Menge/Zeit/Mitarbeiter werden als Korrekturpaar markiert.
              </div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
                  <tr>
                    <th className="px-3 py-2">Signal</th>
                    <th className="px-3 py-2">Von / Nach</th>
                    <th className="px-3 py-2">Artikel</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2">Typ / Beschreibung</th>
                    <th className="px-3 py-2">Zeit / MA</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSleevingEvents.map((row, index) => {
                    const signal = sleevingSignalForRow(row);
                    const info = skuInfoForSku(row.itemNumber, plannedSkuIndex);
                    const isPair = (signal === "Lost" || signal === "Cycle Count") && sleevingCorrectionKeys.has(sleevingPairKey(row));
                    return (
                      <tr key={`${row.itemNumber}-${row.tranType}-${row.endTranDate}-${index}`} className="odd:bg-white even:bg-slate-50/70 hover:bg-sky-50">
                        <td className="border-b border-slate-100 px-3 py-2">
                          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ${signalTone(signal)}`}>{signal}</span>
                          {isPair && <div className="mt-1 text-[10px] font-bold text-amber-700">Paar</div>}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 font-mono text-[11px] font-bold text-slate-700">
                          <div>{row.von || "-"}</div>
                          <div className="text-slate-400">→ {row.nach || "-"}</div>
                        </td>
                        <td className="max-w-[300px] border-b border-slate-100 px-3 py-2">
                          <div className="font-mono font-black text-slate-900">{row.itemNumber || "-"}</div>
                          <div className="truncate text-[11px] text-slate-500">{info.name}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">{fmtQty(row.tranQty, "Stk")}</td>
                        <td className="max-w-[260px] border-b border-slate-100 px-3 py-2 text-slate-600">
                          <div className="font-mono text-[11px] font-black text-slate-800">{row.tranType || "-"}</div>
                          <div className="truncate text-[11px]">{row.description || "-"}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                          <div>{fmtDateTime(row.endTranDate || row.startTranDate)}</div>
                          <div className="font-mono text-[11px] text-slate-400">{row.employeeId || "-"}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredSleevingEvents.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine Sleeving-Events geladen.</div>}
            </div>
          </div>
        </div>
      </section>
      </>)}

      {activeTab === "prozess" && (<>
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Debox rein - Postblast raus</h3>
              <div className="mt-1 text-sm text-slate-500">
                Zwei getrennte T_STORED_ITEM-Queries: Debox zeigt Input-Locations, PostB-01 zeigt Output nach Blast. Matching laeuft ueber Tool-SKUs und Rezeptbezug.
              </div>
            </div>
            <input
              value={deboxSearch}
              onChange={(event) => setDeboxSearch(event.target.value)}
              placeholder="SKU, Name, Rezept, Debox, PostB..."
              className="w-80 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="Debox Input" value={fmtQty(deboxKpis.deboxQty, "Qty")} tone="emerald" />
          <WmsStat label="Postblast Out" value={fmtQty(deboxKpis.postblastQty, "Qty")} tone="sky" />
          <WmsStat label="Delta" value={fmtQty(deboxKpis.deltaQty, "Qty")} tone={deboxKpis.deltaQty < 0 ? "rose" : "slate"} />
          <WmsStat label="Input SKUs" value={fmtNum(deboxKpis.deboxSkus)} tone="violet" />
          <WmsStat label="Output SKUs" value={fmtNum(deboxKpis.postblastSkus)} tone="amber" />
          <WmsStat label="Rezepte" value={fmtNum(deboxKpis.recipes)} tone="slate" />
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-2">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">Debox Input</h4>
                <div className="text-xs text-slate-500">Was in Debox liegt oder gebucht wurde</div>
              </div>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">
                No Match {fmtNum(deboxKpis.unmatchedInput)}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {filteredDeboxRows.slice(0, 12).map((row) => (
                <StagingSummaryCard
                  key={`debox-${row.key}`}
                  row={row}
                  maxValue={Math.max(1, ...filteredDeboxRows.map((item) => item.rawQty))}
                />
              ))}
              {filteredDeboxRows.length === 0 && <EmptyBox text="Keine Debox-Zeilen fuer diese WMS-KW." />}
            </div>
          </div>

          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">Postblast Output</h4>
                <div className="text-xs text-slate-500">Was in PostB-01 als Output steht</div>
              </div>
              <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-800 ring-1 ring-sky-200">
                No Match {fmtNum(deboxKpis.unmatchedOutput)}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {filteredPostblastRows.slice(0, 12).map((row) => (
                <StagingSummaryCard
                  key={`postblast-${row.key}`}
                  row={row}
                  maxValue={Math.max(1, ...filteredPostblastRows.map((item) => item.rawQty))}
                />
              ))}
              {filteredPostblastRows.length === 0 && <EmptyBox text="Keine Postblast-Zeilen fuer diese WMS-KW." />}
            </div>
          </div>
        </div>

        <div className="max-h-[520px] overflow-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
              <tr>
                <th className="px-3 py-2">Rezeptmatch</th>
                <th className="px-3 py-2 text-right">Debox Input</th>
                <th className="px-3 py-2 text-right">Postblast Output</th>
                <th className="px-3 py-2 text-right">Delta</th>
                <th className="px-3 py-2">Input Artikel</th>
                <th className="px-3 py-2">Output Artikel</th>
              </tr>
            </thead>
            <tbody>
              {filteredProcessRecipeRows.map((row) => {
                const delta = row.postblastQty - row.deboxQty;
                return (
                  <tr key={row.key} className="odd:bg-white even:bg-slate-50/70 hover:bg-sky-50">
                    <td className="border-b border-slate-100 px-3 py-2 font-mono font-black text-slate-900">{row.recipe}</td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-emerald-800">{fmtQty(row.deboxQty, "Qty")}</td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-sky-800">{fmtQty(row.postblastQty, "Qty")}</td>
                    <td className={`border-b border-slate-100 px-3 py-2 text-right font-mono font-black ${delta < 0 ? "text-rose-700" : "text-slate-800"}`}>{fmtQty(delta, "Qty")}</td>
                    <td className="max-w-[360px] border-b border-slate-100 px-3 py-2">
                      <div className="font-mono text-[11px] text-slate-700">{[...row.deboxSkus].slice(0, 4).join(", ") || "-"}</div>
                      <div className="truncate text-[11px] text-slate-400">{[...row.deboxNames].slice(0, 2).join(", ") || "-"}</div>
                    </td>
                    <td className="max-w-[360px] border-b border-slate-100 px-3 py-2">
                      <div className="font-mono text-[11px] text-slate-700">{[...row.postblastSkus].slice(0, 4).join(", ") || "-"}</div>
                      <div className="truncate text-[11px] text-slate-400">{[...row.postblastNames].slice(0, 2).join(", ") || "-"}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredProcessRecipeRows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine Debox/Postblast-Matches geladen.</div>}
        </div>
      </section>
      </>)}

      {activeTab === "inbound" && (<>
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Inbound Query Ergebnis</h3>
              <div className="mt-1 text-sm text-slate-500">
                T_RECEIPT separat: Wareneingang nach RECEIPT_DATE, inklusive PO, Vendor, HU, Lot, MHD und Damaged Qty.
              </div>
            </div>
            <input
              value={inboundSearch}
              onChange={(event) => setInboundSearch(event.target.value)}
              placeholder="SKU, Name, PO, Vendor, HU, Lot..."
              className="w-80 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="Received" value={fmtQty(inboundKpis.received, "Qty")} tone="emerald" />
          <WmsStat label="Damaged" value={fmtQty(inboundKpis.damaged, "Qty")} tone="rose" />
          <WmsStat label="SKUs" value={fmtNum(inboundKpis.skuCount)} tone="sky" />
          <WmsStat label="POs" value={fmtNum(inboundKpis.poCount)} tone="violet" />
          <WmsStat label="Vendoren" value={fmtNum(inboundKpis.vendorCount)} tone="amber" />
          <WmsStat label="HUs" value={fmtNum(inboundKpis.huCount)} tone="slate" />
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-[1fr_1.35fr]">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">Artikel-Eingang</h4>
                <div className="text-xs text-slate-500">Top SKUs nach empfangener Menge und Schaden</div>
              </div>
              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                {fmtNum(filteredInboundSummaryRows.length)} Treffer
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {filteredInboundSummaryRows.slice(0, 14).map((row) => (
                <InboundSummaryCard
                  key={row.key}
                  row={row}
                  maxValue={Math.max(1, ...filteredInboundSummaryRows.map((item) => item.received))}
                />
              ))}
              {filteredInboundSummaryRows.length === 0 && <EmptyBox text="Keine Inbound-Eingaenge fuer diese WMS-KW." />}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
            <div className="border-b border-slate-100 p-3">
              <h4 className="text-sm font-black text-slate-900">PO / Vendor / Lot Details</h4>
              <div className="text-xs text-slate-500">
                Rohzeilen aus T_RECEIPT, nach RECEIPT_DATE absteigend. Mengen bleiben in der WMS-Originaleinheit.
              </div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
                  <tr>
                    <th className="px-3 py-2">PO / Vendor</th>
                    <th className="px-3 py-2">Artikel</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Damaged</th>
                    <th className="px-3 py-2">HU / Lot</th>
                    <th className="px-3 py-2">Status / MHD</th>
                    <th className="px-3 py-2">Zeit</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInboundEvents.map((row, index) => {
                    const info = skuInfoForSku(row.itemNumber, plannedSkuIndex);
                    return (
                      <tr key={`${row.poNumber}-${row.itemNumber}-${row.huId}-${index}`} className="odd:bg-white even:bg-slate-50/70 hover:bg-emerald-50">
                        <td className="border-b border-slate-100 px-3 py-2 font-mono text-[11px] font-bold text-slate-700">
                          <div>{row.poNumber || "-"}</div>
                          <div className="text-slate-400">{row.vendorCode || "-"}</div>
                        </td>
                        <td className="max-w-[300px] border-b border-slate-100 px-3 py-2">
                          <div className="font-mono font-black text-slate-900">{row.itemNumber || "-"}</div>
                          <div className="truncate text-[11px] text-slate-500">{info.name}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">{fmtQty(row.qtyReceived, "Qty")}</td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-rose-700">{fmtQty(row.qtyDamaged, "Qty")}</td>
                        <td className="border-b border-slate-100 px-3 py-2 font-mono text-[11px] text-slate-600">
                          <div>{row.huId || "-"}</div>
                          <div className="text-slate-400">{row.lotNumber || "-"}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                          <div>{row.status || row.tranStatus || "-"}</div>
                          <div className="text-[11px] text-slate-400">{fmtDateTime(row.expirationDate)}</div>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                          <div>{fmtDateTime(row.receiptDate)}</div>
                          <div className="font-mono text-[11px] text-slate-400">{row.shipmentNumber || "-"}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredInboundEvents.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine Inbound-Zeilen geladen.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-black text-slate-950">Staging Query Ergebnis</h3>
              <div className="mt-1 text-sm text-slate-500">
                T_STORED_ITEM separat: nur PHSTG-Locations, nach DB_CHANGE_COMMIT_TIME auf die WMS-KW begrenzt.
              </div>
            </div>
            <input
              value={stagingSearch}
              onChange={(event) => setStagingSearch(event.target.value)}
              placeholder="SKU, Name, PHSTG, Lot, HU, Status..."
              className="w-80 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-3 xl:grid-cols-6">
          <WmsStat label="PHSTG Qty" value={fmtQty(stagingKpis.qty, "Qty")} tone="emerald" />
          <WmsStat label="SKUs" value={fmtNum(stagingKpis.skuCount)} tone="sky" />
          <WmsStat label="Locations" value={fmtNum(stagingKpis.locationCount)} tone="violet" />
          <WmsStat label="HUs" value={fmtNum(stagingKpis.huCount)} tone="slate" />
          <WmsStat label="Lots" value={fmtNum(stagingKpis.lotCount)} tone="amber" />
          <WmsStat label="No Match" value={fmtNum(stagingKpis.unmatched)} tone="rose" />
        </div>

        <div className="grid gap-4 bg-slate-50 p-4 xl:grid-cols-[1fr_1.35fr]">
          <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-black text-slate-900">PHSTG Bestand</h4>
                <div className="text-xs text-slate-500">Top Location/SKU-Kombinationen nach WMS-Qty</div>
              </div>
              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                {fmtNum(filteredStagingRows.length)} Treffer
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {filteredStagingRows.slice(0, 14).map((row) => (
                <StagingSummaryCard
                  key={row.key}
                  row={row}
                  maxValue={Math.max(1, ...filteredStagingRows.map((item) => item.rawQty))}
                />
              ))}
              {filteredStagingRows.length === 0 && <EmptyBox text="Keine PHSTG-Zeilen fuer diese WMS-KW." />}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
            <div className="border-b border-slate-100 p-3">
              <h4 className="text-sm font-black text-slate-900">Location / Lot / HU Details</h4>
              <div className="text-xs text-slate-500">
                Aggregiert nach Location und SKU. Mengen bleiben in der WMS-Originaleinheit.
              </div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-950 text-[11px] uppercase text-slate-200">
                  <tr>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Artikel</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2">Lot / HU</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">FIFO / MHD</th>
                    <th className="px-3 py-2">Rezept / Zeit</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStagingRows.map((row) => (
                    <tr key={row.key} className="odd:bg-white even:bg-slate-50/70 hover:bg-emerald-50">
                      <td className="border-b border-slate-100 px-3 py-2 font-mono font-black text-slate-800">{row.location}</td>
                      <td className="max-w-[300px] border-b border-slate-100 px-3 py-2">
                        <div className="font-mono font-black text-slate-900">{row.sku || "-"}</div>
                        <div className="truncate text-[11px] text-slate-500">{row.name}</div>
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">{fmtQty(row.rawQty, "Qty")}</td>
                      <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                        <div>{fmtNum(row.lots.size)} Lots · {fmtNum(row.hus.size)} HUs</div>
                        <div className="truncate text-[11px] text-slate-400">{[...row.lots].slice(0, 2).join(", ") || "-"}</div>
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-slate-600">{[...row.statuses].slice(0, 3).join(", ") || "-"}</td>
                      <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                        <div>{fmtDateTime(row.fifoDate)}</div>
                        <div className="text-[11px] text-slate-400">{fmtDateTime(row.expirationDate)}</div>
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-slate-600">
                        <div className="font-mono text-[11px]">{[...row.recipes].slice(0, 3).join(", ") || "nicht im Plan"}</div>
                        <div className="text-[11px] text-slate-400">{fmtDateTime(row.lastChange)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredStagingRows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">Keine PHSTG-Zeilen geladen.</div>}
            </div>
          </div>
        </div>
      </section>
      </>)}

      {activeTab === "workorders" && (<>
      {/* ── Workorders (V_SUBMEAL_PRODUCTION) ── */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-950 px-5 py-4 text-white">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-amber-300">Produktionsaufträge · V_SUBMEAL_PRODUCTION</div>
            <h2 className="text-lg font-black">
              {workordersByMeal.length} Meals · {workordersForWeek.length} Submeals · KW {week}
            </h2>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-300">WMS-Code: {wmsWeekCode || "—"}</div>
            <div className="text-[10px] text-slate-400">{workordersRawRows.length} Aufträge gesamt im System</div>
          </div>
        </div>

        {workordersForWeek.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Keine Workorders für KW {week} (WMS-Code: {wmsWeekCode}) gefunden.{" "}
            {workordersRawRows.length > 0 && (
              <span className="text-amber-600">
                Im Cache sind {workordersRawRows.length} Aufträge aus anderen KWs — bitte für diese KW neu synchronisieren:{" "}
              </span>
            )}
            <code className="rounded bg-slate-100 px-1 py-0.5">npm run wms:sync -- --week {week} && npm run wms:push</code>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {workordersByMeal.slice(0, 30).map((group) => {
              const plhRows = group.submeals
                .map((s) => {
                  const plhMatches = (workordersIndex.get(s.submealItemNumber) ?? []);
                  return plhMatches;
                })
                .flat();
              const totalPlates = group.submeals.reduce((sum, s) => sum + (s.plates ?? 0), 0);
              const totalPreblast = group.submeals.reduce((sum, s) => sum + (s.preBlastQuantity ?? 0), 0);
              const totalQtyKg = group.totalQtyG / 1000;
              const completedCount = group.submeals.filter((s) => s.status?.trim() === "C").length;
              const progressPct = group.submeals.length > 0 ? (completedCount / group.submeals.length) * 100 : 0;

              return (
                <div key={group.mealItemNumber} className="p-4">
                  {/* Meal Header */}
                  <div className="mb-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[11px] font-black text-slate-400">{group.mealItemNumber}</div>
                      <div className="text-sm font-black text-slate-900">{group.mealItemDescription}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-right">
                      <div>
                        <div className="font-mono text-base font-black text-slate-900">{fmtNum(totalQtyKg, 1)} kg</div>
                        <div className="text-[10px] text-slate-500">{group.submeals.length} Submeals</div>
                      </div>
                      {progressPct > 0 && (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-800 ring-1 ring-emerald-200">
                          {fmtNum(progressPct, 0)}% fertig
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Progress bar */}
                  {group.submeals.length > 0 && (
                    <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full transition-all ${progressPct >= 100 ? "bg-emerald-500" : progressPct >= 50 ? "bg-sky-400" : "bg-amber-400"}`}
                        style={{ width: `${Math.max(3, progressPct)}%` }}
                      />
                    </div>
                  )}

                  {/* Submeal rows */}
                  <div className="overflow-hidden rounded-lg ring-1 ring-slate-200">
                    <table className="min-w-full border-collapse text-left text-xs">
                      <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Submeal</th>
                          <th className="px-3 py-2 text-right">Menge</th>
                          <th className="px-3 py-2 text-right">Pre-Blast</th>
                          <th className="px-3 py-2 text-right">g/Stk (aus WO)</th>
                          <th className="px-3 py-2">WO-Nr</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Produktion</th>
                          <th className="px-3 py-2">MHD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.submeals.map((sub, idx) => {
                          const qty = sub.quantity ?? 0;
                          const preblast = sub.preBlastQuantity ?? 0;
                          const plates = sub.plates ?? 0;
                          const gPerStk = plates > 0 && qty > 0 ? qty / plates : (sub.targetPerPlate ?? 0);
                          const isCompleted = sub.status?.trim() === "C";
                          const isActive = sub.status?.trim() === "A";
                          // Match to PLH holding: find plating rows for this SKU
                          const plhMatched = platingRows.filter((r) => r.sku === sub.submealItemNumber && r.area === "Holding");
                          const plhPieces = plhMatched.reduce((sum, r) => sum + r.pieces, 0);
                          const plhKg = plhMatched.reduce((sum, r) => sum + r.kg, 0);

                          return (
                            <tr key={idx} className={`odd:bg-white even:bg-slate-50/70 ${isCompleted ? "opacity-60" : ""}`}>
                              <td className="border-b border-slate-100 px-3 py-2">
                                <div className="font-mono text-[10px] font-black text-slate-500">{sub.submealItemNumber}</div>
                                <div className="text-[11px] font-bold text-slate-800">{sub.submealItemDescription}</div>
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono font-black text-slate-900">
                                {qty >= 1000 ? `${fmtNum(qty / 1000, 1)} kg` : `${fmtNum(qty, 0)} g`}
                                <div className="text-[10px] font-normal text-slate-400">{sub.uom}</div>
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono text-slate-700">
                                {preblast > 0 ? (preblast >= 1000 ? `${fmtNum(preblast / 1000, 1)} kg` : `${fmtNum(preblast, 0)} g`) : "—"}
                                {plhPieces > 0 && (
                                  <div className="text-[10px] text-violet-600">PLH: {fmtNum(plhKg, 1)} kg / {fmtNum(plhPieces, 0)} Stk</div>
                                )}
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-right font-mono text-slate-700">
                                {gPerStk > 0 ? `${fmtNum(gPerStk, 1)} g` : plates > 0 ? `${fmtNum(plates, 0)} Stk` : "—"}
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 font-mono text-[11px] text-slate-600">{sub.woNumber || "—"}</td>
                              <td className="border-b border-slate-100 px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                                  isCompleted ? "bg-emerald-50 text-emerald-800 ring-emerald-200" :
                                  isActive ? "bg-sky-50 text-sky-800 ring-sky-200" :
                                  sub.status?.trim() ? "bg-amber-50 text-amber-800 ring-amber-200" :
                                  "bg-slate-50 text-slate-500 ring-slate-200"
                                }`}>
                                  {isCompleted ? "Fertig" : isActive ? "Aktiv" : sub.status?.trim() || "Offen"}
                                </span>
                              </td>
                              <td className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500">{fmtDateTime(sub.productionTime)}</td>
                              <td className={`border-b border-slate-100 px-3 py-2 text-[11px] ${mhdTone(sub.expirationDate)}`}>{mhdDaysLabel(sub.expirationDate)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Totals */}
                  <div className="mt-2 flex gap-4 text-[11px] text-slate-500">
                    {totalPlates > 0 && <span>Platten gesamt: <span className="font-bold text-slate-900">{fmtNum(totalPlates)}</span></span>}
                    {totalPreblast > 0 && <span>Pre-Blast gesamt: <span className="font-bold text-slate-900">{totalPreblast >= 1000 ? `${fmtNum(totalPreblast / 1000, 1)} kg` : `${fmtNum(totalPreblast, 0)} g`}</span></span>}
                  </div>
                </div>
              );
            })}
            {workordersByMeal.length > 30 && (
              <div className="p-4 text-center text-sm text-slate-400">+ {workordersByMeal.length - 30} weitere Meals nicht angezeigt</div>
            )}
          </div>
        )}
      </section>
      </>)}
    </div>
  );
}

function BilanzBadge({ status }: { status: "ok" | "warn" | "err" | "offen" }): JSX.Element {
  if (status === "ok") return <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">✓ Stimmig</span>;
  if (status === "warn") return <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">⚠ Prüfen</span>;
  if (status === "err") return <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-800">✗ Kritisch</span>;
  return <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-500">— Offen</span>;
}

function WmsStat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "sky" | "slate" | "rose" | "amber" | "violet" }): JSX.Element {
  const tones: Record<typeof tone, string> = {
    emerald: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    sky: "bg-sky-50 text-sky-900 ring-sky-200",
    slate: "bg-slate-50 text-slate-900 ring-slate-200",
    rose: "bg-rose-50 text-rose-900 ring-rose-200",
    amber: "bg-amber-50 text-amber-900 ring-amber-200",
    violet: "bg-violet-50 text-violet-900 ring-violet-200",
  };
  return (
    <div className={`rounded-lg px-3 py-2 ring-1 ${tones[tone]}`}>
      <div className="text-[10px] font-black uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 text-2xl font-black tabular-nums">{value}</div>
    </div>
  );
}

function PlatingRowCard({ row, maxPieces }: { row: PlatingLocationRow; maxPieces: number }): JSX.Element {
  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-black text-slate-500">{row.location} · {row.sku || "-"}</div>
          <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {[...row.recipes].slice(0, 2).join(", ") || "nicht im Plan"} · {row.unitNote}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-black text-slate-900">{fmtQty(row.pieces, "Stk")}</div>
          <div className="text-[10px] font-semibold text-slate-400">{row.area === "Line" ? fmtQty(row.rawQty, "Stk") : fmtQty(row.kg, "kg")}</div>
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
        <div className={`h-full rounded-full ${row.area === "Line" ? "bg-emerald-500" : "bg-violet-500"}`} style={{ width: `${Math.max(4, (row.pieces / maxPieces) * 100)}%` }} />
      </div>
    </div>
  );
}

function SleevingSummaryCard({ row, maxValue }: { row: SleevingSummaryRow; maxValue: number }): JSX.Element {
  const totalSignal = row.inbound + row.outbound + row.lost + Math.abs(row.cycleDelta) + row.hold;
  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-black text-slate-500">{row.sku}</div>
          <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {[...row.recipes].slice(0, 2).join(", ") || "nicht im Plan"} · {fmtNum(row.eventCount)} Events
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-black text-slate-900">{fmtQty(totalSignal, "Stk")}</div>
          <div className="text-[10px] font-semibold text-slate-400">{fmtDateTime(row.lastChange)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1 text-center text-[10px] font-bold">
        <div className="rounded bg-emerald-50 px-1 py-1 text-emerald-800">{fmtNum(row.inbound)}</div>
        <div className="rounded bg-sky-50 px-1 py-1 text-sky-800">{fmtNum(row.outbound)}</div>
        <div className="rounded bg-rose-50 px-1 py-1 text-rose-800">{fmtNum(row.lost)}</div>
        <div className="rounded bg-amber-50 px-1 py-1 text-amber-800">{fmtNum(row.cycleDelta)}</div>
        <div className="rounded bg-violet-50 px-1 py-1 text-violet-800">{fmtNum(row.hold)}</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.max(4, (totalSignal / maxValue) * 100)}%` }} />
      </div>
    </div>
  );
}

function InboundSummaryCard({ row, maxValue }: { row: InboundSummaryRow; maxValue: number }): JSX.Element {
  const damagedRate = row.received > 0 ? (row.damaged / row.received) * 100 : 0;
  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-black text-slate-500">{row.sku}</div>
          <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {[...row.vendors].slice(0, 2).join(", ") || "kein Vendor"} · {fmtNum(row.poCount)} POs · {fmtNum(row.lotCount)} Lots
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-black text-slate-900">{fmtQty(row.received, "Qty")}</div>
          <div className="text-[10px] font-semibold text-rose-600">{fmtQty(row.damaged, "damaged")}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[10px] font-bold">
        <div className="rounded bg-emerald-50 px-1 py-1 text-emerald-800">{fmtDateTime(row.lastReceipt)}</div>
        <div className="rounded bg-sky-50 px-1 py-1 text-sky-800">{fmtNum(row.huCount)} HU</div>
        <div className="rounded bg-rose-50 px-1 py-1 text-rose-800">{fmtNum(damagedRate, 1)}%</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(4, (row.received / maxValue) * 100)}%` }} />
      </div>
    </div>
  );
}

function StagingSummaryCard({ row, maxValue }: { row: StagingSummaryRow; maxValue: number }): JSX.Element {
  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-black text-slate-500">{row.location} · {row.sku}</div>
          <div className="truncate text-sm font-black text-slate-900">{row.name}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {[...row.recipes].slice(0, 2).join(", ") || "nicht im Plan"} · {fmtNum(row.lots.size)} Lots · {fmtNum(row.hus.size)} HUs
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-black text-slate-900">{fmtQty(row.rawQty, "Qty")}</div>
          <div className="text-[10px] font-semibold text-slate-400">{fmtDateTime(row.lastChange)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[10px] font-bold">
        <div className="rounded bg-emerald-50 px-1 py-1 text-emerald-800">{row.location}</div>
        <div className="rounded bg-sky-50 px-1 py-1 text-sky-800">{fmtNum(row.hus.size)} HU</div>
        <div className="rounded bg-violet-50 px-1 py-1 text-violet-800">{[...row.statuses].slice(0, 1).join("") || "-"}</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(4, (row.rawQty / maxValue) * 100)}%` }} />
      </div>
    </div>
  );
}

function EmptyBox({ text }: { text: string }): JSX.Element {
  return <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500 ring-1 ring-slate-200">{text}</div>;
}

export default WmsLiveView;
