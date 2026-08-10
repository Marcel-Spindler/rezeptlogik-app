import { useState, type CSSProperties } from "react";
import type { DataBundle, Market, WeekRecipe, Recipe, CookSchedule, ProcessSpec, ShelfLifeInfo, RecipeStructure } from "../core/types";
import { marketToLocale } from "./i18n";
import type { UiLocale } from "./i18n";

// ─── Number formatting ─────────────────────────────────────────────────────

export function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

export function fmtMin(minutes: number): string {
  if (!minutes) return "0 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// ─── String helpers ────────────────────────────────────────────────────────

export function stripMarketTag(name: string): string {
  return name.replace(/\s*\[(?:BNL|BENL|DE|DKSE|NORD)\]\s*/gi, "").trim();
}

export function fmtIngName(raw: string): string {
  const slash = raw.lastIndexOf("/");
  if (slash > 0) {
    const before = raw.substring(slash - 1, slash);
    if (!/\d/.test(before)) {
      const de = raw.substring(slash + 1).trim();
      if (de.length > 1) return de;
    }
  }
  return raw.replace(/^[A-Z]{1,5}-[A-Z]{2}\s+/, "").trim();
}

export function codeDigits(code?: string): string {
  if (!code) return "";
  const m = /(\d{4,5})/.exec(code);
  return m ? m[1] : code;
}

export function scaleQty(qtyPerPortion: number, portions: number, uom: string): string {
  const v = qtyPerPortion * portions;
  if ((uom === "grams" || uom === "g") && v >= 1000) return `${fmtNum(v / 1000, 2)} kg`;
  if (uom === "ml" && v >= 1000) return `${fmtNum(v / 1000, 2)} L`;
  return `${fmtNum(v, v < 10 ? 2 : 0)} ${uom}`;
}

// ─── Data resolution ───────────────────────────────────────────────────────

export function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  const total = (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0);
  return total > 0;
}

export function resolveStructureByCode(
  structures: DataBundle["structures"] | undefined,
  primaryCode: string,
  fallbackCode?: string,
  recipeName?: string
): RecipeStructure | undefined {
  if (!structures) return undefined;
  if (structures[primaryCode]) return structures[primaryCode];
  if (fallbackCode && structures[fallbackCode]) return structures[fallbackCode];
  const wantedDigits = codeDigits(primaryCode) || codeDigits(fallbackCode);
  if (wantedDigits) {
    for (const [key, value] of Object.entries(structures)) {
      if (codeDigits(key) === wantedDigits || codeDigits(value.code) === wantedDigits) return value;
    }
  }
  if (recipeName) {
    const needle = recipeName.toLowerCase().trim();
    for (const value of Object.values(structures)) {
      if ((value.name ?? "").toLowerCase().trim() === needle) return value;
    }
  }
  return undefined;
}

export function resolveRecipeByCode(
  recipes: DataBundle["recipes"] | undefined,
  primaryCode: string,
  fallbackCode?: string
): Recipe | undefined {
  if (!recipes) return undefined;
  if (recipes[primaryCode]) return recipes[primaryCode];
  if (fallbackCode && recipes[fallbackCode]) return recipes[fallbackCode];
  const wantedDigits = codeDigits(primaryCode) || codeDigits(fallbackCode);
  if (!wantedDigits) return undefined;
  for (const [key, value] of Object.entries(recipes)) {
    if (codeDigits(key) === wantedDigits || codeDigits(value.code) === wantedDigits) return value;
  }
  return undefined;
}

// ─── Portions & uplift ─────────────────────────────────────────────────────

export function adjustedPortions(base: number, upliftPercent: number): number {
  return Math.max(0, Math.round(base * (1 + upliftPercent / 100)));
}

// ─── Cook method / schedule ────────────────────────────────────────────────

