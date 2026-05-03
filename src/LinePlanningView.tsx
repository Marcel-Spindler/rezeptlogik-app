/**
 * LinePlanningView – Interaktive Linienplanung mit Drag-and-Drop
 *
 * Sub-Tabs:
 *  1. "Linienplanung" – 5-Tage × 9-Slot × 3-Linien Raster mit Drag-&-Drop-Pills
 *  2. "KET"           – Kitchen Equipment Tracking: Produktionsaufträge nach Rezept / Tag
 *
 * Datenquelle: /data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json
 * Persistenz:  Firestore  apps/rezeptlogik/lineplanning/{week}
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { loadData } from "./dataSource";
import type { WeekRecipe } from "./types";
import type { UiLocale } from "./i18n";

// ══════════════════════════════════════════════════════════════════════════════
//  DOMAIN TYPES
// ══════════════════════════════════════════════════════════════════════════════

type LinePlanRecipe = {
  code: string;          // "FV0970A"
  name: string;          // full name
  totalPlanned: number;
  nordics: number;
  bnl: number;
  de: number;
  speedPerMin: number;   // portions/min on this line
};

function isProducedInVerden(recipe: WeekRecipe): boolean {
  const code = (recipe.code ?? "").toUpperCase();
  if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
  const total = (recipe.verdenVolume.BENL ?? 0) + (recipe.verdenVolume.DKSE ?? 0) + (recipe.verdenVolume.DE ?? 0);
  return total > 0;
}

function deriveRecipesFromWeekRecipes(weekRecipes: WeekRecipe[], requestedWeek: string): LinePlanRecipe[] {
  return weekRecipes
    .filter(recipe => recipe.hfWeek === requestedWeek)
    .filter(isProducedInVerden)
    .filter((recipe, index, all) => all.findIndex(other => other.code === recipe.code) === index)
    .sort((a, b) => b.totalVerdenVolume - a.totalVerdenVolume)
    .map((recipe) => ({
      code: recipe.code,
      name: recipe.recipeName,
      totalPlanned: recipe.totalVerdenVolume,
      nordics: recipe.verdenVolume.DKSE,
      bnl: recipe.verdenVolume.BENL,
      de: recipe.verdenVolume.DE,
      speedPerMin: 10,
    }));
}

// Factor-Woche: Freitag (Produktion startet) → Donnerstag (Lieferwoche)
const DAYS = ["Freitag", "Samstag", "Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag"] as const;
type PlanDay = (typeof DAYS)[number];

// KET-Sheets liefern englische Wochentage – auf deutsche DAYS mappen
const DAY_EN_TO_DE: Record<string, string> = {
  "Friday": "Freitag",
  "Saturday": "Samstag",
  "Sunday": "Sonntag",
  "Monday": "Montag",
  "Tuesday": "Dienstag",
  "Wednesday": "Mittwoch",
  "Thursday": "Donnerstag",
};

const SLOTS: ReadonlyArray<{ key: string; label: string; duration: number }> = [
  { key: "06:00-07:00",   label: "06 – 07",    duration: 60 },
  { key: "07:00-08:00",   label: "07 – 08",    duration: 60 },
  { key: "08:00-08:30",   label: "08 – 08:30", duration: 30 },
  { key: "09:00-10:00",   label: "09 – 10",    duration: 60 },
  { key: "10:00-11:00",   label: "10 – 11",    duration: 60 },
  { key: "11:30-12:00",   label: "11:30 – 12", duration: 30 },
  { key: "12:00-13:00",   label: "12 – 13",    duration: 60 },
  { key: "13:00-14:00",   label: "13 – 14",    duration: 60 },
  { key: "14:00-15:00",   label: "14 – 15",    duration: 60 },
];

const LINES = ["P-Linie 1", "P-Linie 2", "P-Linie 3"] as const;

function defaultLineCapacityMap(): Record<string, number> {
  return {
    "0": 1200,
    "1": 1200,
    "2": 1200,
  };
}

type ScheduleMap = Record<string, LinePlanRecipe | null>;  // key: `${day}|${slotKey}|${lineIdx}`

type DragPayload = {
  recipe: LinePlanRecipe;
  source: "pool" | string;  // "pool" or slot key
};

type KetWO = {
  priority: number;
  stagingBy: string;
  deboxDay: string;
  woReady: boolean;
  hotKitchenDay: string;
  dateNeeded: string;
  woNumber: string;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  cookMethods: string[];
  targetPortions: number;
  allergens: string[];
  status: string;
  comments: string;
};

// ══════════════════════════════════════════════════════════════════════════════
//  PURE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function parseNum(s: unknown): number {
  if (typeof s !== "string") return 0;
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

function recipeHue(code: string): number {
  // Gleiche Hue-Range wie in der linken Rezeptliste (App).
  return 18 + (stableHash(code) % 300);
}

function recipeTone(code: string): {
  base: React.CSSProperties;
  code: React.CSSProperties;
  title: React.CSSProperties;
} {
  const h = recipeHue(code);
  return {
    base: {
      background: `linear-gradient(90deg, hsl(${h} 72% 86%) 0%, hsl(${h} 58% 95%) 20%, hsl(${h} 36% 98%) 100%)`,
      border: `1px solid hsl(${h} 54% 74%)`,
      boxShadow: `inset 4px 0 0 hsl(${h} 70% 52%)`,
    },
    code: { color: `hsl(${h} 40% 34%)` },
    title: { color: `hsl(${h} 46% 24%)` },
  };
}

function pillStyle(code: string): React.CSSProperties {
  return recipeTone(code).base;
}

function nameShort(name: string, max = 30): string {
  const trimmed = name.replace(/\[.*?\]/g, "").trim();
  return trimmed.length > max ? trimmed.substring(0, max - 1) + "…" : trimmed;
}

function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

function slotDuration(slotKey: string): number {
  return SLOTS.find(s => s.key === slotKey)?.duration ?? 60;
}

function portionsInSlot(recipe: LinePlanRecipe, slotKey: string): number {
  return recipe.speedPerMin * slotDuration(slotKey);
}

function mealsPerHourFromScheduleMap(schedule: ScheduleMap, day: PlanDay, slotKey: string): number {
  const duration = slotDuration(slotKey);
  let total = 0;
  for (let li = 0; li < LINES.length; li++) {
    const r = schedule[`${day}|${slotKey}|${li}`];
    if (r) total += portionsInSlot(r, slotKey);
  }
  return duration > 0 ? Math.round((total / duration) * 60) : 0;
}

function statusColor(status: string): string {
  if (/done|complete|fertig/i.test(status)) return "bg-emerald-100 text-emerald-800";
  if (/progress|running|aktiv/i.test(status)) return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

// ══════════════════════════════════════════════════════════════════════════════
//  PARSERS
// ══════════════════════════════════════════════════════════════════════════════

function parseLineplanning(rows: string[][]): {
  weekNum: number;
  totalVolume: number;
  recipes: LinePlanRecipe[];
  initialSchedule: ScheduleMap;
} {
  const weekNum = parseInt(rows[0]?.[2] ?? "0");
  const totalVolume = parseNum(rows[1]?.[2]);

  const recipes: LinePlanRecipe[] = [];
  const seenCodes = new Set<string>();
  for (const row of rows) {
    const code = (row[9] ?? "").trim();
    if (!/^FV\d{4}[A-Z]/.test(code)) continue;
    // Only parse header recipe rows (col15 = speed must be > 0).
    // Actuals/tracking rows later in the sheet reuse the same FV code but have no speed value.
    const speed = parseNum(row[15]);
    if (speed <= 0) continue;
    if (seenCodes.has(code)) continue;   // guard against any remaining duplicates
    seenCodes.add(code);
    recipes.push({
      code,
      name: (row[10] ?? code).trim(),
      totalPlanned: parseNum(row[11]),
      nordics: parseNum(row[12]),
      bnl: (row[13] ?? "").trim() === "X" ? 0 : parseNum(row[13]),
      de: parseNum(row[14]),
      speedPerMin: speed,
    });
  }

  // Parse existing slot assignments (cols 2/3/4)
  const dayMap: Record<string, PlanDay> = {
    Monday: "Montag", Tuesday: "Dienstag", Wednesday: "Mittwoch", Thursday: "Donnerstag",
    Friday: "Freitag", Saturday: "Samstag", Sunday: "Sonntag",
  };
  const slotMap: Record<string, string> = {
    "06:00 - 07:00": "06:00-07:00", "07:00 - 08:00": "07:00-08:00",
    "08:00 - 08:30": "08:00-08:30", "09:00 - 10:00": "09:00-10:00",
    "10:00 - 11:00": "10:00-11:00", "11:30 - 12:00": "11:30-12:00",
    "12:00 - 13:00": "12:00-13:00", "13:00 - 14:00": "13:00-14:00",
    "14:00 - 15:00": "14:00-15:00",
  };
  const initialSchedule: ScheduleMap = {};
  let currentDay: PlanDay | null = null;
  for (const row of rows) {
    const d = (row[0] ?? "").trim();
    if (dayMap[d]) currentDay = dayMap[d];
    if (!currentDay) continue;
    const slot = slotMap[(row[1] ?? "").trim()];
    if (!slot) continue;
    for (let li = 0; li < 3; li++) {
      const cell = (row[li + 2] ?? "").trim();
      if (!cell) continue;
      const found = recipes.find(r =>
        cell.includes(r.code) ||
        r.name.toLowerCase().startsWith(cell.toLowerCase().substring(0, 12))
      );
      if (found) initialSchedule[`${currentDay}|${slot}|${li}`] = found;
    }
  }

  return { weekNum, totalVolume, recipes, initialSchedule };
}

/** Derive a minimal recipe pool from KET work-order rows when no dedicated
 *  Lineplanning sheet exists (e.g. KW20 "Verden-2026-W20" format). */
