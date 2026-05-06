import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { loadData, refreshRampUpDataOnStart } from "./dataSource";
import type { DataBundle, Market, WeekRecipe, Recipe, CookSchedule, ProcessSpec, Station, ShelfLifeInfo, DetailedSubRecipe, RecipeStructure } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, DEFAULT_STATION_DEVICE_COUNTS, DEFAULT_STATION_POOLS, computeWeekLoad, fmtMin, getBaseVerdenVolume, getStationCapacityView, getSubRecipeMassProfile, loadStationDeviceCounts, loadStationPools, normalizePoolName, saveStationDeviceCounts, saveStationPools, tokenToStation, workflowSteps } from "./equipment";
import { loadDynamicModule } from "./dynamicImport";
import { PlanningView } from "./PlanningView";
import { WhatIfView } from "./WhatIfView";
import { formatDateTime, marketToLocale, marketVariantLabel, MARKET_LANGUAGE_LABEL, tl, type UiLocale } from "./i18n";

const RackView = lazy(() => loadDynamicModule("rack-view", () => import("./RackView").then((module) => ({ default: module.RackView }))));
const LinePlanningView = lazy(() => loadDynamicModule("line-planning", () => import("./LinePlanningView").then((module) => ({ default: module.LinePlanningView }))));

const MARKETS: Market[] = ["BENL", "DKSE", "DE"];
const MARKET_LABEL: Record<Market, string> = { BENL: "BENL", DKSE: "DK/SE", DE: "DE" };
const MARKET_COLOR: Record<Market, string> = {
  BENL: "bg-orange-100 text-orange-800",
  DKSE: "bg-blue-100 text-blue-800",
  DE:   "bg-emerald-100 text-emerald-800"
};
function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

/** Extrahiert den deutschen Namen aus "FA-DE English /Deutsch" — zeigt immer die lesbare Variante. */
function fmtIngName(raw: string): string {
  // Format: "FA-DE Something English /Etwas Deutsch"
  const slash = raw.lastIndexOf("/");
  if (slash > 0) {
    // Sicherstellen, dass vor dem "/" kein Bruch wie "1/2" steht
    const before = raw.substring(slash - 1, slash);
    if (!/\d/.test(before)) {
      const de = raw.substring(slash + 1).trim();
      if (de.length > 1) return de;
    }
  }
  // Kein Slash: FA-XX Prefix entfernen wenn vorhanden
  return raw.replace(/^[A-Z]{1,5}-[A-Z]{2}\s+/, "").trim();
}
function codeDigits(code?: string): string {
  if (!code) return "";
  const m = /(\d{4,5})/.exec(code);
  return m ? m[1] : code;
}

function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  const total = (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0);
  return total > 0;
}

function resolveStructureByCode(
  structures: DataBundle["structures"] | undefined,
  primaryCode: string,
  fallbackCode?: string
): RecipeStructure | undefined {
  if (!structures) return undefined;
  if (structures[primaryCode]) return structures[primaryCode];
  if (fallbackCode && structures[fallbackCode]) return structures[fallbackCode];

  const wantedDigits = codeDigits(primaryCode) || codeDigits(fallbackCode);
  if (!wantedDigits) return undefined;

  for (const [key, value] of Object.entries(structures)) {
    if (codeDigits(key) === wantedDigits || codeDigits(value.code) === wantedDigits) {
      return value;
    }
  }
  return undefined;
}
function scaleQty(qtyPerPortion: number, portions: number, uom: string): string {
  const v = qtyPerPortion * portions;
  if ((uom === "grams" || uom === "g") && v >= 1000) return `${fmtNum(v / 1000, 2)} kg`;
  if ((uom === "ml") && v >= 1000) return `${fmtNum(v / 1000, 2)} L`;
  return `${fmtNum(v, v < 10 ? 2 : 0)} ${uom}`;
}

function normalizeToken(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitCookMethod(raw: string): string[] {
  return raw.split(/[\/→»·]+/).map(s => s.trim()).filter(Boolean);
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

function canonicalCookMethod(raw: string): string {
  return splitCookMethod(raw)
    .map(scheduleTokenAlias)
    .filter(Boolean)
    .join("/");
}

function oneShiftLabel(shiftsBefore: number): string {
  if (shiftsBefore === 0) return "Produktionstag";
  if (shiftsBefore === 1) return "Vortag";
  return `${shiftsBefore} Tage vorher`;
}

function oneShiftShortLabel(shiftsBefore: number): string {
  if (shiftsBefore === 0) return "D0";
  return `D-${shiftsBefore}`;
}

function getFulfillmentSplit(wr: WeekRecipe) {
  const deFriday = Math.round(wr.verdenVolume.DE / 2);
  const deSunday = Math.max(0, wr.verdenVolume.DE - deFriday);
  return {
    dkseFriday: wr.verdenVolume.DKSE,
    deFriday,
    deSunday,
    benl: wr.verdenVolume.BENL
  };
}

function shelfLifeTone(status: ShelfLifeInfo["status"]): string {
  if (status === "critical") return "bg-rose-100 text-rose-800";
  if (status === "risk") return "bg-amber-100 text-amber-800";
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-700";
}

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

function recipeHue(seed: string): number {
  // Keep hues in a broad but pleasant range for UI readability.
  return 18 + (stableHash(seed) % 300);
}

function recipeListTone(recipeCode: string): {
  base: CSSProperties;
  active: CSSProperties;
  code: CSSProperties;
  preference: CSSProperties;
  title: CSSProperties;
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
    code: {
      color: `hsl(${hue} 40% 34%)`
    },
    preference: {
      backgroundColor: `hsl(${hue} 78% 88%)`,
      color: `hsl(${hue} 62% 26%)`
    },
    title: {
      color: `hsl(${hue} 46% 24%)`
    }
  };
}

type SubRecipeUrgency = "critical" | "high" | "medium" | "low";

function subRecipeUrgency(cookShifts?: number): SubRecipeUrgency {
  if (cookShifts === undefined) return "low";
  if (cookShifts <= 0) return "critical";
  if (cookShifts === 1) return "high";
  if (cookShifts === 2) return "medium";
  return "low";
}

function subRecipeUrgencyLabel(cookShifts?: number): string {
  if (cookShifts === undefined) return "ohne Termin";
  if (cookShifts <= 0) return "D0 kritisch";
  if (cookShifts === 1) return "D-1 hoch";
  if (cookShifts === 2) return "D-2 mittel";
  return `D-${cookShifts} niedrig`;
}

function subRecipeTone(recipeCode: string, cookShifts?: number): {
  frame: CSSProperties;
  header: CSSProperties;
  headerText: CSSProperties;
  badge: CSSProperties;
  panel: CSSProperties;
  urgency: CSSProperties;
} {
  const hue = recipeHue(recipeCode);
  const urgency = subRecipeUrgency(cookShifts);
  const levels: Record<SubRecipeUrgency, { frameL: number; headerL: number; panelL: number; sat: number; accentL: number }> = {
    critical: { frameL: 66, headerL: 86, panelL: 90, sat: 62, accentL: 30 },
    high: { frameL: 72, headerL: 90, panelL: 93, sat: 58, accentL: 32 },
    medium: { frameL: 78, headerL: 94, panelL: 96, sat: 54, accentL: 34 },
    low: { frameL: 84, headerL: 97, panelL: 98, sat: 48, accentL: 36 }
  };
  const current = levels[urgency];
  return {
    frame: {
      borderColor: `hsl(${hue} ${current.sat}% ${current.frameL}%)`,
      backgroundColor: `hsl(${hue} 35% ${Math.min(99, current.panelL + 1)}%)`
    },
    header: {
      backgroundColor: `hsl(${hue} ${current.sat}% ${current.headerL}%)`
    },
    headerText: {
      color: `hsl(${hue} ${Math.min(70, current.sat + 8)}% ${current.accentL}%)`
    },
    badge: {
      backgroundColor: `hsl(${hue} ${current.sat}% ${Math.min(98, current.headerL + 4)}%)`,
      color: `hsl(${hue} ${Math.min(72, current.sat + 10)}% ${current.accentL}%)`,
      border: `1px solid hsl(${hue} ${current.sat}% ${Math.max(58, current.frameL - 6)}%)`
    },
    panel: {
      backgroundColor: `hsl(${hue} 34% ${current.panelL}%)`,
      borderColor: `hsl(${hue} 38% ${Math.max(70, current.frameL + 8)}%)`
    },
    urgency: {
      backgroundColor: `hsl(${hue} ${Math.min(74, current.sat + 12)}% ${Math.max(83, current.headerL - 1)}%)`,
      color: `hsl(${hue} ${Math.min(78, current.sat + 14)}% ${Math.max(28, current.accentL - 4)}%)`
    }
  };
}

function normalizeIngredientName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/fa-de|\[[^\]]*\]|\([^\)]*\)|\//g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .filter(token => !["und", "ohne", "mit", "fresh", "whole", "grams", "kg", "iqf"].includes(token));
}