export function normalizeToken(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function splitCookMethod(raw: string): string[] {
  return raw.split(/[/→»·]+/).map(s => s.trim()).filter(Boolean);
}

function scheduleTokenAlias(token: string): string {
  const normalized = normalizeToken(token);
  const alias: Record<string, string> = {
    planetarymixer: "mixer",
    scooperbutter: "scooperbutter",
    scoopbutter: "scoopbutter",
    blastchiller: "",
    staging: ""
  };
  return alias[normalized] ?? normalized;
}

export function canonicalCookMethod(raw: string): string {
  return splitCookMethod(raw)
    .map(scheduleTokenAlias)
    .filter(Boolean)
    .join("/");
}

export function resolveCookSchedule(
  category: string,
  cookSchedules: Record<string, CookSchedule>
): { schedule?: CookSchedule; matchedMethod?: string; matchType: "exact" | "canonical" | "subset" | "none" } {
  if (cookSchedules[category]) return { schedule: cookSchedules[category], matchedMethod: category, matchType: "exact" };
  const canonical = canonicalCookMethod(category);
  for (const [method, schedule] of Object.entries(cookSchedules)) {
    if (canonicalCookMethod(method) === canonical) return { schedule, matchedMethod: method, matchType: "canonical" };
  }
  const wanted = canonical.split("/").filter(Boolean);
  for (const [method, schedule] of Object.entries(cookSchedules)) {
    const actual = canonicalCookMethod(method).split("/").filter(Boolean);
    if (actual.length === 0) continue;
    if (actual.every(token => wanted.includes(token))) return { schedule, matchedMethod: method, matchType: "subset" };
  }
  return { matchType: "none" };
}

// ─── Shift labels ──────────────────────────────────────────────────────────

export function oneShiftLabel(shiftsBefore: number): string {
  if (shiftsBefore === 0) return "Produktionstag";
  if (shiftsBefore === 1) return "Vortag";
  return `${shiftsBefore} Tage vorher`;
}

export function oneShiftShortLabel(shiftsBefore: number): string {
  if (shiftsBefore === 0) return "D0";
  return `D-${shiftsBefore}`;
}

export function getFulfillmentSplit(wr: WeekRecipe) {
  const deFriday = Math.round(wr.verdenVolume.DE / 2);
  const deSunday = Math.max(0, wr.verdenVolume.DE - deFriday);
  return { dkseFriday: wr.verdenVolume.DKSE, deFriday, deSunday, benl: wr.verdenVolume.BENL };
}

// ─── Matched schedule steps ────────────────────────────────────────────────

import { tokenToStation, workflowSteps } from "./equipment";

export function matchedScheduleSteps(label: string, steps: ReturnType<typeof workflowSteps>) {
  const normalizedLabel = normalizeToken(label);
  const scheduleStation = tokenToStation(label);
  return steps.filter(step => {
    if (scheduleStation && step.station === scheduleStation) return true;
    const raw = normalizeToken(step.rawLabel);
    const station = step.station ? normalizeToken(step.station) : "";
    return raw === normalizedLabel || station === normalizedLabel || raw.includes(normalizedLabel) || normalizedLabel.includes(raw);
  });
}

// ─── Search ────────────────────────────────────────────────────────────────

export function matchesNeedle(parts: Array<string | number | undefined>, needle: string): boolean {
  if (!needle) return true;
  return parts.some(part => String(part ?? "").toLowerCase().includes(needle));
}

export function recipeSearchText(row: WeekRecipe, recipe?: Recipe): string {
  const parts = [row.code, row.recipeName, row.preference];
  if (recipe) {
    parts.push(recipe.baseName);
    for (const marketData of Object.values(recipe.markets)) {
      parts.push(marketData.recipeNameLocal, marketData.msku, marketData.primaryPackagingSku || "", marketData.secondaryPackagingSkus || "", marketData.allergens || "");
      for (const sub of marketData.subRecipes) parts.push(sub.id, sub.name, sub.category);
      for (const ingredient of marketData.ingredients) parts.push(ingredient.ingredientId, ingredient.name);
    }
    for (const grossRows of Object.values(recipe.grossIngredients)) {
      for (const gross of grossRows ?? []) parts.push(gross.ingredientId, gross.ingredient, gross.subRecipe1 || "", gross.subRecipe2 || "", gross.subRecipe3 || "");
    }
  }
  return parts.join(" ").toLowerCase();
}

// Gibt zurück, warum ein Rezept auf eine Suchanfrage zutrifft.
// Rückgabe: null wenn kein "besonderer" Treffer (Name/Code-Match ist selbsterklärend),
// sonst { kind: "ingredient"|"subrecipe"|"sku"|"allergen", label: string }
export function searchMatchReason(
  needle: string,
  row: WeekRecipe,
  recipe: Recipe | undefined
): { kind: string; label: string } | null {
  if (!needle || !recipe) return null;
  const n = needle.toLowerCase();

  // Wenn Name oder Code matchen, kein extra Kontext nötig
  if (
    row.code.toLowerCase().includes(n) ||
    row.recipeName.toLowerCase().includes(n) ||
    recipe.baseName.toLowerCase().includes(n)
  ) return null;

  for (const md of Object.values(recipe.markets)) {
    // Lokaler Rezeptname
    if (md.recipeNameLocal.toLowerCase().includes(n)) return null;

    // MSKU / Packaging
    if (
      md.msku.toLowerCase().includes(n) ||
      (md.primaryPackagingSku ?? "").toLowerCase().includes(n) ||
      (md.secondaryPackagingSkus ?? "").toLowerCase().includes(n)
    ) return { kind: "sku", label: `SKU: ${md.msku}` };

    // Allergen
    if ((md.allergens ?? "").toLowerCase().includes(n))
      return { kind: "allergen", label: `Allergen: ${(md.allergens ?? "").slice(0, 40)}` };

    // Sub-Rezept
    for (const sub of md.subRecipes) {
      if (sub.name.toLowerCase().includes(n) || sub.id.toLowerCase().includes(n))
        return { kind: "subrecipe", label: sub.name };
    }

    // Zutat (net)
    for (const ing of md.ingredients) {
      if (ing.name.toLowerCase().includes(n) || ing.ingredientId.toLowerCase().includes(n))
        return { kind: "ingredient", label: ing.name };
    }
  }

  // Brutto-Zutaten
  for (const grossRows of Object.values(recipe.grossIngredients)) {
    for (const g of grossRows ?? []) {
      if (
        g.ingredient.toLowerCase().includes(n) ||
        g.ingredientId.toLowerCase().includes(n)
      ) return { kind: "ingredient", label: g.ingredient };
    }
  }

  return null;
}

// ─── Shelf life ────────────────────────────────────────────────────────────

export function shelfLifeTone(status: ShelfLifeInfo["status"]): string {
  if (status === "critical") return "bg-rose-100 text-rose-800";
  if (status === "risk") return "bg-amber-100 text-amber-800";
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-700";
}

// ─── Ingredient name matching ──────────────────────────────────────────────

export function normalizeIngredientName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/fa-de|\[[^\]]*\]|\([^)]*\)|\//g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .filter(token => !["und", "ohne", "mit", "fresh", "whole", "grams", "kg", "iqf"].includes(token));
}