function deriveRecipesFromKet(rows: string[][]): LinePlanRecipe[] {
  const map = new Map<string, LinePlanRecipe>();
  for (const row of rows.slice(2)) {
    if (!row[1]?.match(/^\d+$/)) continue;
    const name = (row[10] ?? "").trim();
    const match = name.match(/^(FV\d{4}[A-Z])/);
    if (!match) continue;
    const code = match[1];
    if (map.has(code)) continue;
    const totalPlanned = parseNum(row[15]);
    map.set(code, {
      code,
      name,
      totalPlanned,
      nordics: 0,
      bnl: 0,
      de: totalPlanned,
      speedPerMin: 10,
    });
  }
  return Array.from(map.values());
}

function parseKet(rows: string[][]): KetWO[] {
  if (rows.length < 2) return [];
  // Detect schema version: W18 has "Weekday" at col 2; W19+ has "WOStaging by"
  const header = rows[1] ?? [];
  const isV18 = (header[2] ?? "").trim() === "Weekday";
  const result: KetWO[] = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r[1]?.match(/^\d+$/)) continue;
    if (isV18) {
      result.push({
        priority: parseInt(r[1]),
        stagingBy: "",
        deboxDay: "",
        woReady: false,
        hotKitchenDay: (r[2] ?? "").trim(),   // W18: Weekday at col 2
        dateNeeded: (r[3] ?? "").trim(),
        woNumber: (r[4] ?? "").trim(),
        recipeId: (r[5] ?? "").trim(),
        recipeName: (r[6] ?? "").trim(),
        subRecipeName: (r[7] ?? "").trim(),
        cookMethods: (r[9] ?? "").trim().split(", ").filter(Boolean),
        targetPortions: parseNum(r[11]),
        allergens: [],
        status: "Not Started",
        comments: "",
      });
    } else {
      result.push({
        priority: parseInt(r[1]),
        stagingBy: (r[2] ?? "").trim(),
        deboxDay: (r[4] ?? "").trim(),
        woReady: r[5] === "TRUE",
        hotKitchenDay: (r[6] ?? "").trim(),
        dateNeeded: (r[7] ?? "").trim(),
        woNumber: (r[8] ?? "").trim(),
        recipeId: (r[9] ?? "").trim(),
        recipeName: (r[10] ?? "").trim(),
        subRecipeName: (r[11] ?? "").trim(),
        cookMethods: (r[13] ?? "").trim().split(" / ").filter(Boolean),
        targetPortions: parseNum(r[14]),
        allergens: (r[24] ?? "").trim().split(",").map(a => a.trim()).filter(Boolean),
        status: (r[19] ?? "").trim() || "Not Started",
        comments: (r[23] ?? "").trim(),
      });
    }
  }
  return result.sort((a, b) => a.priority - b.priority);
}

// ══════════════════════════════════════════════════════════════════════════════
//  REDUCER
// ══════════════════════════════════════════════════════════════════════════════

type ScheduleAction =
  | { type: "assign"; key: string; recipe: LinePlanRecipe }
  | { type: "remove"; key: string }
  | { type: "swap"; from: string; to: string }
  | { type: "load"; schedule: ScheduleMap };

function scheduleReducer(state: ScheduleMap, action: ScheduleAction): ScheduleMap {
  switch (action.type) {
    case "assign": return { ...state, [action.key]: action.recipe };
    case "remove": { const n = { ...state }; delete n[action.key]; return n; }
    case "swap": {
      const a = state[action.from] ?? null;
      const b = state[action.to] ?? null;
      const n = { ...state };
      if (b) n[action.from] = b; else delete n[action.from];
      if (a) n[action.to] = a; else delete n[action.to];
      return n;
    }
    case "load": return { ...action.schedule };
    default: return state;
  }
}

// Module-level drag payloads (avoids stale closures across handler callbacks)
let _drag: DragPayload | null = null;
let _ketDrag: KetWO | null = null;

// ══════════════════════════════════════════════════════════════════════════════
//  RECIPE PILL
// ══════════════════════════════════════════════════════════════════════════════

