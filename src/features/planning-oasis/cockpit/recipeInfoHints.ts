// Sub-Rezept-Info-Modal: Bruttomengen je Sub-Rezept hochgerechnet auf Zielportionen,
// inkl. Kapazitäts-/Tray-Hinweisen aus den Bible-/Master-GSheet-Dumps (Fallback,
// wenn PFEI keine Batch-Größe kennt). Plus die Farb-/Hue-Helfer fürs Wochenboard.
import type { CSSProperties } from "react";
import type { DataBundle, DetailedSubRecipe, Recipe, ShelfLifeInfo } from "../../../core/types";
import { getSubRecipeMassProfile } from "../../../lib/equipment";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

// ─── Einheiten / Text-Normalisierung ─────────────────────────────────────────

export function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeUom(value: string | undefined): string {
  return normalizeText(value).replace(/\s+/g, "");
}

export function isEachUom(uom: string | undefined): boolean {
  const token = normalizeUom(uom);
  return token === "ea" || token === "each" || token === "pcs" || token === "pc" || token === "piece" || token === "pieces";
}

export function toKgEquivalent(value: number, uom: string | undefined): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const token = normalizeUom(uom);
  if (!token) return null;
  if (token === "kg" || token === "kilogram" || token === "kilograms") return value;
  if (token === "g" || token === "gram" || token === "grams") return value / 1000;
  if (token === "mg") return value / 1_000_000;
  if (token === "l" || token === "lt" || token === "liter" || token === "litre") return value;
  if (token === "ml") return value / 1000;
  return null;
}

// ─── Rezept-/Sub-Rezept-Auflösung ────────────────────────────────────────────

export function collectSubRecipeYieldPct(subRecipes: DetailedSubRecipe[], result: Map<string, number>) {
  for (const sub of subRecipes) {
    for (const ingredient of sub.ingredients) {
      const key = `${sub.id}::${ingredient.id}`;
      // yieldPct is stored as decimal ratio (0.0–1.0), not as percentage
      const v = Number(ingredient.yieldPct);
      const ratio = Number.isFinite(v) && v > 0 ? (v > 1 ? v / 100 : v) : 1;
      if (!result.has(key)) result.set(key, ratio);
    }
    if (sub.subRecipes.length > 0) collectSubRecipeYieldPct(sub.subRecipes, result);
  }
}

export function findRecipeSubRecipe(recipe: Recipe, subRecipeId: string) {
  for (const market of Object.values(recipe.markets)) {
    for (const sub of market?.subRecipes ?? []) {
      if (sub.id === subRecipeId) return sub;
    }
  }
  return null;
}

export function planningRecipeDigitKey(code: string): string {
  const match = /(\d{4,5})/.exec(String(code ?? ""));
  return match ? match[1] : String(code ?? "");
}

export function resolvePlanningRecipe(data: DataBundle, code: string): Recipe | undefined {
  const exact = data.recipes[code];
  if (exact) return exact;
  const wanted = planningRecipeDigitKey(code);
  return Object.values(data.recipes).find(recipe => planningRecipeDigitKey(recipe.code) === wanted);
}

export function getWeekSplit(data: DataBundle, week: string) {
  const rows = data.weekRecipes.filter(r => r.hfWeek === week);
  const dkse = rows.reduce((sum, row) => sum + row.verdenVolume.DKSE, 0);
  const de = rows.reduce((sum, row) => sum + row.verdenVolume.DE, 0);
  const benl = rows.reduce((sum, row) => sum + row.verdenVolume.BENL, 0);
  const deFriday = Math.round(de / 2);
  return { dkse, de, benl, benlFriday: benl, deFriday, deSunday: Math.max(0, de - deFriday) };
}

export function shelfTone(status: ShelfLifeInfo["status"]): string {
  if (status === "critical") return "bg-rose-100 text-rose-800";
  if (status === "risk") return "bg-amber-100 text-amber-800";
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-700";
}

// ─── Farb-/Hue-Helfer fürs Wochenboard ───────────────────────────────────────

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

export function recipeHue(seed: string): number {
  // Golden-ratio-based distribution: spreads hues maximally for any number of recipes
  const goldenRatio = 0.618033988749895;
  const h = ((stableHash(seed) & 0x7fffffff) * goldenRatio) % 1;
  return Math.round(h * 360);
}