export function findShelfLifeNameHint(ingredient: string, shelfLifeBySku: Record<string, ShelfLifeInfo>): ShelfLifeInfo | undefined {
  const wanted = new Set(normalizeIngredientName(ingredient));
  if (wanted.size === 0) return undefined;
  let best: { score: number; row: ShelfLifeInfo } | undefined;
  for (const row of Object.values(shelfLifeBySku)) {
    const rowTokens = normalizeIngredientName(row.skuName);
    const score = rowTokens.filter(token => wanted.has(token)).length;
    if (score < 2) continue;
    if (!best || score > best.score) best = { score, row };
  }
  return best?.row;
}

// ─── Pre-production ────────────────────────────────────────────────────────

export function isPreproductionRecommended(spec?: ProcessSpec): boolean {
  if (!spec) return false;
  const holds = Object.values(spec.holdTimeMin ?? {});
  return holds.some(v => (v ?? 0) >= 480) || spec.productFamily === "Butter";
}

// ─── Method color ──────────────────────────────────────────────────────────

export function methodColorToCSS(colorStr: string | undefined): string | null {
  if (!colorStr || colorStr === "-") return null;
  const lower = colorStr.toLowerCase();
  const colorMap: [string, string][] = [
    ["grey", "#9ca3af"], ["gray", "#9ca3af"], ["beige", "#d6c9a0"], ["silver", "#94a3b8"],
    ["white", "#e2e8f0"], ["black", "#1e293b"], ["red", "#ef4444"], ["blue", "#3b82f6"],
    ["green", "#22c55e"], ["yellow", "#fbbf24"], ["orange", "#f97316"], ["purple", "#a855f7"],
    ["pink", "#ec4899"], ["brown", "#a16207"], ["gold", "#d97706"], ["turquoise", "#06b6d4"],
    ["teal", "#14b8a6"], ["coral", "#fb7185"], ["cream", "#fef9c3"], ["violet", "#7c3aed"],
  ];
  for (const [key, val] of colorMap) {
    if (lower.includes(key)) return val;
  }
  return null;
}