const DAY_SHORT: Record<string, string> = {
  Freitag: "Fr", Samstag: "Sa", Sonntag: "So",
  Montag: "Mo", Dienstag: "Di", Mittwoch: "Mi", Donnerstag: "Do",
};
function RecipePill({
  recipe, compact = false, dimmed = false,
  scheduledDays,
  scheduledPortions,
  onDragStart,
}: {
  recipe: LinePlanRecipe;
  compact?: boolean;
  dimmed?: boolean;
  scheduledDays?: string[];
  scheduledPortions?: number;
  onDragStart?: () => void;
}) {
  const tone = recipeTone(recipe.code);
  const style = tone.base;
  const pct = recipe.totalPlanned > 0 && scheduledPortions !== undefined
    ? scheduledPortions / recipe.totalPlanned
    : 0;
  const fullyPlanned = pct >= 1;
  const overPlanned = pct > 1.02;
  const [hovered, setHovered] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div
        draggable
        onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart?.(); }}
        onDragOver={e => e.preventDefault()}
        style={style}
        className={`rounded-xl cursor-grab active:cursor-grabbing select-none transition-all duration-150 ${
          dimmed ? "opacity-40" : "hover:shadow-md hover:scale-[1.02]"
        } ${compact ? "px-2 py-1.5" : "px-3 py-2.5"}`}
      >
        {compact ? (
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-bold text-xs shrink-0" style={tone.code}>{recipe.code}</span>
            <span className="text-[11px] font-medium leading-tight line-clamp-2" style={tone.title}>{recipe.name.replace(/^FV\d+[A-Za-z]?\s*[-\u2013]\s*/i, "")}</span>
            <span className="text-[10px] opacity-50 tabular-nums">{fmtNum(recipe.totalPlanned)} Port.</span>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="font-bold text-sm tracking-tight" style={tone.code}>{recipe.code}</span>
              <span className="text-xs opacity-60 tabular-nums">{recipe.speedPerMin}/min</span>
            </div>
            <div className="text-xs font-medium truncate mb-2" style={tone.title}>{nameShort(recipe.name, 34)}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs opacity-70 tabular-nums">
              {recipe.nordics > 0 && <span>&#x2B21; NORD {fmtNum(recipe.nordics)}</span>}
              {recipe.de > 0 && <span>&#x2B21; DE {fmtNum(recipe.de)}</span>}
              {recipe.bnl > 0 && <span>&#x2B21; BNL {fmtNum(recipe.bnl)}</span>}
            </div>
            <div className="mt-1.5 text-xs font-semibold tabular-nums">
              &#x2211; {fmtNum(recipe.totalPlanned)} Portionen
            </div>
            {scheduledDays && scheduledDays.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 items-center">
                {overPlanned && <span className="text-[10px] font-bold text-rose-600">&#x26A0; überplant</span>}
                {!overPlanned && fullyPlanned && <span className="text-[10px] font-bold text-emerald-700">&#x2713; fertig</span>}
                {scheduledDays.map(d => (
                  <span key={d} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                    overPlanned ? "bg-rose-50 text-rose-700 ring-rose-300"
                    : fullyPlanned ? "bg-emerald-50 text-emerald-700 ring-emerald-300"
                    : "bg-white/70 text-slate-700 ring-slate-300"
                  }`}>
                    {DAY_SHORT[d] ?? d}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {hovered && (
        <div className={`absolute ${compact ? "bottom-full mb-1" : "top-full mt-1"} left-0 z-[300] w-72 rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 p-4 pointer-events-none select-none`}>
          <div className="flex items-start gap-2 mb-3">
            <span className="font-black text-base" style={tone.code}>{recipe.code}</span>
            <span className="font-semibold text-slate-700 text-xs leading-tight mt-0.5">{recipe.name}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {recipe.nordics > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">Nordics</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.nordics)}</div>
              </div>
            )}
            {recipe.de > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">DE</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.de)}</div>
              </div>
            )}
            {recipe.bnl > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">BNL</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.bnl)}</div>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between text-xs mb-2 pb-2 border-b border-slate-100">
            <span className="text-slate-500">&#x2211; Geplant</span>
            <span className="font-bold tabular-nums text-slate-800">{fmtNum(recipe.totalPlanned)} Port.</span>
            {recipe.speedPerMin > 0 && (
              <span className="font-bold tabular-nums text-indigo-600 ml-3">{recipe.speedPerMin}/min</span>
            )}
          </div>
          {scheduledPortions !== undefined && scheduledPortions > 0 && (
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-slate-500">Eingeplant</span>
                <span className={`font-bold tabular-nums ${overPlanned ? "text-rose-600" : fullyPlanned ? "text-emerald-600" : "text-slate-700"}`}>
                  {fmtNum(scheduledPortions)} · {Math.round(pct * 100)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className={`h-full rounded-full ${overPlanned ? "bg-rose-400" : fullyPlanned ? "bg-emerald-400" : "bg-indigo-400"}`}
                  style={{ width: `${Math.min(100, pct * 100)}%` }} />
              </div>
            </div>
          )}
          {scheduledDays && scheduledDays.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2 border-t border-slate-100 mt-1">
              <span className="text-[10px] text-slate-400 font-semibold w-full mb-0.5">Eingeplant an:</span>
              {scheduledDays.map(d => (
                <span key={d} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                  overPlanned ? "bg-rose-50 text-rose-700 ring-rose-300"
                  : fullyPlanned ? "bg-emerald-50 text-emerald-700 ring-emerald-300"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
                }`}>{DAY_SHORT[d] ?? d}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  DROP CELL
// ══════════════════════════════════════════════════════════════════════════════

function DropCell({
  slotKey, recipe, isDragOver, isActiveDrag,
  onDrop, onDragEnter, onDragLeave,
  onDragStartCell, onRemove, multiDayCount,
}: {
  slotKey: string;
  recipe: LinePlanRecipe | null;
  isDragOver: boolean;
  isActiveDrag: boolean;
  onDrop: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDragStartCell: (r: LinePlanRecipe, key: string) => void;
  onRemove: () => void;
  multiDayCount?: number;
}) {
  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragEnter(); }}
      onDragEnter={e => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(); }}
      className={`min-h-[5rem] rounded-xl border-2 transition-all duration-100 flex items-stretch ${
        isDragOver
          ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300/50 scale-[1.03]"
          : recipe
          ? "border-transparent"
          : isActiveDrag
          ? "border-dashed border-indigo-200 bg-indigo-50/30"
          : "border-dashed border-slate-200 bg-slate-50/50 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      {recipe ? (
        <div
          className="relative w-full group p-0.5"
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        >
          <RecipePill
            recipe={recipe}
            compact
            onDragStart={() => onDragStartCell(recipe, slotKey)}
          />
          {multiDayCount && multiDayCount > 1 && (
            <div className="absolute top-0.5 left-0.5 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-black text-white leading-none z-10" title={`${multiDayCount}x diese Woche an verschiedenen Tagen`}>
              {multiDayCount}x
            </div>
          )}
          <button
            onClick={onRemove}
            className="absolute -top-1 -right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-white text-[10px] font-bold leading-none hover:bg-red-500 transition-colors z-10"
            title="Entfernen"
          >x</button>
        </div>
      ) : (
        <div className={`w-full flex items-center justify-center text-slate-300 text-sm transition-opacity ${
          isDragOver ? "opacity-0" : isActiveDrag ? "opacity-70" : "opacity-40"
        }`}>
          {isActiveDrag ? "Ablegen" : "-"}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  VOLUME BALANCE BAR
// ══════════════════════════════════════════════════════════════════════════════


function VolumeBar({ recipe, scheduledPortions }: { recipe: LinePlanRecipe; scheduledPortions: number }) {
  const pct = recipe.totalPlanned > 0 ? Math.min(100, (scheduledPortions / recipe.totalPlanned) * 100) : 0;
  const h = recipeHue(recipe.code);
  const over = scheduledPortions > recipe.totalPlanned;
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-bold text-xs" style={{ color: `hsl(${h},52%,22%)` }}>{recipe.code}</div>
          <div className="text-xs text-slate-500 truncate">{nameShort(recipe.name, 26)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-sm font-bold tabular-nums ${over ? "text-rose-600" : pct >= 100 ? "text-emerald-600" : "text-slate-700"}`}>
            {Math.round(pct)}%
          </div>
          <div className="text-[10px] text-slate-400 tabular-nums">{fmtNum(scheduledPortions)}/{fmtNum(recipe.totalPlanned)}</div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{
          width: `${Math.min(100, pct)}%`,
          background: over ? `hsl(0,75%,60%)` : `hsl(${h},55%,60%)`,
        }} />
      </div>
      {over && <div className="text-[10px] text-rose-500 mt-1">+{fmtNum(scheduledPortions - recipe.totalPlanned)} überplant</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
function KetCard({
  wo, effectiveStatus, scheduledDays, onDragStart, onDragEnd, onStatusCycle,
}: {
  wo: KetWO;
  effectiveStatus: string;
  scheduledDays: string[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onStatusCycle: () => void;
}) {
  const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? (wo.recipeName.match(/^(FV\d{4}[A-Z])/)?.[1] ?? "");
  const tone = code ? recipeTone(code) : { base: {} as React.CSSProperties, code: {} as React.CSSProperties, title: {} as React.CSSProperties };
  const ketTooltip = [
    code ? `${code} – ${wo.recipeName}` : wo.recipeName,
    wo.subRecipeName ? `Sub-Rezept: ${wo.subRecipeName}` : "",
    `WO: ${wo.woNumber}`,
    wo.hotKitchenDay ? `Küchenstart: ${wo.hotKitchenDay}` : "",
    wo.dateNeeded ? `Benötigt: ${wo.dateNeeded}` : "",
    `Status: ${wo.status || "–"}`,
    scheduledDays.length > 0 ? `Geplant an: ${scheduledDays.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  return (
    <div
      draggable
      title={ketTooltip}
      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      style={tone.base}
      className="rounded-xl p-2.5 shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-all select-none"
    >
      {/* Header: priority + name + status badge */}
      <div className="flex items-start justify-between gap-1.5 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ ...tone.base, border: undefined, boxShadow: undefined }}
          >
            {wo.priority}
          </div>
          <span className="font-semibold text-xs text-slate-800 leading-tight line-clamp-2">
            {wo.subRecipeName || wo.recipeName}
          </span>
        </div>
        <button
          onClick={e => { e.stopPropagation(); onStatusCycle(); }}
          className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold transition-colors cursor-pointer ${statusColor(effectiveStatus)}`}
          title="Klicken zum Weiterschalten"
        >
          {effectiveStatus.length > 13 ? effectiveStatus.substring(0, 11) + "…" : effectiveStatus}
        </button>
      </div>

      {/* Recipe code + WO number */}
      <div className="flex gap-2 items-center mb-1.5">
        {code && <span className="text-[10px] font-bold" style={tone.code}>{code}</span>}
        {wo.woNumber && <span className="text-[10px] font-mono text-slate-400">{wo.woNumber}</span>}
        {wo.woReady && <span className="ml-auto text-[9px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-100 px-1 rounded">✓ WO ready</span>}
      </div>

      {/* Cook methods */}
      {wo.cookMethods.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1.5">
          {wo.cookMethods.slice(0, 3).map(m => (
            <span key={m} className="px-1 py-0.5 rounded text-[9px] font-medium bg-slate-100 text-slate-600">{m}</span>
          ))}
          {wo.cookMethods.length > 3 && <span className="text-[9px] text-slate-400">+{wo.cookMethods.length - 3}</span>}
        </div>
      )}

      {/* Footer: allergens + portions */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex flex-wrap gap-0.5">
          {wo.allergens.slice(0, 2).map(a => (
            <span key={a} className="px-1 py-0.5 rounded-full text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-100">
              ⚠ {a.substring(0, 10)}
            </span>
          ))}
          {wo.allergens.length > 2 && <span className="text-[9px] text-slate-400">+{wo.allergens.length - 2}</span>}
        </div>
        {wo.targetPortions > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-slate-500 shrink-0">{fmtNum(wo.targetPortions)}</span>
        )}
      </div>

      {/* Comment */}
      {wo.comments && (
        <div className="mt-1.5 text-[10px] text-slate-400 italic border-t border-slate-50 pt-1.5 leading-tight">
          {wo.comments}
        </div>
      )}
      {/* Linienplan-Badge */}
      {scheduledDays.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-slate-50 pt-1.5">
          <span className="text-[9px] text-indigo-500 font-semibold">📋</span>
          <span className="text-[9px] text-indigo-600 font-semibold">{scheduledDays.map(d => d.substring(0, 2)).join(", ")}</span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  KET DAY COLUMN  (drop target, groups KetCards)
// ══════════════════════════════════════════════════════════════════════════════

function KetDayColumn({
  day, label, wos, isDragOver,
  onDragEnter, onDragLeave, onDrop,
  ketOverrides, onDragStart, onDragEnd, onStatusCycle,
  scheduledDaysByCode,
}: {
  day: string; label: string; wos: KetWO[]; isDragOver: boolean;
  onDragEnter: () => void; onDragLeave: () => void; onDrop: () => void;
  ketOverrides: Record<string, { day?: string; status?: string }>;
  onDragStart: (wo: KetWO) => void;
  onDragEnd: () => void;
  onStatusCycle: (wo: KetWO) => void;
  scheduledDaysByCode: Map<string, Set<string>>;
}) {
  const totalPortions = wos.reduce((s, wo) => s + wo.targetPortions, 0);
  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragEnter(); }}
      onDragEnter={e => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(); }}
      className={`w-52 shrink-0 rounded-2xl border-2 transition-all duration-100 ${
        isDragOver
          ? "border-indigo-400 bg-indigo-50/80 ring-2 ring-indigo-300/40 scale-[1.01]"
          : "border-slate-100 bg-slate-50/60"
      }`}
    >
      {/* Column header */}
      <div className={`px-3 py-2.5 border-b rounded-t-2xl flex items-center justify-between ${
        isDragOver ? "border-indigo-100 bg-indigo-50/60" : "border-slate-100 bg-white/60"
      }`}>
        <div>
          <div className="font-bold text-sm text-slate-700">{label}</div>
          {totalPortions > 0 && (
            <div className="text-[10px] text-slate-400 tabular-nums">∑ {fmtNum(totalPortions)}</div>
          )}
        </div>
        <span className={`text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full ${
          wos.length > 0 ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"
        }`}>
          {wos.length}
        </span>
      </div>

      {/* Cards */}
      <div className="p-2 space-y-2 min-h-28">
        {wos.map(wo => (
          <KetCard
            key={`${wo.woNumber}-${wo.subRecipeName}`}
            wo={wo}
            effectiveStatus={ketOverrides[wo.woNumber]?.status ?? wo.status}
            scheduledDays={Array.from(scheduledDaysByCode.get(wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "") ?? [])}
            onDragStart={() => onDragStart(wo)}
            onDragEnd={onDragEnd}
            onStatusCycle={() => onStatusCycle(wo)}
          />
        ))}
        {wos.length === 0 && (
          <div className={`flex items-center justify-center h-16 text-xs transition-colors ${
            isDragOver ? "text-indigo-300" : "text-slate-200"
          }`}>
            {isDragOver ? "↓ Hierher" : "Leer"}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN VIEW
// ══════════════════════════════════════════════════════════════════════════════

export function LinePlanningView({ week, locale }: { week: string; locale: UiLocale }) {
  const [subTab, setSubTab] = useState<"lineplanning" | "ket">("lineplanning");
  const [recipes, setRecipes] = useState<LinePlanRecipe[]>([]);
  const [schedule, dispatch] = useReducer(scheduleReducer, {});
  const [ketWOs, setKetWOs] = useState<KetWO[]>([]);
  const [weekNum, setWeekNum] = useState(0);
  const [totalVolume, setTotalVolume] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataWarning, setDataWarning] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [ketSearch, setKetSearch] = useState("");
  const [ketStatusFilter, setKetStatusFilter] = useState<"all" | "open" | "done">("all");
  const [ketOverrides, setKetOverrides] = useState<Record<string, { day?: string; status?: string }>>({});
  const [ketDragOverDay, setKetDragOverDay] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [targetMealsBySlot, setTargetMealsBySlot] = useState<Record<string, number>>({});
  const [lineCapacityByLane, setLineCapacityByLane] = useState<Record<string, number>>(defaultLineCapacityMap);
  const [autoPlanNotice, setAutoPlanNotice] = useState<string>("");
  const dragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ketDragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const weekStr = week.split("-W")[1] ?? week;

  // ─── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      fetch("/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json").then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      loadData(),
    ])
      .then(([sheetData, appData]: [{ sheets: Array<{ title: string; sheetId: number; values: string[][] }> }, Awaited<ReturnType<typeof loadData>>]) => {
        const requestedWeekNum = parseInt(weekStr);
        let hasWeekSpecificRecipePool = false;
        setDataWarning(null);

        const weekRecipes = deriveRecipesFromWeekRecipes(appData.weekRecipes ?? [], week);
        if (weekRecipes.length > 0) {
          setRecipes(weekRecipes);
          hasWeekSpecificRecipePool = true;
        }

        // Find week-specific KET sheet (exact match first, then partial)
        const ketSheetExact =
          sheetData.sheets.find(s => s.title.includes(`W${weekStr}`) && s.title.startsWith("KET")) ??
          sheetData.sheets.find(s => s.title.includes(`W${weekStr}`));

        if (ketSheetExact) {
          const wos = parseKet(ketSheetExact.values);
          setKetWOs(wos);
          // KET dient nur noch als Fallback, falls keine Rezeptdaten für die KW vorliegen.
          const derived = deriveRecipesFromKet(ketSheetExact.values);
          if (!hasWeekSpecificRecipePool && derived.length > 0) {
            setRecipes(derived);
            hasWeekSpecificRecipePool = true;
          }
        } else {
          setKetWOs([]);
          setDataWarning(`KW ${weekStr}: Kein KET-Sheet im JSON gefunden. Bitte das JSON neu aus dem Google Sheet importieren (scripts/dump-gsheet.ts). KET-Kanban ist leer.`);
        }

        // Also load Lineplanning sheet for slot schedule template (even if wrong week)
        const lpSheet = sheetData.sheets.find(s => s.title === "Lineplanning");
        if (lpSheet) {
          const { weekNum: wn, totalVolume: tv, recipes: recs, initialSchedule } =
            parseLineplanning(lpSheet.values);
          setTotalVolume(tv);
          setWeekNum(wn);
          // Nur wenn noch kein KW-spezifischer Rezeptpool vorhanden ist,
          // verwenden wir Rezepte aus dem Lineplanning-Sheet.
          if (wn === requestedWeekNum) {
            if (!hasWeekSpecificRecipePool && recs.length > 0) {
              setRecipes(recs);
              hasWeekSpecificRecipePool = true;
            }
            dispatch({ type: "load", schedule: initialSchedule });
          } else if (!ketSheetExact) {
            // No KET data either – warn
            setDataWarning(prev => `KW ${weekStr}: Die JSON-Datei enthält nur KW ${wn}-Daten. Bitte JSON aktualisieren.${prev ? " " + prev : ""}`);
          }
        }

        // Firestore-Manifest nur als Fallback laden, wenn weder KET noch
        // passendes Lineplanning einen KW-spezifischen Pool geliefert haben.
        if (!hasWeekSpecificRecipePool) {
          void (async () => {
            try {
              const { getFirebase } = await import("./firebase");
              const { doc, getDoc } = await import("firebase/firestore");
              const { db } = getFirebase();
              const snap = await getDoc(doc(db, `apps/rezeptlogik/weekRecipes/de_${week.replace(/\W/g, "-")}`));
              if (!snap.exists()) return;
              const manifest = snap.data() as { meals: Array<{ code: string; name: string }> };
              const fallbackRecipes = (manifest.meals ?? []).map((m) => ({
                code: m.code,
                name: m.name,
                totalPlanned: 0,
                nordics: 0,
                bnl: 0,
                de: 0,
                speedPerMin: 10,
              }));
              if (fallbackRecipes.length > 0) setRecipes(fallbackRecipes);
            } catch { /* kein Firestore / offline → still ignorieren */ }
          })();
        }

        setLoading(false);
      })
      .catch(err => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, [week, weekStr]);

  // ─── Echtzeit-Listener: alle Planer sehen denselben Stand ─────────────────
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, onSnapshot } = await import("firebase/firestore");
        const { db } = getFirebase();
        unsubscribe = onSnapshot(
          doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`),
          (snap) => {
            if (!snap.exists()) return;
            const d = snap.data() as { schedule?: ScheduleMap; comments?: Record<string, string>; ketOverrides?: Record<string, { day?: string; status?: string }>; targetMealsBySlot?: Record<string, number>; lineCapacityByLane?: Record<string, number> };
            if (d.schedule) dispatch({ type: "load", schedule: d.schedule });
            if (d.comments) setComments(d.comments);
            if (d.ketOverrides) setKetOverrides(d.ketOverrides);
            if (d.targetMealsBySlot) setTargetMealsBySlot(d.targetMealsBySlot);
            if (d.lineCapacityByLane) {
              setLineCapacityByLane({ ...defaultLineCapacityMap(), ...d.lineCapacityByLane });
            }
          },
          () => { /* silent – offline / keine Rechte */ }
        );
      } catch { /* silent */ }
    })();
    return () => unsubscribe?.();
  }, [weekStr]);

  // ─── Save to Firestore ─────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    try {
      const { getFirebase } = await import("./firebase");
      const { doc, setDoc } = await import("firebase/firestore");
      const { db } = getFirebase();
      await setDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`), {
        week,
        savedAt: new Date().toISOString(),
        schedule,
        comments,
        ketOverrides,
        targetMealsBySlot,
        lineCapacityByLane,
      });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      alert(`Speichern fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearPlan() {
    const confirmed = window.confirm(`Planung für KW ${weekStr} wirklich bereinigen?`);
    if (!confirmed) return;

    dispatch({ type: "load", schedule: {} });
    setComments({});
    setKetOverrides({});
    setTargetMealsBySlot({});
    setAutoPlanNotice(`Planung für KW ${weekStr} wurde bereinigt.`);

    try {
      const { getFirebase } = await import("./firebase");
      const { doc, setDoc } = await import("firebase/firestore");
      const { db } = getFirebase();
      await setDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`), {
        week,
        savedAt: new Date().toISOString(),
        clearedAt: new Date().toISOString(),
        schedule: {},
        comments: {},
        ketOverrides: {},
        targetMealsBySlot: {},
        lineCapacityByLane,
      });
    } catch (err) {
      alert(`Bereinigen fehlgeschlagen: ${(err as Error).message}`);
    }
  }

  // ─── Drag handlers ─────────────────────────────────────────────────────────
  function onDragStartPool(recipe: LinePlanRecipe) {
    _drag = { recipe, source: "pool" };
    setDragActive(true);
  }

  function onDragStartCell(recipe: LinePlanRecipe, key: string) {
    _drag = { recipe, source: key };
    setDragActive(true);
  }

  function onDragEnd() {
    _drag = null;
    setDragActive(false);
    setDragOverKey(null);
  }

  function onDragEnterCell(key: string) {
    if (dragLeaveTimerRef.current) clearTimeout(dragLeaveTimerRef.current);
    setDragOverKey(key);
  }

  function onDragLeaveCell() {
    dragLeaveTimerRef.current = setTimeout(() => setDragOverKey(null), 60);
  }

  function onDropCell(targetKey: string) {
    const payload = _drag;
    if (!payload) return;
    if (payload.source === "pool") {
      dispatch({ type: "assign", key: targetKey, recipe: payload.recipe });
    } else if (payload.source !== targetKey) {
      dispatch({ type: "swap", from: payload.source, to: targetKey });
    }
    _drag = null;
    setDragActive(false);
    setDragOverKey(null);
  }

  function onDropPool() {
    const payload = _drag;
    if (!payload || payload.source === "pool") return;
    dispatch({ type: "remove", key: payload.source });
    _drag = null;
    setDragActive(false);
    setDragOverKey(null);
  }

  function autoPlanFromTargets() {
    const next: ScheduleMap = { ...schedule };
    const producedByRecipe = new Map<string, number>();
    const defaultTargetMh = LINES.reduce((sum, _line, li) => sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0), 0);

    for (const [key, recipe] of Object.entries(next)) {
      if (!recipe) continue;
      const slotKey = key.split("|")[1] ?? "";
      producedByRecipe.set(recipe.code, (producedByRecipe.get(recipe.code) ?? 0) + portionsInSlot(recipe, slotKey));
    }

    let assignments = 0;
    for (const day of DAYS) {
      for (const slot of SLOTS) {
        const targetKey = `${day}|${slot.key}`;
        const targetMh = Math.max(0, targetMealsBySlot[targetKey] ?? defaultTargetMh);
        if (targetMh <= 0) continue;

        const freeLineIdx = Array.from({ length: LINES.length }, (_, li) => li)
          .filter((li) => !next[`${day}|${slot.key}|${li}`] && (lineCapacityByLane[String(li)] ?? 0) > 0)
          .sort((a, b) => Number(a === LINES.length - 1) - Number(b === LINES.length - 1));

        let currentMh = mealsPerHourFromScheduleMap(next, day, slot.key);
        while (freeLineIdx.length > 0 && currentMh < targetMh) {
          const li = freeLineIdx.shift();
          if (li === undefined) break;
          const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
          const missingMh = Math.min(targetMh - currentMh, lineTarget || targetMh);
          let best: LinePlanRecipe | null = null;
          let bestScore = -Infinity;

          for (const recipe of recipes) {
            const produced = producedByRecipe.get(recipe.code) ?? 0;
            const remaining = Math.max(0, recipe.totalPlanned - produced);
            if (remaining <= 0) continue;

            const slotPortions = portionsInSlot(recipe, slot.key);
            const recipeMh = recipe.speedPerMin * 60;
            if (lineTarget > 0 && recipeMh > lineTarget * 1.35) continue;
            const fitScore = 1 - Math.min(1, Math.abs(missingMh - recipeMh) / Math.max(targetMh, recipeMh, 1));
            const volumeScore = Math.min(1, remaining / Math.max(slotPortions, 1));
            const lineFitScore = lineTarget > 0 ? 1 - Math.min(1, Math.abs(lineTarget - recipeMh) / Math.max(lineTarget, recipeMh, 1)) : fitScore;
            const score = fitScore * 0.45 + lineFitScore * 0.25 + volumeScore * 0.3;

            if (score > bestScore) {
              bestScore = score;
              best = recipe;
            }
          }

          if (!best) break;
          next[`${day}|${slot.key}|${li}`] = best;
          producedByRecipe.set(best.code, (producedByRecipe.get(best.code) ?? 0) + portionsInSlot(best, slot.key));
          currentMh = mealsPerHourFromScheduleMap(next, day, slot.key);
          assignments += 1;
        }
      }
    }

    dispatch({ type: "load", schedule: next });
    setAutoPlanNotice(assignments > 0
      ? `${assignments} Slots automatisch belegt (Ziel-Meals/h berücksichtigt).`
      : "Keine neuen Slots belegt. Prüfe Ziel-Meals/h und Restvolumen.");
    setTimeout(() => setAutoPlanNotice(""), 3500);
  }

  function copyCurrentMealsAsTargets() {
    const nextTargets: Record<string, number> = { ...targetMealsBySlot };
    for (const day of DAYS) {
      for (const slot of SLOTS) {
        nextTargets[`${day}|${slot.key}`] = mealsPerHour(day, slot.key);
      }
    }
    setTargetMealsBySlot(nextTargets);
    setAutoPlanNotice("Aktuelle Meals/h als Zielwerte übernommen.");
    setTimeout(() => setAutoPlanNotice(""), 2500);
  }

  function resetLineCapacityDefaults() {
    setLineCapacityByLane(defaultLineCapacityMap());
    setAutoPlanNotice("Linienleistung auf Standardwerte gesetzt.");
    setTimeout(() => setAutoPlanNotice(""), 2200);
  }

  // ─── KET drag / status handlers ───────────────────────────────────────────
  function onKetDragStart(wo: KetWO) {
    _ketDrag = wo;
  }
  function onKetDragEnd() {
    _ketDrag = null;
    setKetDragOverDay(null);
  }
  function onKetDragEnterDay(day: string) {
    if (ketDragLeaveTimerRef.current) clearTimeout(ketDragLeaveTimerRef.current);
    setKetDragOverDay(day);
  }
  function onKetDragLeaveDay() {
    ketDragLeaveTimerRef.current = setTimeout(() => setKetDragOverDay(null), 60);
  }
  function onKetDropDay(targetDay: string) {
    const wo = _ketDrag;
    if (!wo) return;
    setKetOverrides(prev => ({
      ...prev,
      [wo.woNumber]: { ...prev[wo.woNumber], day: targetDay === "__unassigned__" ? "" : targetDay },
    }));
    _ketDrag = null;
    setKetDragOverDay(null);
  }
  function onKetStatusCycle(wo: KetWO) {
    const STATUS_CYCLE = ["Not Started", "In Progress", "Done"];
    const current = ketOverrides[wo.woNumber]?.status ?? wo.status;
    const idx = STATUS_CYCLE.findIndex(s => s.toLowerCase() === current.toLowerCase());
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
    setKetOverrides(prev => ({
      ...prev,
      [wo.woNumber]: { ...prev[wo.woNumber], status: next },
    }));
  }

  // ─── Computations ──────────────────────────────────────────────────────────

  // Portions scheduled per recipe per slot
  const scheduledPortions = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, recipe] of Object.entries(schedule)) {
      if (!recipe) continue;
      const slotKey = key.split("|")[1] ?? "";
      const p = portionsInSlot(recipe, slotKey);
      map.set(recipe.code, (map.get(recipe.code) ?? 0) + p);
    }
    return map;
  }, [schedule]);

  // Days scheduled per recipe code (for KET cross-reference)
  const scheduledDaysByCode = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [key, recipe] of Object.entries(schedule)) {
      if (!recipe) continue;
      const [day] = key.split("|");
      if (!map.has(recipe.code)) map.set(recipe.code, new Set<string>());
      map.get(recipe.code)!.add(day);
    }
    return map;
  }, [schedule]);

  // Slot-count per recipe code (für Multi-Day-Badge in Zellen)
  // Meals/h per (day, slot)
  function mealsPerHour(day: PlanDay, slotKey: string): number {
    const duration = slotDuration(slotKey);
    let total = 0;
    for (let li = 0; li < LINES.length; li++) {
      const r = schedule[`${day}|${slotKey}|${li}`];
      if (r) total += portionsInSlot(r, slotKey);
    }
    return duration > 0 ? Math.round((total / duration) * 60) : 0;
  }

  // KET filtering & grouping
  const filteredKet = useMemo(() => {
    let wos = ketWOs;
    if (ketSearch) {
      const q = ketSearch.toLowerCase();
      wos = wos.filter(wo =>
        wo.recipeName.toLowerCase().includes(q) ||
        wo.subRecipeName.toLowerCase().includes(q) ||
        wo.woNumber.toLowerCase().includes(q) ||
        wo.hotKitchenDay.toLowerCase().includes(q)
      );
    }
    if (ketStatusFilter === "open") wos = wos.filter(wo => !/done|done/i.test(wo.status));
    if (ketStatusFilter === "done") wos = wos.filter(wo => /done|fertig/i.test(wo.status));
    return wos;
  }, [ketWOs, ketSearch, ketStatusFilter]);

  // KET Kanban columns (group by effective day)
  const wosByDay = useMemo(() => {
    const map: Record<string, KetWO[]> = {};
    for (const wo of filteredKet) {
      const rawDay = ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay;
      const day = DAY_EN_TO_DE[rawDay] ?? rawDay; // Englisch → Deutsch normalisieren
      const key = day || "__unassigned__";
      if (!map[key]) map[key] = [];
      map[key].push(wo);
    }
    return map;
  }, [filteredKet, ketOverrides]);

  const ketDayColumns = useMemo(() => {
    const cols: Array<{ day: string; label: string; wos: KetWO[] }> = [];
    const unassigned = wosByDay["__unassigned__"] ?? [];
    if (unassigned.length > 0) cols.push({ day: "__unassigned__", label: "Nicht geplant", wos: unassigned });
    for (const d of DAYS) {
      cols.push({ day: d, label: d, wos: wosByDay[d] ?? [] });
    }
    return cols;
  }, [wosByDay]);

  const ketRecipeLegend = useMemo(() => {
    const map = new Map<string, { code: string; name: string; count: number }>();
    for (const wo of filteredKet) {
      const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "";
      if (!code) continue;
      if (!map.has(code)) map.set(code, { code, name: wo.recipeName, count: 0 });
      map.get(code)!.count++;
    }
    return Array.from(map.values());
  }, [filteredKet]);

  // ─── Render ────────────────────────────────────────────────────────────────

  const lineGridTemplate = `5.5rem 6rem repeat(${LINES.length}, 1fr) 11rem`;

  if (loading) return (
    <div className="card p-8 text-center text-slate-500">
      <div className="text-2xl mb-2">⏳</div>
      Plating Linien Plannung wird geladen …
    </div>
  );

  if (error) return (
    <div className="card p-8 text-center text-rose-600">
      <div className="text-2xl mb-2">⚠️</div>
      Laden fehlgeschlagen: {error}
      <div className="mt-2 text-xs text-slate-400">Stelle sicher dass das JSON-Dump unter /data/ liegt.</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">
              Plating Linien Plannung
              <span className="ml-2 text-slate-400 font-normal text-base">KW {weekStr}</span>
            </h2>
            <div className="flex flex-wrap gap-4 mt-1 text-sm text-slate-500">
              <span>∑ <strong>{fmtNum(totalVolume)}</strong> Portionen</span>
              <span><strong>{recipes.length}</strong> Rezepte</span>
              <span><strong>{Object.values(schedule).filter(Boolean).length}</strong> Slots belegt</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Sub-tab switcher */}
            <div className="flex rounded-lg bg-slate-100 ring-1 ring-slate-200 p-1 gap-0.5">
              {([["lineplanning", "📋 Plating Linien Plannung"], ["ket", "🍳 KET / Küche"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setSubTab(k)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                    subTab === k ? "bg-white shadow ring-1 ring-slate-300 text-slate-800" : "text-slate-500 hover:text-slate-700"
                  }`}>{l}</button>
              ))}
            </div>
            <button
              onClick={() => setShowQrModal(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              title={`QR-Code & Link für KW ${weekStr} teilen`}
            >
              QR / URL
            </button>
            <button
              onClick={() => setShowHelp(h => !h)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${showHelp ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"}`}
              title="Hilfe & Bedienung"
            >
              ? Hilfe
            </button>
            <button
              onClick={copyCurrentMealsAsTargets}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              title="Aktuelle Meals/h in Zielwerte kopieren"
            >
              🎯 Zielwerte übernehmen
            </button>
            <button
              onClick={autoPlanFromTargets}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              title="Füllt freie Slots anhand der Ziel-Meals/h automatisch"
            >
              🤖 Auto-Plan
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                saveOk
                  ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300"
                  : "bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              }`}
            >
              {saving ? "Speichert …" : saveOk ? "✓ Gespeichert" : "💾 Plan sichern"}
            </button>
            <button
              onClick={handleClearPlan}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
              title={`Bereinigt die aktuelle KW ${weekStr} im Plating-Plan`}
            >
              🧹 Planung bereinigen
            </button>
          </div>
        </div>
        {autoPlanNotice && (
          <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
            {autoPlanNotice}
          </div>
        )}
        {dataWarning && (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 flex items-start gap-2">
            <span className="shrink-0">⚠️</span>
            <span>{dataWarning}</span>
          </div>
        )}
        {showHelp && (
          <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4 text-xs text-slate-700 space-y-3">
            <div className="font-bold text-sm text-slate-800 mb-1">Bedienung – Factor OPS Planner · Linienplanung</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
              <div><span className="font-semibold text-slate-900">📋 Plating Linien Plannung</span> – Wechselt zum Raster-Tab: 7 Tage × 9 Zeitslots × 3 P-Linien. Rezepte per Drag&amp;Drop aus dem Rezept-Pool (rechts) in die Slots ziehen.</div>
              <div><span className="font-semibold text-slate-900">🍳 KET / Küche</span> – Kitchen Equipment Tracking: zeigt alle Produktionsaufträge (Work Orders) aus dem Google Sheet, geordnet nach Produktionstag. Cards per Drag&amp;Drop in andere Tage verschieben, Klick auf Status schaltet weiter.</div>
              <div><span className="font-semibold text-slate-900">QR / URL</span> – Öffnet ein Modal mit QR-Code und direktem Link zu dieser Woche. Link direkt in Teams/WhatsApp teilen – Empfänger landen sofort auf der richtigen KW.</div>
              <div><span className="font-semibold text-slate-900">🎯 Zielwerte übernehmen</span> – Kopiert die aktuell berechneten Meals/h-Werte aller belegten Slots als Zielwerte. Danach werden Abweichungen farbig angezeigt (grün = on target, gelb/rot = Abweichung).</div>
              <div><span className="font-semibold text-slate-900">🤖 Auto-Plan</span> – Füllt alle leeren Slots automatisch nach Zielwerten und Rezept-Volumen. Bereits belegte Slots werden nicht überschrieben.</div>
              <div><span className="font-semibold text-slate-900">💾 Plan sichern</span> – Speichert die komplette Planung (Schedule, KET-Status, Zielwerte) in Firestore. Alle anderen Planer sehen die Änderungen sofort (Echtzeit-Sync).</div>
              <div><span className="font-semibold text-slate-900">Rezept-Pool (rechts)</span> – Zeigt alle Rezepte der KW mit Volumen pro Markt. Von hier per Drag&amp;Drop in Slots ziehen. Volumen-Balance unten zeigt Fortschritt.</div>
              <div><span className="font-semibold text-slate-900">P-Linienleistung</span> – Manuelle Soll-Kapazität (Portionen/h) pro Linie. Wird für Auto-Plan und Delta-Berechnung verwendet.</div>
              <div><span className="font-semibold text-slate-900">Ist / Ziel-Spalte</span> – Zeigt berechnete Meals/h des Slots vs. Zielwert. Grün = ±8%, gelb/rot = Abweichung. Zielwert direkt bearbeitbar.</div>
              <div><span className="font-semibold text-slate-900">JSON aktualisieren</span> – Das Rezept-Pool und KET-Daten kommen aus dem Google-Sheet-Dump unter <code className="bg-slate-100 px-1 rounded">public/data/</code>. Bei neuer KW: <code className="bg-slate-100 px-1 rounded">npm run dump</code> oder Script ausführen.</div>
            </div>
          </div>
        )}
      </div>

      {/* ─── LINIENPLANUNG TAB ────────────────────────────────────────────── */}
      {subTab === "lineplanning" && (
        <div className="overflow-x-auto">
        <div className="flex gap-4 items-start min-w-[860px]">

          {/* ── Schedule Grid ─────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Line header */}
            <div className="card px-4 py-2">
              <div className="grid gap-2" style={{ gridTemplateColumns: lineGridTemplate }}>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Tag</div>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Zeit</div>
                {LINES.map(l => (
                  <div key={l} className="text-xs font-semibold text-slate-600 text-center">{l}</div>
                ))}
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide text-right">Ist / Ziel</div>
              </div>
            </div>

            {DAYS.map(day => (
              <div key={day} className="card overflow-hidden">
                {/* Day header */}
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
                  <span className="font-bold text-sm text-slate-700">{day}</span>
                </div>

                <div className="divide-y divide-slate-50">
                  {SLOTS.map(slot => {
                    const mh = mealsPerHour(day, slot.key);
                    const slotComment = comments[`${day}|${slot.key}`] ?? "";
                    const targetKey = `${day}|${slot.key}`;
                    const fallbackTarget = LINES.reduce((sum, _line, li) => sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0), 0);
                    const targetMh = Math.max(0, targetMealsBySlot[targetKey] ?? fallbackTarget);
                    const deltaMh = mh - targetMh;
                    return (
                      <div key={slot.key} className="px-3 py-2">
                        <div className="grid gap-2 items-center" style={{ gridTemplateColumns: lineGridTemplate }}>
                          {/* Spacer (day already shown in header) */}
                          <div className="text-xs text-slate-400">{slot.duration < 60 ? `${slot.duration} min` : ""}</div>
                          {/* Time */}
                          <div className="text-xs font-mono text-slate-600 font-semibold">{slot.label}</div>

                          {/* 3 line cells */}
                          {LINES.map((_, li) => {
                            const cellKey = `${day}|${slot.key}|${li}`;
                            const r = schedule[cellKey] ?? null;
                            return (
                              <DropCell
                                key={cellKey}
                                slotKey={cellKey}
                                recipe={r}
                                isDragOver={dragOverKey === cellKey}
                                isActiveDrag={dragActive}
                                onDrop={() => onDropCell(cellKey)}
                                onDragEnter={() => onDragEnterCell(cellKey)}
                                onDragLeave={onDragLeaveCell}
                                onDragStartCell={onDragStartCell}
                                onRemove={() => dispatch({ type: "remove", key: cellKey })}
                                multiDayCount={r ? (scheduledDaysByCode.get(r.code)?.size ?? 1) : undefined}
                              />
                            );
                          })}

                          {/* Ist/Ziel + Delta */}
                          <div className="space-y-1 text-right">
                            <div className={`text-xs font-bold tabular-nums ${
                              mh > 0 ? "text-slate-700" : "text-slate-300"
                            }`}>
                              {mh > 0 ? fmtNum(mh) : "—"}
                              <span className="text-slate-400"> / </span>
                              <span className="text-indigo-700">{targetMh > 0 ? fmtNum(targetMh) : "—"}</span>
                            </div>
                            <div className={`text-[10px] font-semibold tabular-nums ${
                              targetMh <= 0 ? "text-slate-300" : Math.abs(deltaMh) <= Math.max(60, targetMh * 0.08) ? "text-emerald-600" : deltaMh > 0 ? "text-amber-600" : "text-rose-600"
                            }`}>
                              {targetMh <= 0 ? "" : (deltaMh >= 0 ? `+${fmtNum(deltaMh)}` : fmtNum(deltaMh))}
                            </div>
                            <input
                              type="number"
                              min={0}
                              value={targetMealsBySlot[targetKey] ?? ""}
                              onChange={e => {
                                const raw = e.target.value.trim();
                                setTargetMealsBySlot(prev => {
                                  const next = { ...prev };
                                  if (!raw) {
                                    delete next[targetKey];
                                  } else {
                                    next[targetKey] = Math.max(0, Number(raw) || 0);
                                  }
                                  return next;
                                });
                              }}
                              placeholder="Slot-Ziel (Meals/h)"
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-[10px] text-right font-semibold text-slate-700"
                            />
                          </div>
                        </div>

                        {/* Inline comment */}
                        <div className="mt-1 ml-[11.5rem]">
                          <input
                            type="text"
                            value={slotComment}
                            onChange={e => setComments(prev => ({
                              ...prev, [`${day}|${slot.key}`]: e.target.value
                            }))}
                            placeholder="Kommentar …"
                            className="w-full text-[11px] text-slate-500 bg-transparent border-none outline-none placeholder:text-slate-200 focus:placeholder:text-slate-300"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* ── Right Panel: Recipe Pool + Volume Balance ─────────────────── */}
          <div className="w-72 shrink-0 sticky top-4 space-y-3">

            {/* Plating line capacity inputs */}
            <div className="card p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Plating-Linienleistung</span>
                <button
                  type="button"
                  onClick={resetLineCapacityDefaults}
                  className="text-[10px] font-semibold rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
                >
                  Standard
                </button>
              </div>
              <div className="space-y-2">
                {LINES.map((line, li) => (
                  <label key={line} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-600">{line}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        step={50}
                        value={lineCapacityByLane[String(li)] ?? 0}
                        onChange={(e) => {
                          const value = Math.max(0, Number(e.target.value) || 0);
                          setLineCapacityByLane(prev => ({ ...prev, [String(li)]: value }));
                        }}
                        className="w-20 rounded-md border border-slate-300 px-2 py-1 text-right font-semibold text-slate-700"
                      />
                      <span className="text-[10px] text-slate-400">/h</span>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-slate-500">
                Wird als Auto-Plan-Ziel je Slot genutzt, wenn kein individuelles Slot-Ziel eingetragen ist.
              </div>
            </div>

            {/* Recipe pool */}
            <div
              className={`card p-3 transition-all ${
                dragActive ? "ring-2 ring-indigo-200 bg-indigo-50/30" : ""
              }`}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
              onDrop={e => { e.preventDefault(); onDropPool(); }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Rezept-Pool</span>
                <span className="text-xs text-slate-400">{recipes.length} Rezepte</span>
              </div>
              <div className="mb-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[10px] text-slate-500 ring-1 ring-slate-200">
                Rezepte können an <strong>mehreren Tagen</strong> eingeplant werden – einfach mehrfach aus dem Pool ziehen. Grüne Tages-Badges zeigen bereits geplante Tage.
              </div>
              {dragActive && (
                <div className="mb-2 rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50 p-2 text-center text-xs text-indigo-500 font-medium">
                  ← Hierher ziehen zum Entfernen
                </div>
              )}
              <div
                className="space-y-2"
                onDragEnd={onDragEnd}
              >
                {recipes.map(recipe => (
                  <RecipePill
                    key={recipe.code}
                    recipe={recipe}
                    scheduledDays={scheduledDaysByCode.has(recipe.code)
                      ? [...DAYS].filter(d => scheduledDaysByCode.get(recipe.code)!.has(d))
                      : undefined}
                    scheduledPortions={scheduledPortions.get(recipe.code)}
                    onDragStart={() => onDragStartPool(recipe)}
                  />
                ))}
                {recipes.length === 0 && (
                  <div className="text-xs text-slate-300 text-center py-4">Keine Rezepte geladen</div>
                )}
              </div>
            </div>

            {/* Volume Balance */}
            <div className="card p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Volumen-Balance</div>
              <div className="space-y-2">
                {recipes.map(recipe => (
                  <VolumeBar
                    key={recipe.code}
                    recipe={recipe}
                    scheduledPortions={scheduledPortions.get(recipe.code) ?? 0}
                  />
                ))}
                {recipes.length === 0 && (
                  <div className="text-xs text-slate-300 text-center py-3">—</div>
                )}
              </div>
            </div>

            {/* Day capacity overview */}
            <div className="card p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Tageskapazität</div>
              <div className="space-y-1.5">
                {DAYS.map(day => {
                  const totalMh = SLOTS.reduce((sum, slot) => sum + mealsPerHour(day, slot.key), 0);
                  const maxMh = SLOTS.reduce((sum, slot) => sum + LINES.length * slot.duration * 30, 0); // rough max
                  const pct = Math.min(100, (totalMh / (maxMh / 60)) * 100);
                  return (
                    <div key={day}>
                      <div className="flex justify-between text-xs mb-0.5">
                        <span className="text-slate-600 font-medium">{day.substring(0, 2)}</span>
                        <span className="tabular-nums text-slate-500">{fmtNum(totalMh)}/h</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-indigo-400 transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* ─── KET KANBAN TAB ──────────────────────────────────────────────── */}
      {subTab === "ket" && (
        <div className="flex gap-4 items-start">

          {/* ── Left panel: filter + recipe legend ────────────────────────── */}
          <div className="w-48 shrink-0 sticky top-4 space-y-3">
            <div className="card p-3 space-y-2">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Suche</div>
              <input
                type="text"
                value={ketSearch}
                onChange={e => setKetSearch(e.target.value)}
                placeholder="Rezept, WO-Nr …"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 pt-1">Status</div>
              <div className="flex flex-col gap-0.5">
                {([["all", "Alle"], ["open", "Offen"], ["done", "Fertig"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setKetStatusFilter(k)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-lg text-left transition-all ${
                      ketStatusFilter === k ? "bg-indigo-100 text-indigo-800" : "text-slate-500 hover:bg-slate-50"
                    }`}>{l}</button>
                ))}
              </div>
              <div className="text-[10px] text-slate-400 pt-1">{filteredKet.length} Aufträge</div>
            </div>

            {/* Recipe color legend */}
            {ketRecipeLegend.length > 0 && (
              <div className="card p-3">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Rezepte</div>
                <div className="space-y-1.5">
                  {ketRecipeLegend.map(({ code, name, count }) => (
                    <div key={code} style={pillStyle(code)} className="rounded-xl border px-2 py-1.5 text-xs">
                      <div className="font-bold">{code}</div>
                      <div className="opacity-70 truncate text-[10px]">{nameShort(name, 20)}</div>
                      <div className="opacity-50 text-[9px] tabular-nums">{count} Sub-Rezepte</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Kanban board ──────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0 overflow-x-auto">
            <div className="flex gap-3 pb-2" style={{ minWidth: `${ketDayColumns.length * 220}px` }}>
              {ketDayColumns.map(({ day, label, wos }) => (
                <KetDayColumn
                  key={day}
                  day={day}
                  label={label}
                  wos={wos}
                  isDragOver={ketDragOverDay === day}
                  onDragEnter={() => onKetDragEnterDay(day)}
                  onDragLeave={onKetDragLeaveDay}
                  onDrop={() => onKetDropDay(day)}
                  ketOverrides={ketOverrides}
                  onDragStart={onKetDragStart}
                  onDragEnd={onKetDragEnd}
                  onStatusCycle={onKetStatusCycle}
                  scheduledDaysByCode={scheduledDaysByCode}
                />
              ))}
              {ketDayColumns.length === 0 && (
                <div className="card p-8 text-center text-slate-400 w-full">
                  {ketSearch ? "Keine Treffer für diese Suche." : "Keine KET-Daten geladen."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── QR / URL Modal ───────────────────────────────────────────────── */}
      {showQrModal && (() => {
        const shareUrl = `${window.location.origin}${window.location.pathname}?view=ket&week=${encodeURIComponent(week)}`;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setShowQrModal(false)}
          >
            <div
              className="w-full max-w-sm rounded-[28px] bg-white p-6 shadow-2xl ring-1 ring-slate-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">
                Linienplanung teilen · KW {weekStr}
              </div>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(shareUrl)}`}
                alt="QR Code"
                className="mx-auto rounded-xl"
                width={200}
                height={200}
              />
              <div className="mt-3 break-all rounded-xl bg-slate-50 p-2 text-xs text-slate-600 ring-1 ring-slate-200">{shareUrl}</div>
              <button
                className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700"
                onClick={() => {
                  void navigator.clipboard.writeText(shareUrl);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2500);
                }}
              >
                {shareCopied ? "✓ Kopiert!" : "URL kopieren"}
              </button>
              <button
                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setShowQrModal(false)}
              >
                Schließen
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