export function weekBoardRecipeTone(recipeCode: string): {
  hue: number;
  row: CSSProperties; sticky: CSSProperties; subRow: CSSProperties; subSticky: CSSProperties;
  slotActive: CSSProperties; slotIdle: CSSProperties;
  subPill: CSSProperties; mainPill: CSSProperties;
  r1Pill: CSSProperties; r1SubPill: CSSProperties; r2Pill: CSSProperties; r2SubPill: CSSProperties;
  infoButton: CSSProperties; code: CSSProperties; title: CSSProperties; badge: CSSProperties;
} {
  const hue = recipeHue(recipeCode);
  return {
    hue,
    row: { background: `linear-gradient(90deg, hsl(${hue} 66% 93%) 0%, hsl(${hue} 44% 97%) 26%, hsl(${hue} 35% 99%) 100%)` },
    sticky: { background: `linear-gradient(90deg, hsl(${hue} 70% 91%) 0%, hsl(${hue} 48% 97%) 100%)`, boxShadow: `inset 4px 0 0 hsl(${hue} 74% 52%)` },
    subRow: { background: `linear-gradient(90deg, hsl(${hue} 42% 97%) 0%, hsl(${hue} 26% 99%) 100%)` },
    subSticky: { backgroundColor: `hsl(${hue} 50% 98%)` },
    slotActive: { backgroundColor: "#ffffff", borderColor: `hsl(${hue} 44% 74%)` },
    slotIdle: { backgroundColor: `hsl(${hue} 46% 98%)`, borderColor: `hsl(${hue} 24% 86%)` },
    subPill: { backgroundColor: `hsl(${hue} 84% 92%)`, color: `hsl(${hue} 62% 26%)`, boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 66%)`, touchAction: "none" as const },
    mainPill: { backgroundColor: `hsl(${hue} 72% 38%)`, color: "#ffffff", boxShadow: `inset 0 0 0 1px hsl(${hue} 78% 28%)`, touchAction: "none" as const },
    // R1: Rezept-Hue dunkel (blau-nah)
    r1Pill: { backgroundColor: `hsl(${hue} 72% 36%)`, color: "#ffffff", boxShadow: `inset 0 0 0 1.5px hsl(${hue} 82% 22%)`, touchAction: "none" as const },
    r1SubPill: { backgroundColor: `hsl(${hue} 68% 88%)`, color: `hsl(${hue} 70% 22%)`, boxShadow: `inset 0 0 0 1.5px hsl(${hue} 58% 58%)`, touchAction: "none" as const },
    // R2: +150° verschoben → deutlich andere Farbe (lila/violett-Richtung)
    r2Pill: { backgroundColor: `hsl(${(hue + 150) % 360} 55% 36%)`, color: "#ffffff", boxShadow: `inset 0 0 0 1.5px hsl(${(hue + 150) % 360} 64% 22%)`, touchAction: "none" as const },
    r2SubPill: { backgroundColor: `hsl(${(hue + 150) % 360} 52% 88%)`, color: `hsl(${(hue + 150) % 360} 60% 22%)`, boxShadow: `inset 0 0 0 1.5px hsl(${(hue + 150) % 360} 50% 58%)`, touchAction: "none" as const },
    infoButton: { backgroundColor: `hsl(${hue} 52% 98%)`, color: `hsl(${hue} 60% 28%)`, boxShadow: `inset 0 0 0 1px hsl(${hue} 48% 70%)` },
    code: { color: `hsl(${hue} 44% 32%)` },
    title: { color: `hsl(${hue} 52% 22%)` },
    badge: { backgroundColor: `hsl(${hue} 74% 90%)`, color: `hsl(${hue} 64% 24%)`, border: `1px solid hsl(${hue} 54% 70%)` },
  };
}

// ─── Bible/Master-GSheet-Hinweise: Kapazität & Tray-Größen (Fallback für PFEI) ──

export type InfoCapacityHint = { key: string; capacityKg: number; equipment: string | null };
export type InfoTrayHint = { key: string; pcsPerTray: number };
export type InfoHints = {
  capacityHints: Map<string, InfoCapacityHint>;
  pieceWeightKg: Map<string, number>;
  trayHints: InfoTrayHint[];
};

export type SubRecipeInfoIngredientRow = {
  ingredientId: string;
  ingredientName: string;
  uom: string;
  yieldRatio: number;
  rawTotal: number;
  rawKg: number | null;
  finishedTotal: number;
  containerType: string;
  containerCount: number;
  proBatchKg: number | null;
};

export type SubRecipeInfoView = {
  recipeCode: string;
  subRecipeId: string;
  subRecipeName: string;
  targetPortions: number;
  yieldRatio: number;
  ingredientRows: SubRecipeInfoIngredientRow[];
  totalRawKg: number;
  totalFinishedKg: number;
  totalContainerCount: number;
  capacityKg: number | null;
  equipment: string | null;
  batchCount: number | null;
  capacitySource: "bible" | "process-spec" | "unknown";
};

function infoNorm(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9äöüß]/g, " ").replace(/\s+/g, " ").trim();
}

function infoParseNum(value: unknown): number | null {
  const text = String(value ?? "").trim().replace(/\./g, "").replace(",", ".");
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function infoParseKg(value: unknown): number | null {
  const text = String(value ?? "").trim();
  const n = infoParseNum(text);
  if (n == null || n <= 0) return null;
  if (text.toLowerCase().includes(" g") || /^\d+\s*g\b/.test(text.toLowerCase())) return n / 1000;
  return n;
}

function infoParsePcs(value: unknown): number | null {
  const m = String(value ?? "").trim().toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*pcs/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function infoToCells(rowValues: unknown): string[] {
  if (!Array.isArray(rowValues)) return [];
  return rowValues.map(cell => String(cell ?? "").trim());
}

function infoDetectHeaderRow(rows: string[][], patterns: RegExp[]): number {
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonEmpty = row.filter(c => c.length > 0).length;
    if (nonEmpty < 3) continue;
    const text = row.join(" | ").toLowerCase();
    const score = patterns.reduce((s, p) => s + (p.test(text) ? 1 : 0), 0) * 10 + nonEmpty;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function infoFindColIdx(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (patterns.some(p => p.test(headers[i].toLowerCase()))) return i;
  }
  return -1;
}

function infoTokenize(value: string): string[] {
  return infoNorm(value).split(" ").filter(t => t.length > 1);
}

/** Baut Kapazitäts- und Tray-Hinweise aus den GSheet-Dump-JSONs auf. */
export function buildInfoHintsFromDumps(master: unknown, bibles: unknown): InfoHints {
  const capacityHints = new Map<string, InfoCapacityHint>();
  const pieceWeightKg = new Map<string, number>();
  const trayHints: InfoTrayHint[] = [];

  function upsertCap(name: string, cap: number | null, equipment: string | null) {
    const key = infoNorm(name);
    if (!key || !cap || cap <= 0) return;
    const existing = capacityHints.get(key);
    if (!existing || cap < existing.capacityKg) capacityHints.set(key, { key, capacityKg: cap, equipment });
  }

  type GSheetDump = { sheets?: Array<{ title?: string; values?: unknown[] }> };
  const masterSheets = Array.isArray((master as GSheetDump)?.sheets) ? (master as GSheetDump).sheets! : [];
  const bibleSheets = Array.isArray((bibles as GSheetDump)?.sheets) ? (bibles as GSheetDump).sheets! : [];

  for (const sheet of masterSheets) {
    const title = String(sheet.title ?? "");
    const rows = Array.isArray(sheet.values) ? sheet.values.map(infoToCells) : [];

    if (/bd_master|breakdown_sup|bd_supervisors/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 40), [/sub\s*recipe/i, /bible\s*ref/i, /kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const subIdx = infoFindColIdx(headers, [/sub\s*recipe/i]);
        const subSubIdx = infoFindColIdx(headers, [/sub\s*-?sub\s*recipe/i]);
        const refIdx = infoFindColIdx(headers, [/bible\s*ref/i]);
        const totalIdx = infoFindColIdx(headers, [/total\s*size.*kg/i]);
        const brkIdx = infoFindColIdx(headers, [/batch\s*breakdown.*kg/i]);
        const areaIdx = infoFindColIdx(headers, [/area\s*associated/i, /^area/i]);
        if (subIdx >= 0 || subSubIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const sub = (subIdx >= 0 ? row[subIdx] : "") || (subSubIdx >= 0 ? row[subSubIdx] : "");
            if (!sub) continue;
            const area = areaIdx >= 0 ? (row[areaIdx] || null) : null;
            upsertCap(sub, infoParseKg(refIdx >= 0 ? row[refIdx] : null) ?? infoParseKg(brkIdx >= 0 ? row[brkIdx] : null) ?? infoParseKg(totalIdx >= 0 ? row[totalIdx] : null), area);
          }
        }
      }
    }

    if (/middle-kitchen/i.test(title) && !/bible/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 30), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const skuIdx = infoFindColIdx(headers, [/sku\s*subrecipes/i]);
        const capIdx = infoFindColIdx(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) upsertCap(rows[i][skuIdx] ?? "", infoParseKg(rows[i][capIdx]), "MIDDLE-KITCHEN");
        }
      }
    }

    if (/braiser/i.test(title) && !/bible/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 30), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const skuIdx = infoFindColIdx(headers, [/subrecipe\s*sku/i]);
        const capIdx = infoFindColIdx(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) upsertCap(rows[i][skuIdx] ?? "", infoParseKg(rows[i][capIdx]), "BRAISER");
        }
      }
    }
  }

  for (const sheet of bibleSheets) {
    const title = String(sheet.title ?? "");
    const rows = Array.isArray(sheet.values) ? sheet.values.map(infoToCells) : [];

    if (/protein-debox/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 30), [/protein\s*type/i, /cut/i, /est\.?\s*pieces/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const protIdx = infoFindColIdx(headers, [/protein\s*type/i]);
        const cutIdx = infoFindColIdx(headers, [/^cut/i]);
        const trayIdx = infoFindColIdx(headers, [/tray\s*spec/i]);
        const piecesIdx = infoFindColIdx(headers, [/est\.?\s*pieces/i]);
        const weightIdx = infoFindColIdx(headers, [/weight.*kg/i]);
        for (let i = hIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          const cut = cutIdx >= 0 ? row[cutIdx] : "";
          const protein = protIdx >= 0 ? row[protIdx] : "";
          const label = cut || protein;
          if (!label) continue;
          const pcsFromTray = trayIdx >= 0 ? infoParsePcs(row[trayIdx]) : null;
          const piecesNum = piecesIdx >= 0 ? infoParseNum(row[piecesIdx]) : null;
          const trayPcs = pcsFromTray ?? piecesNum;
          if (trayPcs && trayPcs > 0) {
            const key = infoNorm(label);
            if (!trayHints.some(h => h.key === key)) trayHints.push({ key, pcsPerTray: trayPcs });
            if (protein && cut) {
              const key2 = infoNorm(`${protein} ${cut}`);
              if (!trayHints.some(h => h.key === key2)) trayHints.push({ key: key2, pcsPerTray: trayPcs });
            }
          }
          const rowWeight = weightIdx >= 0 ? infoParseKg(row[weightIdx]) : null;
          if (rowWeight && piecesNum && piecesNum > 0) pieceWeightKg.set(infoNorm(label), rowWeight / piecesNum);
        }
      }
    }

    if (/veggie-debox/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 30), [/item_/i, /capacity\s*wanne/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const itemIdx = infoFindColIdx(headers, [/item_/i]);
        const capIdx = infoFindColIdx(headers, [/capacity\s*wanne/i]);
        if (itemIdx >= 0 && capIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) upsertCap(rows[i][itemIdx] ?? "", infoParseKg(rows[i][capIdx]), "VEGGIE-DEBOX");
        }
      }
    }

    if (/braiser\s*bible/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 20), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const catIdx = infoFindColIdx(headers, [/^category/i]);
        const skuIdx = infoFindColIdx(headers, [/subrecipe\s*sku/i]);
        const capIdx = infoFindColIdx(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const sku = row[skuIdx] ?? "";
            const cat = catIdx >= 0 ? (row[catIdx] ?? "") : "";
            const name = sku && sku !== "-" ? sku : cat;
            upsertCap(name, infoParseKg(row[capIdx]), "BRAISER");
            if (cat && cat !== name) upsertCap(cat, infoParseKg(row[capIdx]), "BRAISER");
          }
        }
      }
    }

    if (/middle-kitchen\s*bible/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 20), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const skuIdx = infoFindColIdx(headers, [/sku\s*subrecipes/i]);
        const capIdx = infoFindColIdx(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = hIdx + 1; i < rows.length; i++) upsertCap(rows[i][skuIdx] ?? "", infoParseKg(rows[i][capIdx]), "MIDDLE-KITCHEN");
        }
      }
    }
  }

  return { capacityHints, pieceWeightKg, trayHints };
}

function resolveInfoCapacityHint(hints: Map<string, InfoCapacityHint>, subRecipeName: string): InfoCapacityHint | null {
  const key = infoNorm(subRecipeName);
  if (!key) return null;
  const direct = hints.get(key);
  if (direct) return direct;
  let best: { score: number; hint: InfoCapacityHint } | null = null;
  for (const hint of hints.values()) {
    const aTokens = new Set(infoTokenize(hint.key));
    const bTokens = new Set(infoTokenize(key));
    if (aTokens.size === 0 || bTokens.size === 0) continue;
    let overlap = 0;
    for (const t of aTokens) { if (bTokens.has(t)) overlap++; }
    const score = overlap / Math.max(aTokens.size, bTokens.size);
    if (score > 0 && (!best || score > best.score)) best = { score, hint };
  }
  return best && best.score >= 0.4 ? best.hint : null;
}

function lookupInfoTrayPcs(trayHints: InfoTrayHint[], ingredientName: string): number | null {
  const keyTokens = new Set(infoTokenize(ingredientName));
  if (keyTokens.size === 0) return null;
  let best: { hintSize: number; pcs: number } | null = null;
  for (const hint of trayHints) {
    const hintTokens = new Set(infoTokenize(hint.key));
    if (hintTokens.size === 0) continue;
    let overlap = 0;
    for (const t of hintTokens) { if (keyTokens.has(t)) overlap++; }
    if (overlap < hintTokens.size) continue; // 100% containment required
    if (!best || hintTokens.size > best.hintSize) best = { hintSize: hintTokens.size, pcs: hint.pcsPerTray };
  }
  return best ? best.pcs : null;
}

export function getSubRecipeInfo(
  data: DataBundle,
  recipeCode: string,
  subRecipeId: string,
  targetPortions: number,
  hints: InfoHints
): SubRecipeInfoView | null {
  const recipe = resolvePlanningRecipe(data, recipeCode);
  if (!recipe) return null;
  const subRecipe = findRecipeSubRecipe(recipe, subRecipeId);
  if (!subRecipe) return null;
  const structure = data.structures?.[recipeCode];
  const yieldByIngredient = new Map<string, number>();
  for (const roots of Object.values(structure?.markets ?? {})) {
    collectSubRecipeYieldPct(roots ?? [], yieldByIngredient);
  }

  const profile = getSubRecipeMassProfile(subRecipe, recipe);
  const profileYield = Number(profile.yieldRatio ?? 1);
  const fallbackYield = profileYield > 0 ? profileYield : 1;
  const normalizedSubName = normalizeText(subRecipe.name);

  // Kapazität aus Bible-Hinweisen (höchste Priorität) → PFEI-ProcessSpec → unbekannt
  const capHint = resolveInfoCapacityHint(hints.capacityHints, subRecipe.name);
  const processSpec = data.processSpecs?.[subRecipeId];
  const capacityKg = capHint?.capacityKg ?? processSpec?.batchSizeKg ?? null;
  const equipment = capHint?.equipment ?? processSpec?.primaryStation ?? null;
  const capacitySource: "bible" | "process-spec" | "unknown" =
    capHint ? "bible" : processSpec?.batchSizeKg ? "process-spec" : "unknown";

  // Markt-Priorität (DE → BENL → DKSE) – nur eine Markt-Variante nehmen, keine Doppelzählung
  const MARKET_PRIO = ["DE", "BENL", "DKSE"] as const;
  let grossList: Array<{ subRecipe1?: string; subRecipe2?: string; subRecipe3?: string; ingredient: string; ingredientId: string; grossQuantityPerPortion: number; uom: string }> | undefined;
  for (const mkt of MARKET_PRIO) {
    const list = recipe.grossIngredients[mkt];
    if (list && list.length > 0) { grossList = list; break; }
  }
  if (!grossList) {
    const fallback = Object.values(recipe.grossIngredients).find(l => l && l.length > 0);
    grossList = fallback ?? [];
  }

  const aggregated = new Map<string, SubRecipeInfoIngredientRow>();

  for (const row of grossList) {
    const matchesSub = [row.subRecipe1, row.subRecipe2, row.subRecipe3].some(name => normalizeText(name) === normalizedSubName);
    if (!matchesSub) continue;

    const ingredientId = row.ingredientId || row.ingredient;
    const key = `${ingredientId}::${normalizeUom(row.uom)}`;
    const rawPerPortion = Number(row.grossQuantityPerPortion) || 0;
    const rawTotal = Math.max(0, rawPerPortion * targetPortions);
    const rawKg = toKgEquivalent(rawTotal, row.uom);
    const ingredientYield = yieldByIngredient.get(`${subRecipeId}::${ingredientId}`) ?? fallbackYield;
    const finishedTotal = rawTotal * ingredientYield;

    const existing = aggregated.get(key);
    if (existing) {
      existing.rawTotal += rawTotal;
      if (existing.rawKg !== null && rawKg !== null) existing.rawKg += rawKg;
      else if (rawKg === null) existing.rawKg = null;
      existing.finishedTotal += finishedTotal;
    } else {
      aggregated.set(key, {
        ingredientId, ingredientName: row.ingredient, uom: row.uom, yieldRatio: ingredientYield,
        rawTotal, rawKg, finishedTotal, containerType: "", containerCount: 0, proBatchKg: null,
      });
    }
  }

  // batchCount zuerst aus Gesamt-Rohgewicht aller Zutaten berechnen –
  // alle kg-Zutaten teilen sich dieselben Wannen (kein per-Zutat-Ansatz)
  const preRows = Array.from(aggregated.values());
  const totalRawKg = preRows.reduce((sum, row) => sum + (row.rawKg ?? 0), 0);
  const batchCount = capacityKg && capacityKg > 0 && totalRawKg > 0 ? Math.ceil(totalRawKg / capacityKg) : null;

  const ingredientRows = preRows.map(row => {
    // EA-Artikel: Tray-Anzahl aus Bible-Hinweisen (nicht hardcoded 25 Stk)
    if (isEachUom(row.uom)) {
      const pcsPerTray = lookupInfoTrayPcs(hints.trayHints, row.ingredientName) ?? 25;
      const trays = Math.max(1, Math.ceil(row.rawTotal / pcsPerTray));
      return { ...row, containerType: `Tray (${pcsPerTray} Stk)`, containerCount: trays };
    }

    // Kg-Artikel: alle teilen sich batchCount Wannen (nicht per-Zutat aufteilen)
    const rawKg = row.rawKg;
    if (rawKg !== null && rawKg > 0) {
      if (batchCount !== null && capacityKg && capacityKg > 0) {
        return { ...row, containerType: `Wanne (${fmtNum(capacityKg, 1)} kg)`, containerCount: batchCount };
      }
      return { ...row, containerType: "Wanne (Kapazität unbekannt)", containerCount: 0 };
    }

    return { ...row, containerType: "Manuell", containerCount: 0 };
  });

  const totalFinishedKg = ingredientRows.reduce((sum, row) => sum + (toKgEquivalent(row.finishedTotal, row.uom) ?? 0), 0);
  // totalContainerCount = EA-Tray-Anzahlen; Wannen (batchCount) stehen im Footer-Badge
  const totalContainerCount = ingredientRows.filter(r => isEachUom(r.uom)).reduce((s, r) => s + r.containerCount, 0);

  return {
    recipeCode, subRecipeId, subRecipeName: subRecipe.name, targetPortions, yieldRatio: fallbackYield,
    ingredientRows, totalRawKg, totalFinishedKg, totalContainerCount, capacityKg, equipment, batchCount, capacitySource,
  };
}