// ─── Visual tones ──────────────────────────────────────────────────────────

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

export function recipeHue(seed: string): number {
  return 18 + (stableHash(seed) % 300);
}

export function recipeListTone(recipeCode: string): {
  base: CSSProperties; active: CSSProperties; code: CSSProperties; preference: CSSProperties; title: CSSProperties;
} {
  const hue = recipeHue(recipeCode);
  return {
    base: {
      background: `linear-gradient(90deg, hsl(${hue} 72% 86%) 0%, hsl(${hue} 58% 95%) 20%, hsl(${hue} 36% 98%) 100%)`,
      border: `1px solid hsl(${hue} 54% 74%)`,
      boxShadow: `inset 4px 0 0 hsl(${hue} 70% 52%)`
    },
    active: {
      background: `linear-gradient(90deg, hsl(${hue} 78% 80%) 0%, hsl(${hue} 68% 90%) 24%, hsl(${hue} 46% 97%) 100%)`,
      border: `1px solid hsl(${hue} 78% 46%)`,
      boxShadow: `inset 6px 0 0 hsl(${hue} 82% 42%), 0 0 0 1px hsl(${hue} 72% 54%)`
    },
    code: { color: `hsl(${hue} 40% 34%)` },
    preference: { backgroundColor: `hsl(${hue} 78% 88%)`, color: `hsl(${hue} 62% 26%)` },
    title: { color: `hsl(${hue} 46% 24%)` }
  };
}

type SubRecipeUrgency = "critical" | "high" | "medium" | "low";

export function subRecipeUrgency(cookShifts?: number): SubRecipeUrgency {
  if (cookShifts === undefined) return "low";
  if (cookShifts <= 0) return "critical";
  if (cookShifts === 1) return "high";
  if (cookShifts === 2) return "medium";
  return "low";
}

export function subRecipeUrgencyLabel(cookShifts?: number): string {
  if (cookShifts === undefined) return "ohne Termin";
  if (cookShifts <= 0) return "D0 kritisch";
  if (cookShifts === 1) return "D-1 hoch";
  if (cookShifts === 2) return "D-2 mittel";
  return `D-${cookShifts} niedrig`;
}

export function subRecipeTone(recipeCode: string, cookShifts?: number): {
  frame: CSSProperties; header: CSSProperties; headerText: CSSProperties;
  badge: CSSProperties; panel: CSSProperties; urgency: CSSProperties;
} {
  const hue = recipeHue(recipeCode);
  const urgency = subRecipeUrgency(cookShifts);
  const levels: Record<SubRecipeUrgency, { frameL: number; headerL: number; panelL: number; sat: number; accentL: number }> = {
    critical: { frameL: 66, headerL: 86, panelL: 90, sat: 62, accentL: 30 },
    high:     { frameL: 72, headerL: 90, panelL: 93, sat: 58, accentL: 32 },
    medium:   { frameL: 78, headerL: 94, panelL: 96, sat: 54, accentL: 34 },
    low:      { frameL: 84, headerL: 97, panelL: 98, sat: 48, accentL: 36 }
  };
  const c = levels[urgency];
  return {
    frame: { borderColor: `hsl(${hue} ${c.sat}% ${c.frameL}%)`, backgroundColor: `hsl(${hue} 35% ${Math.min(99, c.panelL + 1)}%)` },
    header: { backgroundColor: `hsl(${hue} ${c.sat}% ${c.headerL}%)` },
    headerText: { color: `hsl(${hue} ${Math.min(70, c.sat + 8)}% ${c.accentL}%)` },
    badge: { backgroundColor: `hsl(${hue} ${c.sat}% ${Math.min(98, c.headerL + 4)}%)`, color: `hsl(${hue} ${Math.min(72, c.sat + 10)}% ${c.accentL}%)`, border: `1px solid hsl(${hue} ${c.sat}% ${Math.max(58, c.frameL - 6)}%)` },
    panel: { backgroundColor: `hsl(${hue} 34% ${c.panelL}%)`, borderColor: `hsl(${hue} 38% ${Math.max(70, c.frameL + 8)}%)` },
    urgency: { backgroundColor: `hsl(${hue} ${Math.min(74, c.sat + 12)}% ${Math.max(83, c.headerL - 1)}%)`, color: `hsl(${hue} ${Math.min(78, c.sat + 14)}% ${Math.max(28, c.accentL - 4)}%)` }
  };
}