function findShelfLifeNameHint(ingredient: string, shelfLifeBySku: Record<string, ShelfLifeInfo>): ShelfLifeInfo | undefined {
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

function isPreproductionRecommended(spec?: ProcessSpec): boolean {
  if (!spec) return false;
  const holds = Object.values(spec.holdTimeMin ?? {});
  return holds.some(v => (v ?? 0) >= 480) || spec.productFamily === "Butter";
}

function resolveCookSchedule(category: string, cookSchedules: Record<string, CookSchedule>):
  { schedule?: CookSchedule; matchedMethod?: string; matchType: "exact" | "canonical" | "subset" | "none" } {
  if (cookSchedules[category]) return { schedule: cookSchedules[category], matchedMethod: category, matchType: "exact" };
  const canonical = canonicalCookMethod(category);
  for (const [method, schedule] of Object.entries(cookSchedules)) {
    if (canonicalCookMethod(method) === canonical) {
      return { schedule, matchedMethod: method, matchType: "canonical" };
    }
  }
  const wanted = canonical.split("/").filter(Boolean);
  for (const [method, schedule] of Object.entries(cookSchedules)) {
    const actual = canonicalCookMethod(method).split("/").filter(Boolean);
    if (actual.length === 0) continue;
    const matches = actual.every(token => wanted.includes(token));
    if (matches) return { schedule, matchedMethod: method, matchType: "subset" };
  }
  return { matchType: "none" };
}

function adjustedPortions(base: number, upliftPercent: number): number {
  return Math.max(0, Math.round(base * (1 + upliftPercent / 100)));
}

function matchedScheduleSteps(label: string, steps: ReturnType<typeof workflowSteps>) {
  const normalizedLabel = normalizeToken(label);
  const scheduleStation = tokenToStation(label);
  return steps.filter(step => {
    if (scheduleStation && step.station === scheduleStation) return true;
    const raw = normalizeToken(step.rawLabel);
    const station = step.station ? normalizeToken(step.station) : "";
    return raw === normalizedLabel || station === normalizedLabel || raw.includes(normalizedLabel) || normalizedLabel.includes(raw);
  });
}

function recipeSearchText(row: WeekRecipe, recipe?: Recipe): string {
  const parts = [row.code, row.recipeName, row.preference];
  if (recipe) {
    parts.push(recipe.baseName);
    for (const marketData of Object.values(recipe.markets)) {
      parts.push(
        marketData.recipeNameLocal,
        marketData.msku,
        marketData.primaryPackagingSku || "",
        marketData.secondaryPackagingSkus || "",
        marketData.allergens || ""
      );
      for (const sub of marketData.subRecipes) parts.push(sub.id, sub.name, sub.category);
      for (const ingredient of marketData.ingredients) parts.push(ingredient.ingredientId, ingredient.name);
    }
    for (const grossRows of Object.values(recipe.grossIngredients)) {
      for (const gross of grossRows ?? []) parts.push(gross.ingredientId, gross.ingredient, gross.subRecipe1 || "", gross.subRecipe2 || "", gross.subRecipe3 || "");
    }
  }
  return parts.join(" ").toLowerCase();
}

function matchesNeedle(parts: Array<string | number | undefined>, needle: string): boolean {
  if (!needle) return true;
  return parts.some(part => String(part ?? "").toLowerCase().includes(needle));
}

// ===== localStorage persistence helpers =====
const LS_PREFIX = "rezeptlogik_v1_";
function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}
function lsSet<T>(key: string, value: T): void {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch { /* quota/private */ }
}
function usePersistent<T>(key: string, defaultVal: T): [T, React.Dispatch<React.SetStateAction<T>>] {
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

export default function App() {
  const [data, setData] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWeek, setSelectedWeek] = usePersistent<string>("week", "");
  const [selectedRecipe, setSelectedRecipe] = usePersistent<string | null>("recipe", null);
  const [view, setView] = usePersistent<"recipe" | "equipment" | "planning" | "woche" | "rack" | "ket" | "phase2">("view", "recipe");
  // URL-Parameter ?view=ket und ?week=... haben Vorrang vor gespeichertem Zustand.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const param = params.get("view");
    const weekParam = params.get("week");
    const valid = ["recipe", "equipment", "planning", "woche", "rack", "ket", "phase2"] as const;
    if ((valid as readonly string[]).includes(param ?? "")) {
      setView(param as typeof valid[number]);
    }
    if (weekParam) {
      setSelectedWeek(weekParam);
      setSelectedRecipe(null);
      setSearchText("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [upliftPercent, setUpliftPercent] = usePersistent<number>("uplift", 0);
  const [searchText, setSearchText] = useState<string>("");
  // Markt-Selektion global mitlesen (wird in RecipeDetail gespeichert)
  const [globalMarket] = usePersistent<Market>("detail_market", "BENL");
  const locale = marketToLocale(globalMarket);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        await refreshRampUpDataOnStart();
        const d = await loadData();
        if (disposed) return;
        setData(d);
        // Nur setzen wenn noch kein gespeicherter Wert vorhanden
        const saved = lsGet<string>("week", "");
        if (!saved || !d.weeks.includes(saved)) {
          const firstWithRecipes = d.weeks.find(w => d.weekRecipes.some(r => r.hfWeek === w));
          const week = firstWithRecipes ?? d.weeks[0] ?? "";
          setSelectedWeek(week);
        }
      } catch (e: any) {
        if (!disposed) setError(String(e?.message ?? e));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const weeks = data?.weeks ?? [];
  const weekRecipes = data?.weekRecipes ?? [];
  const recipesByCode = data?.recipes ?? {};

  const recipesOfWeek = weekRecipes
    .filter(r => r.hfWeek === selectedWeek)
    .filter(isProducedInVerden)
    .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
    .sort((a, b) => adjustedPortions(getBaseVerdenVolume(b), upliftPercent) - adjustedPortions(getBaseVerdenVolume(a), upliftPercent));

  const searchNeedle = searchText.trim().toLowerCase();
  const filteredRecipes = searchNeedle
    ? recipesOfWeek.filter(r => recipeSearchText(r, recipesByCode[r.code]).includes(searchNeedle))
    : recipesOfWeek;

  const portionMultiplier = 1 + upliftPercent / 100;

  const totals = recipesOfWeek.reduce((acc, r) => {
    acc.BENL += r.verdenVolume.BENL; acc.DKSE += r.verdenVolume.DKSE;
    acc.DE   += r.verdenVolume.DE;   acc.base += getBaseVerdenVolume(r);
    return acc;
  }, { BENL: 0, DKSE: 0, DE: 0, base: 0 });
  const plannedTotal = adjustedPortions(totals.base, upliftPercent);

  const previousWeek = useMemo(() => {
    const currentIndex = weeks.indexOf(selectedWeek);
    if (currentIndex <= 0) return null;
    return weeks[currentIndex - 1] ?? null;
  }, [selectedWeek, weeks]);

  const previousWeekRecipes = useMemo(() => {
    if (!previousWeek) return [] as WeekRecipe[];
    return weekRecipes
      .filter(r => r.hfWeek === previousWeek)
      .filter(isProducedInVerden)
      .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i);
  }, [previousWeek, weekRecipes]);

  const weekDelta = useMemo(() => {
    if (!data || !previousWeek) return null;

    const currentByCode = new Map(recipesOfWeek.map(recipe => [recipe.code, recipe]));
    const previousByCode = new Map(previousWeekRecipes.map(recipe => [recipe.code, recipe]));
    const allCodes = new Set<string>([...currentByCode.keys(), ...previousByCode.keys()]);

    const added: WeekRecipe[] = [];
    const removed: WeekRecipe[] = [];
    const changed: Array<{ code: string; recipeName: string; current: number; previous: number; delta: number }> = [];

    for (const code of allCodes) {
      const current = currentByCode.get(code);
      const previous = previousByCode.get(code);
      if (current && !previous) {
        added.push(current);
        continue;
      }
      if (!current && previous) {
        removed.push(previous);
        continue;
      }
      if (!current || !previous) continue;

      const currentPortions = adjustedPortions(getBaseVerdenVolume(current), upliftPercent);
      const previousPortions = adjustedPortions(getBaseVerdenVolume(previous), upliftPercent);
      const delta = currentPortions - previousPortions;
      if (delta !== 0) {
        changed.push({
          code,
          recipeName: recipesByCode[code]?.markets[globalMarket]?.recipeNameLocal || current.recipeName || previous.recipeName,
          current: currentPortions,
          previous: previousPortions,
          delta,
        });
      }
    }

    const currentTotal = recipesOfWeek.reduce((sum, recipe) => sum + adjustedPortions(getBaseVerdenVolume(recipe), upliftPercent), 0);
    const previousTotal = previousWeekRecipes.reduce((sum, recipe) => sum + adjustedPortions(getBaseVerdenVolume(recipe), upliftPercent), 0);

    changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    added.sort((a, b) => adjustedPortions(getBaseVerdenVolume(b), upliftPercent) - adjustedPortions(getBaseVerdenVolume(a), upliftPercent));
    removed.sort((a, b) => adjustedPortions(getBaseVerdenVolume(b), upliftPercent) - adjustedPortions(getBaseVerdenVolume(a), upliftPercent));

    return {
      previousWeek,
      currentTotal,
      previousTotal,
      totalDelta: currentTotal - previousTotal,
      recipeDelta: recipesOfWeek.length - previousWeekRecipes.length,
      added,
      removed,
      changed,
    };
  }, [data, globalMarket, previousWeek, previousWeekRecipes, recipesByCode, recipesOfWeek, upliftPercent]);

  const activeRecipe: WeekRecipe | undefined =
    filteredRecipes.find(r => r.code === selectedRecipe)
    ?? filteredRecipes[0]
    ?? recipesOfWeek.find(r => r.code === selectedRecipe)
    ?? recipesOfWeek[0];

  if (error) return <Shell locale={locale}><div className="card p-6 text-red-700">{tl(locale, "Fehler:")} {error}<br/>
    <span className="text-sm text-slate-500">{tl(locale, "Tipp:")} <code>npm run import:local</code> ausführen.</span></div></Shell>;
  if (!data) return <Shell locale={locale}><div className="card p-6">{tl(locale, "Lade Daten…")}</div></Shell>;

  return (
    <Shell locale={locale}>
      <div className="grid grid-cols-12 gap-4">
        {/* Sidebar: KW + Rezeptliste */}
        <aside className="col-span-12 md:col-span-4 lg:col-span-3 space-y-3">
          <div className="card p-1.5 flex flex-wrap w-full rounded-lg bg-slate-100 ring-1 ring-slate-200 gap-0.5">
            {([
              ["recipe", tl(locale, "Rezept")],
              ["woche", tl(locale, "Σ Wochenbestellung")],
              ["equipment", tl(locale, "Equipment")],
              ["planning", tl(locale, "Wochenplaner")],
              ["rack", "Rack"],
              ["ket", "Linienplanung"],
              ["phase2", "What-if & Diff"]
            ] as ["recipe"|"equipment"|"planning"|"woche"|"rack"|"ket"|"phase2", string][]).map(([k, l]) => (
              <button key={k} onClick={() => setView(k)}
                className={`flex-1 px-2 py-1.5 text-xs font-semibold rounded-md ${
                  view === k ? "bg-white shadow ring-1 ring-slate-300" : "text-slate-500 hover:text-slate-800"
                }`}>{l}</button>
            ))}
          </div>
          <div className="card p-4">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tl(locale, "Kalenderwoche")}</label>
            <select
              className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
              value={selectedWeek}
              onChange={e => { setSelectedWeek(e.target.value); setSelectedRecipe(null); setSearchText(""); }}
            >
              {data.weeks.map(w => {
                const n = data.weekRecipes.filter(r => r.hfWeek === w).filter(isProducedInVerden).length;
                return <option key={w} value={w}>{w}  ({n} produzierte Rezepte)</option>;
              })}
            </select>
            <div className="mt-3 grid grid-cols-2 xl:grid-cols-3 gap-2 text-xs">
              <Stat label={tl(locale, "Produzierte Rezepte")} value={fmtNum(recipesOfWeek.length)} />
              <Stat label={tl(locale, "Verden Basis")} value={fmtNum(totals.base)} />
              <Stat label={`Verden Plan${upliftPercent !== 0 ? ` (${upliftPercent > 0 ? "+" : ""}${upliftPercent}%)` : ""}`} value={fmtNum(plannedTotal)} accent />
              {MARKETS.map(m => totals[m] > 0 && (
                <Stat key={m} label={marketVariantLabel(locale, m)} value={fmtNum(totals[m])} />
              ))}
            </div>
            <WeekDeltaCard locale={locale} delta={weekDelta} upliftPercent={upliftPercent} />
            <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{tl(locale, "Verden Uplift")}</div>
                  <div className="text-sm font-semibold">{tl(locale, "Planmenge per Klick prozentual anheben")}</div>
                </div>
                <div className="rounded-lg bg-white px-2 py-1 text-sm font-bold ring-1 ring-slate-300">
                  {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
                </div>
              </div>
              <input
                className="mt-3 w-full"
                type="range"
                min={-10}
                max={30}
                step={1}
                value={upliftPercent}
                onChange={e => setUpliftPercent(Number(e.target.value))}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn" onClick={() => setUpliftPercent(p => Math.max(-10, p - 5))}>-5%</button>
                <button className="btn" onClick={() => setUpliftPercent(0)}>{tl(locale, "Reset")}</button>
                <button className="btn btn-primary" onClick={() => setUpliftPercent(p => Math.min(30, p + 5))}>+5%</button>
              </div>
            </div>
          </div>

          <div className="card p-2">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {`Rezepte in ${selectedWeek}`}
            </div>
            <div className="px-2 pb-2">
              <input
                type="search"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder="Suche nach Meal, Artikel, SKU, Zutat ..."
                className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                <span>{`${fmtNum(filteredRecipes.length)} von ${fmtNum(recipesOfWeek.length)} Treffern`}</span>
                {searchText && <button className="hover:text-slate-800" onClick={() => setSearchText("")}>{tl(locale, "Suche leeren")}</button>}
              </div>
            </div>
            <ul className="divide-y divide-slate-100">
              {filteredRecipes.map(r => {
                const tone = recipeListTone(r.code);
                const isActive = activeRecipe?.code === r.code;
                return (
                <li key={r.code}>
                  <button
                    onClick={() => setSelectedRecipe(r.code)}
                    className="w-full text-left px-3 py-2 rounded-lg transition-colors"
                    style={isActive ? tone.active : tone.base}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs" style={tone.code}>{r.code}</span>
                      <span className="text-sm font-semibold">{fmtNum(adjustedPortions(getBaseVerdenVolume(r), upliftPercent))}</span>
                    </div>
                    <div className="text-sm font-medium" style={tone.title}>{data.recipes[r.code]?.markets[globalMarket]?.recipeNameLocal || r.recipeName}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="pill" style={tone.preference}>{r.preference}</span>
                      {MARKETS.map(m => r.verdenVolume[m] > 0 && (
                        <span key={m} className={`pill ${MARKET_COLOR[m]}`}>
                          {marketVariantLabel(locale, m)} {fmtNum(r.verdenVolume[m])}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              );})}
              {filteredRecipes.length === 0 && (
                <li className="px-3 py-4 text-sm text-slate-500">{tl(locale, "Keine Treffer für diese Suche.")}</li>
              )}
              {recipesOfWeek.length === 0 && (
                <li className="px-3 py-4 text-sm text-slate-500">{tl(locale, "Keine Rezepte in dieser Woche.")}</li>
              )}
            </ul>
          </div>
        </aside>

        {/* Hauptbereich */}
        <main className="col-span-12 md:col-span-8 lg:col-span-9">
          {view === "equipment" && <EquipmentView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale={locale} />}
          {view === "woche" && <WocheZutatenView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale={locale} />}
          {view === "planning" && (
            <PlanningView
              data={data}
              week={selectedWeek}
              locale={locale}
              upliftPercent={upliftPercent}
              selectedRecipe={selectedRecipe}
              onSelectRecipe={code => {
                setSelectedRecipe(code);
                setView("recipe");
              }}
            />
          )}
          {view === "rack" && (
            <Suspense fallback={<div className="card p-6 text-slate-500">{tl(locale, "Rack-Ansicht wird geladen …")}</div>}>
              <RackView week={selectedWeek} locale="de" />
            </Suspense>
          )}
          {view === "ket" && (
            <Suspense fallback={<div className="card p-6 text-slate-500">Linienplanung wird geladen …</div>}>
              <LinePlanningView week={selectedWeek} locale={locale} />
            </Suspense>
          )}
          {view === "phase2" && (
            <WhatIfView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale={locale} />
          )}
          {view === "recipe" && (activeRecipe
            ? <RecipeDetail wr={activeRecipe} recipe={data.recipes[activeRecipe.code]} data={data}
                            cookSchedules={data.cookSchedules} processSpecs={data.processSpecs ?? {}}
                            upliftPercent={upliftPercent} />
            : <div className="card p-6 text-slate-500">{tl(locale, "Kein Rezept ausgewählt.")}</div>)}
        </main>
      </div>
      <footer className="mt-6 text-xs text-slate-400">
        Daten generiert: {formatDateTime(locale, data.generatedAt)} ·
        Quelle: {(import.meta.env.VITE_DATA_SOURCE ?? "local")} · Site: VF (Verden)
      </footer>
    </Shell>
  );
}

// ========== Σ Wochenbestellung ============================================

type WocheSortKey = "qty" | "name" | "cat" | "recipes";

interface WocheAggRow {
  ingredientId: string;
  ingredient: string;
  cat: string;
  uom: string;
  totalBase: number;          // in "base UOM" (grams or ml)
  displayTotal: number;       // in kg or L
  displayUom: string;
  recipes: string[];          // codes that need it
  recipesNames: string[];
  perMarket: Record<Market, number>;  // displayUom totals per market
}

function WocheZutatenView({ data, week, upliftPercent, locale }:
  { data: DataBundle; week: string; upliftPercent: number; locale: UiLocale }) {

  const weekRecipes = useMemo(
    () => data.weekRecipes
      .filter(r => r.hfWeek === week)
      .filter(isProducedInVerden)
      .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i),
    [data.weekRecipes, week]
  );

  const [search, setSearch] = useState("");
  const [sort, setSort] = usePersistent<WocheSortKey>("woche_sort", "qty");
  const [sortAsc, setSortAsc] = usePersistent<boolean>("woche_sortasc", false);
  const [selectedMarkets, setSelectedMarkets] = usePersistent<Market[]>("woche_markets", ["BENL", "DKSE", "DE"]);
  const [copied, setCopied] = useState(false);

  function toggleMarket(m: Market) {
    setSelectedMarkets(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  }

  const aggregated = useMemo<WocheAggRow[]>(() => {
    const map = new Map<string, WocheAggRow>();
    for (const wr of weekRecipes) {
      const recipe = data.recipes[wr.code];
      if (!recipe) continue;
      for (const market of MARKETS) {
        if (!selectedMarkets.includes(market)) continue;
        const portions = adjustedPortions(wr.verdenVolume[market], upliftPercent);
        if (portions <= 0) continue;
        for (const g of recipe.grossIngredients[market] ?? []) {
          const key = `${g.ingredientId || g.ingredient}::${g.uom}`;
          const existing = map.get(key);
          const uomLow = g.uom.toLowerCase();
          const isWeight = uomLow === "grams" || uomLow === "g";
          const isVol    = uomLow === "ml";
          const cf = isWeight || isVol ? 1000 : 1;
          const du = isWeight ? "kg" : isVol ? "L" : g.uom;

          if (existing) {
            existing.totalBase += g.grossQuantityPerPortion * portions;
            existing.displayTotal = existing.totalBase / cf;
            if (!existing.recipes.includes(wr.code)) {
              existing.recipes.push(wr.code);
              existing.recipesNames.push(wr.recipeName);
            }
            existing.perMarket[market] = (existing.perMarket[market] ?? 0) + g.grossQuantityPerPortion * portions / cf;
          } else {
            const totalBase = g.grossQuantityPerPortion * portions;
            map.set(key, {
              ingredientId: g.ingredientId,
              ingredient: g.ingredient,
              cat: g.ingredientCategory ?? "—",
              uom: g.uom,
              totalBase,
              displayTotal: totalBase / cf,
              displayUom: du,
              recipes: [wr.code],
              recipesNames: [wr.recipeName],
              perMarket: { BENL: 0, DKSE: 0, DE: 0, [market]: totalBase / cf },
            });
          }
        }
      }
    }
    return [...map.values()];
  }, [weekRecipes, data.recipes, upliftPercent, selectedMarkets]);

  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() =>
    aggregated.filter(r => !needle || [r.ingredient, r.ingredientId, r.cat].some(s => s.toLowerCase().includes(needle))),
    [aggregated, needle]
  );

  const sorted = useMemo(() => {
    const cmp = (a: WocheAggRow, b: WocheAggRow): number => {
      switch (sort) {
        case "qty":     return b.totalBase - a.totalBase;
        case "name":    return a.ingredient.localeCompare(b.ingredient, "de");
        case "cat":     return a.cat.localeCompare(b.cat, "de") || b.totalBase - a.totalBase;
        case "recipes": return b.recipes.length - a.recipes.length;
      }
    };
    const base = [...filtered].sort(cmp);
    return sortAsc ? base.reverse() : base;
  }, [filtered, sort, sortAsc]);

  // totals per UOM
  const grandTotals = useMemo(() => {
    const m = new Map<string, { total: number; du: string }>();
    for (const r of sorted) {
      const cur = m.get(r.displayUom) ?? { total: 0, du: r.displayUom };
      cur.total += r.displayTotal;
      m.set(r.displayUom, cur);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [sorted]);

  function handleSort(key: WocheSortKey) {
    if (sort === key) setSortAsc(a => !a);
    else { setSort(key); setSortAsc(false); }
  }

  function sortIndicator(key: WocheSortKey) {
    if (sort !== key) return <span className="text-slate-300 ml-1">↕</span>;
    return <span className="text-slate-700 ml-1">{sortAsc ? "↑" : "↓"}</span>;
  }

  function exportToClipboard() {
    const header = ["Zutat", "SKU", "Kategorie", "Gesamt", "Einheit", "BENL", "DKSE", "DE", "Anz. Rezepte", "Rezepte"].join("\t");
    const rows = sorted.map(r =>
      [r.ingredient, r.ingredientId, r.cat,
       fmtNum(r.displayTotal, 3).replace(/\./g, "").replace(",", "."),
       r.displayUom,
       fmtNum(r.perMarket.BENL, 3).replace(/\./g, "").replace(",", "."),
       fmtNum(r.perMarket.DKSE, 3).replace(/\./g, "").replace(",", "."),
       fmtNum(r.perMarket.DE, 3).replace(/\./g, "").replace(",", "."),
       r.recipes.length,
       r.recipesNames.join("; ")
      ].join("\t")
    ).join("\n");
    navigator.clipboard.writeText(header + "\n" + rows).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  const catColors: Record<string, string> = {
    PRO: "bg-amber-100 text-amber-800", SPI: "bg-red-100 text-red-800",
    PHF: "bg-sky-100 text-sky-800",     DRY: "bg-lime-100 text-lime-800",
    OTH: "bg-slate-100 text-slate-700", "—": "bg-slate-100 text-slate-500",
  };

  function catColor(cat: string) {
    const prefix = cat.slice(0, 3).toUpperCase();
    return catColors[prefix] ?? "bg-violet-100 text-violet-800";
  }

  if (weekRecipes.length === 0) return (
    <div className="card p-6 text-slate-500">{`Keine Rezepte in ${week}.`}</div>
  );

  return (
    <div className="space-y-4">
      {/* Header / Controls */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{tl(locale, "Σ Wochenbestellung")}</div>
            <div className="text-lg font-bold text-slate-900">{week} · {fmtNum(weekRecipes.length)} produzierte Rezepte</div>
            <div className="text-sm text-slate-500 mt-0.5">
              Alle Brutto-Zutaten über alle Rezepte der Woche aggregiert.
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {/* Market filter */}
            {MARKETS.map(m => (
              <button key={m} onClick={() => toggleMarket(m)}
                className={`pill text-xs font-semibold ${selectedMarkets.includes(m) ? MARKET_COLOR[m] : "bg-slate-100 text-slate-400"}`}>
                {marketVariantLabel(locale, m)}
              </button>
            ))}
          </div>
        </div>

        {/* Grand total badges */}
        <div className="mt-3 flex flex-wrap gap-2">
          {grandTotals.map(gt => (
            <div key={gt.du} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-1.5 text-sm">
              <span className="font-bold tabular-nums">{fmtNum(gt.total, 1)} {gt.du}</span>
              <span className="text-slate-400 ml-1 text-xs">gesamt</span>
            </div>
          ))}
          <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-1.5 text-sm">
            <span className="font-bold tabular-nums">{fmtNum(sorted.length)}</span>
            <span className="text-slate-400 ml-1 text-xs">Zutaten</span>
          </div>
        </div>

        {/* Search + Sort + Export */}
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <input type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Zutat, SKU, Kategorie suchen ..."
            className="min-w-[14rem] flex-1 rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm" />
          {search && <button className="btn" onClick={() => setSearch("")}>Leeren</button>}
          <select value={sort} onChange={e => { setSort(e.target.value as WocheSortKey); setSortAsc(false); }}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm">
            <option value="qty">Sortierung: Menge ↓</option>
            <option value="name">Sortierung: Name A–Z</option>
            <option value="cat">Sortierung: Kategorie</option>
            <option value="recipes">Sortierung: Anz. Rezepte</option>
          </select>
          <button onClick={() => setSortAsc(a => !a)} className="btn" title="Reihenfolge umkehren">
            {sortAsc ? "↑ Aufsteigend" : "↓ Absteigend"}
          </button>
          <button onClick={exportToClipboard} className={`btn ${copied ? "bg-emerald-100 text-emerald-800" : ""}`}>
            {copied ? tl(locale, "✓ Kopiert!") : tl(locale, "📋 Export TSV")}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left py-2.5 pl-4 pr-2 cursor-pointer hover:text-slate-600"
                  onClick={() => handleSort("name")}>{locale === "de" ? "Zutat" : locale === "nl" ? "Ingrediënt" : "Ingredient"} {sortIndicator("name")}</th>
                <th className="text-left py-2.5 pr-2 cursor-pointer hover:text-slate-600"
                  onClick={() => handleSort("cat")}>{locale === "de" ? "Kat" : locale === "nl" ? "Cat" : "Cat"} {sortIndicator("cat")}</th>
                <th className="text-right py-2.5 pr-2 cursor-pointer hover:text-slate-600"
                  onClick={() => handleSort("qty")}>{locale === "de" ? "Gesamt" : locale === "nl" ? "Totaal" : "Total"} {sortIndicator("qty")}</th>
                {selectedMarkets.map(m => (
                  <th key={m} className="text-right py-2.5 pr-2">{marketVariantLabel(locale, m)}</th>
                ))}
                <th className="text-right py-2.5 pr-2 cursor-pointer hover:text-slate-600"
                  onClick={() => handleSort("recipes")}>{locale === "de" ? "Rezepte" : locale === "nl" ? "Recepten" : "Recipes"} {sortIndicator("recipes")}</th>
                <th className="text-left py-2.5 pr-4">{locale === "de" ? "Verwendet in" : locale === "nl" ? "Gebruikt in" : "Used in"}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/80 align-top">
                  <td className="py-2 pl-4 pr-2">
                    <div className="font-medium text-slate-800">{fmtIngName(r.ingredient)}</div>
                    {r.ingredientId && <div className="font-mono text-[10px] text-slate-400">{r.ingredientId}</div>}
                  </td>
                  <td className="py-2 pr-2">
                    <span className={`pill text-[10px] ${catColor(r.cat)}`}>{r.cat}</span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums font-semibold text-slate-900">
                    {fmtNum(r.displayTotal, r.displayTotal < 10 ? 2 : 1)} {r.displayUom}
                  </td>
                  {selectedMarkets.map(m => (
                    <td key={m} className="py-2 pr-2 text-right tabular-nums text-slate-500">
                      {r.perMarket[m] > 0 ? `${fmtNum(r.perMarket[m], r.perMarket[m] < 10 ? 2 : 1)}` : <span className="text-slate-200">—</span>}
                    </td>
                  ))}
                  <td className="py-2 pr-2 text-right tabular-nums">
                    <span className={`pill text-[10px] ${r.recipes.length > 1 ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-500"}`}>
                      {r.recipes.length}×
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-500 max-w-xs">
                    <div className="flex flex-wrap gap-1">
                      {r.recipes.map((code, j) => (
                        <span key={code} className="pill bg-slate-100 text-slate-600 text-[10px]"
                          title={r.recipesNames[j]}>{code}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={6 + selectedMarkets.length} className="py-8 text-center text-slate-400">{locale === "de" ? "Keine Treffer." : locale === "nl" ? "Geen resultaten." : "No matches."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Shell({ children, locale }: { children: React.ReactNode; locale: UiLocale }) {
  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-screen-2xl px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Factor OPS Planner</h1>
            <p className="text-xs text-slate-500">2026 Ramp-Up · NL · EN · DE</p>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-screen-2xl px-4 py-4">{children}</div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function DeltaPill({ value }: { value: number }) {
  const positive = value > 0;
  const negative = value < 0;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${positive ? "bg-emerald-100 text-emerald-800" : negative ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600"}`}>
      {positive ? "+" : ""}{fmtNum(value)}
    </span>
  );
}

function WeekDeltaCard({
  locale,
  delta,
  upliftPercent,
}: {
  locale: UiLocale;
  delta: {
    previousWeek: string;
    currentTotal: number;
    previousTotal: number;
    totalDelta: number;
    recipeDelta: number;
    added: WeekRecipe[];
    removed: WeekRecipe[];
    changed: Array<{ code: string; recipeName: string; current: number; previous: number; delta: number }>;
  } | null;
  upliftPercent: number;
}) {
  if (!delta) {
    return (
      <div className="mt-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">{locale === "de" ? "Vorwochenvergleich" : locale === "nl" ? "Vergelijking vorige week" : "Previous week delta"}</div>
        <div className="mt-1 text-sm text-slate-600">{locale === "de" ? "Für diese Woche ist keine Vorwoche im Datensatz verfügbar." : locale === "nl" ? "Voor deze week is geen vorige week beschikbaar in de dataset." : "No previous week is available in the dataset for this selection."}</div>
      </div>
    );
  }

  const topChanges = delta.changed.slice(0, 5);
  const topAdded = delta.added.slice(0, 3);
  const topRemoved = delta.removed.slice(0, 3);

  return (
    <div className="mt-3 rounded-xl bg-[linear-gradient(135deg,_rgba(14,165,233,0.08),_rgba(248,250,252,1)_36%,_rgba(16,185,129,0.08))] p-3 ring-1 ring-slate-200">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{locale === "de" ? "Vorwochenvergleich" : locale === "nl" ? "Vergelijking vorige week" : "Previous week delta"}</div>
          <div className="text-sm font-semibold text-slate-900">{locale === "de" ? `Änderungen zu ${delta.previousWeek}` : locale === "nl" ? `Wijzigingen t.o.v. ${delta.previousWeek}` : `Changes vs ${delta.previousWeek}`}</div>
        </div>
        {upliftPercent !== 0 && <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">Uplift {upliftPercent > 0 ? "+" : ""}{upliftPercent}%</span>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs xl:grid-cols-3">
        <Stat label={locale === "de" ? "Plan Δ Portionen" : locale === "nl" ? "Plan Δ porties" : "Plan Δ portions"} value={`${delta.totalDelta > 0 ? "+" : ""}${fmtNum(delta.totalDelta)}`} accent={delta.totalDelta !== 0} />
        <Stat label={locale === "de" ? "Rezept Δ" : locale === "nl" ? "Recept Δ" : "Recipe Δ"} value={`${delta.recipeDelta > 0 ? "+" : ""}${fmtNum(delta.recipeDelta)}`} accent={delta.recipeDelta !== 0} />
        <Stat label={locale === "de" ? "Neu / Weg" : locale === "nl" ? "Nieuw / weg" : "Added / removed"} value={`${fmtNum(delta.added.length)} / ${fmtNum(delta.removed.length)}`} />
      </div>

      <div className="mt-3 space-y-3 text-xs">
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Größte Mengenänderungen" : locale === "nl" ? "Grootste volumewijzigingen" : "Largest volume changes"}</div>
          <div className="space-y-1.5">
            {topChanges.length === 0 && <div className="rounded-lg bg-white px-2 py-2 text-slate-500 ring-1 ring-slate-200">{locale === "de" ? "Keine Mengenänderungen gegenüber der Vorwoche." : locale === "nl" ? "Geen volumewijzigingen t.o.v. vorige week." : "No volume changes versus previous week."}</div>}
            {topChanges.map(change => (
              <div key={change.code} className="rounded-lg bg-white px-2 py-2 ring-1 ring-slate-200">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-slate-500">{change.code}</div>
                    <div className="truncate text-slate-800">{change.recipeName}</div>
                  </div>
                  <DeltaPill value={change.delta} />
                </div>
                <div className="mt-1 text-[11px] text-slate-500">{fmtNum(change.previous)} → {fmtNum(change.current)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Neu in der Woche" : locale === "nl" ? "Nieuw deze week" : "New this week"}</div>
            <div className="space-y-1.5">
              {topAdded.length === 0 && <div className="rounded-lg bg-white px-2 py-2 text-slate-500 ring-1 ring-slate-200">{locale === "de" ? "Keine neuen Rezepte." : locale === "nl" ? "Geen nieuwe recepten." : "No new recipes."}</div>}
              {topAdded.map(recipe => (
                <div key={recipe.code} className="rounded-lg bg-white px-2 py-2 ring-1 ring-slate-200">
                  <div className="font-mono text-[11px] text-slate-500">{recipe.code}</div>
                  <div className="truncate text-slate-800">{recipe.recipeName}</div>
                  <div className="mt-1 text-[11px] text-emerald-700">+{fmtNum(adjustedPortions(getBaseVerdenVolume(recipe), upliftPercent))}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Weg zur Vorwoche" : locale === "nl" ? "Weg t.o.v. vorige week" : "Removed vs previous week"}</div>
            <div className="space-y-1.5">
              {topRemoved.length === 0 && <div className="rounded-lg bg-white px-2 py-2 text-slate-500 ring-1 ring-slate-200">{locale === "de" ? "Keine weggefallenen Rezepte." : locale === "nl" ? "Geen verwijderde recepten." : "No removed recipes."}</div>}
              {topRemoved.map(recipe => (
                <div key={recipe.code} className="rounded-lg bg-white px-2 py-2 ring-1 ring-slate-200">
                  <div className="font-mono text-[11px] text-slate-500">{recipe.code}</div>
                  <div className="truncate text-slate-800">{recipe.recipeName}</div>
                  <div className="mt-1 text-[11px] text-rose-700">-{fmtNum(adjustedPortions(getBaseVerdenVolume(recipe), upliftPercent))}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Rezept-Detail ----------
type Tab = "overview" | "subrecipes" | "structure" | "ingredients" | "engpass" | "plating" | "cook" | "workflow";

function RecipeDetail({ wr, recipe, data, cookSchedules, processSpecs, upliftPercent }:
  { wr: WeekRecipe; recipe?: Recipe; data: DataBundle; cookSchedules: Record<string, CookSchedule>;
    processSpecs: Record<string, ProcessSpec>; upliftPercent: number }) {

  const [tab, setTab] = usePersistent<Tab>("detail_tab", "overview");
  const [market, setMarket] = usePersistent<Market>("detail_market", "BENL");
  const locale = marketToLocale(market);
  const [detailSearch, setDetailSearch] = useState<string>("");

  // Beim Wechsel des Rezepts: Markt anpassen, aber Tab behalten
  const prevCodeRef = useRef<string>("");
  useEffect(() => {
    if (prevCodeRef.current === wr.code) return;
    prevCodeRef.current = wr.code;
    const def = MARKETS.find(m => wr.verdenVolume[m] > 0) ?? "BENL";
    setMarket(def);
    setDetailSearch("");
  }, [wr.code, wr.hfWeek]);

  const md = recipe?.markets[market];
  const structure = useMemo(
    () => resolveStructureByCode(data.structures, wr.code, recipe?.code),
    [data.structures, wr.code, recipe?.code]
  );
  const basePortionsTotal = getBaseVerdenVolume(wr);
  const portionsTotal = adjustedPortions(basePortionsTotal, upliftPercent);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-mono text-xs text-slate-500">{wr.code} · {wr.hfWeek}</div>
            <h2 className="text-xl font-bold leading-tight">{md?.recipeNameLocal || wr.recipeName}</h2>
            {md?.recipeNameLocal && md.recipeNameLocal !== wr.recipeName && (
              <div className="text-xs text-slate-400 mt-0.5">{wr.recipeName}</div>
            )}
            <div className="mt-1 flex flex-wrap gap-1 text-xs">
              <span className="pill bg-slate-100 text-slate-700">{wr.preference}</span>
              {MARKETS.map(m => (
                <span key={m} className={`pill ${MARKET_COLOR[m]}`}>
                  {marketVariantLabel(locale, m)} · {fmtNum(wr.verdenVolume[m])} {wr.slot[m] ? `(Slot ${wr.slot[m]})` : ""}
                </span>
              ))}
              <span className="pill bg-verden-600 text-white">Σ Verden {fmtNum(portionsTotal)}</span>
              {upliftPercent !== 0 && <span className="pill bg-verden-100 text-verden-700">Basis {fmtNum(basePortionsTotal)} · {upliftPercent > 0 ? "+" : ""}{upliftPercent}%</span>}
              {wr.productionBuffer > 0 && (
                <span className="pill bg-amber-100 text-amber-800">Buffer +{fmtNum(wr.productionBuffer)}</span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <div className="inline-flex rounded-lg ring-1 ring-slate-300 bg-white overflow-hidden">
              {MARKETS.map(m => {
                const has = !!recipe?.markets[m];
                return (
                  <button key={m}
                    disabled={!has}
                    onClick={() => setMarket(m)}
                    className={`px-3 py-1.5 text-xs font-medium ${
                      market === m ? "bg-verden-600 text-white" : has ? "hover:bg-slate-50" : "text-slate-300"
                    }`}>
                    {MARKET_LANGUAGE_LABEL[m]}
                  </button>
                );
              })}
            </div>
            {md && <div className="font-mono text-[10px] text-slate-400">{md.msku}</div>}
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-sm">
          {([
            ["overview",   tl(locale, "Übersicht")],
            ["subrecipes", `${tl(locale, "Sub-Rezepte")} (${md?.subRecipes.length ?? 0})`],
            ["structure",  tl(locale, "Rezeptstruktur")],
            ["workflow",   tl(locale, "Workflow & Equipment")],
            ["ingredients",tl(locale, "Brutto-Zutaten (Σ)")],
            ["engpass",    tl(locale, "🚨 Engpass-Analyse")],
            ["plating",    tl(locale, "Plating / Anweisungen")],
            ["cook",       tl(locale, "Cook-Schedule")]
          ] as [Tab, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg ring-1 ${
                tab === k ? "bg-slate-900 text-white ring-slate-900" : "bg-white ring-slate-300 hover:bg-slate-50"
              }`}>{l}</button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={detailSearch}
            onChange={e => setDetailSearch(e.target.value)}
            placeholder={locale === "de" ? "Im geöffneten Rezept suchen: Zutat, Sub-Rezept, Step, SKU ..." : locale === "nl" ? "Zoeken in geopend recept: ingrediënt, subrecept, stap, SKU ..." : "Search open recipe: ingredient, sub-recipe, step, SKU ..."}
            className="min-w-[18rem] flex-1 rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
          />
          {detailSearch && <button className="btn" onClick={() => setDetailSearch("")}>{tl(locale, "Suche leeren")}</button>}
        </div>
      </div>

      {!recipe && <div className="card p-4 text-amber-700">{locale === "de" ? `Keine Rezept-Stammdaten für ${wr.code} gefunden (CSV-Export prüfen).` : locale === "nl" ? `Geen receptstamgegevens voor ${wr.code} gevonden (controleer CSV-export).` : `No recipe master data found for ${wr.code} (check CSV export).`}</div>}

      {recipe && tab === "overview"   && <OverviewTab wr={wr} recipe={recipe} market={market} md={md} portionsTotal={portionsTotal} upliftPercent={upliftPercent} locale={locale} />}
      {recipe && tab === "subrecipes" && md && <SubRecipesTab recipeCode={wr.code} md={md} cookSchedules={cookSchedules} detailSearch={detailSearch} />}
      {tab === "structure" && <StructureTab code={wr.code} structure={structure} market={market} week={wr.hfWeek} recipeName={recipe?.baseName ?? wr.code} wr={wr} portionsTotal={portionsTotal} upliftPercent={upliftPercent} data={data} />}
      {recipe && tab === "workflow"   && md && <WorkflowTab wr={wr} recipe={recipe} md={md} processSpecs={processSpecs} detailSearch={detailSearch} />}
      {recipe && tab === "ingredients"&& <IngredientsTab recipe={recipe} market={market} portionsTotal={portionsTotal} wr={wr} shelfLifeBySku={data.shelfLifeBySku ?? {}} generatedAt={data.generatedAt} detailSearch={detailSearch} />}
      {recipe && tab === "engpass"   && <EngpassTab recipe={recipe} market={market} portionsTotal={portionsTotal} wr={wr} md={md} />}
      {recipe && tab === "plating"    && md && <PlatingTab md={md} detailSearch={detailSearch} />}
      {recipe && tab === "cook"       && md && <CookTab wr={wr} md={md} cookSchedules={cookSchedules} portionsTotal={portionsTotal} recipe={recipe} processSpecs={processSpecs} detailSearch={detailSearch} />}
    </div>
  );
}

function OverviewTab({ wr, recipe, market, md, portionsTotal, upliftPercent, locale }:
  { wr: WeekRecipe; recipe: Recipe; market: Market; md?: Recipe["markets"][Market]; portionsTotal: number; upliftPercent: number; locale: UiLocale }) {
  const baseTotal = getBaseVerdenVolume(wr);
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{tl(locale, "Produktion (alle Märkte werden gemeinsam gekocht)")}</h3>
        <table className="w-full text-sm">
          <tbody>
            {MARKETS.map(m => (
              <tr key={m} className="border-b last:border-0">
                <td className="py-1"><span className={`pill ${MARKET_COLOR[m]}`}>{marketVariantLabel(locale, m)}</span></td>
                <td className="py-1 text-right tabular-nums">{fmtNum(wr.verdenVolume[m])}</td>
                <td className="py-1 text-right text-xs text-slate-500">{wr.slot[m] ? `Slot ${wr.slot[m]}` : ""}</td>
              </tr>
            ))}
            <tr className="font-semibold bg-verden-50">
              <td className="py-1.5 px-1">Σ {tl(locale, "Verden Basis")}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtNum(baseTotal)}</td>
              <td></td>
            </tr>
            <tr className="font-semibold bg-verden-100">
              <td className="py-1.5 px-1">Σ {locale === "de" ? "Plan Verden" : locale === "nl" ? "Verden plan" : "Verden plan"}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtNum(portionsTotal)}</td>
              <td className="py-1.5 text-right text-xs text-verden-700">{upliftPercent > 0 ? "+" : ""}{upliftPercent}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{locale === "de" ? "Markt-Variante" : locale === "nl" ? "Marktvariant" : "Market variant"}: {marketVariantLabel(locale, market)}</h3>
        {md ? (
          <dl className="text-sm space-y-1.5">
            <Row k={tl(locale, "MSKU")} v={md.msku} />
            <Row k={tl(locale, "Lokaler Name")} v={md.recipeNameLocal} />
            <Row k={tl(locale, "Yield")} v={md.recipeYield ? `${md.recipeYield} ${md.recipeYieldUom ?? ""}` : "-"} />
            <Row k={tl(locale, "Allergene")} v={md.allergens || "-"} />
            <Row k={tl(locale, "Primäre Verpackung")} v={md.primaryPackagingSku || "-"} />
            <Row k={tl(locale, "Compartment")} v={md.compartmentName || "-"} />
            <Row k={tl(locale, "Sek. Verpackungen")} v={md.secondaryPackagingSkus || "-"} />
            <Row k={tl(locale, "Märkte verfügbar")} v={Object.keys(recipe.markets).map(m => marketVariantLabel(locale, m as Market)).join(", ")} />
          </dl>
        ) : <div className="text-slate-500 text-sm">{tl(locale, "Keine Daten für diesen Markt.")}</div>}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt>
      <dd className="col-span-2">{v}</dd>
    </div>
  );
}

// Bekannte Farbnamen → CSS-Farbe
function methodColorToCSS(colorStr: string | undefined): string | null {
  if (!colorStr || colorStr === "-") return null;
  const lower = colorStr.toLowerCase();
  const colorMap: [string, string][] = [
    ["grey", "#9ca3af"], ["gray", "#9ca3af"],
    ["beige", "#d6c9a0"],
    ["silver", "#94a3b8"],
    ["white", "#e2e8f0"],
    ["black", "#1e293b"],
    ["red", "#ef4444"],
    ["blue", "#3b82f6"],
    ["green", "#22c55e"],
    ["yellow", "#fbbf24"],
    ["orange", "#f97316"],
    ["purple", "#a855f7"],
    ["pink", "#ec4899"],
    ["brown", "#a16207"],
    ["gold", "#d97706"],
    ["turquoise", "#06b6d4"],
    ["teal", "#14b8a6"],
    ["coral", "#fb7185"],
    ["cream", "#fef9c3"],
    ["violet", "#7c3aed"],
  ];
  for (const [key, val] of colorMap) {
    if (lower.includes(key)) return val;
  }
  return null;
}

// ========== Interaktiver Rezeptbaum =======================================

const CATEGORY_COLOR: Record<string, string> = {
  GRILL:            "bg-rose-100 text-rose-800 border-rose-300",
  OVEN:             "bg-orange-100 text-orange-800 border-orange-300",
  BRAISER:          "bg-amber-100 text-amber-800 border-amber-300",
  BRINE:            "bg-cyan-100 text-cyan-800 border-cyan-300",
  MARINADE:         "bg-violet-100 text-violet-800 border-violet-300",
  "BLAST CHILLER":  "bg-sky-100 text-sky-800 border-sky-300",
  "PLANETARY MIXER":"bg-emerald-100 text-emerald-800 border-emerald-300",
  "HAND MIX":       "bg-lime-100 text-lime-800 border-lime-300",
  "IMMERSION BLENDER":"bg-teal-100 text-teal-800 border-teal-300",
  STAGING:          "bg-slate-100 text-slate-700 border-slate-300",
};

function categoryBadges(categories: string) {
  if (!categories) return null;
  const cats = categories.split(/[,/]/).map(s => s.trim()).filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {cats.map(c => {
        const cls = Object.entries(CATEGORY_COLOR).find(([k]) => c.toUpperCase().includes(k))?.[1]
          ?? "bg-slate-100 text-slate-600 border-slate-200";
        return <span key={c} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>{c}</span>;
      })}
    </div>
  );
}

function IngredientRow({ ing }: { ing: DetailedSubRecipe["ingredients"][number] }) {
  return (
    <div className="flex items-start gap-2 py-1 border-b border-dashed border-slate-100 last:border-0">
      <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-7 shrink-0">ING</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-700 font-medium truncate">{fmtIngName(ing.name)}</div>
        <div className="text-[10px] text-slate-400 tabular-nums">
          {ing.grossQty > 0 ? `Brutto ${ing.grossQty} ${ing.uom}` : ""}
          {ing.netQty > 0 && ing.netQty !== ing.grossQty ? ` / Netto ${ing.netQty}` : ""}
          {ing.allergen ? ` · ⚠ ${ing.allergen}` : ""}
        </div>
      </div>
    </div>
  );
}

function countIngredients(node: DetailedSubRecipe): number {
  return node.ingredients.length + node.subRecipes.reduce((s, c) => s + countIngredients(c), 0);
}

// Old list-view node (used in "Liste" mode)
function SubRecipeNode({ node, depth }: { node: DetailedSubRecipe; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.subRecipes.length > 0 || node.ingredients.length > 0;
  const totalIng = countIngredients(node);
  const borderCols = ["border-l-indigo-400","border-l-violet-400","border-l-fuchsia-400","border-l-rose-400"];
  const borderClass = borderCols[Math.min(depth, borderCols.length - 1)];
  return (
    <div className={`ml-${depth === 0 ? "0" : "5"} mt-2`}>
      <div className={`rounded-xl border border-slate-200 border-l-4 ${borderClass} bg-white shadow-sm`}>
        <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 p-3 text-left">
          <span className={`mt-0.5 text-[9px] font-bold uppercase tracking-widest shrink-0 ${
            depth === 0 ? "text-indigo-500" : depth === 1 ? "text-violet-500" : "text-fuchsia-500"
          }`}>SUB{depth + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800 leading-snug">{node.name}</div>
            {categoryBadges(node.categories)}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {node.quantity != null && (
              <span className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full tabular-nums">
                {node.quantity} {node.uom ?? ""}
              </span>
            )}
            <span className="text-[10px] text-slate-400">{totalIng} Zutat{totalIng !== 1 ? "en" : ""}</span>
            <span className="text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
          </div>
        </button>
        {open && hasChildren && (
          <div className="border-t border-slate-100 px-3 pb-3 pt-2">
            {node.ingredients.length > 0 && (
              <div className="mb-2 rounded-lg bg-slate-50 px-2 py-1">
                {node.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
              </div>
            )}
            {node.subRecipes.map((sub, i) => (
              <SubRecipeNode key={sub.id || i} node={sub} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SVG interactive tree ──────────────────────────────────────────────────

const TW = 220;   // tree node width
const TH = 62;    // tree node height
const TGX = 72;   // horizontal gap between depth levels
const TGY = 14;   // vertical gap between siblings
const TPAD = 32;  // canvas padding

interface FlatTreeNode {
  id: string;
  label: string;
  categories: string;
  ingCount: number;
  depth: number;
  cx: number;
  cy: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  node: DetailedSubRecipe;
}

function subtreeLeafCount(nodes: DetailedSubRecipe[], exp: Set<string>): number {
  return nodes.reduce((s, n) => {
    const id = n.id || n.name;
    return s + (exp.has(id) && n.subRecipes.length > 0 ? subtreeLeafCount(n.subRecipes, exp) : 1);
  }, 0);
}

function buildFlatTree(roots: DetailedSubRecipe[], expanded: Set<string>): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  function layout(nodes: DetailedSubRecipe[], depth: number, leafStart: number, parentId: string | null): number {
    let li = leafStart;
    for (const node of nodes) {
      const id = node.id || node.name;
      const isExpanded = expanded.has(id) && node.subRecipes.length > 0;
      const leaves = isExpanded ? subtreeLeafCount(node.subRecipes, expanded) : 1;
      result.push({
        id,
        label: node.name,
        categories: node.categories,
        ingCount: countIngredients(node),
        depth,
        cx: TPAD + depth * (TW + TGX) + TW / 2,
        cy: TPAD + (li + (leaves - 1) / 2) * (TH + TGY) + TH / 2,
        parentId,
        hasChildren: node.subRecipes.length > 0,
        expanded: isExpanded,
        node,
      });
      if (isExpanded) layout(node.subRecipes, depth + 1, li, id);
      li += leaves;
    }
    return li;
  }
  layout(roots, 0, 0, null);
  return result;
}

function treeNodeFill(depth: number, categories: string): string {
  const c = categories?.toUpperCase() ?? "";
  if (c.includes("GRILL"))   return "#fee2e2";
  if (c.includes("OVEN"))    return "#ffedd5";
  if (c.includes("BLAST"))   return "#e0f2fe";
  if (c.includes("MARINADE"))return "#ede9fe";
  if (c.includes("MIXER"))   return "#d1fae5";
  if (c.includes("HAND MIX"))return "#ecfccb";
  if (c.includes("BRINE"))   return "#cffafe";
  if (c.includes("BRAISER")) return "#fef9c3";
  const fills = ["#e0e7ff","#ede9fe","#fce7f3","#fef3c7","#d1fae5"];
  return fills[depth % fills.length];
}

function treeNodeStroke(depth: number): string {
  const strokes = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981"];
  return strokes[depth % strokes.length];
}

function TreeCanvas({ roots, code, recipeName, week, market }: {
  roots: DetailedSubRecipe[];
  code: string;
  recipeName: string;
  week: string;
  market: Market;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Alle Knoten-IDs rekursiv sammeln (für "alles aufgeklappt" als Default)
  function collectAllIds(nodes: DetailedSubRecipe[]): Set<string> {
    const s = new Set<string>();
    function add(ns: DetailedSubRecipe[]) { ns.forEach(n => { s.add(n.id || n.name); add(n.subRecipes); }); }
    add(nodes);
    return s;
  }

  const [expanded, setExpanded] = useState<Set<string>>(() => collectAllIds(roots));
  const [selected, setSelected] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const flatNodes = useMemo(() => buildFlatTree(roots, expanded), [roots, expanded]);
  const selectedNode = useMemo(() => flatNodes.find(n => n.id === selected)?.node, [flatNodes, selected]);

  const totalLeaves = useMemo(() => Math.max(1, subtreeLeafCount(roots, expanded)), [roots, expanded]);
  const maxDepth   = useMemo(() => flatNodes.reduce((m, n) => Math.max(m, n.depth), 0), [flatNodes]);
  const _svgW = TPAD * 2 + (maxDepth + 1) * (TW + TGX);
  const svgH = TPAD * 2 + totalLeaves * (TH + TGY);

  const edges = useMemo(() => flatNodes.filter(n => n.parentId).map(n => {
    const p = flatNodes.find(f => f.id === n.parentId)!;
    return { x1: p.cx + TW / 2, y1: p.cy, x2: n.cx - TW / 2, y2: n.cy };
  }), [flatNodes]);

  function toggleExpanded(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }

  function expandAll() {
    setExpanded(collectAllIds(roots));
  }
  function collapseAll() { setExpanded(new Set()); }

  // Wheel: nativer non-passive Listener, damit preventDefault() funktioniert
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => Math.min(3, Math.max(0.15, z * (e.deltaY > 0 ? 0.88 : 1.14))));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  function onMouseDown(e: React.MouseEvent) {
    if ((e.target as Element).closest("[data-treenode]")) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.ox + e.clientX - dragRef.current.sx, y: dragRef.current.oy + e.clientY - dragRef.current.sy });
  }
  function onMouseUp() { dragRef.current = null; }

  // ── GSheet-Export ─────────────────────────────────────────────────────────
  function exportGSheet() {
    // Baum flach machen: jede Zeile repräsentiert einen Knoten mit Pfad-Spalten
    const rows: string[][] = [];
    const MARKET_LABEL_EXP: Record<Market, string> = { DE: "Deutschland", BENL: "Belgien/NL", DKSE: "Dänemark/SE" };

    // Tiefensuche, Pfad aufbauen (sub1..sub4 Zellen)
    function walk(node: DetailedSubRecipe, path: string[], depth: number, stepLabel: string) {
      const paddedPath = [...path, ...Array(4).fill("")].slice(0, 4);
      // Alle direkten Zutaten als eigene Zeile
      const ingNames = node.ingredients.map(i => `${fmtIngName(i.name)} (${i.grossQty} ${i.uom})`).join(" | ");
      const subDepth = (function countD(subs: DetailedSubRecipe[]): number {
        if (!subs.length) return 0;
        return 1 + Math.max(...subs.map(s => countD(s.subRecipes)));
      })(node.subRecipes);

      rows.push([
        stepLabel,                           // Kochschritt
        paddedPath[0],                       // Sub-Rezept Ebene 1
        paddedPath[1],                       // Sub-Rezept Ebene 2
        paddedPath[2],                       // Sub-Rezept Ebene 3
        paddedPath[3],                       // Sub-Rezept Ebene 4
        node.categories ?? "",               // Kategorie / Methode
        node.quantity != null ? String(node.quantity) : "",  // Menge
        node.uom ?? "",                      // Einheit
        String(depth + 1),                   // Ebene (1=SUB1, 2=SUB2, …)
        subDepth > 0 ? String(subDepth) : "—", // Unterebenen
        String(node.ingredients.length),     // Anzahl direkte Zutaten
        ingNames,                            // Zutaten (Name + Menge)
      ]);

      node.subRecipes.forEach((child, ci) => {
        const childPath = [...path.slice(0, depth + 1), child.name];
        walk(child, childPath, depth + 1, `${stepLabel}.${ci + 1}`);
      });
    }

    roots.forEach((root, ri) => {
      walk(root, [root.name], 0, String(ri + 1));
    });

    const headers = [
      "Kochschritt",
      "Sub-Rezept (Ebene 1)",
      "Sub-Rezept (Ebene 2)",
      "Sub-Rezept (Ebene 3)",
      "Sub-Rezept (Ebene 4)",
      "Kategorie/Methode",
      "Menge",
      "Einheit",
      "Ebene",
      "Unterebenen",
      "Anz. Zutaten",
      "Zutaten (Brutto)",
    ];

    const tsv = [headers, ...rows]
      .map(r => r.map(c => c.replace(/\t/g, " ")).join("\t"))
      .join("\n");

    const blob = new Blob(["\uFEFF" + tsv], { type: "text/tab-separated-values;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${week}_${code}_Rezeptbaum_${MARKET_LABEL_EXP[market] ?? market}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const canvasH = Math.max(260, Math.min(620, svgH * zoom + 80));

  return (
    <div className="space-y-2">
      {/* Kochreihenfolge-Legende */}
      {roots.length > 0 && (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3">
          <div className="text-xs font-semibold text-amber-700 mb-2">🍳 Kochreihenfolge (empfohlen: von links nach rechts / oben nach unten)</div>
          <div className="flex flex-wrap gap-2">
            {roots.map((r, i) => (
              <div key={r.id || r.name} className="flex items-center gap-1.5 rounded-lg bg-white ring-1 ring-amber-200 px-3 py-1.5">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-bold flex-shrink-0">{i + 1}</span>
                <span className="text-xs font-medium text-slate-800">{r.name}</span>
                {r.categories && <span className="text-[10px] text-slate-400">· {r.categories.split(/[,/]/)[0].trim()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative select-none rounded-xl ring-1 ring-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 overflow-hidden"
        style={{ height: canvasH, cursor: dragRef.current ? "grabbing" : "grab" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <svg width="100%" height="100%" style={{ display: "block" }}>
          <defs>
            <filter id="node-shadow">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.12" />
            </filter>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {/* Edges */}
            {edges.map((e, i) => {
              const mx = (e.x1 + e.x2) / 2;
              return (
                <path
                  key={i}
                  d={`M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  opacity="0.7"
                />
              );
            })}

            {/* Nodes */}
            {flatNodes.map(n => {
              const x = n.cx - TW / 2;
              const y = n.cy - TH / 2;
              const fill   = treeNodeFill(n.depth, n.categories);
              const stroke = treeNodeStroke(n.depth);
              const isSel  = n.id === selected;
              const label  = n.label.length > 27 ? n.label.slice(0, 25) + "…" : n.label;
              const cats   = n.categories?.split(/[,/]/).map(s => s.trim()).filter(Boolean) ?? [];
              const catTxt = cats[0] ? (cats[0].length > 24 ? cats[0].slice(0, 22) + "…" : cats[0]) : "";
              const rootIdx = n.depth === 0 ? roots.findIndex(r => (r.id || r.name) === n.id) : -1;
              // Tiefe der Unterebenen dieses Knotens
              const subDepth = (function countDepth(subs: DetailedSubRecipe[]): number {
                if (!subs.length) return 0;
                return 1 + Math.max(...subs.map(s => countDepth(s.subRecipes)));
              })(n.node.subRecipes);
              const subDepthLabel = subDepth > 0 ? `${subDepth} Ebene${subDepth > 1 ? "n" : ""}` : null;

              return (
                <g
                  key={n.id}
                  data-treenode="1"
                  onClick={() => setSelected(n.id === selected ? null : n.id)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Shadow rect */}
                  <rect x={x+2} y={y+3} width={TW} height={TH} rx={11} fill="rgba(0,0,0,0.07)" />
                  {/* Main rect */}
                  <rect
                    x={x} y={y} width={TW} height={TH} rx={10}
                    fill={fill}
                    stroke={isSel ? "#1e293b" : stroke}
                    strokeWidth={isSel ? 2.5 : 1.5}
                  />
                  {/* Left accent bar */}
                  <rect x={x} y={y} width={4} height={TH} rx={10} fill={stroke} />
                  {/* Step badge on root nodes */}
                  {rootIdx >= 0 && (
                    <>
                      <circle cx={x + 14} cy={y + 14} r={10} fill="#f59e0b" />
                      <text x={x + 14} y={y + 18} fontSize="9" fontWeight="900" fill="#fff"
                        textAnchor="middle" style={{ userSelect: "none" }}>
                        {rootIdx + 1}
                      </text>
                    </>
                  )}
                  {/* Depth label */}
                  <text x={x + 14} y={rootIdx >= 0 ? y + 34 : y + 16} fontSize="7.5" fontWeight="800" fill={stroke}
                    textAnchor="middle" style={{ userSelect: "none" }}>
                    {rootIdx >= 0 ? "SUB" : `SUB${n.depth + 1}`}
                  </text>
                  {/* Name */}
                  <text x={x + 26} y={y + 18} fontSize="11" fontWeight="700" fill="#1e293b"
                    style={{ userSelect: "none" }}>
                    {label}
                  </text>
                  {/* Category */}
                  {catTxt && (
                    <text x={x + 26} y={y + 31} fontSize="9" fill="#64748b" style={{ userSelect: "none" }}>
                      {catTxt}
                    </text>
                  )}
                  {/* Ingredient count + sub-level depth */}
                  <text x={x + 26} y={y + TH - 10} fontSize="8.5" fill="#94a3b8" style={{ userSelect: "none" }}>
                    {n.ingCount} Zutat{n.ingCount !== 1 ? "en" : ""}
                    {n.node.quantity != null ? `  ·  ${n.node.quantity} ${n.node.uom ?? ""}` : ""}
                    {subDepthLabel ? `  ·  ↓ ${subDepthLabel}` : ""}
                  </text>
                  {/* Expand/collapse toggle */}
                  {n.hasChildren && (
                    <g onClick={e => toggleExpanded(n.id, e)} style={{ cursor: "pointer" }}>
                      <circle cx={x + TW + 12} cy={n.cy} r={11}
                        fill={n.expanded ? stroke : "#fff"}
                        stroke={stroke} strokeWidth="1.5" />
                      <text x={x + TW + 12} y={n.cy + 4.5} textAnchor="middle"
                        fontSize="14" fontWeight="bold"
                        fill={n.expanded ? "#fff" : stroke}
                        style={{ userSelect: "none" }}>
                        {n.expanded ? "−" : "+"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Zoom badge */}
        <div className="pointer-events-none absolute bottom-2 right-3 rounded bg-white/80 px-2 py-0.5 text-[10px] text-slate-500 backdrop-blur-sm">
          {Math.round(zoom * 100)}%
        </div>
      </div>

      {/* Detail panel for selected node */}
      {selected && selectedNode && (
        <div className="card p-4 ring-2 ring-indigo-200 space-y-3 animate-in fade-in duration-150">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Knoten-Detail</div>
              <div className="text-base font-bold text-slate-900 mt-0.5">{selectedNode.name}</div>
              {selectedNode.id && <div className="font-mono text-[10px] text-slate-400 mt-0.5">{selectedNode.id}</div>}
            </div>
            <button className="btn text-xs" onClick={() => setSelected(null)}>✕</button>
          </div>
          {selectedNode.categories && categoryBadges(selectedNode.categories)}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {selectedNode.quantity != null && (
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Menge / Portion</div>
                <div className="font-semibold mt-0.5">{selectedNode.quantity} {selectedNode.uom ?? ""}</div>
              </div>
            )}
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Zutaten gesamt</div>
              <div className="font-semibold mt-0.5">{countIngredients(selectedNode)}</div>
            </div>
          </div>
          {selectedNode.ingredients.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 mb-2">
                Direkte Zutaten ({selectedNode.ingredients.length})
              </div>
              <div className="rounded-lg bg-slate-50 px-2 py-1 divide-y divide-slate-100">
                {selectedNode.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
              </div>
            </div>
          )}
          {selectedNode.subRecipes.length > 0 && (
            <div className="text-xs text-slate-500">
              <span className="font-medium">Kind-Sub-Rezepte:</span>{" "}
              {selectedNode.subRecipes.map(s => s.name).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StructureTab ──────────────────────────────────────────────────────────

function StructureTab({ code, structure, market, week, recipeName, wr, portionsTotal, upliftPercent, data }: {
  code: string; structure: RecipeStructure | undefined; market: Market; week: string; recipeName: string;
  wr: WeekRecipe; portionsTotal: number; upliftPercent: number; data: DataBundle;
}) {
  const locale = marketToLocale(market);
  const MARKET_ORDER: Market[] = ["BENL", "DE", "DKSE"];
  const MARKET_LABEL_FULL: Record<Market, string> = { DE: "Deutschland", BENL: "Belgien/NL", DKSE: "Dänemark/SE" };
  const [activeMarket, setActiveMarket] = usePersistent<Market | "ALL">("structure_market", market);
  const [treeMode, setTreeMode] = usePersistent<"svg" | "list">("structure_mode", "svg");
  const [xlsxLoading, setXlsxLoading] = useState(false);

  const availableMarkets = MARKET_ORDER.filter(m => structure?.markets[m]?.length);

  // ── Formatierter XLSX-Export (farbig, alle Ebenen, KG, GSheets-ready) ── GANZE KW ──
  async function exportFormattedXLSX() {
    setXlsxLoading(true);
    try {
      // Alle in Verden produzierten Rezepte der aktuellen KW (FE/FV)
      const allWrOfWeek = data.weekRecipes
        .filter(r => r.hfWeek === week)
        .filter(isProducedInVerden)
        .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
        .sort((a, b) => (getBaseVerdenVolume(b) - getBaseVerdenVolume(a)));

      const { Workbook } = await import("exceljs");
      const wb = new Workbook();
      wb.creator = "Rezeptlogik Verden";
      wb.created = new Date();

      // ── ARGB-Farben ──────────────────────────────────────────────────────
      const C = {
        darkSlate:  "FF1e293b", lightSlate: "FF334155", white: "FFFFFFFF",
        sub1Bg:     "FF4f46e5", sub1Text:   "FFFFFFFF",   // indigo
        sub2Bg:     "FFede9fe", sub2Text:   "FF3730a3",   // violet-100 / 800
        sub3Bg:     "FFfae8ff", sub3Text:   "FF86198f",   // fuchsia-100 / 800
        sub4Bg:     "FFffe4e6", sub4Text:   "FF9f1239",   // rose-100 / 800
        ingBg:      "FFf8fafc", ingText:    "FF64748b",   // slate-50 / 500
        amberBg:    "FFfef3c7", amberText:  "FF92400e", amberAccent: "FFd97706",
        greenBg:    "FFdcfce7", greenText:  "FF14532d",
        sectionBg:  "FFf1f5f9", sectionText: "FF0f172a",
        border:     "FFcbd5e1",
      };
      type ArgbColor = { argb: string };
      type SolidFill  = { type: "pattern"; pattern: "solid"; fgColor: ArgbColor };
      const fill  = (argb: string): SolidFill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
      const font  = (argb: string, bold = false, size = 9) => ({ name: "Calibri", size, bold, color: { argb } });
      const brd   = (argb = C.border) => ({ top:{style:"thin" as const,color:{argb}}, bottom:{style:"thin" as const,color:{argb}}, left:{style:"thin" as const,color:{argb}}, right:{style:"thin" as const,color:{argb}} });

      const mColors: Record<Market,string> = { BENL:"FF1d4ed8", DKSE:"FF0284c7", DE:"FF16a34a" };
      const depthStyles = [
        { bg: C.sub1Bg, text: C.sub1Text, bold: true,  h: 24 },
        { bg: C.sub2Bg, text: C.sub2Text, bold: true,  h: 20 },
        { bg: C.sub3Bg, text: C.sub3Text, bold: false, h: 18 },
        { bg: C.sub4Bg, text: C.sub4Text, bold: false, h: 18 },
      ];
      const mEmoji: Record<Market,string> = { BENL:"🇧🇪 BENL", DKSE:"🇩🇰 DKSE", DE:"🇩🇪 DE" };

      // ── SHEET 1: KW-Übersicht (alle Rezepte) ────────────────────────────
      const ws1 = wb.addWorksheet("📋 Übersicht", { views: [{ showGridLines: false }] });
      ws1.columns = [{ width:12 },{ width:36 },{ width:14 },{ width:14 },{ width:14 },{ width:14 },{ width:14 }];

      ws1.mergeCells("A1:G1");
      const title = ws1.getCell("A1");
      title.value = `Rezeptlogik Verden · ${week}`;
      title.font  = { name:"Calibri", size:20, bold:true, color:{argb:C.white} };
      title.fill  = fill(C.darkSlate);
      title.alignment = { vertical:"middle", horizontal:"left", indent:2 };
      ws1.getRow(1).height = 38;

      ws1.mergeCells("A2:G2");
      const sub2 = ws1.getCell("A2");
      sub2.value = `${allWrOfWeek.length} produzierte Rezepte · Export ${new Date().toLocaleDateString("de-DE")}`;
      sub2.font  = { name:"Calibri", size:10, italic:true, color:{argb:"FF94a3b8"} };
      sub2.fill  = fill(C.darkSlate);
      sub2.alignment = { vertical:"middle", horizontal:"left", indent:2 };
      ws1.getRow(2).height = 20;

      ws1.addRow([]).height = 6;

      const ovColHdr = ws1.addRow(["Code","Rezeptname","BENL Port.","DKSE Port.","DE Port.","Σ Verden","Preference"]);
      ovColHdr.height = 18;
      ovColHdr.eachCell((cell, col) => {
        if (col > 7) return;
        cell.font  = font(C.white, true);
        cell.fill  = fill(C.lightSlate);
        cell.border= brd();
        cell.alignment = { horizontal: col <= 2 ? "left" : "center", indent: col <= 2 ? 1 : 0, vertical:"middle" };
      });

      allWrOfWeek.forEach(r => {
        const totalV = r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE;
        const row = ws1.addRow([r.code, r.recipeName, r.verdenVolume.BENL, r.verdenVolume.DKSE, r.verdenVolume.DE, totalV, r.preference]);
        row.height = 17;
        row.getCell(1).font = font("FF1e293b", true);
        row.getCell(1).alignment = { indent:1 };
        row.getCell(2).alignment = { indent:1 };
        [1,2,3,4,5,6,7].forEach(c => {
          row.getCell(c).border = brd();
          if (c > 2) row.getCell(c).alignment = { horizontal:"center", vertical:"middle" };
        });
      });

      // Gesamt-Zeile
      const grandBENL = allWrOfWeek.reduce((s,r) => s + r.verdenVolume.BENL, 0);
      const grandDKSE = allWrOfWeek.reduce((s,r) => s + r.verdenVolume.DKSE, 0);
      const grandDE   = allWrOfWeek.reduce((s,r) => s + r.verdenVolume.DE, 0);
      const grandTot  = grandBENL + grandDKSE + grandDE;
      const totRow = ws1.addRow(["GESAMT", "", grandBENL, grandDKSE, grandDE, grandTot, ""]);
      totRow.height = 19;
      totRow.eachCell((cell, col) => {
        if (col > 7) return;
        cell.font  = font(C.sectionText, true);
        cell.fill  = fill(C.sectionBg);
        cell.border= brd(C.amberAccent);
        if (col > 2) cell.alignment = { horizontal:"center", vertical:"middle" };
        else cell.alignment = { indent:1, vertical:"middle" };
      });

      // ── SHEETS: Pro Rezept × Markt ───────────────────────────────────────
      for (const wrEntry of allWrOfWeek) {
        const recipe = data.recipes[wrEntry.code];
        const structEntry = resolveStructureByCode(data.structures, wrEntry.code, recipe?.code);
        if (!structEntry) continue;

        const entryMarkets = (["BENL","DE","DKSE"] as Market[]).filter(m => structEntry.markets[m]?.length);

        for (const m of entryMarkets) {
          const subs = structEntry.markets[m] ?? [];
          if (!subs.length) continue;
          const mPorts = adjustedPortions(wrEntry.verdenVolume[m], upliftPercent);

          // Sheet-Name: max 31 Zeichen, eindeutig
          const shortCode = wrEntry.code.replace(/^FV/, "");
          const sheetName = `${shortCode} ${mEmoji[m]}`.substring(0, 31);

          const ws = wb.addWorksheet(sheetName, {
            views: [{ state:"frozen", ySplit:2, showGridLines:false }],
          });
          ws.columns = [
            { width:12 }, { width:8 }, { width:46 }, { width:26 },
            { width:14 }, { width:10 }, { width:16 }, { width:10 }, { width:80 },
          ];

          ws.mergeCells("A1:I1");
          const mTitle = ws.getCell("A1");
          mTitle.value = `${structEntry.name}  ·  ${MARKET_LABEL_FULL[m]}  ·  ${week}  ·  ${mPorts} Portionen`;
          mTitle.font  = { name:"Calibri", size:13, bold:true, color:{argb:C.white} };
          mTitle.fill  = fill(mColors[m]);
          mTitle.alignment = { vertical:"middle", horizontal:"left", indent:2 };
          ws.getRow(1).height = 28;

          const hdr = ws.addRow([
            "Kochschritt","Ebene","Name des Sub-Rezepts","Kategorie / Methode",
            "Menge/Port.","Einheit",`KG gesamt\n(${mPorts} Port.)`,
            "Zutaten ∑","Zutaten-Detail  (Brutto/Portion → Gesamtmenge Verden)"
          ]);
          hdr.height = 32;
          hdr.eachCell((cell, col) => {
            cell.font  = font(col===7 ? C.amberAccent : C.white, true, 9);
            cell.fill  = fill(C.darkSlate);
            cell.border= brd("FF475569");
            cell.alignment = { vertical:"middle", horizontal:"left", indent:1, wrapText:true };
          });

          function addRow(node: DetailedSubRecipe, depth: number, step: string) {
            const st = depthStyles[Math.min(depth, depthStyles.length-1)];
            const qpp = node.quantity ?? null;
            let kg = "";
            if (qpp != null) {
              const ul = (node.uom??"").toLowerCase();
              const isG = ["grams","g","ml","gram"].includes(ul);
              const raw = qpp * mPorts;
              kg = isG ? `${(raw/1000).toFixed(2)} kg` : `${raw.toFixed(0)} ${node.uom??""}`;
            }
            const ingDetail = node.ingredients.map(i => {
              const ul = (i.uom??"").toLowerCase();
              const isG = ["grams","g","ml","gram"].includes(ul);
              const tot = i.grossQty * mPorts;
              const ts  = isG ? `${(tot/1000).toFixed(2)} kg` : `${tot.toFixed(0)} ${i.uom}`;
              return `${fmtIngName(i.name)}: ${i.grossQty} ${i.uom}/Port → ${ts}`;
            }).join("   |   ");

            const r = ws.addRow([
              step, `SUB${depth+1}`, node.name, node.categories??"",
              qpp ?? "", node.uom??"", kg,
              node.ingredients.length || "", ingDetail
            ]);
            r.height = st.h;
            r.eachCell((cell, col) => {
              cell.fill   = fill(st.bg);
              cell.font   = font(st.text, st.bold, 9);
              cell.border = brd();
              cell.alignment = { vertical:"middle", wrapText: col===9 };
              if (col===3) cell.alignment = { ...cell.alignment, indent: depth*2 };
              if (col===5||col===7) cell.alignment = { ...cell.alignment, horizontal:"right" };
            });
            if (kg) {
              const kgCell = r.getCell(7);
              kgCell.fill = fill(depth===0 ? C.amberBg : "FFFffbeb");
              kgCell.font = font(C.amberText, true, 9);
            }
            node.subRecipes.forEach((child, ci) => addRow(child, depth+1, `${step}.${ci+1}`));
          }

          subs.forEach((s, si) => addRow(s, 0, String(si+1)));
        }
      }

      // Download
      const buf  = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${week}_Alle_Rezepte_Rezeptbaum.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setXlsxLoading(false);
    }
  }

  // ── Vollständiger GSheet-Export (alle Märkte, alle Ebenen, Mengen, KG) ──
  function exportFullGSheet() {
    if (!structure) return;

    const rows: string[][] = [];

    // ── Block 1: Rezept-Kopfzeilen ─────────────────────────────────
    rows.push(["=== REZEPT-ÜBERSICHT ===", "", "", "", "", "", "", "", "", "", ""]);
    rows.push(["Feld", "Wert", "", "", "", "", "", "", "", "", ""]);
    rows.push(["KW",              week,                     "", "", "", "", "", "", "", "", ""]);
    rows.push(["Code",            code,                     "", "", "", "", "", "", "", "", ""]);
    rows.push(["Rezeptname",      structure.name,           "", "", "", "", "", "", "", "", ""]);
    rows.push(["Rezept-ID",       structure.recipeId,       "", "", "", "", "", "", "", "", ""]);
    rows.push(["Portionen gesamt (Verden)", String(portionsTotal), "", "", "", "", "", "", "", "", ""]);
    if (upliftPercent !== 0) rows.push(["Uplift %", `${upliftPercent}%`, "", "", "", "", "", "", "", "", ""]);
    rows.push(["BENL Portionen",  String(wr.verdenVolume.BENL), "", "", "", "", "", "", "", "", ""]);
    rows.push(["DKSE Portionen",  String(wr.verdenVolume.DKSE), "", "", "", "", "", "", "", "", ""]);
    rows.push(["DE Portionen",    String(wr.verdenVolume.DE),   "", "", "", "", "", "", "", "", ""]);
    rows.push(["", "", "", "", "", "", "", "", "", "", ""]);

    // ── Block 2: Sub-Rezepte je Markt ──────────────────────────────
    const exportMarkets = availableMarkets;

    exportMarkets.forEach(m => {
      const subs = structure.markets[m] ?? [];
      if (!subs.length) return;
      const mPortions = wr.verdenVolume[m];

      rows.push([`=== MARKT: ${MARKET_LABEL_FULL[m].toUpperCase()} (${mPortions} Portionen) ===`,
        "", "", "", "", "", "", "", "", "", ""]);
      rows.push([
        "Kochschritt",
        "Sub-Rezept Ebene 1",
        "Sub-Rezept Ebene 2",
        "Sub-Rezept Ebene 3",
        "Sub-Rezept Ebene 4",
        "Kategorie / Methode",
        "Menge/Portion",
        "Einheit",
        "KG gesamt (Verden)",
        "Ebene",
        "Zutaten",
        "Zutaten-Detail (Brutto/Portion → gesamt)",
      ]);

      function walkExport(node: DetailedSubRecipe, path: string[], depth: number, step: string) {
        const paddedPath = [...path, ...Array(4).fill("")].slice(0, 4);
        const qtyPerPortion = node.quantity ?? null;

        // KG gesamt = Menge/Portion × Portionen des Markts (/ 1000 wenn grams/ml)
        let kgTotal = "";
        if (qtyPerPortion != null) {
          const uomLow = (node.uom ?? "").toLowerCase();
          const isGram = uomLow === "grams" || uomLow === "g" || uomLow === "ml" || uomLow === "gram";
          const raw = qtyPerPortion * mPortions;
          kgTotal = isGram
            ? `${(raw / 1000).toFixed(2)} kg`
            : `${raw.toFixed(0)} ${node.uom ?? ""}`;
        }

        // Zutaten: Name + Brutto/Portion → Gesamtmenge
        const ingDetail = node.ingredients.map(i => {
          const uomLow = (i.uom ?? "").toLowerCase();
          const isGram = uomLow === "grams" || uomLow === "g" || uomLow === "ml" || uomLow === "gram";
          const totalRaw = i.grossQty * mPortions;
          const totalStr = isGram
            ? `${(totalRaw / 1000).toFixed(2)} kg`
            : `${totalRaw.toFixed(0)} ${i.uom}`;
          return `${fmtIngName(i.name)}: ${i.grossQty}${i.uom}/Port → ${totalStr}`;
        }).join(" | ");

        rows.push([
          step,
          paddedPath[0],
          paddedPath[1],
          paddedPath[2],
          paddedPath[3],
          node.categories ?? "",
          qtyPerPortion != null ? `${qtyPerPortion} ${node.uom ?? ""}` : "",
          node.uom ?? "",
          kgTotal,
          `SUB${depth + 1}`,
          String(node.ingredients.length),
          ingDetail,
        ]);

        node.subRecipes.forEach((child, ci) => {
          walkExport(child, [...path.slice(0, depth + 1), child.name], depth + 1, `${step}.${ci + 1}`);
        });
      }

      subs.forEach((sub, si) => walkExport(sub, [sub.name], 0, String(si + 1)));
      rows.push(["", "", "", "", "", "", "", "", "", "", ""]);
    });

    const tsv = rows
      .map(r => r.map(c => (c ?? "").replace(/\t/g, " ")).join("\t"))
      .join("\n");

    const blob = new Blob(["\uFEFF" + tsv], { type: "text/tab-separated-values;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${week}_${code}_Vollexport_Rezeptstruktur.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!structure) {
    return (
      <div className="card p-4 text-amber-700">
        Keine Detailed-CSV-Daten für {code} gefunden. Import mit{" "}
        <code className="text-xs bg-amber-100 px-1 rounded">npm run import:local</code> neu ausführen.
      </div>
    );
  }

  const visibleMarkets = activeMarket === "ALL"
    ? availableMarkets
    : availableMarkets.filter(m => m === activeMarket);
  const totalTopSubs = visibleMarkets.reduce((s, m) => s + ((structure.markets[m] ?? []).length), 0);
  const totalIng = visibleMarkets.reduce(
    (s, m) => s + (structure.markets[m] ?? []).reduce((x, n) => x + countIngredients(n), 0),
    0
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{tl(locale, "Rezeptstruktur")}</div>
            <div className="text-lg font-bold text-slate-900">{structure.name}</div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">{code} · {structure.recipeId}</div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {/* View mode */}
            <button onClick={() => setTreeMode("svg")}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ${
                treeMode === "svg" ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white ring-slate-300 hover:bg-slate-50"
              }`}>{locale === "de" ? "⬡ Interaktiver Baum" : locale === "nl" ? "⬡ Interactieve boom" : "⬡ Interactive tree"}</button>
            <button onClick={() => setTreeMode("list")}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ${
                treeMode === "list" ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white ring-slate-300 hover:bg-slate-50"
              }`}>{locale === "de" ? "☰ Liste" : locale === "nl" ? "☰ Lijst" : "☰ List"}</button>
            {/* Exports */}
            <div className="h-6 w-px bg-slate-200" />
            <button
              onClick={exportFormattedXLSX}
              disabled={xlsxLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold shadow-sm text-xs transition-colors"
              title={locale === "de" ? "Formatiertes Excel: Farben, Einrückung, KG-Mengen, alle Märkte -> direkt in Google Sheets öffnen" : locale === "nl" ? "Geformatteerde Excel: kleuren, inspringing, kg-hoeveelheden, alle markten -> direct in Google Sheets openen" : "Formatted Excel: colors, indentation, kg quantities, all markets -> open directly in Google Sheets"}
            >
              <span>{xlsxLoading ? "⏳" : "📥"}</span>
              <span>{xlsxLoading ? (locale === "de" ? "Wird erstellt ..." : locale === "nl" ? "Wordt gemaakt ..." : "Creating ...") : (locale === "de" ? "Export XLSX – ganze KW" : locale === "nl" ? "XLSX-export – hele week" : "Export XLSX – full week")}</span>
            </button>
          </div>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-slate-500">
          <span><b className="text-slate-800">{totalTopSubs}</b> {locale === "de" ? "Sub-Rezepte (Top-Ebene)" : locale === "nl" ? "Subrecepten (bovenste niveau)" : "Sub-recipes (top level)"}</span>
          <span><b className="text-slate-800">{totalIng}</b> {locale === "de" ? "Zutaten gesamt" : locale === "nl" ? "Ingrediënten totaal" : "Ingredients total"}</span>
        </div>
      </div>

      {/* Legend (list mode only) */}
      {treeMode === "list" && (
        <div className="card p-3 flex flex-wrap gap-2 text-[10px]">
          {[["SUB1","indigo", locale === "de" ? "Erste Ebene" : locale === "nl" ? "Eerste niveau" : "First level"],["SUB2","violet", locale === "de" ? "Zweite Ebene" : locale === "nl" ? "Tweede niveau" : "Second level"],["SUB3","fuchsia", locale === "de" ? "Dritte Ebene" : locale === "nl" ? "Derde niveau" : "Third level"]].map(([l,c,d])=>(
            <span key={l} className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-${c}-50 text-${c}-700 ring-1 ring-${c}-200`}>
              <b>{l}</b><span className="text-slate-500">{d}</span>
            </span>
          ))}
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 ring-1 ring-slate-200">
            <b>ING</b><span>{locale === "de" ? "Brutto-Zutat" : locale === "nl" ? "Bruto-ingrediënt" : "Gross ingredient"}</span>
          </span>
        </div>
      )}

      {visibleMarkets.length === 0 && (
        <div className="card p-4 text-slate-500">{locale === "de" ? "Keine Struktur für diesen Markt gefunden." : locale === "nl" ? "Geen structuur voor deze markt gevonden." : "No structure found for this market."}</div>
      )}

      {visibleMarkets.map(m => {
        const marketSubs = structure.markets[m] ?? [];
        return (
          <div key={m} className="space-y-2">
            {activeMarket === "ALL" && (
              <div className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {locale === "de" ? "Markt" : locale === "nl" ? "Markt" : "Market"}: {marketVariantLabel(locale, m)}
              </div>
            )}
            {marketSubs.length === 0
              ? <div className="card p-4 text-slate-500">{locale === "de" ? `Keine Struktur für Markt ${marketVariantLabel(locale, m)} gefunden.` : locale === "nl" ? `Geen structuur voor markt ${marketVariantLabel(locale, m)} gevonden.` : `No structure found for market ${marketVariantLabel(locale, m)}.`}</div>
              : treeMode === "svg"
                ? <TreeCanvas roots={marketSubs} code={code} recipeName={recipeName} week={week} market={m} />
                : marketSubs.map((sub, i) => <SubRecipeNode key={`${m}-${sub.id || i}`} node={sub} depth={0} />)
            }
          </div>
        );
      })}
    </div>
  );
}

// ========== Sub-Rezepte-Tab ================================================

function SubRecipesTab({ recipeCode, md, cookSchedules, detailSearch }:
  { recipeCode: string; md: NonNullable<Recipe["markets"][Market]>; cookSchedules: Record<string, CookSchedule>; detailSearch: string }) {
  const needle = detailSearch.trim().toLowerCase();

  // Nach Dringlichkeit sortieren (kritischste zuerst)
  const urgencyOrder: Record<SubRecipeUrgency, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const items = md.subRecipes
    .filter(s => matchesNeedle([s.id, s.name, s.category, s.instructions, s.methodColor, s.methodType], needle))
    .slice()
    .sort((a, b) => {
      const csA = resolveCookSchedule(a.category, cookSchedules).schedule;
      const csB = resolveCookSchedule(b.category, cookSchedules).schedule;
      return urgencyOrder[subRecipeUrgency(csA?.cookShifts)] - urgencyOrder[subRecipeUrgency(csB?.cookShifts)];
    });

  return (
    <div className="space-y-3">
      {items.map((s, idx) => {
        const resolved = resolveCookSchedule(s.category, cookSchedules);
        const cs = resolved.schedule;
        const tone = subRecipeTone(recipeCode, cs?.cookShifts);
        const urgencyLabel = subRecipeUrgencyLabel(cs?.cookShifts);
        const isNext = idx === 0;
        const stepNum = idx + 1;
        const totalSteps = items.length;

        // Farbe für Method-Color
        const colorCSS = methodColorToCSS(s.methodColor);
        const colorPanelStyle: CSSProperties = colorCSS
          ? { backgroundColor: colorCSS + "33", borderColor: colorCSS + "88" }
          : tone.panel;
        const colorTextStyle: CSSProperties = colorCSS
          ? { color: colorCSS.replace(/#([0-9a-f]{6})/i, (_, h) => {
              const r = parseInt(h.slice(0,2),16)*0.4, g = parseInt(h.slice(2,4),16)*0.4, b = parseInt(h.slice(4,6),16)*0.4;
              return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
            })}
          : { color: "#334155" };

        return (
          <div key={s.id} className="overflow-hidden rounded-2xl border shadow-sm" style={tone.frame}>
            <div className="px-4 py-3" style={tone.header}>
              <div className="flex flex-wrap items-center gap-2">
                {/* Schritt-Nummer */}
                <span
                  className="flex items-center justify-center rounded-full text-xs font-bold w-6 h-6 shrink-0 shadow-sm"
                  style={{ backgroundColor: isNext ? "#1e293b" : "#64748b", color: "#fff" }}
                  title={`Schritt ${stepNum} von ${totalSteps}`}
                >
                  {stepNum}
                </span>
                {isNext && (
                  <span className="pill bg-slate-800 text-white text-[10px] font-semibold px-2 py-0.5">
                    → Als Nächstes
                  </span>
                )}
                <span className="font-mono text-xs text-slate-500">{s.id}</span>
                <h4 className="font-semibold" style={tone.headerText}>{s.name}</h4>
                {s.category && <span className="pill" style={tone.badge}>{s.category}</span>}
                {cs && <span className="pill" style={tone.urgency}>VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>}
                {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
                  <span className="pill bg-blue-100 text-blue-800">VF-Match via {resolved.matchedMethod}</span>
                )}
                <span className="pill" style={tone.urgency}>Dringlichkeit: {urgencyLabel}</span>
                {!cs && s.category && <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule</span>}
              </div>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="grid gap-2 md:grid-cols-2 text-xs">
                <div className="rounded-xl px-3 py-2 ring-1" style={tone.panel}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Typ</div>
                  <div className="mt-1 font-medium text-slate-700">{s.methodType || "-"}</div>
                </div>
                <div className="rounded-xl px-3 py-2 ring-1" style={colorPanelStyle}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Color</div>
                  <div className="mt-1 flex items-center gap-2 font-semibold" style={colorTextStyle}>
                    {colorCSS && (
                      <span
                        className="inline-block h-4 w-4 shrink-0 rounded-full border border-white shadow"
                        style={{ backgroundColor: colorCSS }}
                      />
                    )}
                    {s.methodColor || "-"}
                  </div>
                </div>
              </div>
              {s.instructions && (
                <div className="rounded-xl px-3 py-3 text-sm leading-relaxed text-slate-700 ring-1" style={tone.panel}>
                  {s.instructions}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {items.length === 0 && <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>}
    </div>
  );
}

const INGREDIENT_SECTION_TONES = [
  {
    frame: "border-orange-200",
    header: "bg-orange-50",
    headerText: "text-orange-900",
    badge: "bg-white text-orange-800 ring-1 ring-orange-200"
  },
  {
    frame: "border-sky-200",
    header: "bg-sky-50",
    headerText: "text-sky-900",
    badge: "bg-white text-sky-800 ring-1 ring-sky-200"
  },
  {
    frame: "border-emerald-200",
    header: "bg-emerald-50",
    headerText: "text-emerald-900",
    badge: "bg-white text-emerald-800 ring-1 ring-emerald-200"
  },
  {
    frame: "border-amber-200",
    header: "bg-amber-50",
    headerText: "text-amber-900",
    badge: "bg-white text-amber-800 ring-1 ring-amber-200"
  }
] as const;
const INGREDIENT_COLLAPSE_STORAGE_PREFIX = "rezeptlogik-ingredient-collapse-v1";

function ingredientSectionTone(index: number) {
  return INGREDIENT_SECTION_TONES[index % INGREDIENT_SECTION_TONES.length];
}

function formatUnitTotal(value: number, uom: string, portions = 1): string {
  return scaleQty(value, portions, uom);
}

function categoryRiskTone(status: ShelfLifeInfo["status"] | "unknown") {
  if (status === "critical") return "bg-rose-50 text-rose-800 ring-1 ring-rose-200";
  if (status === "risk") return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  if (status === "ok") return "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200";
  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

function loadCollapsedIngredientSections(storageKey: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function IngredientsTab({ recipe, market, portionsTotal, wr, shelfLifeBySku, generatedAt, detailSearch }:
  { recipe: Recipe; market: Market; portionsTotal: number; wr: WeekRecipe; shelfLifeBySku: Record<string, ShelfLifeInfo>; generatedAt: string; detailSearch: string }) {
  // Brutto-Zutaten kommen aus dem Gross-Ingredients-CSV des jeweiligen Markts.
  const list = recipe.grossIngredients[market] ?? [];

  // Aggregieren über (ingredientId, sub-recipe1) — selbe Zutat in mehreren Sub-Rezepten als getrennte Zeilen lassen.
  const grouped = useMemo(() => {
    const m = new Map<string, { sub: string; ingredient: string; ingredientId: string;
      uom: string; perPortion: number; cat?: string }>();
    for (const g of list) {
      const sub = g.subRecipe1 || g.subRecipe2 || g.subRecipe3 || "—";
      const k = `${sub}::${g.ingredientId}::${g.uom}`;
      const cur = m.get(k);
      if (cur) cur.perPortion += g.grossQuantityPerPortion;
      else m.set(k, {
        sub, ingredient: g.ingredient, ingredientId: g.ingredientId,
        uom: g.uom, perPortion: g.grossQuantityPerPortion, cat: g.ingredientCategory
      });
    }
    return [...m.values()].map(row => {
      const shelfLife = shelfLifeBySku[row.ingredientId];
      const suggested = shelfLife ? undefined : findShelfLifeNameHint(row.ingredient, shelfLifeBySku);
      return {
        ...row,
        shelfLife,
        suggested,
        matchReason: shelfLife
          ? `exakter SKU-Match: ${row.ingredientId}`
          : !row.ingredientId
            ? "keine Ingredient-ID im Gross-Export"
            : suggested
              ? `kein ID-Match, aber aehnliche Sheet-SKU: ${suggested.skuCode}`
              : `SKU ${row.ingredientId} nicht im Shelf-Life-Sheet`
      };
    }).sort((a, b) => (a.sub === b.sub ? b.perPortion - a.perPortion : a.sub.localeCompare(b.sub)));
  }, [list, shelfLifeBySku]);

  const needle = detailSearch.trim().toLowerCase();
  const filteredGrouped = useMemo(() => grouped.filter(g => matchesNeedle([
    g.sub, g.ingredient, g.ingredientId, g.cat, g.shelfLife?.skuCode, g.shelfLife?.skuName, g.matchReason, g.suggested?.skuCode, g.suggested?.skuName
  ], needle)), [grouped, needle]);

  const groupedSections = useMemo(() => {
    const sections = new Map<string, typeof filteredGrouped>();
    for (const row of filteredGrouped) {
      const bucket = sections.get(row.sub) ?? [];
      bucket.push(row);
      sections.set(row.sub, bucket);
    }
    return [...sections.entries()]
      .map(([sub, rows]) => ({
        sub,
        rows,
        totalPerPortion: rows.reduce((sum, row) => sum + row.perPortion, 0),
        categoryTotals: [...rows.reduce((acc, row) => {
          const key = row.cat?.trim() || "ohne Kategorie";
          const bucket = acc.get(key) ?? new Map<string, number>();
          bucket.set(row.uom, (bucket.get(row.uom) ?? 0) + row.perPortion);
          acc.set(key, bucket);
          return acc;
        }, new Map<string, Map<string, number>>()).entries()]
          .map(([category, totals]) => {
            const rowsInCategory = rows.filter(row => (row.cat?.trim() || "ohne Kategorie") === category);
            const riskStatus: ShelfLifeInfo["status"] | "unknown" = rowsInCategory.some(row => row.shelfLife?.status === "critical")
              ? "critical"
              : rowsInCategory.some(row => row.shelfLife?.status === "risk")
                ? "risk"
                : rowsInCategory.some(row => row.shelfLife?.status === "ok")
                  ? "ok"
                  : "unknown";
            return {
            category,
            riskStatus,
            totals: [...totals.entries()].map(([uom, total]) => ({ uom, total }))
          }})
          .sort((a, b) => a.category.localeCompare(b.category)),
        unitTotals: [...rows.reduce((acc, row) => {
          acc.set(row.uom, (acc.get(row.uom) ?? 0) + row.perPortion);
          return acc;
        }, new Map<string, number>()).entries()]
          .map(([uom, total]) => ({ uom, total }))
          .sort((a, b) => a.uom.localeCompare(b.uom))
      }))
      .sort((a, b) => a.sub.localeCompare(b.sub));
  }, [filteredGrouped]);

  const shelfSummary = useMemo(() => {
    const known = filteredGrouped.filter(g => !!g.shelfLife);
    return {
      known: known.length,
      critical: known.filter(g => g.shelfLife?.status === "critical").length,
      risk: known.filter(g => g.shelfLife?.status === "risk").length
    };
  }, [filteredGrouped]);

  const collapseStorageKey = useMemo(() => `${INGREDIENT_COLLAPSE_STORAGE_PREFIX}:${wr.code}:${market}`, [wr.code, market]);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => loadCollapsedIngredientSections(collapseStorageKey));

  useEffect(() => {
    setCollapsedSections(loadCollapsedIngredientSections(collapseStorageKey));
  }, [collapseStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(collapseStorageKey, JSON.stringify(collapsedSections));
  }, [collapseStorageKey, collapsedSections]);

  const allCollapsed = groupedSections.length > 0 && groupedSections.every(section => collapsedSections[section.sub]);

  function toggleSection(sub: string) {
    setCollapsedSections(prev => ({ ...prev, [sub]: !prev[sub] }));
  }

  function setAllSections(collapsed: boolean) {
    setCollapsedSections(Object.fromEntries(groupedSections.map(section => [section.sub, collapsed])));
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700">
          Brutto-Zutaten ({MARKET_LABEL[market]}) — hochgerechnet auf <b>{fmtNum(portionsTotal)}</b> Portionen Verden gesamt
        </h3>
        <div className="text-right">
          <div className="text-xs text-slate-500">{list.length} Zeilen aus Gross-Export</div>
          <div className="text-[11px] text-slate-400">Datenstand: {new Date(generatedAt).toLocaleString("de-DE")}</div>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Stat label="Sheet-Matches" value={fmtNum(shelfSummary.known)} />
        <Stat label="kritisch < 7d" value={fmtNum(shelfSummary.critical)} accent={shelfSummary.critical > 0} />
        <Stat label="knapp" value={fmtNum(shelfSummary.risk)} accent={shelfSummary.risk > 0} />
        <Stat label="Kundenziel" value="7 Tage" />
      </div>
      {groupedSections.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
          <div className="text-xs text-slate-500">
            {fmtNum(groupedSections.length)} Sub-Rezept-Blöcke sichtbar. Jeder Block kann separat ein- oder ausgeklappt werden.
          </div>
          <button className="btn" onClick={() => setAllSections(!allCollapsed)}>
            {allCollapsed ? "Alle aufklappen" : "Alle einklappen"}
          </button>
        </div>
      )}
      {list.length === 0 && <div className="text-slate-500 text-sm">Keine Brutto-Daten für {MARKET_LABEL[market]}.</div>}
      {list.length > 0 && (
        <div className="space-y-4">
          {groupedSections.map((section, index) => {
            const tone = ingredientSectionTone(index);
            const isCollapsed = !!collapsedSections[section.sub];
            return (
              <div key={section.sub} className={`rounded-2xl border bg-white shadow-sm overflow-hidden ${tone.frame}`}>
                <button
                  className={`flex w-full flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-left ${tone.header} ${tone.frame}`}
                  onClick={() => toggleSection(section.sub)}
                >
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Sub-Rezept</div>
                    <h4 className={`text-base font-semibold ${tone.headerText}`}>{section.sub}</h4>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                    <span className={tone.badge}>{fmtNum(section.rows.length)} Zutaten</span>
                    {section.unitTotals.map(total => (
                      <span key={`${section.sub}-${total.uom}`} className={tone.badge}>
                        Σ {formatUnitTotal(total.total, total.uom)} / Portion
                      </span>
                    ))}
                    <span className={`rounded-full px-2.5 py-1 font-semibold uppercase tracking-wide ${isCollapsed ? "bg-slate-200 text-slate-600" : "bg-slate-800 text-white"}`}>
                      {isCollapsed ? "zu" : "offen"}
                    </span>
                  </div>
                </button>
                {!isCollapsed && (
                  <>
                    <div className="border-b border-slate-100 bg-white px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Kategorien im Block</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {section.categoryTotals.map(category => (
                          <span key={`${section.sub}-${category.category}`} className={categoryRiskTone(category.riskStatus)}>
                            {category.category}: {category.totals.map(total => formatUnitTotal(total.total, total.uom)).join(" · ")}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs uppercase tracking-wide text-slate-500 bg-white">
                          <tr className="border-b border-slate-100">
                            <th className="text-left py-2 pr-2 pl-4">Zutat</th>
                            <th className="text-left py-2 pr-2">Cat</th>
                            <th className="text-right py-2 pr-2">/ Portion</th>
                            <th className="text-right py-2 pr-2">Σ {fmtNum(portionsTotal)} Portionen</th>
                            <th className="text-left py-2 pr-4 pl-2">Shelf / MLOR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {section.rows.map((g, i) => (
                            <tr key={`${section.sub}-${g.ingredientId}-${i}`} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/80">
                              <td className="py-2 pr-2 pl-4">
                                <div className="font-medium text-slate-800">{g.ingredient}</div>
                                <div className="font-mono text-[10px] text-slate-400">{g.ingredientId || "ohne SKU"}</div>
                              </td>
                              <td className="py-2 pr-2"><span className="pill bg-slate-100 text-slate-700">{g.cat ?? "-"}</span></td>
                              <td className="py-2 pr-2 text-right tabular-nums">{fmtNum(g.perPortion, 2)} {g.uom}</td>
                              <td className="py-2 pr-2 text-right tabular-nums font-semibold">{scaleQty(g.perPortion, portionsTotal, g.uom)}</td>
                              <td className="py-2 pl-2 pr-4 text-xs">
                                {g.shelfLife ? (
                                  <div className="space-y-1">
                                    <span className={`pill ${shelfLifeTone(g.shelfLife.status)}`}>{g.shelfLife.status === "critical" ? "kritisch" : g.shelfLife.status === "risk" ? "knapp" : g.shelfLife.status === "ok" ? "ok" : "unbekannt"}</span>
                                    <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                                    <div className="text-slate-600">MLOR: {g.shelfLife.mlorRaw ?? "-"}</div>
                                    <div className="text-slate-600">Open: {g.shelfLife.openShelfLifeRaw ?? "-"}</div>
                                    <div className="text-slate-500">Kunde braucht 7 Tage Rest.</div>
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <span className="text-slate-400">kein Sheet-Match</span>
                                    <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                                    {g.suggested && <div className="text-[10px] text-blue-700">Namenshinweis: {g.suggested.skuCode} · {g.suggested.skuName}</div>}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className={`flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs ${tone.header} ${tone.frame}`}>
                      <div className="font-semibold text-slate-600">Summen für {section.sub}</div>
                      <div className="flex flex-wrap gap-2">
                        {section.unitTotals.map(total => (
                          <span key={`${section.sub}-footer-${total.uom}`} className={tone.badge}>
                            {total.uom}: {formatUnitTotal(total.total, total.uom)} / Portion · {formatUnitTotal(total.total, total.uom, portionsTotal)} gesamt
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {list.length > 0 && filteredGrouped.length === 0 && <div className="mt-3 text-sm text-slate-500">Keine Zutaten-Treffer für diese Suche.</div>}
    </div>
  );
}

// ========== Engpass-Analyse ================================================

interface EngpassRow {
  sub: string;
  subCategory: string;
  ingredient: string;
  ingredientId: string;
  uom: string;
  perPortion: number; // base input per portion (gross)
  perPortionWithYield: number; // adjusted for process losses
  yieldLossPct: number;
  totalNeeded: number;
  totalNeededWithYield: number;
  available: number | null; // user input in same UOM (base: kg→g or L→ml converted)
  availableDisplay: number | null; // as entered (kg or L)
  displayUom: string;
  convFactor: number; // multiply entered value to get "base uom" amount
  maxPortions: number | null;
  shortfall: number | null;
  status: "ok" | "warn" | "critical" | "unknown";
}

function engpassStatus(maxPortions: number | null, needed: number): EngpassRow["status"] {
  if (maxPortions === null) return "unknown";
  if (maxPortions >= needed) return "ok";
  if (maxPortions >= needed * 0.8) return "warn";
  return "critical";
}

function engpassStatusLabel(s: EngpassRow["status"]): string {
  if (s === "ok") return "✓ Ausreichend";
  if (s === "warn") return "⚠ Knapp";
  if (s === "critical") return "✗ Engpass";
  return "— offen";
}

function engpassStatusColor(s: EngpassRow["status"]): string {
  if (s === "ok") return "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200";
  if (s === "warn") return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  if (s === "critical") return "bg-rose-50 text-rose-800 ring-1 ring-rose-200";
  return "bg-slate-100 text-slate-500 ring-1 ring-slate-200";
}

function engpassScenarioText(row: EngpassRow, needed: number): string {
  if (row.available === null || row.availableDisplay == null || row.maxPortions == null) {
    return "Trage hier ein, wie viel wirklich da ist. Dann zeigt das Tool sofort, bis wie viele Portionen die Menge reicht.";
  }

  const available = `${fmtNum(row.availableDisplay, 2)} ${row.displayUom}`;
  const portions = fmtNum(row.maxPortions);

  if (row.maxPortions <= 0) {
    return `Mit ${available} reicht es aktuell fuer keine Portion.`;
  }

  if (row.maxPortions >= needed) {
    return `Mit ${available} kommen wir bis ${portions} Portionen. Der Plan ist damit abgedeckt.`;
  }

  if ((row.shortfall ?? 0) > 0) {
    return `Mit ${available} kommen wir bis ${portions} Portionen. Fuer den Plan fehlen ${fmtNum((row.shortfall ?? 0) / row.convFactor, 2)} ${row.displayUom}.`;
  }

  return `Mit ${available} kommen wir bis ${portions} Portionen.`;
}

function EngpassTab({ recipe, market, portionsTotal, wr, md }:
  { recipe: Recipe; market: Market; portionsTotal: number; wr: WeekRecipe; md?: Recipe["markets"][Market] }) {
  const locale = marketToLocale(market);

  const list = recipe.grossIngredients[market] ?? [];

  const [yieldEnabled, setYieldEnabled] = usePersistent<boolean>("engpass_yield_enabled", true);
  const [yieldLossByProcess, setYieldLossByProcess] = usePersistent<Record<string, number>>(
    "engpass_yield_loss_v1",
    {
      "Grill": 8,
      "Oven": 6,
      "Braiser": 10,
      "Blast Chiller": 2,
      "Drain": 3,
      "Hand Mix": 2
    }
  );

  const subCategoryByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of md?.subRecipes ?? []) {
      const k = s.name.trim().toLowerCase();
      if (!k) continue;
      if (!m.has(k)) m.set(k, s.category ?? "");
    }
    return m;
  }, [md?.subRecipes]);

  function calcYieldLossPct(subCategory: string): number {
    if (!yieldEnabled || !subCategory) return 0;
    const low = subCategory.toLowerCase();
    const matched = Object.entries(yieldLossByProcess)
      .filter(([name, pct]) => Number.isFinite(pct) && pct > 0 && low.includes(name.toLowerCase()))
      .map(([, pct]) => Math.max(0, Math.min(40, pct)));
    if (!matched.length) return 0;
    const factor = matched.reduce((acc, pct) => acc * (1 - pct / 100), 1);
    return Math.max(0, Math.min(90, (1 - factor) * 100));
  }

  // Aggregate same as IngredientsTab
  const baseRows = useMemo(() => {
    const m = new Map<string, { sub: string; subCategory: string; ingredient: string; ingredientId: string; uom: string; perPortion: number }>();
    for (const g of list) {
      const sub = g.subRecipe1 || g.subRecipe2 || g.subRecipe3 || "—";
      const subCategory = subCategoryByName.get(sub.trim().toLowerCase()) ?? "";
      const k = `${sub}::${g.ingredientId}::${g.uom}`;
      const cur = m.get(k);
      if (cur) cur.perPortion += g.grossQuantityPerPortion;
      else m.set(k, { sub, subCategory, ingredient: g.ingredient, ingredientId: g.ingredientId, uom: g.uom, perPortion: g.grossQuantityPerPortion });
    }
    return [...m.values()].sort((a, b) => a.sub === b.sub ? b.perPortion - a.perPortion : a.sub.localeCompare(b.sub));
  }, [list, subCategoryByName]);

  // Storage key per recipe+market
  const storageKey = `rezeptlogik_v1_engpass_${wr.code}_${market}`;

  const [availableMap, setAvailableMap] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; }
  });
  const [engpassSort, setEngpassSort] = useState<"default"|"status"|"shortfall"|"name">("default");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(availableMap)); } catch { /* quota */ }
  }, [availableMap, storageKey]);

  function setAvailable(key: string, val: string) {
    setAvailableMap(prev => ({ ...prev, [key]: val }));
  }

  // Determine display UOM: if uom is grams/g → show kg; if ml → show L; else show as-is
  function displayUom(uom: string): { displayUom: string; convFactor: number } {
    const u = uom.toLowerCase();
    if (u === "grams" || u === "g") return { displayUom: "kg", convFactor: 1000 };
    if (u === "ml") return { displayUom: "L", convFactor: 1000 };
    return { displayUom: uom, convFactor: 1 };
  }

  const rows: EngpassRow[] = useMemo(() => {
    const base = baseRows.map(r => {
      const key = `${r.sub}::${r.ingredientId}::${r.uom}`;
      const { displayUom: du, convFactor } = displayUom(r.uom);
      const totalNeeded = r.perPortion * portionsTotal;
      const yieldLossPct = calcYieldLossPct(r.subCategory);
      const yieldFactor = Math.max(0.1, 1 - (yieldLossPct / 100));
      const perPortionWithYield = r.perPortion / yieldFactor;
      const totalNeededWithYield = totalNeeded / yieldFactor;
      const rawInput = availableMap[key];
      const availableDisplay = rawInput !== undefined && rawInput !== "" ? parseFloat(rawInput) : null;
      const available = availableDisplay !== null && !isNaN(availableDisplay) ? availableDisplay * convFactor : null;
      const maxPortions = available !== null && perPortionWithYield > 0 ? Math.floor(available / perPortionWithYield) : null;
      const shortfall = available !== null ? Math.max(0, totalNeededWithYield - available) : null;
      return {
        ...r,
        perPortionWithYield,
        yieldLossPct,
        totalNeeded,
        totalNeededWithYield,
        available,
        availableDisplay,
        displayUom: du,
        convFactor,
        maxPortions,
        shortfall,
        status: engpassStatus(maxPortions, portionsTotal),
      } as EngpassRow;
    });
    const statusOrder = { critical: 0, warn: 1, ok: 2, unknown: 3 };
    if (engpassSort === "status") return [...base].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
    if (engpassSort === "shortfall") return [...base].sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1));
    if (engpassSort === "name") return [...base].sort((a, b) => a.ingredient.localeCompare(b.ingredient, "de"));
    return base;
  }, [baseRows, portionsTotal, availableMap, engpassSort, yieldEnabled, yieldLossByProcess]);

  const configured = rows.filter(r => r.available !== null);
  const bottleneck = configured.length > 0
    ? configured.reduce((min, r) => (r.maxPortions ?? Infinity) < (min.maxPortions ?? Infinity) ? r : min)
    : null;
  const criticalRows = rows.filter(r => r.status === "critical");
  const warnRows    = rows.filter(r => r.status === "warn");

  const effectivePortions = bottleneck?.maxPortions ?? portionsTotal;
  const portionScale = portionsTotal > 0 ? effectivePortions / portionsTotal : 1;

  function clearAll() { setAvailableMap({}); }

  function fillAll() {
    const next: Record<string, string> = { ...availableMap };
    for (const r of rows) {
      const key = `${r.sub}::${r.ingredientId}::${r.uom}`;
      next[key] = String((r.totalNeededWithYield / r.convFactor).toFixed(3));
    }
    setAvailableMap(next);
  }

  function exportToClipboard() {
    const header = ["Zutat", "SKU", "Sub-Rezept", "/ Portion", "Yield-Verlust %", "Einheit", "Σ Bedarf", "Σ Bedarf inkl. Yield", "Verfügbar", "Max. Portionen", "Fehlmenge", "Status"].join("\t");
    const tsv = rows.map(r =>
      [r.ingredient, r.ingredientId, r.sub,
       String(r.perPortion / r.convFactor).replace(".", ","),
       String(r.yieldLossPct.toFixed(1)).replace(".", ","),
       r.displayUom,
       String((r.totalNeeded / r.convFactor).toFixed(3)).replace(".", ","),
       String((r.totalNeededWithYield / r.convFactor).toFixed(3)).replace(".", ","),
       r.availableDisplay !== null ? String(r.availableDisplay.toFixed(3)).replace(".", ",") : "",
       r.maxPortions !== null ? String(r.maxPortions) : "",
       r.shortfall !== null ? String((r.shortfall / r.convFactor).toFixed(3)).replace(".", ",") : "",
       engpassStatusLabel(r.status)
      ].join("\t")
    ).join("\n");
    navigator.clipboard.writeText(header + "\n" + tsv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  if (list.length === 0) {
    return <div className="card p-4 text-slate-500">{locale === "de" ? `Keine Brutto-Zutaten für ${marketVariantLabel(locale, market)} vorhanden.` : locale === "nl" ? `Geen bruto-ingrediënten voor ${marketVariantLabel(locale, market)} beschikbaar.` : `No gross ingredients available for ${marketVariantLabel(locale, market)}.`}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className={`card p-4 ${criticalRows.length > 0 ? "ring-2 ring-rose-300" : warnRows.length > 0 ? "ring-2 ring-amber-300" : "ring-1 ring-slate-200"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{tl(locale, "Engpass-Analyse")}</div>
            <div className="text-lg font-bold text-slate-900 mt-0.5">
              {configured.length === 0
                ? tl(locale, "Verfügbare Mengen eingeben →")
                : criticalRows.length > 0
                  ? (locale === "de" ? `${criticalRows.length} Engpass${criticalRows.length > 1 ? "pässe" : ""} erkannt` : locale === "nl" ? `${criticalRows.length} bottleneck${criticalRows.length > 1 ? "s" : ""} gevonden` : `${criticalRows.length} bottleneck${criticalRows.length > 1 ? "s" : ""} found`)
                  : warnRows.length > 0
                    ? (locale === "de" ? `${warnRows.length} Zutat${warnRows.length > 1 ? "en" : ""} knapp` : locale === "nl" ? `${warnRows.length} ingrediënt${warnRows.length > 1 ? "en" : ""} krap` : `${warnRows.length} ingredient${warnRows.length > 1 ? "s" : ""} tight`)
                    : tl(locale, "Alle eingegebenen Mengen ausreichend ✓")}
            </div>
            <div className="mt-1 text-sm text-slate-600">
              {locale === "de" ? "Geplante Portionen" : locale === "nl" ? "Geplande porties" : "Planned portions"}: <b>{fmtNum(portionsTotal)}</b>
              {bottleneck && bottleneck.status !== "ok" && (
                <> · {locale === "de" ? "Erreichbar mit Engpass" : locale === "nl" ? "Haalbaar met bottleneck" : "Reachable with bottleneck"}: <b className={criticalRows.length > 0 ? "text-rose-700" : "text-amber-700"}>{fmtNum(effectivePortions)}</b>
                <span className="text-slate-400"> ({fmtNum(portionScale * 100, 1)}%)</span></>
              )}
              {yieldEnabled && rows.some(r => r.yieldLossPct > 0) && (
                <> · {locale === "de" ? "Yield-Verlust aktiv bei" : locale === "nl" ? "Yield-verlies actief bij" : "Yield loss active for"} <b>{rows.filter(r => r.yieldLossPct > 0).length}</b> {locale === "de" ? "Zutaten" : locale === "nl" ? "ingrediënten" : "ingredients"}</>
              )}
            </div>
            <div className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
              {locale === "de" ? "Du trägst pro Zutat ein, wie viel wirklich da ist, zum Beispiel 70 kg. Das Tool rechnet dann in Klartext:" : locale === "nl" ? "Je voert per ingrediënt in hoeveel echt beschikbaar is, bijvoorbeeld 70 kg. De tool rekent dan in gewone taal:" : "For each ingredient you enter what is really available, for example 70 kg. The tool then explains it in plain language:"}
              <b> {locale === "de" ? "Mit dieser Menge kommen wir bis X Portionen." : locale === "nl" ? "Met deze hoeveelheid komen we tot X porties." : "With this amount we can reach X portions."}</b>
              {locale === "de" ? "Wenn X kleiner ist als der Plan, siehst du sofort, was fehlt und wo es knapp wird." : locale === "nl" ? "Als X kleiner is dan het plan zie je direct wat ontbreekt en waar het krap wordt." : "If X is smaller than the plan you immediately see what is missing and where it gets tight."}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <div className={`rounded-lg px-3 py-2 ${engpassStatusColor("critical")}`}>
              <div className="font-semibold">{criticalRows.length}</div>
              <div>{tl(locale, "Engpass")}</div>
            </div>
            <div className={`rounded-lg px-3 py-2 ${engpassStatusColor("warn")}`}>
              <div className="font-semibold">{warnRows.length}</div>
              <div>{tl(locale, "Knapp")}</div>
            </div>
            <div className={`rounded-lg px-3 py-2 ${engpassStatusColor("ok")}`}>
              <div className="font-semibold">{configured.filter(r => r.status === "ok").length}</div>
              <div>OK</div>
            </div>
          </div>
        </div>

        {/* Bottleneck callout */}
        {bottleneck && bottleneck.status !== "ok" && (
          <div className={`mt-3 rounded-xl px-4 py-3 ${engpassStatusColor(bottleneck.status)}`}>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{tl(locale, "Kritischster Engpass")}</div>
            <div className="font-bold mt-0.5">{bottleneck.ingredient}</div>
            <div className="text-sm mt-1">
              {locale === "de" ? "Verfügbar" : locale === "nl" ? "Beschikbaar" : "Available"}: <b>{fmtNum(bottleneck.availableDisplay ?? 0, 2)} {bottleneck.displayUom}</b>
              {" · "}{locale === "de" ? "Benötigt" : locale === "nl" ? "Benodigd" : "Needed"}: <b>{fmtNum(bottleneck.totalNeededWithYield / bottleneck.convFactor, 2)} {bottleneck.displayUom}</b>
              {" · "}{locale === "de" ? "Reicht für" : locale === "nl" ? "Voldoende voor" : "Enough for"}: <b>{fmtNum(bottleneck.maxPortions ?? 0)} {locale === "de" ? "Portionen" : locale === "nl" ? "porties" : "portions"}</b>
              {bottleneck.shortfall != null && (
                <> · {tl(locale, "Fehlend")}: <b>{fmtNum(bottleneck.shortfall / bottleneck.convFactor, 2)} {bottleneck.displayUom}</b></>
              )}
            </div>
            {bottleneck.maxPortions != null && bottleneck.maxPortions < portionsTotal && (
              <div className="mt-2 text-sm">
                💡 Grammatur auf <b>{fmtNum(bottleneck.perPortionWithYield * portionScale, 2)} {bottleneck.uom.toLowerCase() === "grams" ? "g" : bottleneck.uom}</b> / Portion skalieren
                → Plan-Volumen auf <b>{fmtNum(effectivePortions)}</b> Portionen reduzieren
                (Faktor <b>{fmtNum(portionScale * 100, 1)}%</b>).
              </div>
            )}
          </div>
        )}
      </div>

      {/* Process yield settings */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={yieldEnabled} onChange={e => setYieldEnabled(e.target.checked)} />
            {tl(locale, "Yield-Verlust nach Kochprozess berücksichtigen")}
          </label>
          <span className="text-xs text-slate-500">{locale === "de" ? "KI-Logik: Sub-Rezept-Kategorie wird gegen Prozessnamen gematcht und Verlust auf den Bedarf aufgeschlagen." : locale === "nl" ? "AI-logica: subrecept-categorie wordt gematcht met procesnamen en verlies wordt op de behoefte gezet." : "AI logic: the sub-recipe category is matched against process names and the loss is added to demand."}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {Object.entries(yieldLossByProcess).map(([process, pct]) => (
            <label key={process} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-2 py-2 text-xs">
              <div className="font-semibold text-slate-700 truncate" title={process}>{process}</div>
              <div className="mt-1 flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={40}
                  step={0.5}
                  value={pct}
                  onChange={e => {
                    const n = Number(e.target.value);
                    setYieldLossByProcess(prev => ({ ...prev, [process]: Number.isFinite(n) ? Math.max(0, Math.min(40, n)) : 0 }));
                  }}
                  className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right"
                />
                <span className="text-slate-500">%</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Per-ingredient table */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-700 flex-1">
            {locale === "de" ? "Zutaten" : locale === "nl" ? "Ingrediënten" : "Ingredients"} — {marketVariantLabel(locale, market)} · {fmtNum(portionsTotal)} {locale === "de" ? "Portionen" : locale === "nl" ? "porties" : "portions"}
          </div>
          <select value={engpassSort} onChange={e => setEngpassSort(e.target.value as typeof engpassSort)}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-xs">
            <option value="default">{tl(locale, "Sortierung: Standard (Sub-Rezept)")}</option>
            <option value="status">{tl(locale, "Sortierung: Status (kritisch zuerst)")}</option>
            <option value="shortfall">{tl(locale, "Sortierung: Fehlmenge ↓")}</option>
            <option value="name">{tl(locale, "Sortierung: Name A–Z")}</option>
          </select>
          <button onClick={fillAll} className="btn text-xs" title={locale === "de" ? "Alle Felder mit dem exakten Bedarf inkl. Yield befüllen" : locale === "nl" ? "Alle velden vullen met de exacte behoefte incl. yield" : "Fill all fields with the exact demand incl. yield"}>
            {tl(locale, "↓ Alle befüllen")}
          </button>
          <button onClick={exportToClipboard} className={`btn text-xs ${copied ? "bg-emerald-100 text-emerald-800" : ""}`}>
            {copied ? tl(locale, "✓ Kopiert!") : tl(locale, "📋 Export TSV")}
          </button>
          {configured.length > 0 && (
            <button className="btn text-xs" onClick={clearAll}>{tl(locale, "Alle zurücksetzen")}</button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 bg-white border-b border-slate-100">
              <tr>
                <th className="text-left py-2 pl-4 pr-2">Zutat · Sub-Rezept</th>
                <th className="text-right py-2 pr-2">/ Portion</th>
                <th className="text-right py-2 pr-2">Σ Bedarf</th>
                <th className="text-right py-2 pr-2">Yield</th>
                <th className="text-right py-2 pr-2">Σ inkl. Yield</th>
                <th className="py-2 pr-2" style={{ minWidth: 180 }}>Verfügbar eingeben</th>
                <th className="text-right py-2 pr-2">Max. Portionen</th>
                <th className="text-left py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const key = `${r.sub}::${r.ingredientId}::${r.uom}`;
                const exactNeeded = parseFloat((r.totalNeededWithYield / r.convFactor).toFixed(3));
                const scalePortions = portionScale < 1 && r.available !== null && r.perPortionWithYield > 0
                  ? Math.min(portionsTotal, Math.floor(r.available / r.perPortionWithYield))
                  : null;
                const scaledGrammatur = scalePortions != null && scalePortions < portionsTotal && r.perPortionWithYield > 0
                  ? r.totalNeededWithYield / scalePortions
                  : null;

                return (
                  <tr key={i} className={`border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/80 ${
                    r.status === "critical" ? "bg-rose-50/40" : r.status === "warn" ? "bg-amber-50/30" : ""
                  }`}>
                    <td className="py-2 pl-4 pr-2">
                      <div className="font-medium text-slate-800">{r.ingredient}</div>
                      <div className="text-[10px] text-slate-400">{r.sub} · <span className="font-mono">{r.ingredientId || "—"}</span></div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-600">
                      {fmtNum(r.perPortion / r.convFactor, 2)} {r.displayUom}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold">
                      {fmtNum(r.totalNeeded / r.convFactor, 2)} {r.displayUom}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {r.yieldLossPct > 0 ? <span className="text-rose-700 font-semibold">+{fmtNum(r.yieldLossPct, 1)}%</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold text-rose-700">
                      {fmtNum(r.totalNeededWithYield / r.convFactor, 2)} {r.displayUom}
                    </td>
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder={`${fmtNum(r.totalNeededWithYield / r.convFactor, 3)}`}
                          value={availableMap[key] ?? ""}
                          onChange={e => setAvailable(key, e.target.value)}
                          className={`w-24 rounded-lg border px-2 py-1 text-sm tabular-nums text-right focus:outline-none focus:ring-2 ${
                            r.status === "critical" ? "border-rose-300 focus:ring-rose-300 bg-rose-50" :
                            r.status === "warn" ? "border-amber-300 focus:ring-amber-300 bg-amber-50" :
                            r.status === "ok" ? "border-emerald-300 focus:ring-emerald-300 bg-emerald-50" :
                            "border-slate-300 focus:ring-indigo-300 bg-white"
                          }`}
                        />
                        <span className="text-xs text-slate-500">{r.displayUom}</span>
                        {/* Fill with exact need */}
                        <button
                          onClick={() => setAvailable(key, String(exactNeeded))}
                          className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium px-1 leading-none"
                          title={`Genau ${exactNeeded} ${r.displayUom} eintragen (= Bedarf inkl. Yield)`}>
                          =Bedarf
                        </button>
                        {availableMap[key] && (
                          <button
                            onClick={() => setAvailable(key, "")}
                            className="text-slate-300 hover:text-slate-500 text-xs leading-none"
                            title="Zurücksetzen">✕</button>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] leading-4 text-slate-500">
                        {engpassScenarioText(r, portionsTotal)}
                      </div>
                      {/* Scaled Grammatur hint */}
                      {scaledGrammatur != null && (
                        <div className="mt-1 text-[10px] text-rose-600 font-medium">
                          → {fmtNum(scaledGrammatur, 2)} {r.uom.toLowerCase() === "grams" ? "g" : r.uom} / Portion
                          bei {fmtNum(scalePortions!)} Port.
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {r.maxPortions !== null ? (
                        <span className={`font-bold ${r.status === "critical" ? "text-rose-700" : r.status === "warn" ? "text-amber-700" : "text-emerald-700"}`}>
                          {fmtNum(r.maxPortions)}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`pill text-[10px] font-semibold ${engpassStatusColor(r.status)}`}>
                        {engpassStatusLabel(r.status)}
                      </span>
                      {r.shortfall != null && r.shortfall > 0 && (
                        <div className="text-[10px] text-rose-600 mt-0.5">
                          Fehlend: {fmtNum(r.shortfall / r.convFactor, 2)} {r.displayUom}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Scale impact summary */}
      {configured.length > 0 && portionScale < 0.999 && (
        <div className="card p-4 ring-2 ring-rose-200 space-y-3">
          <div className="text-sm font-bold text-slate-800">Skalierungs-Impact: Plan {fmtNum(portionsTotal)} → {fmtNum(effectivePortions)} Portionen ({fmtNum(portionScale * 100, 1)}%)</div>
          <p className="text-xs text-slate-600">
            Durch den Engpass bei <b>{bottleneck?.ingredient}</b> kann nur für <b>{fmtNum(effectivePortions)}</b> Portionen produziert werden.
            Alle Grammaturen werden mit Faktor <b>{fmtNum(portionScale, 3)}</b> skaliert.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <tr>
                  <th className="text-left py-1.5">Zutat</th>
                  <th className="text-right py-1.5 pr-2">Orig. / Portion</th>
                  <th className="text-right py-1.5 pr-2">Skaliert / Portion</th>
                  <th className="text-right py-1.5 pr-2">Orig. Gesamt</th>
                  <th className="text-right py-1.5">Skaliert Gesamt</th>
                </tr>
              </thead>
              <tbody>
                {rows.filter(r => r.perPortionWithYield > 0).map((r, i) => {
                  const scaledPer = r.perPortionWithYield * portionScale;
                  const origTotal = r.perPortionWithYield * portionsTotal;
                  const scaledTotal = scaledPer * effectivePortions;
                  const du = r.displayUom;
                  const cf = r.convFactor;
                  return (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 font-medium text-slate-800">{r.ingredient}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">
                        {fmtNum(r.perPortionWithYield / cf, 2)} {du}
                      </td>
                      <td className={`py-1.5 pr-2 text-right tabular-nums font-semibold ${portionScale < 1 ? "text-rose-700" : "text-slate-700"}`}>
                        {fmtNum(scaledPer / cf, 2)} {du}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">
                        {fmtNum(origTotal / cf, 2)} {du}
                      </td>
                      <td className={`py-1.5 text-right tabular-nums font-semibold ${portionScale < 1 ? "text-rose-700" : "text-slate-700"}`}>
                        {fmtNum(scaledTotal / cf, 2)} {du}
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
  );
}

function PlatingTab({ md, detailSearch }: { md: NonNullable<Recipe["markets"][Market]>; detailSearch: string }) {
  // Eindeutige Instructions je Sub-Rezept (Plating)
  const needle = detailSearch.trim().toLowerCase();
  const blocks = md.subRecipes
    .map(s => ({ name: s.name, id: s.id, text: s.instructions }))
    .filter(b => b.text)
    .filter(b => matchesNeedle([b.name, b.id, b.text], needle));
  return (
    <div className="space-y-3">
      {blocks.length === 0 && <div className="card p-4 text-slate-500">Keine Plating-Treffer für diese Suche vorhanden.</div>}
      {blocks.map(b => (
        <div key={b.id} className="card p-4">
          <div className="font-semibold">{b.name}</div>
          <div className="font-mono text-[10px] text-slate-400 mb-2">{b.id}</div>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{b.text}</pre>
        </div>
      ))}
    </div>
  );
}

function CookTab({ wr, md, cookSchedules, portionsTotal, recipe, processSpecs, detailSearch }:
  { wr: WeekRecipe; md: NonNullable<Recipe["markets"][Market]>; cookSchedules: Record<string, CookSchedule>; portionsTotal: number;
    recipe: Recipe; processSpecs: Record<string, ProcessSpec>; detailSearch: string }) {

  const needle = detailSearch.trim().toLowerCase();
  const methods = [...new Set(md.subRecipes.map(s => s.category).filter(Boolean))]
    .filter(m => {
      const subs = md.subRecipes.filter(s => s.category === m);
      return matchesNeedle([
        m,
        ...subs.flatMap(s => [s.id, s.name, s.category, s.instructions])
      ], needle);
    });
  const split = getFulfillmentSplit(wr);

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Plan für <b>Verden (VF)</b> · gesamt <b>{fmtNum(portionsTotal)}</b> Portionen.
        Anzeige im <b>Einschicht-Modell</b>: 1 Shift = 1 Tag. Also D-1 = Vortag, D0 = Produktionstag.
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Wochenlogik ab Donnerstag</h3>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Donnerstag</div>
            <div className="mt-1 font-semibold">Wochenstart Produktion</div>
            <div className="mt-1 text-xs text-slate-600">Vorproduktion und chilled Prep für alles, was Freitag ins Fulfillment muss.</div>
          </div>
          <div className="rounded-xl bg-verden-50 ring-1 ring-verden-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-verden-700">Freitag</div>
            <div className="mt-1 font-semibold">Fulfillment-Tag 1</div>
            <div className="mt-1 text-xs text-slate-700">DK/SE komplett: <b>{fmtNum(split.dkseFriday)}</b></div>
            <div className="text-xs text-slate-700">DE Split 1: <b>{fmtNum(split.deFriday)}</b></div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Samstag</div>
            <div className="mt-1 font-semibold">Zwischenlauf / Vorproduktion</div>
            <div className="mt-1 text-xs text-slate-600">Vorbereitung für den Sonntagssplit Deutschland.</div>
          </div>
          <div className="rounded-xl bg-blue-50 ring-1 ring-blue-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-blue-700">Sonntag</div>
            <div className="mt-1 font-semibold">Fulfillment-Tag 2</div>
            <div className="mt-1 text-xs text-slate-700">DE Split 2: <b>{fmtNum(split.deSunday)}</b></div>
            {split.benl > 0 && <div className="text-xs text-slate-600 mt-1">BENL Volumen: <b>{fmtNum(split.benl)}</b> ohne feste Packregel im Modell.</div>}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Operative Herangehensweise</h3>
        <ol className="space-y-2 text-sm text-slate-700">
          <li className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2"><b>Do / S1:</b> Alle Vortags- und chilled-prep Sub-Rezepte für Freitag vorbereiten, insbesondere Butter-, Chiller- und Hold-lastige Teile.</li>
          <li className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2"><b>Fr / S1:</b> Finalproduktion für Freitag plus Fulfillment: DK/SE komplett und erste DE-Hälfte packen.</li>
          <li className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2"><b>Sa / S1:</b> Restliche Vorproduktion für den Deutschland-Sonntagssplit ziehen.</li>
          <li className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2"><b>So / S1:</b> Zweite DE-Hälfte fulfillment-ready machen und packen.</li>
        </ol>
      </div>
      {methods.map((m, index) => {
        const resolved = resolveCookSchedule(m, cookSchedules);
        const cs = resolved.schedule;
        const subs = md.subRecipes.filter(s => s.category === m);
        const tone = ingredientSectionTone(index);
        return (
          <div key={m} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${tone.frame}`}>
            <div className={`px-4 py-3 ${tone.header}`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className={`font-semibold ${tone.headerText}`}>{m}</h4>
                {cs ? (
                  <span className="pill bg-verden-100 text-verden-700">VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>
                ) : (
                  <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule definiert</span>
                )}
              </div>
              <div className="text-xs text-slate-600">Sub-Rezepte: {subs.map(s => s.name).join(" · ")}</div>
            </div>
            <div className="p-4">
              {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
                <div className="mb-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 ring-1 ring-blue-200">
                  VF-Schedule gematcht ueber <b>{resolved.matchedMethod}</b>, weil der Export die Cook-Method kuerzer fuehrt als das Rezept.
                </div>
              )}
              {cs && <Timeline cs={cs} />}
              {cs && (
                <div className="mt-3 space-y-3">
                  {subs.map(sub => {
                    const spec = processSpecs[sub.id];
                    const steps = workflowSteps(sub, spec);
                    const mass = getSubRecipeMassProfile(sub, recipe);
                    const grossKg = (portionsTotal * (mass.grossInputGramsPerPortion || mass.planningGramsPerPortion)) / 1000;
                    const outputKg = (portionsTotal * mass.outputGramsPerPortion) / 1000;
                    const batches = spec?.batchSizeKg && spec.batchSizeKg > 0
                      ? Math.max(1, Math.ceil(grossKg / spec.batchSizeKg))
                      : (grossKg > 0 ? 1 : 0);
                    const recommendPreproduction = isPreproductionRecommended(spec) && /blast chiller/i.test(sub.category);
                    return (
                      <div key={sub.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <div className="mb-3">
                          <div className="font-semibold text-slate-800">{sub.name}</div>
                          <div className="font-mono text-[10px] text-slate-400">{sub.id}</div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Input {grossKg ? fmtNum(grossKg, 1) : "—"} kg · Output {outputKg ? fmtNum(outputKg, 1) : "—"} kg
                            {mass.lossPercent !== undefined ? ` · Verlust ${fmtNum(mass.lossPercent, 1)}%` : ""}
                            {batches > 0 ? ` · ${fmtNum(batches)} Batch` : ""}
                          </div>
                        </div>
                        {recommendPreproduction && (
                          <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900 ring-1 ring-amber-200">
                            Empfehlung im Einschicht-Modell: spaetestens <b>am Vortag (D-1)</b> abschliessen.
                            Grund: Butter/Blast-Chiller-Profil mit langer Hold-Zeit in PFEI.
                          </div>
                        )}
                        {recommendPreproduction && (
                          <div className="mb-3 rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-900 ring-1 ring-blue-200">
                            Wochenrhythmus: fuer Freitagspack auf <b>Donnerstag</b> legen, fuer den DE-Sonntagssplit auf <b>Samstag</b>.
                          </div>
                        )}
                        <div className="grid gap-2 md:grid-cols-5">
                          {[4, 3, 2, 1, 0].map(n => {
                            const scheduleLabel = cs.steps.find(step => step.shiftsBefore === n)?.label;
                            const matches = scheduleLabel ? matchedScheduleSteps(scheduleLabel, steps) : [];
                            return (
                              <div key={n} className={`rounded-lg ring-1 p-2 ${matches.length > 0 ? "bg-white ring-verden-200" : "bg-slate-100 ring-slate-200"}`}>
                                <div className="text-[10px] uppercase tracking-wide text-slate-500">{scheduleLabel ?? "—"}</div>
                                <div className="text-[10px] text-slate-400">{oneShiftLabel(n)}</div>
                                <div className="mt-1 space-y-1">
                                  {matches.length === 0 && <div className="text-[11px] text-slate-400">kein direkter Step-Match</div>}
                                  {matches.map(step => (
                                    <div key={`${step.index}-${step.rawLabel}`} className="rounded bg-white px-2 py-1 text-[11px] ring-1 ring-slate-200">
                                      <div className="font-semibold text-slate-700">#{step.index} {step.station ?? step.rawLabel}</div>
                                      <div className="text-slate-500">
                                        {step.minutesPerBatch ? `${fmtMin(step.minutesPerBatch)} / Batch` : "ohne Zeit"}
                                        {step.holdMin ? ` · Hold ${fmtMin(step.holdMin)}` : ""}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {methods.length === 0 && <div className="card p-4 text-slate-500">Keine Cook-Methoden in den Sub-Rezepten.</div>}
    </div>
  );
}

function Timeline({ cs }: { cs: CookSchedule }) {
  const stepsByShift = new Map<number, string>();
  cs.steps.forEach(s => stepsByShift.set(s.shiftsBefore, s.label));
  const cells = [4, 3, 2, 1, 0];
  return (
    <div className="grid grid-cols-5 gap-2">
      {cells.map(n => {
        const lbl = stepsByShift.get(n);
        const isToday = n === 0;
        return (
          <div key={n} className={`rounded-lg p-3 ring-1 ${
            lbl ? (isToday ? "bg-verden-600 text-white ring-verden-700" : "bg-slate-100 ring-slate-200")
                : "bg-slate-50 ring-slate-100 text-slate-300"
          }`}>
            <div className="text-[10px] uppercase tracking-wide opacity-80">
              {oneShiftShortLabel(n)} · {oneShiftLabel(n)}
            </div>
            <div className="text-sm font-semibold mt-1 leading-tight">{lbl ?? "—"}</div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Workflow & Equipment (pro Rezept) ----------
function WorkflowTab({ wr, recipe, md, processSpecs, detailSearch }:
  { wr: WeekRecipe; recipe: Recipe; md: NonNullable<Recipe["markets"][Market]>;
    processSpecs: Record<string, ProcessSpec>; detailSearch: string }) {
  const portions = getBaseVerdenVolume(wr);
  const needle = detailSearch.trim().toLowerCase();
  // Wir berechnen pro Sub-Rezept dieselbe Logik wie computeWeekLoad — aber lokal
  // (keine Doppel-Schleife für die ganze Woche n\u00f6tig).
  const rows = useMemo(() => md.subRecipes.map(s => {
    const spec = processSpecs[s.id];
    const steps = workflowSteps(s, spec);
    const mass = getSubRecipeMassProfile(s, recipe);
    const gpp = mass.planningGramsPerPortion;
    const totalKg = portions * gpp / 1000;
    const batchSize = spec?.batchSizeKg ?? 0;
    const batches = batchSize > 0 ? Math.max(1, Math.ceil(totalKg / batchSize)) : (totalKg > 0 ? 1 : 0);
    const outputKg = portions * mass.outputGramsPerPortion / 1000;
    return { sub: s, spec, steps, gpp, totalKg, outputKg, batchSize, batches, mass };
  }).filter(row => matchesNeedle([
    row.sub.id,
    row.sub.name,
    row.sub.category,
    row.spec?.primaryStation,
    row.spec?.productFamily,
    ...row.steps.flatMap(step => [step.station ?? undefined, step.rawLabel])
  ], needle)), [md, processSpecs, recipe, portions, needle]);

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Reihenfolge der Arbeitsschritte aus <code>Sub-Rezept-Cook-Method</code>, Equipment-Zeiten aus PFEI-Sheet
        (gerechnet auf <b>{fmtNum(portions)}</b> Portionen Verden gesamt, alle Märkte zusammen).
      </div>
      {rows.map(({ sub, spec, steps, gpp, totalKg, outputKg, batchSize, batches, mass }) => (
        <div key={sub.id} className="card p-4">
          <div className="flex flex-wrap items-baseline gap-2 mb-2">
            <span className="font-mono text-xs text-slate-500">{sub.id}</span>
            <h4 className="font-semibold">{sub.name}</h4>
            {sub.category && <span className="pill bg-slate-100 text-slate-700">{sub.category}</span>}
            {!spec && <span className="pill bg-amber-100 text-amber-800">keine PFEI-Daten</span>}
            {spec?.primaryStation && <span className="pill bg-verden-100 text-verden-700">Constraint: {spec.primaryStation}</span>}
            {spec?.hygienic && <span className="pill bg-rose-100 text-rose-800">hygienic</span>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 text-xs mb-3">
            <Stat label="Input g / Portion" value={gpp ? fmtNum(gpp, 1) : "—"} />
            <Stat label="Output g / Portion" value={mass.outputGramsPerPortion ? fmtNum(mass.outputGramsPerPortion, 1) : "—"} />
            <Stat label="Input kg gesamt" value={totalKg ? fmtNum(totalKg, 1) : "—"} accent />
            <Stat label="Output kg gesamt" value={outputKg ? fmtNum(outputKg, 1) : "—"} />
            <Stat label="Verlust" value={mass.lossPercent !== undefined ? `${fmtNum(mass.lossPercent, 1)} %` : "—"} />
            <Stat label="Batches" value={batches ? fmtNum(batches) : "—"} accent />
          </div>

          {steps.length === 0
            ? <div className="text-sm text-slate-500">Keine Cook-Method-Schritte hinterlegt.</div>
            : (
              <ol className="space-y-1.5">
                {steps.map(st => {
                  const totalActive = (st.minutesPerBatch ?? 0) * batches;
                  return (
                    <li key={st.index} className="flex items-center gap-3 rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-white text-xs font-bold tabular-nums">
                        {st.index}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-semibold">
                          {st.station ?? st.rawLabel}
                          {st.station == null && <span className="ml-2 pill bg-amber-100 text-amber-800">unbekannte Station</span>}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {st.minutesPerBatch ? `${fmtMin(st.minutesPerBatch)} / Batch` : "keine Zeit hinterlegt"}
                          {st.holdMin ? ` · Hold: ${fmtMin(st.holdMin)}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-slate-500">Σ aktiv</div>
                        <div className="text-sm font-bold tabular-nums">{fmtMin(totalActive)}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

          {/* Zusätzlich aktive Stationen, die nicht in der Cook-Method stehen */}
          {spec && (() => {
            const inFlow = new Set(steps.map(s => s.station).filter(Boolean) as Station[]);
            const extras = STATIONS.filter(s => !inFlow.has(s) && (spec.minutesPerBatch[s] ?? 0) > 0);
            if (extras.length === 0) return null;
            return (
              <div className="mt-3 rounded-lg bg-slate-50 ring-1 ring-slate-200 p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                  Weitere aktive Stationen laut PFEI (nicht in Cook-Method-Reihenfolge)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {extras.map(s => (
                    <span key={s} className="pill bg-white ring-1 ring-slate-300 text-slate-700">
                      {s}: {fmtMin((spec.minutesPerBatch[s] ?? 0) * batches)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

// ---------- Equipment-Auslastung pro KW (global) ----------
function EquipmentView({ data, week, upliftPercent = 0, locale }: { data: DataBundle; week: string; upliftPercent?: number; locale: UiLocale }) {
  const portionMultiplier = 1 + upliftPercent / 100;
  const [stationDeviceCounts, setStationDeviceCounts] = useState<Record<Station, number>>(() => loadStationDeviceCounts());
  const [stationPools, setStationPools] = useState<Record<Station, string>>(() => loadStationPools());
  const [deviceParkOpen, setDeviceParkOpen] = useState(true);

  useEffect(() => {
    saveStationDeviceCounts(stationDeviceCounts);
  }, [stationDeviceCounts]);

  useEffect(() => {
    saveStationPools(stationPools);
  }, [stationPools]);

  const load = useMemo(() => computeWeekLoad(data, week, { portionMultiplier }), [data, week, portionMultiplier]);
  const stationCapacity = useMemo(() => Object.fromEntries(
    STATIONS.map(station => [station, getStationCapacityView(load.perStationMin[station] ?? 0, stationDeviceCounts[station] ?? 1, DEFAULT_SHIFT_MIN)])
  ) as Record<Station, ReturnType<typeof getStationCapacityView>>, [load, stationDeviceCounts]);
  const stationsSorted = useMemo(
    () => STATIONS.slice().sort((a, b) => stationCapacity[b].utilizationPct - stationCapacity[a].utilizationPct || (load.perStationMin[b] ?? 0) - (load.perStationMin[a] ?? 0)),
    [load, stationCapacity]
  );
  const configuredCapacityMin = useMemo(
    () => STATIONS.reduce((sum, station) => sum + (stationDeviceCounts[station] ?? 1) * DEFAULT_SHIFT_MIN, 0),
    [stationDeviceCounts]
  );
  const poolSummary = useMemo(() => {
    const pools = new Map<string, { stations: Station[]; totalMin: number; deviceCount: number }>();
    for (const station of STATIONS) {
      const poolName = normalizePoolName(stationPools[station], station);
      const existing = pools.get(poolName) ?? { stations: [], totalMin: 0, deviceCount: 0 };
      existing.stations.push(station);
      existing.totalMin += load.perStationMin[station] ?? 0;
      existing.deviceCount += stationDeviceCounts[station] ?? 1;
      pools.set(poolName, existing);
    }
    return [...pools.entries()]
      .map(([poolName, value]) => ({
        poolName,
        ...value,
        capacity: getStationCapacityView(value.totalMin, value.deviceCount, DEFAULT_SHIFT_MIN)
      }))
      .sort((a, b) => b.capacity.utilizationPct - a.capacity.utilizationPct || b.totalMin - a.totalMin);
  }, [load, stationDeviceCounts, stationPools]);
  const constrainedStations = stationsSorted.filter(station => stationCapacity[station].utilizationPct > 100);
  const tightStations = stationsSorted.filter(station => stationCapacity[station].utilizationPct > 70 && stationCapacity[station].utilizationPct <= 100);
  const constrainedPools = poolSummary.filter(pool => pool.capacity.utilizationPct > 100);

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-bold">{locale === "de" ? "Equipment-Auslastung" : locale === "nl" ? "Equipment-belasting" : "Equipment load"} · {week}</h2>
          <span className="text-sm text-slate-500">
            {load.recipes.length} {locale === "de" ? "Rezepte" : locale === "nl" ? "recepten" : "recipes"} · Σ {locale === "de" ? "aktive Maschinenzeit" : locale === "nl" ? "actieve machinetijd" : "active machine time"} <b>{fmtMin(load.totalActiveMin)}</b>
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {locale === "de" ? "Aggregiert über BENL + DK/SE + DE (gemeinsame Produktion). Annahme: 1 Schicht = 8 h = 480 min." : locale === "nl" ? "Geaggregeerd over BENL + DK/SE + DE (gezamenlijke productie). Aannames: 1 ploeg = 8 u = 480 min." : "Aggregated across BENL + DK/SE + DE (shared production). Assumption: 1 shift = 8 h = 480 min."}
          {" "}{locale === "de" ? "Hold-/Kühlzeiten zählen nicht in die aktive Zeit." : locale === "nl" ? "Hold-/koeltijden tellen niet mee als actieve tijd." : "Hold/cooling time does not count as active time."}{upliftPercent !== 0 ? ` ${locale === "de" ? "Planfaktor" : locale === "nl" ? "Planfactor" : "Plan factor"}: ${upliftPercent > 0 ? "+" : ""}${upliftPercent}% ${locale === "de" ? "auf Basis-Verden." : locale === "nl" ? "op Verden-basis." : "on Verden base."}` : ""}
        </p>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Stat label={locale === "de" ? "aktive Zeit" : locale === "nl" ? "actieve tijd" : "active time"} value={fmtMin(load.totalActiveMin)} accent />
          <Stat label={locale === "de" ? "Gerätepark-Kapazität" : locale === "nl" ? "apparaatcapaciteit" : "device capacity"} value={fmtMin(configuredCapacityMin)} />
          <Stat label={locale === "de" ? "überlastet" : locale === "nl" ? "overbelast" : "overloaded"} value={fmtNum(constrainedStations.length)} accent={constrainedStations.length > 0} />
          <Stat label={locale === "de" ? "Pool-Überlast" : locale === "nl" ? "pool-overbelasting" : "pool overload"} value={fmtNum(constrainedPools.length)} accent={constrainedPools.length > 0} />
        </div>
      </div>

      <div className="card p-4">
        {/* Header mit Toggle */}
        <button
          className="flex w-full items-center justify-between gap-2 text-left group"
          onClick={() => setDeviceParkOpen(o => !o)}
        >
          <div>
            <h3 className="text-sm font-semibold text-slate-700 group-hover:text-slate-900">
              {locale === "de" ? "Gerätepark je Station" : locale === "nl" ? "Apparaten per station" : "Devices per station"}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {locale === "de" ? "Hier hinterlegst du, wie viele Geräte je Station parallel verfügbar sind und welche Stationen denselben Ressourcenpool teilen." : locale === "nl" ? "Hier leg je vast hoeveel apparaten per station parallel beschikbaar zijn en welke stations dezelfde resourcepool delen." : "Here you define how many devices are available in parallel per station and which stations share the same resource pool."}
            </p>
          </div>
          <span className="shrink-0 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 group-hover:bg-slate-200 select-none">
            {deviceParkOpen ? (locale === "de" ? "▲ Zuklappen" : locale === "nl" ? "▲ Inklappen" : "▲ Collapse") : (locale === "de" ? "▼ Aufklappen" : locale === "nl" ? "▼ Uitklappen" : "▼ Expand")}
          </span>
        </button>

        {deviceParkOpen && (
          <>
            {/* Aktions-Buttons */}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn" onClick={() => { setStationDeviceCounts({ ...DEFAULT_STATION_DEVICE_COUNTS }); setStationPools({ ...DEFAULT_STATION_POOLS }); }}>
                {locale === "de" ? "Gerätepark auffüllen" : locale === "nl" ? "Apparaten aanvullen" : "Fill device setup"}
              </button>
              <button className="btn" onClick={() => setStationDeviceCounts(Object.fromEntries(STATIONS.map(s => [s, 1])) as Record<Station, number>)}>
                {locale === "de" ? "Auf 1 je Station" : locale === "nl" ? "Naar 1 per station" : "Set 1 per station"}
              </button>
              <button className="btn" onClick={() => setStationPools({ ...DEFAULT_STATION_POOLS })}>
                {locale === "de" ? "Pools zurücksetzen" : locale === "nl" ? "Pools resetten" : "Reset pools"}
              </button>
            </div>

            {/* Grid der Stations-Karten */}
            <div className="mt-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {STATIONS.map(station => (
                <div key={station} className="rounded-xl bg-white ring-1 ring-slate-200 p-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-700">{station}</div>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={stationDeviceCounts[station] ?? 1}
                    onChange={e => {
                      const value = Math.max(1, Math.floor(Number(e.target.value) || 1));
                      setStationDeviceCounts(prev => ({ ...prev, [station]: value }));
                    }}
                    className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-sm"
                  />
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{locale === "de" ? "Pool" : locale === "nl" ? "Pool" : "Pool"}</div>
                  <input
                    type="text"
                    value={stationPools[station] ?? station}
                    onChange={e => setStationPools(prev => ({ ...prev, [station]: e.target.value }))}
                    className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-sm"
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{locale === "de" ? "Ressourcenpools" : locale === "nl" ? "Resourcepools" : "Resource pools"}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">{locale === "de" ? "Pool" : locale === "nl" ? "Pool" : "Pool"}</th>
                <th className="text-left py-1.5 pr-2">{locale === "de" ? "Stationen" : locale === "nl" ? "Stations" : "Stations"}</th>
                <th className="text-right py-1.5 pr-2">{locale === "de" ? "Geräte gesamt" : locale === "nl" ? "Apparaten totaal" : "Devices total"}</th>
                <th className="text-right py-1.5 pr-2">Σ {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"}</th>
                <th className="text-right py-1.5 pr-2">{locale === "de" ? "je Gerät" : locale === "nl" ? "per apparaat" : "per device"}</th>
                <th className="py-1.5 w-1/3">{locale === "de" ? "Auslastung" : locale === "nl" ? "Belasting" : "Utilization"}</th>
              </tr>
            </thead>
            <tbody>
              {poolSummary.map(pool => (
                <tr key={pool.poolName} className="border-b last:border-0 align-top">
                  <td className="py-1.5 pr-2 font-medium">{pool.poolName}</td>
                  <td className="py-1.5 pr-2 text-xs text-slate-600">{pool.stations.join(" · ")}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(pool.deviceCount)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtMin(pool.totalMin)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{pool.totalMin > 0 ? fmtMin(pool.capacity.runtimePerDeviceMin) : "—"}</td>
                  <td className="py-1.5">
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div className={`${pool.capacity.utilizationPct > 100 ? "bg-rose-500" : pool.capacity.utilizationPct > 70 ? "bg-amber-500" : "bg-verden-500"} h-full`} style={{ width: `${Math.min(100, pool.capacity.utilizationPct)}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-right text-slate-500">{pool.totalMin > 0 ? `${fmtNum(pool.capacity.utilizationPct, 0)}%` : "—"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{locale === "de" ? "Pro Station" : locale === "nl" ? "Per station" : "Per station"}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">{locale === "de" ? "Station" : locale === "nl" ? "Station" : "Station"}</th>
                <th className="text-right py-1.5 pr-2">{locale === "de" ? "Geräte" : locale === "nl" ? "Apparaten" : "Devices"}</th>
                <th className="text-right py-1.5 pr-2">Σ {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"}</th>
                <th className="text-right py-1.5 pr-2">{locale === "de" ? "Bedarf" : locale === "nl" ? "Behoefte" : "Required"}</th>
                <th className="text-right py-1.5 pr-2">{locale === "de" ? "je Gerät" : locale === "nl" ? "per apparaat" : "per device"}</th>
                <th className="py-1.5 pr-2 w-1/3">{locale === "de" ? "Gerätepark-Auslastung" : locale === "nl" ? "Apparaatbelasting" : "Device utilization"}</th>
                <th className="text-left py-1.5">{locale === "de" ? "Top-Treiber" : locale === "nl" ? "Top drivers" : "Top drivers"}</th>
              </tr>
            </thead>
            <tbody>
              {stationsSorted.map(s => {
                const min = load.perStationMin[s] ?? 0;
                const drivers = load.perStationDriversTop3[s];
                const capacity = stationCapacity[s];
                return (
                  <tr key={s} className="border-b last:border-0 align-top">
                    <td className="py-1.5 pr-2 font-medium">{s}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(capacity.deviceCount)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtMin(min)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{min > 0 ? `${fmtNum(capacity.requiredDevices)} / ${fmtNum(capacity.deviceCount)}` : "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{min > 0 ? fmtMin(capacity.runtimePerDeviceMin) : "—"}</td>
                    <td className="py-1.5 pr-2">
                      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div className={`h-full ${
                          capacity.utilizationPct > 100 ? "bg-rose-500" : capacity.utilizationPct > 70 ? "bg-amber-500" : "bg-verden-500"
                        }`} style={{ width: `${Math.min(100, capacity.utilizationPct)}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 text-right">
                        {min > 0 ? `${fmtNum(capacity.utilizationPct, 0)}%` : "—"}
                      </div>
                    </td>
                    <td className="py-1.5 text-xs text-slate-600">
                      {min > 0 && (
                        <div className={`mb-1 inline-flex rounded-full px-2 py-0.5 ${capacity.utilizationPct > 100 ? "bg-rose-100 text-rose-800" : capacity.utilizationPct > 70 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                          {capacity.utilizationPct > 100
                            ? `${locale === "de" ? "Mehr Geräte nötig" : locale === "nl" ? "Meer apparaten nodig" : "More devices needed"}: ${fmtNum(capacity.requiredDevices - capacity.deviceCount)}`
                            : capacity.freeDeviceBuffer > 0
                              ? `${locale === "de" ? "Puffer" : locale === "nl" ? "Buffer" : "Buffer"}: ${fmtNum(capacity.freeDeviceBuffer)} ${locale === "de" ? "frei" : locale === "nl" ? "vrij" : "free"}`
                              : (locale === "de" ? "Voll ausgelastet" : locale === "nl" ? "Volledig benut" : "Fully utilized")}
                        </div>
                      )}
                      {drivers.length === 0 ? <span className="text-slate-400">—</span>
                        : drivers.map((d, i) => (
                            <div key={i}><span className="font-mono text-[10px] text-slate-400">{d.code}</span> {d.sub} · <span className="tabular-nums">{fmtMin(d.minutes)}</span></div>
                          ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{locale === "de" ? "Pro Rezept (aktive Min gesamt)" : locale === "nl" ? "Per recept (totale actieve min)" : "Per recipe (total active min)"}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">{locale === "de" ? "Code" : locale === "nl" ? "Code" : "Code"}</th>
                <th className="text-left py-1.5 pr-2">{locale === "de" ? "Rezept" : locale === "nl" ? "Recept" : "Recipe"}</th>
                <th className="text-right py-1.5 pr-2">Σ Verden</th>
                <th className="text-right py-1.5 pr-2">Σ {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"}</th>
                <th className="text-left py-1.5">{locale === "de" ? "Belegte Stationen" : locale === "nl" ? "Bezette stations" : "Occupied stations"}</th>
              </tr>
            </thead>
            <tbody>
              {load.recipes.slice().sort((a, b) => b.totalActiveMin - a.totalActiveMin).map(r => {
                const stations = STATIONS.filter(s => (r.perStationMin[s] ?? 0) > 0);
                return (
                  <tr key={r.weekRecipe.code} className="border-b last:border-0 align-top">
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-500">{r.weekRecipe.code}</td>
                    <td className="py-1.5 pr-2">{r.weekRecipe.recipeName}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmtNum(adjustedPortions(getBaseVerdenVolume(r.weekRecipe), upliftPercent))}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtMin(r.totalActiveMin)}</td>
                    <td className="py-1.5 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {stations.length === 0 && <span className="text-slate-400">{locale === "de" ? "— keine PFEI-Daten" : locale === "nl" ? "— geen PFEI-gegevens" : "— no PFEI data"}</span>}
                        {stations.map(s => (
                          <span key={s} className="pill bg-slate-100 text-slate-700">
                            {s} {fmtMin(r.perStationMin[s] ?? 0)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