export const INGREDIENT_SECTION_TONES = [
  { frame: "border-orange-200", header: "bg-orange-50", headerText: "text-orange-900", badge: "bg-white text-orange-800 ring-1 ring-orange-200" },
  { frame: "border-sky-200",    header: "bg-sky-50",    headerText: "text-sky-900",    badge: "bg-white text-sky-800 ring-1 ring-sky-200" },
  { frame: "border-emerald-200",header: "bg-emerald-50",headerText: "text-emerald-900",badge: "bg-white text-emerald-800 ring-1 ring-emerald-200" },
  { frame: "border-amber-200",  header: "bg-amber-50",  headerText: "text-amber-900",  badge: "bg-white text-amber-800 ring-1 ring-amber-200" }
] as const;

export function ingredientSectionTone(index: number) {
  return INGREDIENT_SECTION_TONES[index % INGREDIENT_SECTION_TONES.length];
}

export function categoryRiskTone(status: ShelfLifeInfo["status"] | "unknown") {
  if (status === "critical") return "bg-rose-50 text-rose-800 ring-1 ring-rose-200";
  if (status === "risk") return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  if (status === "ok") return "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200";
  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

// ─── localStorage ──────────────────────────────────────────────────────────

const LS_PREFIX = "rezeptlogik_v1_";

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function lsSet<T>(key: string, value: T): void {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch { /* quota */ }
}

export function usePersistent<T>(key: string, defaultVal: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => lsGet(key, defaultVal));
  const wrapped: React.Dispatch<React.SetStateAction<T>> = (action) => {
    setState(prev => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      lsSet(key, next);
      return next;
    });
  };
  return [state, wrapped];
}

// ─── URL helpers ───────────────────────────────────────────────────────────

export function buildKitchenShareUrl(week: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("surface", "kitchen");
  url.searchParams.set("view", "breakdown");
  url.searchParams.set("week", week);
  return url.toString();
}

// ─── Market constants ──────────────────────────────────────────────────────

export const MARKETS: Market[] = ["BENL", "DKSE", "DE"];
export const MARKET_LABEL: Record<Market, string> = { BENL: "BENL", DKSE: "DK/SE", DE: "DE" };
export const MARKET_COLOR: Record<Market, string> = {
  BENL: "bg-orange-100 text-orange-800",
  DKSE: "bg-blue-100 text-blue-800",
  DE:   "bg-emerald-100 text-emerald-800"
};

// ─── Recipe-code CSV text helpers ──────────────────────────────────────────
// Geteilt zwischen KET Plan, PET Plan (WO-Export-Zeilen tragen den Rezeptcode
// als Präfix im Namensfeld: "FE1234A5 - Chicken Tikka [DE]").

export function extractCode(name: string): string {
  return (name ?? "").trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
}

export function cleanRecipeName(name: string): string {
  return (name ?? "")
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*[-–]\s*/, "")
    .replace(/\s*\[(?:DE|BNL|DKSE|BENL|NORD)\]\s*$/i, "")
    .trim();
}

// Freitext-Anweisungen (Bindestrich-/nummerierte Listen) in einzelne Schritte.
export function parseSteps(text: string): string[] {
  return text
    .split(/\n+/)
    .map(s => s.replace(/^\s*[-–•*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

// Re-export locale helper for convenience
export { marketToLocale };
export type { UiLocale };
