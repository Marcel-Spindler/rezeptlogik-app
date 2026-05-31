/**
 * LinePlanningView – Interaktive Linienplanung mit Drag-and-Drop
 *
 * Datenquelle: /data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json
 * Persistenz:  Firestore  apps/rezeptlogik/lineplanning/{week}
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { loadData } from "./dataSource";
import { usePlanningOasisData } from "./planningOasisData";
import { analyzePlan, type PlannerDay, type PlannerScenario } from "./planner";
import type { DataBundle, WeekRecipe } from "./types";
import type { UiLocale } from "./i18n";
import { calculateRunSplit, type RunSplitPlan } from "./runPlanning";
import { recordRampUpSnapshot, type RampUpSnapshot, type RampUpChangeEvent } from "./rampUpHistory";

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
  /** true wenn Rezept Fisch enthält (MHD 9 Tage) */
  isSeafood: boolean;
  /** true = Reinigungspause nach Rezeptwechsel (kein echtes Rezept) */
  isBreak?: boolean;
};

/** Heuristik: Rezeptname auf Fisch-Schlüsselwörter prüfen (kein Zugriff auf Zutaten nötig) */
function detectSeafoodByName(name: string): boolean {
  return /salmon|shrimp|prawn|fish|seafood|cod|tuna|trout|hering|herring|lachs|garnele|forelle|kabeljau|thunfisch/i.test(name);
}

function isProducedInVerden(recipe: WeekRecipe): boolean {
  const code = (recipe.code ?? "").toUpperCase();
  if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
  const total = (recipe.verdenVolume.BENL ?? 0) + (recipe.verdenVolume.DKSE ?? 0) + (recipe.verdenVolume.DE ?? 0);
  return total > 0;
}

function deriveRecipesFromWeekRecipes(weekRecipes: WeekRecipe[], requestedWeek: string, upliftFactor = 1): LinePlanRecipe[] {
  return weekRecipes
    .filter(recipe => recipe.hfWeek === requestedWeek)
    .filter(isProducedInVerden)
    .filter((recipe, index, all) => all.findIndex(other => other.code === recipe.code) === index)
    .sort((a, b) => b.totalVerdenVolume - a.totalVerdenVolume)
    .map((recipe) => ({
      code: recipe.code,
      name: recipe.recipeName,
      totalPlanned: Math.round(recipe.totalVerdenVolume * upliftFactor),
      nordics: Math.round(recipe.verdenVolume.DKSE * upliftFactor),
      bnl: Math.round(recipe.verdenVolume.BENL * upliftFactor),
      de: Math.round(recipe.verdenVolume.DE * upliftFactor),
      speedPerMin: 10,
      isSeafood: detectSeafoodByName(recipe.recipeName),
    }));
}

// Factor-Woche: Freitag (Produktion startet) → Donnerstag (Lieferwoche)
// Versandtag ist der Freitag NACH Donnerstag (= index 7, außerhalb des Arrays).
// MHD-Tage: Fisch 9d (maxGap=2d), Non-Fisch 13d (maxGap=6d).
// daysBeforeShipping für Index i = (DAYS.length - i) weil Donnerstag (idx 6) = 1 Tag vor Versand.
const DAYS = ["Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag", "Montag"] as const;
type PlanDay = (typeof DAYS)[number];

type CockpitRunReadiness = {
  startDay: PlanDay;
  readyDay: PlanDay;
  dueDay: PlanDay;
  portions: number;
  submealCount: number;
};

type ManufacturingPlanSnapshot = {
  savedAtIso: string;
  savedAtLabel?: string;
  week: string;
  scenarioId: string;
  scenarioName: string;
  assignments: PlannerScenario["assignments"];
  stats?: {
    plannedCount?: number;
    unplannedCount?: number;
  };
};

type ForecastVarianceRow = {
  code: string;
  recipeName: string;
  forecastPortions: number;
  targetPortions: number;
  delta: number;
};

type LineCollisionHint = {
  key: string;
  severity: "error" | "warn";
  domain: "volume" | "readiness" | "mhd" | "slot" | "run";
  location: string;
  message: string;
  action: string;
  cellKey?: string;
  recipeCode?: string;
};

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

const PLANNER_DAY_TO_PLAN_DAY: Record<PlannerDay, PlanDay> = {
  Mo: "Montag",
  Di: "Dienstag",
  Mi: "Mittwoch",
  Do: "Donnerstag",
  Fr: "Freitag",
  Sa: "Samstag",
  So: "Sonntag",
};

const RUN_ONE_SUB_DAYS: readonly PlannerDay[] = ["So", "Mo", "Di", "Mi", "Do"];
const RUN_TWO_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do", "Fr"];

const RUN_PLATING_WINDOWS: Record<1 | 2, { startDay: PlanDay; dueDay: PlanDay }> = {
  1: { startDay: "Dienstag", dueDay: "Freitag" },
  2: { startDay: "Mittwoch", dueDay: "Samstag" },
};

const SLOTS: ReadonlyArray<{ key: string; label: string; duration: number }> = [
  { key: "07:00-08:00", label: "07 – 08", duration: 60 },
  { key: "08:00-09:00", label: "08 – 09", duration: 60 },
  { key: "09:00-10:00", label: "09 – 10", duration: 60 },
  { key: "10:00-11:00", label: "10 – 11", duration: 60 },
  { key: "11:00-12:00", label: "11 – 12", duration: 60 },
  { key: "12:00-13:00", label: "12 – 13", duration: 60 },
  { key: "13:00-14:00", label: "13 – 14", duration: 60 },
  { key: "14:00-15:00", label: "14 – 15", duration: 60 },
  { key: "15:00-16:00", label: "15 – 16", duration: 60 },
  { key: "16:00-17:00", label: "16 – 17", duration: 60 },
];

const LINES = ["P-Linie 1", "P-Linie 2", "P-Linie 3"] as const;
type DayLineCount = 0 | 1 | 2 | 3;

const DEFAULT_DAY_LINE_COUNT: Record<PlanDay, DayLineCount> = {
  Montag: 1,
  Dienstag: 3,
  Mittwoch: 3,
  Donnerstag: 3,
  Freitag: 2,
  Samstag: 1,
  Sonntag: 0,
};
const DAY_LINE_COUNT_ORDER: readonly PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const MEAL_CHANGE_BREAK: LinePlanRecipe = {
  code: "__BREAK__",
  name: "Reinigung & Zählung (1h)",
  totalPlanned: 0, nordics: 0, bnl: 0, de: 0, speedPerMin: 0,
  isSeafood: false, isBreak: true,
};


function defaultLineCapacityMap(): Record<string, number> {
  return {
    "0": 1200,
    "1": 1200,
    "2": 1200,
  };
}

function defaultDayLineCountMap(): Record<PlanDay, DayLineCount> {
  return { ...DEFAULT_DAY_LINE_COUNT };
}

function normalizeDayLineCountMap(input?: Record<string, number> | null): Record<PlanDay, DayLineCount> {
  const next = defaultDayLineCountMap();
  for (const day of DAYS) {
    const raw = input?.[day];
    if (raw === 0 || raw === 1 || raw === 2 || raw === 3) next[day] = raw;
  }
  return next;
}

type ScheduleMap = Record<string, LinePlanRecipe | null>;  // key: `${day}|${slotKey}|${lineIdx}`

type DragPayload = {
  recipe: LinePlanRecipe;
  source: "pool" | string;  // "pool" or slot key
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

// @ts-expect-error unused
function _pillStyle(code: string): React.CSSProperties {
  return recipeTone(code).base;
}

function nameShort(name: string, max = 30): string {
  const trimmed = name.replace(/\[.*?\]/g, "").trim();
  return trimmed.length > max ? trimmed.substring(0, max - 1) + "…" : trimmed;
}

function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

function planningRoleTone(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "bg-sky-50 text-sky-800 ring-sky-200";
  if (role === "supplied") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-emerald-50 text-emerald-800 ring-emerald-200";
}

function planningRoleLabel(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "Hybrid";
  if (role === "supplied") return "Zulieferung";
  return "Eigene Produktion";
}

function slotDuration(slotKey: string): number {
  return SLOTS.find(s => s.key === slotKey)?.duration ?? 0;
}

function portionsInSlotByLineCapacity(lineCapacityPerHour: number, slotKey: string): number {
  return (Math.max(0, lineCapacityPerHour) / 60) * slotDuration(slotKey);
}

function runSplitForLineRecipe(recipe: LinePlanRecipe): RunSplitPlan {
  return calculateRunSplit({
    bnl: recipe.bnl,
    nordics: recipe.nordics,
    de: recipe.de,
  });
}

function lineRunTargetsForRecipe(recipe: LinePlanRecipe): { firstRunTarget: number; secondRunTarget: number; totalTarget: number } {
  const split = runSplitForLineRecipe(recipe);
  const totalTarget = Math.max(0, Math.round(recipe.totalPlanned || split.baseTotal));
  const firstRunTarget = Math.max(0, Math.min(totalTarget, split.firstRun.total || 0));
  return {
    firstRunTarget,
    secondRunTarget: Math.max(0, totalTarget - firstRunTarget),
    totalTarget,
  };
}

function normalizePlanDay(raw: string): PlanDay | null {
  const clean = String(raw ?? "").trim();
  if (!clean) return null;
  if ((DAYS as readonly string[]).includes(clean)) return clean as PlanDay;
  if ((["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as readonly string[]).includes(clean)) {
    return PLANNER_DAY_TO_PLAN_DAY[clean as PlannerDay];
  }
  const mapped = DAY_EN_TO_DE[clean];
  return mapped && (DAYS as readonly string[]).includes(mapped) ? mapped as PlanDay : null;
}

function planDayIndex(day: PlanDay): number {
  const index = DAYS.indexOf(day);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function planDayCompare(left: PlanDay, right: PlanDay): number {
  return planDayIndex(left) - planDayIndex(right);
}

// @ts-expect-error unused
function _laterPlanDay(left: PlanDay, right: PlanDay): PlanDay {
  return planDayCompare(left, right) >= 0 ? left : right;
}

function runReadyDayIndex(day: PlanDay, run: 1 | 2): number {
  if (run === 1 && day === "Sonntag") return -1;
  const order: PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const index = order.indexOf(day);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function laterRunReadyDay(left: PlanDay, right: PlanDay, run: 1 | 2): PlanDay {
  return runReadyDayIndex(left, run) >= runReadyDayIndex(right, run) ? left : right;
}

function nextPlanDay(day: PlanDay): PlanDay {
  const idx = planDayIndex(day);
  return idx < DAYS.length - 1 ? DAYS[idx + 1] : day;
}

function parseLineBoardNote(note?: string): { notes: string } {
  const raw = String(note ?? "").trim();
  if (!raw) return { notes: "" };
  const notesPart = raw.split("||").find((part) => part.startsWith("notes=")) ?? "";
  return { notes: notesPart ? notesPart.slice(6).trim() : "" };
}

function loadManufacturingPlanSnapshot(week: string): ManufacturingPlanSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`rezeptlogik-plan-snapshot-${week}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ManufacturingPlanSnapshot>;
    if (!parsed || parsed.week !== week || !parsed.assignments || typeof parsed.assignments !== "object") return null;
    return {
      savedAtIso: String(parsed.savedAtIso ?? ""),
      savedAtLabel: parsed.savedAtLabel ? String(parsed.savedAtLabel) : undefined,
      week,
      scenarioId: String(parsed.scenarioId ?? "snapshot"),
      scenarioName: String(parsed.scenarioName ?? "Gesicherter Küchenplan"),
      assignments: parsed.assignments as PlannerScenario["assignments"],
    };
  } catch {
    return null;
  }
}

function manufacturingSnapshotSignature(snapshot: ManufacturingPlanSnapshot | null): string {
  if (!snapshot) return "";
  return JSON.stringify(snapshot.assignments ?? {});
}

function extractLineSplitSpec(notes: string): string {
  const match = /(?:^|\s)split=([^\s]+)/i.exec(String(notes ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

function parseLineSplitSpecToBatches(
  splitSpec: string,
  fallbackDay: PlannerDay,
  totalTarget: number,
): Array<{ day: PlannerDay; portions: number }> {
  const tokens = splitSpec.split("|").map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 0) return totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];
  const parsed: Array<{ day: PlannerDay; portions: number }> = [];
  for (const token of tokens) {
    const [rawDay, rawPortions] = token.split(":");
    if (!rawDay || !rawPortions) continue;
    const day = rawDay.trim() as PlannerDay;
    if (!(day in PLANNER_DAY_TO_PLAN_DAY)) continue;
    const portions = Math.max(0, Math.round(Number(rawPortions) || 0));
    if (portions > 0) parsed.push({ day, portions });
  }
  return parsed.length > 0 ? parsed : totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];
}

function resolveCockpitRunBatches(
  mainBatches: Array<{ day: PlannerDay; portions: number }>,
  targets: { firstRunTarget: number; secondRunTarget: number },
): Partial<Record<1 | 2, { day: PlannerDay; portions: number }>> {
  const runOneFromSplit = mainBatches.find((batch) => batch.day === "Fr") ?? mainBatches[0];
  const runTwoFromSplit = mainBatches.find((batch) => batch.day === "So") ?? mainBatches[1];
  const out: Partial<Record<1 | 2, { day: PlannerDay; portions: number }>> = {};
  if (targets.firstRunTarget > 0) {
    out[1] = {
      day: runOneFromSplit?.day ?? "Fr",
      portions: Math.max(0, Math.round(runOneFromSplit?.portions ?? targets.firstRunTarget)),
    };
  }
  if (targets.secondRunTarget > 0) {
    out[2] = {
      day: runTwoFromSplit?.day ?? "So",
      portions: Math.max(0, Math.round(runTwoFromSplit?.portions ?? targets.secondRunTarget)),
    };
  }
  return out;
}

function distributedRunSubDay(runIndex: number, subIndex: number): PlannerDay {
  const window = runIndex === 0 ? RUN_ONE_SUB_DAYS : RUN_TWO_SUB_DAYS;
  const offset = runIndex === 0 ? 0 : 2;
  return window[(subIndex + offset) % window.length] ?? window[0];
}

/**
 * Bewertet Tag `day` für einen Run anhand tatsächlicher Küchen-Bereitschaft.
 * Gate: 0 wenn Küche noch nicht fertig (day < readyDay) oder Deadline überschritten.
 * Höchste Bewertung genau am readyDay (sofort starten sobald Küche fertig).
 */
function cockpitScoreForDay(day: PlanDay, rule: CockpitRunReadiness): number {
  const dayIdx = planDayIndex(day);
  const readyIdx = planDayIndex(rule.readyDay);  // erster gültiger Plating-Tag lt. Küchen-Plan
  const dueIdx = planDayIndex(rule.dueDay);
  if (dayIdx < readyIdx || dayIdx > dueIdx) return 0;
  if (dayIdx === readyIdx) return 1.0;
  if (dayIdx === dueIdx) return 0.82;
  const span = Math.max(1, dueIdx - readyIdx);
  return 1.0 - ((dayIdx - readyIdx) / span) * 0.18;
}

/**
 * Gibt zurück welcher Run an einem Tag eindeutig aktiv ist.
 * Overlap-Tage (Mittwoch/Donnerstag sind in Run 1 + Run 2) → null, Fallback entscheidet.
 */
function cockpitRunForDay(day: PlanDay): 1 | 2 | null {
  const idx = planDayIndex(day);
  const in1 = idx >= planDayIndex(RUN_PLATING_WINDOWS[1].startDay) && idx <= planDayIndex(RUN_PLATING_WINDOWS[1].dueDay);
  const in2 = idx >= planDayIndex(RUN_PLATING_WINDOWS[2].startDay) && idx <= planDayIndex(RUN_PLATING_WINDOWS[2].dueDay);
  if (in1 && !in2) return 1;
  if (in2 && !in1) return 2;
  return null; // Mi/Do: in beiden Runs → nach Produktionsstand entscheiden
}

function emptyRunProduction(): Record<1 | 2, number> {
  return { 1: 0, 2: 0 };
}

// @ts-expect-error unused
function _runWindowDays(run: 1 | 2): PlanDay[] {
  const { startDay, dueDay } = RUN_PLATING_WINDOWS[run];
  const startIdx = planDayIndex(startDay);
  const dueIdx = planDayIndex(dueDay);
  if (startIdx < 0 || dueIdx < startIdx) return [startDay];
  return DAYS.slice(startIdx, dueIdx + 1) as PlanDay[];
}

function slotFitsRemaining(slotPortions: number, remaining: number): boolean {
  if (remaining <= 0) return false;
  if (slotPortions <= remaining) return true;
  const toleratedOver = Math.max(150, slotPortions * 2.0);
  return slotPortions - remaining <= toleratedOver;
}

function mhdRunWindow(recipe: LinePlanRecipe, run: 1 | 2): ReadonlyArray<PlanDay> {
  if (recipe.isSeafood) {
    return run === 1 ? ["Dienstag", "Mittwoch"] : ["Mittwoch", "Donnerstag", "Freitag"];
  }
  return run === 1
    ? ["Dienstag", "Mittwoch", "Donnerstag"]
    : ["Mittwoch", "Donnerstag", "Freitag", "Samstag"];
}

function recommendedRunDay(run: 1 | 2): PlanDay {
  return run === 1 ? "Mittwoch" : "Freitag";
}

function runWindowScore(day: PlanDay, window: ReadonlyArray<PlanDay>, preferred: PlanDay): number {
  if (day === preferred) return 1;
  if (window.includes(day)) return 0.72;
  return 0.06;
}

function planDayDistance(a: PlanDay, b: PlanDay): number {
  const order: PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai < 0 || bi < 0) return 3;
  return Math.abs(ai - bi);
}

function runBadgeTone(run: 1 | 2): string {
  return run === 1
    ? "bg-indigo-50 text-indigo-700 border-indigo-200"
    : "bg-teal-50 text-teal-700 border-teal-200";
}

function collisionTone(severity: LineCollisionHint["severity"]): string {
  return severity === "error"
    ? "border-rose-300 bg-rose-50 text-rose-900"
    : "border-amber-300 bg-amber-50 text-amber-900";
}

function collisionPillTone(severity: LineCollisionHint["severity"]): string {
  return severity === "error"
    ? "bg-rose-100 text-rose-800 ring-rose-300"
    : "bg-amber-100 text-amber-800 ring-amber-300";
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
      isSeafood: detectSeafoodByName((row[10] ?? code).trim()),
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

// Module-level drag payload (avoids stale closures across handler callbacks)
let _drag: DragPayload | null = null;

function normalizeMealChangeBreaks(input: ScheduleMap, lineIdxs: number[]): ScheduleMap {
  const next: ScheduleMap = { ...input };
  for (const day of DAYS) {
    for (const li of lineIdxs) {
      const meals = SLOTS
        .map((slot) => next[`${day}|${slot.key}|${li}`] ?? null)
        .filter((recipe): recipe is LinePlanRecipe => !!recipe && !recipe.isBreak);
      const output: Array<LinePlanRecipe | null> = [];
      let previousCode: string | null = null;

      for (const meal of meals) {
        if (previousCode && meal.code !== previousCode && output.length < SLOTS.length) {
          output.push(MEAL_CHANGE_BREAK);
        }
        if (output.length < SLOTS.length) {
          output.push(meal);
          previousCode = meal.code;
        }
      }

      if (meals.length > 0 && output.length < SLOTS.length) {
        output.push(MEAL_CHANGE_BREAK);
      }

      SLOTS.forEach((slot, index) => {
        next[`${day}|${slot.key}|${li}`] = output[index] ?? null;
      });
    }
  }
  return next;
}

function schedulesEqual(left: ScheduleMap, right: ScheduleMap): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  RECIPE PILL
// ══════════════════════════════════════════════════════════════════════════════

const DAY_SHORT: Record<string, string> = {
  Freitag: "Fr", Samstag: "Sa", Sonntag: "So",
  Montag: "Mo", Dienstag: "Di", Mittwoch: "Mi", Donnerstag: "Do",
};

function Sparkline({ values, width = 60, height = 16 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((max - v) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#10b981" : last < first ? "#f43f5e" : "#94a3b8";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={pts.split(" ").pop()!.split(",")[0]} cy={pts.split(" ").pop()!.split(",")[1]} r="2" fill={stroke} />
    </svg>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span className={`text-[9px] font-bold tabular-nums px-1 rounded-full ring-1 ${
      up ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200"
    }`}>
      {up ? "+" : ""}{fmtNum(delta)}
    </span>
  );
}

function RecipePill({
  recipe, compact = false, dimmed = false,
  scheduledDays,
  scheduledPortions,
  planningRole,
  multiDayCount,
  mhdViolation,
  collisions = [],
  onDragStart,
  volumeHistory,
  volumeDelta,
  volumeSnapshots,
}: {
  recipe: LinePlanRecipe;
  compact?: boolean;
  dimmed?: boolean;
  scheduledDays?: string[];
  scheduledPortions?: number;
  planningRole?: "factory" | "hybrid" | "supplied";
  multiDayCount?: number;
  mhdViolation?: boolean;
  collisions?: LineCollisionHint[];
  onDragStart?: () => void;
  volumeHistory?: number[];
  volumeDelta?: number;
  volumeSnapshots?: RampUpSnapshot[];
}) {
  if (recipe.isBreak) {
    return (
      <div
        className={`rounded-xl border border-amber-300 bg-amber-50 ring-1 ring-amber-200/60 select-none ${compact ? "px-2 py-1.5" : "px-3 py-2.5"}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-sm">🧹</span>
          <span className="font-bold text-xs text-amber-700">Pause – Reinigung & Zählung</span>
        </div>
        <div className="text-[10px] text-amber-500 mt-0.5">1 Stunde · Rezeptwechsel</div>
      </div>
    );
  }

  const tone = recipeTone(recipe.code);
  const style = tone.base;
  const runTargets = lineRunTargetsForRecipe(recipe);
  const targetTotal = runTargets.totalTarget;
  const pct = targetTotal > 0 && scheduledPortions !== undefined
    ? scheduledPortions / targetTotal
    : 0;
  const fullyPlanned = pct >= 1;
  const overPlanned = pct > 1.02;
  const worstCollision = collisions.find((item) => item.severity === "error") ?? collisions[0];
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
            <div className="flex items-center gap-1">
              <span className="font-bold text-xs shrink-0" style={tone.code}>{recipe.code}</span>
              {recipe.isSeafood
                ? <span className="rounded-full px-1.5 py-0 text-[9px] font-bold bg-blue-100 text-blue-700 ring-1 ring-blue-200">🐟 9d</span>
                : <span className="rounded-full px-1.5 py-0 text-[9px] font-bold bg-slate-100 text-slate-500 ring-1 ring-slate-200">13d</span>
              }
              {worstCollision && (
                <span
                  className={`rounded-full px-1.5 py-0 text-[9px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`}
                  title={worstCollision.message}
                >
                  !
                </span>
              )}
            </div>
            <span className="text-[11px] font-medium leading-tight line-clamp-2" style={tone.title}>{recipe.name.replace(/^FV\d+[A-Za-z]?\s*[-\u2013]\s*/i, "")}</span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] opacity-50 tabular-nums">{fmtNum(targetTotal)} Port.</span>
              {volumeDelta !== undefined && volumeDelta !== 0 && <DeltaBadge delta={volumeDelta} />}
            </div>
            {volumeHistory && volumeHistory.length >= 2 && (
              <div className="mt-1 flex items-center gap-2">
                <Sparkline values={volumeHistory} width={40} height={12} />
                <span className="text-[9px] text-slate-400 tabular-nums">{fmtNum(volumeHistory[0])} → {fmtNum(volumeHistory[volumeHistory.length - 1])}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-sm tracking-tight" style={tone.code}>{recipe.code}</span>
                {recipe.isSeafood
                  ? <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 ring-1 ring-blue-200">🐟 9d</span>
                  : <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-500 ring-1 ring-slate-200">13d</span>
                }
                {worstCollision && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`}
                    title={worstCollision.message}
                  >
                    Kollision
                  </span>
                )}
              </div>
              <span className="text-xs opacity-60 tabular-nums">{recipe.speedPerMin}/min</span>
            </div>
            <div className="text-xs font-medium truncate mb-2" style={tone.title}>{nameShort(recipe.name, 34)}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs opacity-70 tabular-nums">
              {recipe.nordics > 0 && <span>&#x2B21; NORD {fmtNum(recipe.nordics)}</span>}
              {recipe.de > 0 && <span>&#x2B21; DE {fmtNum(recipe.de)}</span>}
              {recipe.bnl > 0 && <span>&#x2B21; BNL {fmtNum(recipe.bnl)}</span>}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-xs font-semibold tabular-nums">&#x2211; {fmtNum(targetTotal)} Portionen · R1 {fmtNum(runTargets.firstRunTarget)} / R2 {fmtNum(runTargets.secondRunTarget)}</span>
              {volumeDelta !== undefined && volumeDelta !== 0 && <DeltaBadge delta={volumeDelta} />}
            </div>
            {volumeHistory && volumeHistory.length >= 2 && (
              <div className="mt-1.5 flex items-center gap-2">
                <Sparkline values={volumeHistory} width={60} height={16} />
                <span className="text-[10px] text-slate-400 tabular-nums">{fmtNum(volumeHistory[0])} → {fmtNum(volumeHistory[volumeHistory.length - 1])}</span>
              </div>
            )}
            <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${planningRoleTone(planningRole)}`}>
              {planningRoleLabel(planningRole)}
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
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
            <span className="font-black text-base" style={tone.code}>{recipe.code}</span>
            <span className="font-semibold text-slate-700 text-xs leading-tight mt-0.5">{recipe.name}</span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {mhdViolation && (
                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-black text-orange-700 ring-1 ring-orange-200">
                  MHD
                </span>
              )}
              {worstCollision && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`}>
                  Kollision
                </span>
              )}
              {multiDayCount && multiDayCount > 1 && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-black text-indigo-700 ring-1 ring-indigo-200">
                  {multiDayCount} Tage
                </span>
              )}
              {overPlanned && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700 ring-1 ring-rose-200">
                  überplant
                </span>
              )}
              {!overPlanned && fullyPlanned && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-700 ring-1 ring-emerald-200">
                  fertig
                </span>
              )}
            </div>
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
          {collisions.length > 0 && (
            <div className="mb-3 space-y-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
              {collisions.slice(0, 3).map((item) => (
                <div key={item.key}>
                  <span className="font-black">{item.location}:</span> {item.message}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-xs mb-2 pb-2 border-b border-slate-100">
            <span className="text-slate-500">&#x2211; Geplant</span>
            <span className="font-bold tabular-nums text-slate-800">{fmtNum(targetTotal)} Port.</span>
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
          {volumeSnapshots && volumeSnapshots.length >= 2 && (
            <div className="pt-2 border-t border-slate-100 mt-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] text-slate-400 font-semibold">Portionen-Verlauf</span>
                <Sparkline values={volumeSnapshots.map(s => s.volumes[recipe.code] ?? 0)} width={50} height={14} />
              </div>
              <div className="flex flex-col gap-0.5">
                {volumeSnapshots.slice(-5).reverse().map((snap, idx) => {
                  const vol = snap.volumes[recipe.code] ?? 0;
                  const prev = volumeSnapshots[volumeSnapshots.indexOf(snap) - 1]?.volumes[recipe.code];
                  const delta = prev !== undefined ? vol - prev : 0;
                  return (
                    <div key={snap.ts} className={`flex items-center justify-between text-[10px] ${idx === 0 ? "font-semibold text-slate-700" : "text-slate-400"}`}>
                      <span className="tabular-nums">{snap.label}</span>
                      <span className="tabular-nums">{fmtNum(vol)}</span>
                      {delta !== 0 && <DeltaBadge delta={delta} />}
                    </div>
                  );
                })}
              </div>
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
  onDragStartCell, onRemove, multiDayCount, mhdViolation,
  collisions = [],
  volumeHistory, volumeDelta, volumeSnapshots,
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
  /** true wenn das Rezept in diesem Slot zu früh geplattet wird (MHD-Verletzung) */
  mhdViolation?: boolean;
  collisions?: LineCollisionHint[];
  volumeHistory?: number[];
  volumeDelta?: number;
  volumeSnapshots?: RampUpSnapshot[];
}) {
  const worstCollision = collisions.find((item) => item.severity === "error") ?? collisions[0];
  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragEnter(); }}
      onDragEnter={e => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(); }}
      className={`min-h-[5rem] rounded-xl border-2 transition-all duration-100 flex items-stretch ${
        recipe?.isBreak
          ? "border-amber-200 bg-amber-50/60"
          : isDragOver
          ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300/50 scale-[1.03]"
          : worstCollision
          ? `${worstCollision.severity === "error" ? "border-rose-500 bg-rose-50/60 ring-1 ring-rose-300/70" : "border-amber-400 bg-amber-50/60 ring-1 ring-amber-300/70"}`
          : mhdViolation
          ? "border-orange-400 bg-orange-50/40 ring-1 ring-orange-300/50"
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
            multiDayCount={multiDayCount}
            mhdViolation={mhdViolation}
            collisions={collisions}
            onDragStart={() => onDragStartCell(recipe, slotKey)}
            volumeHistory={volumeHistory}
            volumeDelta={volumeDelta}
            volumeSnapshots={volumeSnapshots}
          />
          {worstCollision && (
            <div
              className={`mt-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${collisionPillTone(worstCollision.severity)}`}
              title={worstCollision.action}
            >
              {worstCollision.message}
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
  const runTargets = lineRunTargetsForRecipe(recipe);
  const targetTotal = runTargets.totalTarget;
  const pct = targetTotal > 0 ? Math.min(100, (scheduledPortions / targetTotal) * 100) : 0;
  const h = recipeHue(recipe.code);
  const over = scheduledPortions > targetTotal;
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
          <div className="mt-0.5 text-[10px] text-slate-400 tabular-nums">{fmtNum(scheduledPortions)}/{fmtNum(targetTotal)}</div>
          <div className="mt-1 flex items-center justify-end gap-1">
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${runBadgeTone(1)}`}>
              R1 {fmtNum(runTargets.firstRunTarget)}
            </span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${runBadgeTone(2)}`}>
              R2 {fmtNum(runTargets.secondRunTarget)}
            </span>
          </div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{
          width: `${Math.min(100, pct)}%`,
          background: over ? `hsl(0,75%,60%)` : `hsl(${h},55%,60%)`,
        }} />
      </div>
      {over && <div className="text-[10px] text-rose-500 mt-1">+{fmtNum(scheduledPortions - targetTotal)} überplant</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN VIEW
// ══════════════════════════════════════════════════════════════════════════════

export function LinePlanningView({ week, locale: _locale, autoPlanTrigger, upliftPercent = 0 }: { week: string; locale: UiLocale; autoPlanTrigger?: number; upliftPercent?: number }) {
  const { data: planningOasis } = usePlanningOasisData();
  const [recipes, setRecipes] = useState<LinePlanRecipe[]>([]);
  const [appData, setAppData] = useState<DataBundle | null>(null);
  const [manufacturingSnapshot, setManufacturingSnapshot] = useState<ManufacturingPlanSnapshot | null>(() => loadManufacturingPlanSnapshot(week));
  const [schedule, dispatch] = useReducer(scheduleReducer, {});
  const [, setWeekNum] = useState(0);
  const [totalVolume, setTotalVolume] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setDataWarning] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [targetMealsBySlot, setTargetMealsBySlot] = useState<Record<string, number>>({});
  const [lineCapacityByLane, setLineCapacityByLane] = useState<Record<string, number>>(defaultLineCapacityMap);
  const [platingLineCount, setPlatingLineCount] = useState<1 | 2 | 3>(3);
  const [dayLineCount, setDayLineCount] = useState<Record<PlanDay, DayLineCount>>(defaultDayLineCountMap);
  const [autoPlanNotice, setAutoPlanNotice] = useState<string>("");
  const [pendingSnapshotAutoplan, setPendingSnapshotAutoplan] = useState(0);
  const [forecastAutoThreshold, setForecastAutoThreshold] = useState<number>(() => {
    if (typeof window === "undefined") return 100;
    const raw = window.localStorage.getItem("rezeptlogik-forecast-auto-threshold");
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 100;
  });
  const [forecastAlertRows, setForecastAlertRows] = useState<ForecastVarianceRow[]>([]);
  const [forecastAlertStamp, setForecastAlertStamp] = useState<string | null>(null);
  const [rampUpHistoryMap, setRampUpHistoryMap] = useState<Map<string, RampUpSnapshot[]>>(new Map());
  const [rampUpChanges, setRampUpChanges] = useState<RampUpChangeEvent[]>([]);
  const [rampUpBannerDismissed, setRampUpBannerDismissed] = useState(false);
  const dragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoPlanTriggerRef = useRef<number | undefined>(autoPlanTrigger);
  const lastLinePlanAutosaveSignatureRef = useRef<string>("");
  const linePlanAutosaveInitializedRef = useRef(false);
  const lastManufacturingReconcileRequestRef = useRef<string>("");
  const lastManufacturingSnapshotSignatureRef = useRef<string>(manufacturingSnapshotSignature(manufacturingSnapshot));
  const ignoreRemoteLinePlanUntilRef = useRef(0);
  const weekStr = week.split("-W")[1] ?? week;
  const hasSavedManufacturingPlan = !!manufacturingSnapshot && Object.keys(manufacturingSnapshot.assignments ?? {}).length > 0;
  const activeLineIdx = useMemo(() => Array.from({ length: LINES.length }, (_, idx) => idx), []);
  const activeLineIdxByDay = useMemo(() => {
    return Object.fromEntries(
      DAYS.map((day) => [day, Array.from({ length: Math.max(0, dayLineCount[day] ?? 0) }, (_, idx) => idx)])
    ) as Record<PlanDay, number[]>;
  }, [dayLineCount]);
  const weekIntel = planningOasis?.weeks[week] ?? null;

  useEffect(() => {
    const normalized = normalizeMealChangeBreaks(schedule, activeLineIdx);
    if (!schedulesEqual(schedule, normalized)) {
      dispatch({ type: "load", schedule: normalized });
    }
  }, [activeLineIdx, schedule]);

  const runSplitByRecipe = useMemo(() => {
    return Object.fromEntries(
      recipes.map((recipe) => [recipe.code, runSplitForLineRecipe(recipe)])
    ) as Record<string, RunSplitPlan>;
  }, [recipes]);
  const recipePlanTotal = useMemo(
    () => recipes.reduce((sum, recipe) => sum + Math.max(0, Math.round(recipe.totalPlanned || 0)), 0),
    [recipes]
  );
  const subMealRecipeCodes = useMemo(() => {
    const codes = new Set<string>();
    if (!planningOasis) return codes;
    for (const recipe of recipes) {
      const wos = planningOasis.recipes[recipe.code]?.workOrders ?? [];
      if (wos.some(wo => wo.subRecipeName?.trim())) codes.add(recipe.code);
    }
    return codes;
  }, [planningOasis, recipes]);
  const runTargetsByRecipe = useMemo(() => {
    const map = new Map<string, { firstRunTarget: number; secondRunTarget: number; totalTarget: number }>();
    for (const recipe of recipes) {
      const base = lineRunTargetsForRecipe(recipe);
      let totalTarget = base.totalTarget;
      let firstRunTarget = base.firstRunTarget;
      let secondRunTarget = base.secondRunTarget;

      const forecastPortions = Math.max(0, Math.round(planningOasis?.recipes[recipe.code]?.forecastTotal ?? 0));
      if (forecastPortions > 0) {
        const fluctuation = forecastPortions - totalTarget;
        // Forecast-Fluktuation wird zuerst in Run 2 verarbeitet, Run 1 bleibt stabil planbar.
        secondRunTarget = Math.max(0, secondRunTarget + fluctuation);
        totalTarget = firstRunTarget + secondRunTarget;
      }

      if (subMealRecipeCodes.has(recipe.code) && totalTarget > 1 && secondRunTarget <= 0) {
        secondRunTarget = Math.max(1, Math.round(totalTarget * 0.35));
        if (secondRunTarget >= totalTarget) secondRunTarget = totalTarget - 1;
        firstRunTarget = totalTarget - secondRunTarget;
      }

      map.set(recipe.code, { firstRunTarget, secondRunTarget, totalTarget });
    }
    return map;
  }, [planningOasis?.recipes, recipes, subMealRecipeCodes]);
  // @ts-expect-error unused
  const _recipeByCode = useMemo(() => {
    return new Map(recipes.map((recipe) => [recipe.code, recipe] as const));
  }, [recipes]);
  const forecastVarianceRows = useMemo<ForecastVarianceRow[]>(() => {
    return recipes
      .map((recipe) => {
        const forecastPortions = Math.max(0, Math.round(planningOasis?.recipes[recipe.code]?.forecastTotal ?? 0));
        const targetPortions = Math.max(0, Math.round(recipe.totalPlanned || 0));
        const delta = forecastPortions - targetPortions;
        return {
          code: recipe.code,
          recipeName: recipe.name,
          forecastPortions,
          targetPortions,
          delta,
        };
      })
      .filter((row) => row.forecastPortions > 0 && row.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  }, [planningOasis?.recipes, recipes]);
  const forecastVarianceSignature = useMemo(() => {
    return JSON.stringify(
      forecastVarianceRows.map((row) => ({ code: row.code, forecast: row.forecastPortions, target: row.targetPortions }))
    );
  }, [forecastVarianceRows]);
  const linePlanAutosaveSignature = useMemo(() => JSON.stringify({
    schedule,
    comments,
    targetMealsBySlot,
    lineCapacityByLane,
    platingLineCount,
    dayLineCount,
    runSplitByRecipe,
  }), [comments, dayLineCount, lineCapacityByLane, platingLineCount, runSplitByRecipe, schedule, targetMealsBySlot]);
  const cockpitRunReadiness = useMemo(() => {
    const map = new Map<string, Partial<Record<1 | 2, CockpitRunReadiness>>>();
    if (!appData || !manufacturingSnapshot) return map;
    try {
      const scenario: PlannerScenario = {
        id: manufacturingSnapshot.scenarioId || "snapshot",
        name: manufacturingSnapshot.scenarioName || "Gesicherter Küchenplan",
        assignments: manufacturingSnapshot.assignments,
      };
      const analysis = analyzePlan(appData, week, scenario);
      for (const recipeSummary of analysis.recipes) {
        const targets = runTargetsByRecipe.get(recipeSummary.recipeCode);
        const totalTarget = Math.max(0, targets?.totalTarget ?? 0);
        const mainAssignment = recipeSummary.assigned;
        const mainBatches = mainAssignment
          ? parseLineSplitSpecToBatches(
              extractLineSplitSpec(parseLineBoardNote(mainAssignment.note).notes),
              mainAssignment.day,
              Math.max(0, Math.round(mainAssignment.targetPortions ?? totalTarget)),
            )
          : [
              ...(targets && targets.firstRunTarget > 0 ? [{ day: "Fr" as PlannerDay, portions: targets.firstRunTarget }] : []),
              ...(targets && targets.secondRunTarget > 0 ? [{ day: "So" as PlannerDay, portions: targets.secondRunTarget }] : []),
            ];
        if (mainBatches.length === 0) continue;

        const allSubsAssigned = recipeSummary.subRecipes.every((sub) => !!sub.assigned);
        if (recipeSummary.subRecipes.length > 0 && !allSubsAssigned) continue;

        const perRun: Partial<Record<1 | 2, CockpitRunReadiness>> = {};
        const runBatches = resolveCockpitRunBatches(mainBatches, targets ?? { firstRunTarget: 0, secondRunTarget: 0 });
        ([1, 2] as const).forEach((run) => {
          const batch = runBatches[run];
          if (!batch) return;
          const runIndex = run - 1;
          const { startDay, dueDay } = RUN_PLATING_WINDOWS[run];
          // Default: Küche gilt als bereit ab dem ersten Plating-Tag (optimistisch, wenn keine Submeal-Daten).
          let readyDay = startDay;
          let hasSubDay = false;
          recipeSummary.subRecipes.forEach((sub, subIndex) => {
            if (!sub.assigned) return;
            const subDay = mainBatches.length > 1
              ? distributedRunSubDay(runIndex, subIndex)
              : sub.assigned.day;
            const planSubDay = PLANNER_DAY_TO_PLAN_DAY[subDay];
            if (!planSubDay) return;
            readyDay = hasSubDay ? laterRunReadyDay(readyDay, planSubDay, run) : planSubDay;
            hasSubDay = true;
          });
          // Plating-Tag = der Tag NACH dem letzten Submeal-Tag
          if (hasSubDay) readyDay = nextPlanDay(readyDay);
          // Niemals später als das Run-Deadline
          if (planDayIndex(readyDay) > planDayIndex(dueDay)) readyDay = dueDay;
          perRun[run] = {
            startDay: readyDay,
            readyDay,
            dueDay,
            portions: batch.portions,
            submealCount: recipeSummary.subRecipes.length,
          };
        });
        if (perRun[1] || perRun[2]) map.set(recipeSummary.recipeCode, perRun);
      }
    } catch {
      return map;
    }
    return map;
  }, [appData, manufacturingSnapshot, runTargetsByRecipe, week]);

  async function handleRefresh() {
    setManufacturingSnapshot(loadManufacturingPlanSnapshot(week));
    setLoading(true);
    setError(null);

    try {
      const appData = await loadData();

      setAppData(appData);
      const requestedWeekNum = parseInt(weekStr);
      let hasWeekSpecificRecipePool = false;
      setDataWarning(null);

      const weekRecipes = deriveRecipesFromWeekRecipes(appData.weekRecipes ?? [], week, 1 + upliftPercent / 100);
      if (weekRecipes.length > 0) {
        setRecipes(weekRecipes);
        hasWeekSpecificRecipePool = true;
      }

      // Ramp-Up History: Snapshot aufzeichnen + Änderungen erkennen
      if ((appData.weekRecipes ?? []).length > 0) {
        const { changes, history } = recordRampUpSnapshot(week, appData.weekRecipes ?? []);
        const allCodes = new Set((appData.weekRecipes ?? []).filter(r => r.hfWeek === week).map(r => r.code));
        const histMap = new Map<string, RampUpSnapshot[]>();
        for (const code of allCodes) {
          histMap.set(code, history.filter(snap => code in snap.volumes));
        }
        setRampUpHistoryMap(histMap);
        if (changes.length > 0) {
          setRampUpChanges(changes);
          setRampUpBannerDismissed(false);
        }
      }

      // KPL-Sheet optional laden — kein harter Fehler wenn nicht vorhanden
      try {
        const kplRes = await fetch("/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json");
        if (kplRes.ok) {
          const sheetData = await kplRes.json();
          const lpSheet = (sheetData.sheets ?? []).find((s: any) => s.title === "Lineplanning");
          if (lpSheet) {
            const { weekNum: wn, totalVolume: tv, recipes: recs, initialSchedule } =
              parseLineplanning(lpSheet.values);
            setTotalVolume(tv);
            setWeekNum(wn);
            if (wn === requestedWeekNum) {
              if (!hasWeekSpecificRecipePool && recs.length > 0) {
                setRecipes(recs);
                hasWeekSpecificRecipePool = true;
              }
              dispatch({ type: "load", schedule: initialSchedule });
            }
          }
        }
      } catch {
        // KPL-Sheet nicht verfügbar — Linienplanung startet mit leerem Schedule
      }

      // Firestore-Manifest nur als Fallback laden, wenn weder KET noch
      // passendes Lineplanning einen KW-spezifischen Pool geliefert haben.
      if (!hasWeekSpecificRecipePool) {
        try {
          const { getFirebase } = await import("./firebase");
          const { doc, getDoc } = await import("firebase/firestore");
          const { db } = getFirebase();
          const snap = await getDoc(doc(db, `apps/rezeptlogik/weekRecipes/de_${week.replace(/\W/g, "-")}`));
          if (snap.exists()) {
            const manifest = snap.data() as { meals: Array<{ code: string; name: string }> };
            const fallbackRecipes = (manifest.meals ?? []).map((m) => ({
              code: m.code,
              name: m.name,
              totalPlanned: 0,
              nordics: 0,
              bnl: 0,
              de: 0,
              speedPerMin: 10,
              isSeafood: detectSeafoodByName(m.name),
            }));
            if (fallbackRecipes.length > 0) setRecipes(fallbackRecipes);
          }
        } catch { /* kein Firestore / offline → still ignorieren */ }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  
  // ─── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    void handleRefresh();
  }, [week, weekStr]);

  useEffect(() => {
    const refreshSnapshot = () => setManufacturingSnapshot(loadManufacturingPlanSnapshot(week));
    window.addEventListener("focus", refreshSnapshot);
    window.addEventListener("storage", refreshSnapshot);
    return () => {
      window.removeEventListener("focus", refreshSnapshot);
      window.removeEventListener("storage", refreshSnapshot);
    };
  }, [week]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, onSnapshot } = await import("firebase/firestore");
        const { db } = getFirebase();
        unsubscribe = onSnapshot(
          doc(db, "apps/rezeptlogik/manufacturingPlans", `de_W${weekStr}`),
          (snap) => {
            if (!snap.exists()) return;
            const data = snap.data() as Partial<ManufacturingPlanSnapshot>;
            if (data.week !== week || !data.assignments || typeof data.assignments !== "object") return;
            const snapshot: ManufacturingPlanSnapshot = {
              savedAtIso: String(data.savedAtIso ?? new Date().toISOString()),
              savedAtLabel: data.savedAtLabel ? String(data.savedAtLabel) : undefined,
              week,
              scenarioId: String(data.scenarioId ?? "live"),
              scenarioName: String(data.scenarioName ?? "Manufacturing Live"),
              assignments: data.assignments as PlannerScenario["assignments"],
              stats: data.stats,
            };
            setManufacturingSnapshot(snapshot);
            window.localStorage.setItem(`rezeptlogik-plan-snapshot-${week}`, JSON.stringify(snapshot));
            const signature = manufacturingSnapshotSignature(snapshot);
            if (signature && signature !== lastManufacturingSnapshotSignatureRef.current) {
              lastManufacturingSnapshotSignatureRef.current = signature;
            }
          },
          () => { /* Firestore optional */ }
        );
      } catch {
        // Firestore optional; local snapshot listener above remains active.
      }
    })();
    return () => unsubscribe?.();
  }, [week, weekStr]);

  useEffect(() => {
    if (autoPlanTrigger === undefined) return;
    if (lastAutoPlanTriggerRef.current === autoPlanTrigger) return;
    lastAutoPlanTriggerRef.current = autoPlanTrigger;
    setPendingSnapshotAutoplan((value) => value + 1);
  }, [autoPlanTrigger]);

  useEffect(() => {
    const onSnapshotSaved = (event: Event) => {
      const custom = event as CustomEvent<{ week?: string }>;
      if (custom.detail?.week !== week) return;
      const snapshot = loadManufacturingPlanSnapshot(week);
      const signature = manufacturingSnapshotSignature(snapshot);
      if (!signature || signature === lastManufacturingSnapshotSignatureRef.current) return;
      lastManufacturingSnapshotSignatureRef.current = signature;
      setManufacturingSnapshot(snapshot);
    };
    window.addEventListener("rezeptlogik:plan-snapshot-saved", onSnapshotSaved as EventListener);
    return () => window.removeEventListener("rezeptlogik:plan-snapshot-saved", onSnapshotSaved as EventListener);
  }, [week]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("rezeptlogik-forecast-auto-threshold", String(Math.max(0, Math.round(forecastAutoThreshold))));
  }, [forecastAutoThreshold]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = `rezeptlogik-forecast-monitor-${week}`;
    const previousSignature = window.localStorage.getItem(storageKey);
    window.localStorage.setItem(storageKey, forecastVarianceSignature);
    if (!previousSignature || previousSignature === forecastVarianceSignature) return;

    const changedRows = forecastVarianceRows.filter((row) => Math.abs(row.delta) >= forecastAutoThreshold).slice(0, 6);
    if (changedRows.length === 0) return;
    setForecastAlertRows(changedRows);
    setForecastAlertStamp(new Date().toLocaleString("de-DE"));

    if (hasSavedManufacturingPlan) {
      setAutoPlanNotice("Forecast-Fluktuation erkannt: Run-2-Ziele wurden aktualisiert. Auto-Plan startet erst per Klick.");
      setTimeout(() => setAutoPlanNotice(""), 6000);
    }
  }, [forecastAutoThreshold, forecastVarianceRows, forecastVarianceSignature, hasSavedManufacturingPlan, week]);

  useEffect(() => {
    if (pendingSnapshotAutoplan <= 0 || loading) return;
    setPendingSnapshotAutoplan(0);
    const snapshot = loadManufacturingPlanSnapshot(week);
    setManufacturingSnapshot(snapshot);
    const signature = manufacturingSnapshotSignature(snapshot);
    if (signature) lastManufacturingSnapshotSignatureRef.current = signature;
    if (!snapshot || Object.keys(snapshot.assignments ?? {}).length === 0) {
      setAutoPlanNotice("Kein Manufacturing-Snapshot geladen: Plating verplant weiter und gibt Manufacturing den Nachzieh-Auftrag.");
      setTimeout(() => setAutoPlanNotice(""), 4200);
    }
    autoPlanFromTargets();
  }, [pendingSnapshotAutoplan, loading, week]);

  useEffect(() => {
    if (loading || recipes.length === 0) return;
    if (!linePlanAutosaveInitializedRef.current) {
      linePlanAutosaveInitializedRef.current = true;
      lastLinePlanAutosaveSignatureRef.current = linePlanAutosaveSignature;
      return;
    }
    if (lastLinePlanAutosaveSignatureRef.current === linePlanAutosaveSignature) return;
    const timer = window.setTimeout(async () => {
      lastLinePlanAutosaveSignatureRef.current = linePlanAutosaveSignature;
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, setDoc } = await import("firebase/firestore");
        const { db } = getFirebase();
        await setDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`), {
          week,
          savedAt: new Date().toISOString(),
          autosavedAt: new Date().toISOString(),
          schedule,
          comments,
          targetMealsBySlot,
          lineCapacityByLane,
          platingLineCount,
          dayLineCount,
          runSplitByRecipe,
        }, { merge: true });
      } catch {
        // Manual save still exists; autosave must not block editing.
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [comments, dayLineCount, lineCapacityByLane, linePlanAutosaveSignature, loading, platingLineCount, recipes.length, runSplitByRecipe, schedule, targetMealsBySlot, week, weekStr]);

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
            const d = snap.data() as {
              schedule?: ScheduleMap;
              comments?: Record<string, string>;
              ketOverrides?: Record<string, { day?: string; status?: string }>;
              targetMealsBySlot?: Record<string, number>;
              lineCapacityByLane?: Record<string, number>;
              platingLineCount?: number;
              dayLineCount?: Record<string, number>;
            };
            const remoteSchedule = d.schedule ?? {};
            const hasRemoteMeals = Object.values(remoteSchedule).some((recipe) => !!recipe);
            if (Date.now() < ignoreRemoteLinePlanUntilRef.current && hasRemoteMeals) return;
            if (d.schedule) dispatch({ type: "load", schedule: d.schedule });
            if (d.comments) setComments(d.comments);
            if (d.targetMealsBySlot) setTargetMealsBySlot(d.targetMealsBySlot);
            if (d.lineCapacityByLane) {
              setLineCapacityByLane({ ...defaultLineCapacityMap(), ...d.lineCapacityByLane });
            }
            if (d.platingLineCount === 1 || d.platingLineCount === 2 || d.platingLineCount === 3) {
              setPlatingLineCount(d.platingLineCount);
            }
            setDayLineCount(normalizeDayLineCountMap(d.dayLineCount));
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
        targetMealsBySlot,
        lineCapacityByLane,
        platingLineCount,
        dayLineCount,
        runSplitByRecipe,
      });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("Firebase config")) {
        alert(`Speichern fehlgeschlagen: ${msg}`);
      }
      // Firebase nicht konfiguriert → Plan ist lokal gespeichert, kein Alert nötig
    } finally {
      setSaving(false);
    }
  }

  async function handleClearPlan() {
    const confirmed = window.confirm(`Planung für KW ${weekStr} wirklich bereinigen?`);
    if (!confirmed) return;

    dispatch({ type: "load", schedule: {} });
    ignoreRemoteLinePlanUntilRef.current = Date.now() + 2500;
    setComments({});
    setTargetMealsBySlot({});
    setDayLineCount(defaultDayLineCountMap());
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
        targetMealsBySlot: {},
        lineCapacityByLane,
        platingLineCount,
        dayLineCount: defaultDayLineCountMap(),
        runSplitByRecipe,
      });
    } catch {
      // Firebase nicht konfiguriert oder nicht erreichbar — nur lokal bereinigt
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

  async function requestManufacturingReconciliation(reason: string, hints: LineCollisionHint[] = []) {
    if (typeof window === "undefined") return;
    const signature = JSON.stringify({
      week,
      reason,
      schedule,
      dayLineCount,
      collisions: hints.slice(0, 12).map((hint) => ({
        key: hint.key,
        severity: hint.severity,
        domain: hint.domain,
        recipeCode: hint.recipeCode,
        cellKey: hint.cellKey,
      })),
    });
    if (lastManufacturingReconcileRequestRef.current === signature) return;
    lastManufacturingReconcileRequestRef.current = signature;
    const payload = {
      week,
      requestedAt: new Date().toISOString(),
      reason,
      schedule,
      lineCapacityByLane,
      platingLineCount,
      dayLineCount,
      runSplitByRecipe,
      collisions: hints.slice(0, 20).map((hint) => ({
        key: hint.key,
        severity: hint.severity,
        domain: hint.domain,
        location: hint.location,
        message: hint.message,
        action: hint.action,
        cellKey: hint.cellKey ?? null,
        recipeCode: hint.recipeCode ?? null,
      })),
    };
    window.localStorage.setItem(`rezeptlogik-manufacturing-reconcile-${week}`, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("rezeptlogik:manufacturing-reconcile-request", { detail: payload }));
    try {
      const { getFirebase } = await import("./firebase");
      const { doc, setDoc } = await import("firebase/firestore");
      const { db } = getFirebase();
      await setDoc(doc(db, "apps/rezeptlogik/planningRequests", `de_W${weekStr}`), payload, { merge: true });
    } catch {
      // Local event/localStorage are enough when Firestore is not available.
    }
  }

  function autoPlanFromTargets(repairCollisions = false) {
    const snapshot = loadManufacturingPlanSnapshot(week);
    setManufacturingSnapshot(snapshot);
    const hasManufacturingSnapshotForPlan = !!snapshot && Object.keys(snapshot.assignments ?? {}).length > 0;
    if (!hasManufacturingSnapshotForPlan) {
      setAutoPlanNotice("Kein Manufacturing-Snapshot geladen: Plating verplant trotzdem alles und gibt Manufacturing einen Nachzieh-Auftrag.");
      setTimeout(() => setAutoPlanNotice(""), 5000);
    }
    const next: ScheduleMap = { ...schedule };
    for (const [key, recipe] of Object.entries(next)) {
      if (recipe?.isBreak) next[key] = null;
    }
    if (repairCollisions) {
      for (const hint of collisionHints) {
        if (!hint.cellKey) continue;
        if (hint.domain !== "readiness" && hint.domain !== "mhd" && hint.domain !== "slot") continue;
        next[hint.cellKey] = null;
      }
    }
    const producedByRecipe = new Map<string, number>();
    const producedByRecipeRun = new Map<string, Record<1 | 2, number>>();
    const producedByRecipeRunDay = new Map<string, Record<1 | 2, Map<PlanDay, number>>>();
    const lineIdxForDay = (day: PlanDay) => (activeLineIdxByDay[day] ?? [])
      .filter((li) => Math.max(0, lineCapacityByLane[String(li)] ?? 0) > 0);

    function addProduced(recipe: LinePlanRecipe, run: 1 | 2, portions: number, day: PlanDay) {
      const cleanPortions = Math.max(0, portions);
      producedByRecipe.set(recipe.code, (producedByRecipe.get(recipe.code) ?? 0) + cleanPortions);
      const byRun = producedByRecipeRun.get(recipe.code) ?? emptyRunProduction();
      byRun[run] += cleanPortions;
      producedByRecipeRun.set(recipe.code, byRun);
      const byRunDay = producedByRecipeRunDay.get(recipe.code) ?? { 1: new Map<PlanDay, number>(), 2: new Map<PlanDay, number>() };
      byRunDay[run].set(day, (byRunDay[run].get(day) ?? 0) + cleanPortions);
      producedByRecipeRunDay.set(recipe.code, byRunDay);
    }

    const kitchenDemandByRecipeDay = new Map<string, Map<PlanDay, number>>();
    const kitchenDemandByRecipeRunDay = new Map<string, { 1: Map<PlanDay, number>; 2: Map<PlanDay, number> }>();
    for (const recipe of recipes) {
      const oasisWos = planningOasis?.recipes[recipe.code]?.workOrders ?? [];
      for (const wo of oasisWos) {
        const day = normalizePlanDay(wo.hotKitchenDay ?? "");
        if (!day) continue;
        const code = recipe.code;
        if (!kitchenDemandByRecipeDay.has(code)) kitchenDemandByRecipeDay.set(code, new Map<PlanDay, number>());
        const dayMap = kitchenDemandByRecipeDay.get(code)!;
        const weight = Math.max(1, Math.round(wo.targetPortions || 0));
        dayMap.set(day, (dayMap.get(day) ?? 0) + weight);

        if (!kitchenDemandByRecipeRunDay.has(code)) {
          kitchenDemandByRecipeRunDay.set(code, { 1: new Map<PlanDay, number>(), 2: new Map<PlanDay, number>() });
        }
        const runMaps = kitchenDemandByRecipeRunDay.get(code)!;
        const targets = runTargetsByRecipe.get(code);
        const upliftTotal = Math.max(1, targets?.totalTarget ?? 1);
        let run1Share = (targets?.firstRunTarget ?? 0) / upliftTotal;
        let run2Share = (targets?.secondRunTarget ?? 0) / upliftTotal;
        if (subMealRecipeCodes.has(code)) {
          run1Share = Math.max(0.3, run1Share);
          run2Share = Math.max(0.3, run2Share);
        }
        const shareSum = Math.max(0.0001, run1Share + run2Share);
        run1Share /= shareSum;
        run2Share /= shareSum;
        runMaps[1].set(day, (runMaps[1].get(day) ?? 0) + weight * run1Share);
        runMaps[2].set(day, (runMaps[2].get(day) ?? 0) + weight * run2Share);
      }
    }

    // Nutzt exakt die aktivierten Plating-Linien und deren eingestellte Kapazitaet.
    for (const day of DAYS) {
      const dayLineIdx = lineIdxForDay(day);
      for (const slot of SLOTS) {
        for (const li of activeLineIdx) {
          const key = `${day}|${slot.key}|${li}`;
          if (!dayLineIdx.includes(li)) next[key] = null;
          else if (!(key in next)) next[key] = null;
        }
      }
    }

    // Oasis-Prio-Map: bestes (niedrigstes) Priority-Nummer je Rezeptcode aus Planning Oasis
    const prioByCode = new Map<string, number>();
    for (const recipe of recipes) {
      const wos = planningOasis?.recipes[recipe.code]?.workOrders ?? [];
      for (const wo of wos) {
        const p = wo.priority;
        if (!Number.isFinite(p) || p <= 0) continue;
        const current = prioByCode.get(recipe.code) ?? Infinity;
        if (p < current) prioByCode.set(recipe.code, p);
      }
    }

    for (const [key, recipe] of Object.entries(next)) {
      if (!recipe || recipe.isBreak) continue;
      const [dayRaw, slotKey, liRaw] = key.split("|");
      const normalizedDay = normalizePlanDay(dayRaw ?? "");
      if (!normalizedDay) continue;
      const li = Number(liRaw ?? -1);
      if (li < 0 || !lineIdxForDay(normalizedDay).includes(li)) continue;
      const lineTarget = li >= 0 ? Math.max(0, lineCapacityByLane[String(li)] ?? 0) : 0;
      const p = portionsInSlotByLineCapacity(lineTarget, slotKey ?? "");
      const targets = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
      const dayRun = cockpitRunForDay(normalizedDay);
      const fallbackRun: 1 | 2 = (producedByRecipe.get(recipe.code) ?? 0) < targets.firstRunTarget ? 1 : 2;
      const run = dayRun ?? fallbackRun;
      const runOpen = Math.max(0, (run === 1 ? targets.firstRunTarget : targets.secondRunTarget) - (producedByRecipeRun.get(recipe.code)?.[run] ?? 0));
      const totalOpen = Math.max(0, targets.totalTarget - (producedByRecipe.get(recipe.code) ?? 0));
      addProduced(recipe, run, Math.min(p, runOpen, totalOpen), normalizedDay);
    }

    let assignments = 0;
    for (const day of DAYS) {
      const dayLineIdx = lineIdxForDay(day);
      const defaultTargetMh = dayLineIdx.reduce((sum, li) => sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0), 0);
      for (const slot of SLOTS) {
        const targetKey = `${day}|${slot.key}`;
        const targetMh = Math.max(0, targetMealsBySlot[targetKey] ?? defaultTargetMh);
        if (targetMh <= 0) continue;

        const freeLineIdx = [...dayLineIdx]
          .filter((li) => !next[`${day}|${slot.key}|${li}`] && (lineCapacityByLane[String(li)] ?? 0) > 0)
          .sort((a, b) => a - b);

        let currentMh = dayLineIdx.reduce<number>((sum, li) => {
          return next[`${day}|${slot.key}|${li}`] ? sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0) : sum;
        }, 0);
        while (freeLineIdx.length > 0 && currentMh < targetMh) {
          const li = freeLineIdx.shift();
          if (li === undefined) break;
          const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
          const missingMh = Math.min(targetMh - currentMh, lineTarget || targetMh);
          let best: LinePlanRecipe | null = null;
          let bestScore = -Infinity;

          // Sticky: laufendes Rezept des Vorgänger-Slots weiterführen wenn noch Volumen vorhanden
          {
            const slotIdxS = SLOTS.findIndex(s => s.key === slot.key);
            const prevSlotKeyS = slotIdxS > 0 ? SLOTS[slotIdxS - 1]?.key : undefined;
            const prevCellS = prevSlotKeyS ? next[`${day}|${prevSlotKeyS}|${li}`] : null;
            if (prevCellS && !prevCellS.isBreak) {
              const stickyR = recipes.find(r => r.code === prevCellS.code);
              if (stickyR) {
                const prod = producedByRecipe.get(stickyR.code) ?? 0;
                const tgt = runTargetsByRecipe.get(stickyR.code) ?? lineRunTargetsForRecipe(stickyR);
                const sRun: 1 | 2 = cockpitRunForDay(day) ?? (prod < tgt.firstRunTarget ? 1 : 2);
                const sWin = RUN_PLATING_WINDOWS[sRun];
                if (planDayIndex(day) >= planDayIndex(sWin.startDay) && planDayIndex(day) <= planDayIndex(sWin.dueDay)) {
                  const sRunOpen = Math.max(0, (sRun === 1 ? tgt.firstRunTarget : tgt.secondRunTarget) - (producedByRecipeRun.get(stickyR.code)?.[sRun] ?? 0));
                  const sTotalOpen = Math.max(0, tgt.totalTarget - prod);
                  if (Math.min(sRunOpen, sTotalOpen) > 0) {
                    best = stickyR;
                    bestScore = Infinity;
                  }
                }
              }
            }
          }

          if (best === null) for (const recipe of recipes) {
            const produced = producedByRecipe.get(recipe.code) ?? 0;
            const targets = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
            const dayRun = cockpitRunForDay(day);
            const currentRun: 1 | 2 = dayRun ?? (produced < targets.firstRunTarget ? 1 : 2);

            // Hard gate: Tag muss im Plating-Fenster dieses Runs liegen
            const runWin = RUN_PLATING_WINDOWS[currentRun];
            if (planDayIndex(day) < planDayIndex(runWin.startDay) || planDayIndex(day) > planDayIndex(runWin.dueDay)) continue;

            const runTarget = currentRun === 1 ? Math.max(1, targets.firstRunTarget) : Math.max(1, targets.secondRunTarget);
            const producedRun = producedByRecipeRun.get(recipe.code)?.[currentRun] ?? 0;
            const runOpen = Math.max(0, runTarget - producedRun);
            const totalOpen = Math.max(0, targets.totalTarget - produced);
            // Kein Tages-Cap: Rezept darf so viele Stunden laufen wie nötig
            const remaining = Math.min(runOpen, totalOpen);
            if (remaining <= 0) continue;

            const slotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);
            if (!slotFitsRemaining(slotPortions, remaining)) continue;
            const recipeMh = Math.max(0, lineTarget);
            const fitScore = 1 - Math.min(1, Math.abs(missingMh - recipeMh) / Math.max(targetMh, recipeMh, 1));
            const volumeScore = Math.min(1, remaining / Math.max(slotPortions, 1));

            const runWindow = mhdRunWindow(recipe, currentRun);
            const runAnchor = recommendedRunDay(currentRun);
            const runDayScore = runWindowScore(day, runWindow, runAnchor);
            const runPressure = Math.min(1, runOpen / runTarget);

            // Küchen-Bereitschaft aus Manufacturing Calendar (soft gate: 0 = noch nicht fertig)
            const cockpitRule = cockpitRunReadiness.get(recipe.code)?.[currentRun];
            if (cockpitRule && cockpitScoreForDay(day, cockpitRule) <= 0) continue;
            const cockpitDayScore = cockpitRule ? cockpitScoreForDay(day, cockpitRule) : 0.6;

            const runDemand = kitchenDemandByRecipeRunDay.get(recipe.code)?.[currentRun];
            const dayDemand = runDemand && runDemand.size > 0 ? runDemand : kitchenDemandByRecipeDay.get(recipe.code);
            let kitchenDayScore = 0.3;
            if (dayDemand && dayDemand.size > 0) {
              const totalDemand = Array.from(dayDemand.values()).reduce((sum, value) => sum + value, 0);
              const exactShare = totalDemand > 0 ? (dayDemand.get(day) ?? 0) / totalDemand : 0;
              const minDist = Math.min(
                ...Array.from(dayDemand.keys()).map((d) => planDayDistance(day, d)),
              );
              const nearScore = 1 - Math.min(3, minDist) / 3;
              kitchenDayScore = Math.min(1, exactShare * 0.75 + nearScore * 0.55);
            }

            // Oasis-Priorität: niedrigste bekannte Prio-Nummer = höchster Score
            const bestPrio = prioByCode.get(recipe.code) ?? 999;
            const prioScore = bestPrio < 999 ? Math.max(0.05, 1 - (bestPrio - 1) / 25) : 0.05;

            // Hoher Bonus wenn selbes Rezept im Vorgänger-Slot → mehrstündige Läufe bevorzugt
            const slotIdx = SLOTS.findIndex(s => s.key === slot.key);
            const prevSlotKey = slotIdx > 0 ? SLOTS[slotIdx - 1]?.key : undefined;
            const prevCode = prevSlotKey ? next[`${day}|${prevSlotKey}|${li}`]?.code : undefined;
            const continuityBonus = (prevCode && prevCode === recipe.code && prevCode !== "__BREAK__") ? 0.8 : 0;

            const baseScore = cockpitRule
              ? cockpitDayScore * 0.35 + prioScore * 0.28 + runPressure * 0.20 + kitchenDayScore * 0.12 + volumeScore * 0.03 + fitScore * 0.02
              : prioScore * 0.40 + kitchenDayScore * 0.28 + runDayScore * 0.17 + runPressure * 0.12 + volumeScore * 0.02 + fitScore * 0.01;
            const score = baseScore + continuityBonus;

            if (score > bestScore) {
              bestScore = score;
              best = recipe;
            }
          }

          if (!best) {
            // Fallback: größte Restmenge im aktiven Run-Fenster
            let fallback: LinePlanRecipe | null = null;
            let maxRemaining = 0;
            for (const recipe of recipes) {
              const produced = producedByRecipe.get(recipe.code) ?? 0;
              const targets = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
              const fallbackRun: 1 | 2 = cockpitRunForDay(day) ?? (produced < targets.firstRunTarget ? 1 : 2);
              const runWin2 = RUN_PLATING_WINDOWS[fallbackRun];
              if (planDayIndex(day) < planDayIndex(runWin2.startDay) || planDayIndex(day) > planDayIndex(runWin2.dueDay)) continue;
              const runTarget = fallbackRun === 1 ? Math.max(1, targets.firstRunTarget) : Math.max(1, targets.secondRunTarget);
              const producedRun = producedByRecipeRun.get(recipe.code)?.[fallbackRun] ?? 0;
              const remaining = Math.min(
                Math.max(0, runTarget - producedRun),
                Math.max(0, targets.totalTarget - produced),
              );
              if (remaining <= 0) continue;
              const slotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);
              if (!slotFitsRemaining(slotPortions, remaining)) continue;
              const cockpitRule = cockpitRunReadiness.get(recipe.code)?.[fallbackRun];
              if (cockpitRule && cockpitScoreForDay(day, cockpitRule) <= 0) continue;
              if (remaining > maxRemaining) {
                maxRemaining = remaining;
                fallback = recipe;
              }
            }
            best = fallback;
          }
          if (!best) break;
          next[`${day}|${slot.key}|${li}`] = best;
          const bestTargets = runTargetsByRecipe.get(best.code) ?? lineRunTargetsForRecipe(best);
          const bestRun = cockpitRunForDay(day) ?? ((producedByRecipe.get(best.code) ?? 0) < bestTargets.firstRunTarget ? 1 : 2);
          const bestSlotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);
          const bestRunOpen = Math.max(0, (bestRun === 1 ? bestTargets.firstRunTarget : bestTargets.secondRunTarget) - (producedByRecipeRun.get(best.code)?.[bestRun] ?? 0));
          const bestTotalOpen = Math.max(0, bestTargets.totalTarget - (producedByRecipe.get(best.code) ?? 0));
          addProduced(best, bestRun, Math.min(bestSlotPortions, bestRunOpen, bestTotalOpen), day);
          currentMh = dayLineIdx.reduce<number>((sum, idx) => {
            return next[`${day}|${slot.key}|${idx}`] ? sum + Math.max(0, lineCapacityByLane[String(idx)] ?? 0) : sum;
          }, 0);
          assignments += 1;
        }
      }
    }

    // Finaler Auffüll-Pass: iteriert Tag → Slot → Linie (wie Hauptpass) statt Rezept → Tag.
    // Bevorzugt dasselbe Rezept wie der Vorgänger-Slot → keine Streuplatzierungen → weniger Pausen.
    for (const day of DAYS) {
      const dayLineIdx = lineIdxForDay(day);
      for (const slot of SLOTS) {
        for (const li of dayLineIdx) {
          const key = `${day}|${slot.key}|${li}`;
          if (next[key]) continue;

          const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
          const slotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);

          // Vorherigen Slot auf dieser Linie lesen → Kontinuitätspräferenz
          const slotIdx = SLOTS.findIndex(s => s.key === slot.key);
          const prevSlotKey = slotIdx > 0 ? SLOTS[slotIdx - 1]?.key : undefined;
          const prevCell = prevSlotKey ? next[`${day}|${prevSlotKey}|${li}`] : null;
          const prevCode = prevCell && !prevCell.isBreak ? prevCell.code : null;

          let best: LinePlanRecipe | null = null;
          let bestScore = -Infinity;

          // Sticky: laufendes Rezept weiterführen wenn noch Volumen vorhanden
          if (prevCode) {
            const stickyR = recipes.find(r => r.code === prevCode);
            if (stickyR) {
              const prod = producedByRecipe.get(stickyR.code) ?? 0;
              const tgt = runTargetsByRecipe.get(stickyR.code) ?? lineRunTargetsForRecipe(stickyR);
              const sRun: 1 | 2 = cockpitRunForDay(day) ?? (prod < tgt.firstRunTarget ? 1 : 2);
              const sWin = RUN_PLATING_WINDOWS[sRun];
              if (planDayIndex(day) >= planDayIndex(sWin.startDay) && planDayIndex(day) <= planDayIndex(sWin.dueDay)) {
                const sRunOpen = Math.max(0, (sRun === 1 ? tgt.firstRunTarget : tgt.secondRunTarget) - (producedByRecipeRun.get(stickyR.code)?.[sRun] ?? 0));
                const sTotalOpen = Math.max(0, tgt.totalTarget - prod);
                if (Math.min(sRunOpen, sTotalOpen) > 0) {
                  best = stickyR;
                  bestScore = Infinity;
                }
              }
            }
          }

          if (best === null) for (const recipe of recipes) {
            const produced = producedByRecipe.get(recipe.code) ?? 0;
            const targets2 = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
            const dayRun2 = cockpitRunForDay(day);
            const fillRun: 1 | 2 = dayRun2 ?? (produced < targets2.firstRunTarget ? 1 : 2);
            const runWin3 = RUN_PLATING_WINDOWS[fillRun];
            if (planDayIndex(day) < planDayIndex(runWin3.startDay) || planDayIndex(day) > planDayIndex(runWin3.dueDay)) continue;
            const runTarget2 = fillRun === 1 ? Math.max(1, targets2.firstRunTarget) : Math.max(1, targets2.secondRunTarget);
            const producedRun2 = producedByRecipeRun.get(recipe.code)?.[fillRun] ?? 0;
            const runOpen2 = Math.max(0, runTarget2 - producedRun2);
            const totalOpen2 = Math.max(0, targets2.totalTarget - produced);
            const remaining2 = Math.min(runOpen2, totalOpen2);
            if (remaining2 <= 0) continue;
            if (!slotFitsRemaining(slotPortions, remaining2)) continue;
            // Kontinuität zählt am meisten, dann Restmenge
            const contBonus = recipe.code === prevCode ? 2.0 : 0;
            const fillScore = remaining2 / Math.max(1, targets2.totalTarget) + contBonus;
            if (fillScore > bestScore) { bestScore = fillScore; best = recipe; }
          }

          if (best) {
            next[key] = best;
            const targets3 = runTargetsByRecipe.get(best.code) ?? lineRunTargetsForRecipe(best);
            const prod3 = producedByRecipe.get(best.code) ?? 0;
            const fillRun3: 1 | 2 = cockpitRunForDay(day) ?? (prod3 < targets3.firstRunTarget ? 1 : 2);
            const runOpen3 = Math.max(0, (fillRun3 === 1 ? targets3.firstRunTarget : targets3.secondRunTarget) - (producedByRecipeRun.get(best.code)?.[fillRun3] ?? 0));
            const totalOpen3 = Math.max(0, targets3.totalTarget - prod3);
            addProduced(best, fillRun3, Math.min(slotPortions, runOpen3, totalOpen3), day);
            assignments += 1;
          }
        }
      }
    }

    // Force-Fill: Alle Rezepte mit Restvolumen zwingend platzieren (ignoriert Score, respektiert Run-Fenster).
    // Verhindert dass Rezepte mit großem Gesamtvolumen aber kleinem Rest-Anteil nie einen Slot bekommen.
    {
      const withRemaining = recipes
        .map(r => {
          const prod = producedByRecipe.get(r.code) ?? 0;
          const tgt = runTargetsByRecipe.get(r.code) ?? lineRunTargetsForRecipe(r);
          return { recipe: r, remaining: Math.max(0, tgt.totalTarget - prod) };
        })
        .filter(x => x.remaining > 0)
        .sort((a, b) => b.remaining - a.remaining);

      for (const { recipe } of withRemaining) {
        for (const day of DAYS) {
          const dayLineIdx = lineIdxForDay(day);
          const prod = producedByRecipe.get(recipe.code) ?? 0;
          const tgt = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
          const totalOpen = Math.max(0, tgt.totalTarget - prod);
          if (totalOpen <= 0) break;
          const fRun: 1 | 2 = cockpitRunForDay(day) ?? (prod < tgt.firstRunTarget ? 1 : 2);
          const fWin = RUN_PLATING_WINDOWS[fRun];
          if (planDayIndex(day) < planDayIndex(fWin.startDay) || planDayIndex(day) > planDayIndex(fWin.dueDay)) continue;
          for (const slot of SLOTS) {
            const prod2 = producedByRecipe.get(recipe.code) ?? 0;
            const tgt2 = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
            const fRun2: 1 | 2 = cockpitRunForDay(day) ?? (prod2 < tgt2.firstRunTarget ? 1 : 2);
            const runOpen2 = Math.max(0, (fRun2 === 1 ? tgt2.firstRunTarget : tgt2.secondRunTarget) - (producedByRecipeRun.get(recipe.code)?.[fRun2] ?? 0));
            const totalOpen2 = Math.max(0, tgt2.totalTarget - prod2);
            if (Math.min(runOpen2, totalOpen2) <= 0) break;
            for (const li of dayLineIdx) {
              const key = `${day}|${slot.key}|${li}`;
              if (next[key]) continue;
              const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
              const slotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);
              const prod3 = producedByRecipe.get(recipe.code) ?? 0;
              const tgt3 = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
              const fRun3: 1 | 2 = cockpitRunForDay(day) ?? (prod3 < tgt3.firstRunTarget ? 1 : 2);
              const runOpen3 = Math.max(0, (fRun3 === 1 ? tgt3.firstRunTarget : tgt3.secondRunTarget) - (producedByRecipeRun.get(recipe.code)?.[fRun3] ?? 0));
              const totalOpen3 = Math.max(0, tgt3.totalTarget - prod3);
              const remaining3 = Math.min(runOpen3, totalOpen3);
              if (remaining3 <= 0) continue;
              next[key] = recipe;
              addProduced(recipe, fRun3, Math.min(slotPortions, remaining3), day);
              assignments += 1;
            }
          }
        }
      }
    }

    // Desperate-Fill: Wenn nach dem Run-Fenster-Fill noch Volumen offen ist, ignoriere alle Fenster
    // und platziere in ALLE freien Slots! Das stellt sicher, dass verplant wird, was kapazitiv geht.
    {
      const withRemaining = recipes
        .map(r => {
          const prod = producedByRecipe.get(r.code) ?? 0;
          const tgt = runTargetsByRecipe.get(r.code) ?? lineRunTargetsForRecipe(r);
          return { recipe: r, remaining: Math.max(0, tgt.totalTarget - prod) };
        })
        .filter(x => x.remaining > 0)
        .sort((a, b) => b.remaining - a.remaining);

      for (const { recipe } of withRemaining) {
        for (const day of DAYS) {
          const dayLineIdx = lineIdxForDay(day);
          const prod = producedByRecipe.get(recipe.code) ?? 0;
          const tgt = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
          const totalOpen = Math.max(0, tgt.totalTarget - prod);
          if (totalOpen <= 0) break;
          for (const slot of SLOTS) {
            for (const li of dayLineIdx) {
              const key = `${day}|${slot.key}|${li}`;
              if (next[key]) continue;
              const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
              const slotPortions = portionsInSlotByLineCapacity(lineTarget, slot.key);
              const prod3 = producedByRecipe.get(recipe.code) ?? 0;
              const totalOpen3 = Math.max(0, tgt.totalTarget - prod3);
              if (totalOpen3 <= 0) continue;
              next[key] = recipe;
              const fRun3: 1 | 2 = cockpitRunForDay(day) ?? (prod3 < tgt.firstRunTarget ? 1 : 2);
              addProduced(recipe, fRun3, Math.min(slotPortions, totalOpen3), day);
              assignments += 1;
            }
          }
        }
      }
    }

    // Gleiche Meal-Batches bleiben zusammen; zwischen zwei verschiedenen Batches
    // und nach Batch-Ende steht maximal eine Reinigungs-Pille.
    const normalizedNext = normalizeMealChangeBreaks(next, activeLineIdx);

    dispatch({ type: "load", schedule: normalizedNext });
    if (!hasManufacturingSnapshotForPlan) {
      void requestManufacturingReconciliation("Plating hat ohne Manufacturing-Snapshot vollständig vorgeplant");
    }
    setAutoPlanNotice(assignments > 0
      ? `${assignments} Slots automatisch belegt (Cockpit-Calendar: Run erst nach Submeal-Fertigstellung, dann Run-Due-Day).`
      : "Keine neuen Slots belegt. Prüfe Ziel-Meals/h, Küchenzuordnung und Restvolumen.");
    setTimeout(() => setAutoPlanNotice(""), 3500);
  }

  function handleCorrectCollisions() {
    const actionable = collisionHints.filter((hint) =>
      hint.severity === "error"
      && (hint.domain === "readiness" || hint.domain === "mhd" || hint.domain === "volume" || hint.domain === "run" || hint.domain === "slot")
    );
    if (actionable.some((hint) => hint.domain === "readiness" || hint.domain === "run" || hint.domain === "mhd")) {
      void requestManufacturingReconciliation("Auto-Plan korrigieren: Plating-Kollisionen an Manufacturing übergeben", actionable);
    }
    autoPlanFromTargets(true);
  }

  function resetLineCapacityDefaults() {
    setLineCapacityByLane(defaultLineCapacityMap());
    setPlatingLineCount(3);
    setDayLineCount(defaultDayLineCountMap());
    setAutoPlanNotice("Linienleistung auf Standardwerte gesetzt.");
    setTimeout(() => setAutoPlanNotice(""), 2200);
  }

  // ─── Computations ──────────────────────────────────────────────────────────

  const allocatedPortionsByCell = useMemo(() => {
    const allocation = new Map<string, number>();
    const producedByRecipe = new Map<string, number>();
    const entries = Object.entries(schedule)
      .filter(([, recipe]) => !!recipe)
      .sort(([left], [right]) => {
        const [leftDay, leftSlot, leftLine] = left.split("|");
        const [rightDay, rightSlot, rightLine] = right.split("|");
        const dayDelta = planDayIndex((normalizePlanDay(leftDay ?? "") ?? "Montag") as PlanDay) - planDayIndex((normalizePlanDay(rightDay ?? "") ?? "Montag") as PlanDay);
        if (dayDelta !== 0) return dayDelta;
        const slotDelta = SLOTS.findIndex(slot => slot.key === leftSlot) - SLOTS.findIndex(slot => slot.key === rightSlot);
        if (slotDelta !== 0) return slotDelta;
        return Number(leftLine ?? 0) - Number(rightLine ?? 0);
      });

    for (const [key, recipe] of entries) {
      if (!recipe || recipe.isBreak) continue;
      const [dayRaw, slotKey, liRaw] = key.split("|");
      const day = normalizePlanDay(dayRaw ?? "");
      if (!day) continue;
      const li = Number(liRaw ?? -1);
      if (li < 0 || !(activeLineIdxByDay[day] ?? []).includes(li)) continue;
      const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
      const slotPortions = portionsInSlotByLineCapacity(lineTarget, slotKey ?? "");
      const target = runTargetsByRecipe.get(recipe.code)?.totalTarget ?? lineRunTargetsForRecipe(recipe).totalTarget;
      const alreadyProduced = producedByRecipe.get(recipe.code) ?? 0;
      const allocated = Math.max(0, Math.min(slotPortions, target - alreadyProduced));
      allocation.set(key, allocated);
      producedByRecipe.set(recipe.code, alreadyProduced + allocated);
    }
    return allocation;
  }, [activeLineIdxByDay, lineCapacityByLane, runTargetsByRecipe, schedule]);

  // Portions scheduled per recipe per slot, capped to the real recipe target.
  const scheduledPortions = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, recipe] of Object.entries(schedule)) {
      if (!recipe) continue;
      const allocated = allocatedPortionsByCell.get(key) ?? 0;
      if (allocated <= 0) continue;
      map.set(recipe.code, (map.get(recipe.code) ?? 0) + allocated);
    }
    return map;
  }, [allocatedPortionsByCell, schedule]);
  const volumeCoverageRows = useMemo(() => {
    return recipes.map((recipe) => {
      const target = runTargetsByRecipe.get(recipe.code)?.totalTarget ?? lineRunTargetsForRecipe(recipe).totalTarget;
      const planned = Math.round(scheduledPortions.get(recipe.code) ?? 0);
      return {
        code: recipe.code,
        name: recipe.name,
        target,
        planned,
        open: Math.max(0, target - planned),
        over: Math.max(0, planned - target),
      };
    }).filter((row) => row.target > 0);
  }, [recipes, runTargetsByRecipe, scheduledPortions]);
  const openVolumeTotal = useMemo(
    () => volumeCoverageRows.reduce((sum, row) => sum + row.open, 0),
    [volumeCoverageRows]
  );

  // Days scheduled per recipe code (for multi-day badge in recipe pills)
  const scheduledDaysByCode = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [key, recipe] of Object.entries(schedule)) {
      if (!recipe) continue;
      const [dayRaw, , liRaw] = key.split("|");
      const day = normalizePlanDay(dayRaw ?? "");
      if (!day) continue;
      const li = Number(liRaw ?? -1);
      if (li < 0 || !(activeLineIdxByDay[day] ?? []).includes(li)) continue;
      if (!map.has(recipe.code)) map.set(recipe.code, new Set<string>());
      map.get(recipe.code)!.add(day);
    }
    return map;
  }, [activeLineIdxByDay, schedule]);

  // Slot-count per recipe code (für Multi-Day-Badge in Zellen)
  // Meals/h per (day, slot)
  function mealsPerHour(day: PlanDay, slotKey: string): number {
    let totalMh = 0;
    for (const li of activeLineIdxByDay[day] ?? []) {
      const r = schedule[`${day}|${slotKey}|${li}`];
      if (r) totalMh += Math.max(0, lineCapacityByLane[String(li)] ?? 0);
    }
    return Math.round(totalMh);
  }

  const platingCalendarDays = useMemo(() => {
    return DAYS.map((day) => {
      const dayLineIdx = activeLineIdxByDay[day] ?? [];
      const lineSummaries = dayLineIdx.map((li) => {
        const capacity = SLOTS.reduce((sum, slot) => {
          return sum + portionsInSlotByLineCapacity(lineCapacityByLane[String(li)] ?? 0, slot.key);
        }, 0);
        let planned = 0;
        const recipesOnLine = new Map<string, LinePlanRecipe>();
        let slotCount = 0;
        for (const slot of SLOTS) {
          const recipe = schedule[`${day}|${slot.key}|${li}`];
          if (!recipe || recipe.isBreak) continue;
          planned += allocatedPortionsByCell.get(`${day}|${slot.key}|${li}`) ?? 0;
          recipesOnLine.set(recipe.code, recipe);
          slotCount += 1;
        }
        return {
          lineIdx: li,
          capacity,
          planned,
          utilization: capacity > 0 ? planned / capacity : 0,
          slotCount,
          recipes: Array.from(recipesOnLine.values()),
        };
      });
      const capacity = lineSummaries.reduce((sum, line) => sum + line.capacity, 0);
      const planned = lineSummaries.reduce((sum, line) => sum + line.planned, 0);
      const recipeCount = new Set(lineSummaries.flatMap((line) => line.recipes.map((recipe) => recipe.code))).size;
      return {
        day,
        capacity,
        planned,
        open: Math.max(0, capacity - planned),
        utilization: capacity > 0 ? planned / capacity : 0,
        recipeCount,
        lineSummaries,
      };
    });
  }, [activeLineIdxByDay, allocatedPortionsByCell, lineCapacityByLane, schedule]);

  const platingCalendarTotals = useMemo(() => {
    const capacity = platingCalendarDays.reduce((sum, day) => sum + day.capacity, 0);
    const planned = platingCalendarDays.reduce((sum, day) => sum + day.planned, 0);
    return {
      capacity,
      planned,
      open: Math.max(0, (recipePlanTotal || planned) - planned),
      utilization: capacity > 0 ? planned / capacity : 0,
    };
  }, [platingCalendarDays, recipePlanTotal]);

  const collisionHints = useMemo<LineCollisionHint[]>(() => {
    const hints: LineCollisionHint[] = [];

    for (const row of volumeCoverageRows) {
      if (row.open > 0) {
        hints.push({
          key: `volume-open-${row.code}`,
          severity: "error",
          domain: "volume",
          recipeCode: row.code,
          location: row.code,
          message: `${fmtNum(row.open)} Portionen offen`,
          action: "Auto-Plan laufen lassen oder zusätzliche Slots/Kapazität zuweisen.",
        });
      }
      if (row.over > 0) {
        hints.push({
          key: `volume-over-${row.code}`,
          severity: "warn",
          domain: "volume",
          recipeCode: row.code,
          location: row.code,
          message: `${fmtNum(row.over)} Portionen über Ziel`,
          action: "Überzählige Slots entfernen oder Zielvolumen prüfen.",
        });
      }
    }

    const producedByRecipe = new Map<string, number>();
    const entries = Object.entries(schedule)
      .filter(([, recipe]) => !!recipe)
      .sort(([left], [right]) => {
        const [leftDay, leftSlot, leftLine] = left.split("|");
        const [rightDay, rightSlot, rightLine] = right.split("|");
        const dayDelta = planDayIndex((normalizePlanDay(leftDay ?? "") ?? "Dienstag") as PlanDay)
          - planDayIndex((normalizePlanDay(rightDay ?? "") ?? "Dienstag") as PlanDay);
        if (dayDelta !== 0) return dayDelta;
        const slotDelta = SLOTS.findIndex((slot) => slot.key === leftSlot) - SLOTS.findIndex((slot) => slot.key === rightSlot);
        if (slotDelta !== 0) return slotDelta;
        return Number(leftLine ?? 0) - Number(rightLine ?? 0);
      });

    for (const [cellKey, recipe] of entries) {
      if (!recipe || recipe.isBreak) continue;
      const [dayRaw, slotKey, liRaw] = cellKey.split("|");
      const day = normalizePlanDay(dayRaw ?? "");
      if (!day) continue;
      const li = Number(liRaw ?? -1);
      if (li < 0 || !(activeLineIdxByDay[day] ?? []).includes(li)) continue;

      const location = `${DAY_SHORT[day] ?? day} ${SLOTS.find((slot) => slot.key === slotKey)?.label ?? slotKey} L${li + 1}`;
      const dayIdx = DAYS.indexOf(day);
      const mhdViolation = recipe.isSeafood ? dayIdx < 5 : dayIdx < 1;
      if (mhdViolation) {
        hints.push({
          key: `mhd-${cellKey}`,
          severity: "error",
          domain: "mhd",
          cellKey,
          recipeCode: recipe.code,
          location,
          message: recipe.isSeafood ? "MHD-Risiko: Fisch zu früh geplattet" : "MHD-Risiko: zu früh geplattet",
          action: "Slot näher an Versand legen oder Manufacturing-/Plating-Fenster neu abstimmen.",
        });
      }

      const targets = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
      const alreadyProduced = producedByRecipe.get(recipe.code) ?? 0;
      const run = cockpitRunForDay(day) ?? (alreadyProduced < targets.firstRunTarget ? 1 : 2);
      const cockpitRule = cockpitRunReadiness.get(recipe.code)?.[run];
      if (cockpitRule && cockpitScoreForDay(day, cockpitRule) <= 0) {
        const message = planDayIndex(day) < planDayIndex(cockpitRule.readyDay)
          ? `R${run} vor Küchenfertigstellung (${cockpitRule.readyDay})`
          : `R${run} nach Deadline (${cockpitRule.dueDay})`;
        hints.push({
          key: `readiness-${cellKey}-${run}`,
          severity: "error",
          domain: "readiness",
          cellKey,
          recipeCode: recipe.code,
          location,
          message,
          action: "Slot verschieben oder Manufacturing-Submeals so planen, dass die Küche rechtzeitig fertig ist.",
        });
      }

      const slotPortions = portionsInSlotByLineCapacity(Math.max(0, lineCapacityByLane[String(li)] ?? 0), slotKey ?? "");
      const allocated = allocatedPortionsByCell.get(cellKey) ?? Math.max(0, Math.min(slotPortions, targets.totalTarget - alreadyProduced));
      producedByRecipe.set(recipe.code, alreadyProduced + allocated);
    }

    for (const day of DAYS) {
      for (const slot of SLOTS) {
        const mh = mealsPerHour(day, slot.key);
        const targetKey = `${day}|${slot.key}`;
        const fallbackTarget = (activeLineIdxByDay[day] ?? []).reduce((sum, li) => sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0), 0);
        const targetMh = Math.max(0, targetMealsBySlot[targetKey] ?? fallbackTarget);
        const deltaMh = mh - targetMh;
        if (targetMh > 0 && mh > 0 && Math.abs(deltaMh) > Math.max(60, targetMh * 0.08)) {
          hints.push({
            key: `slot-target-${targetKey}`,
            severity: "warn",
            domain: "slot",
            location: `${DAY_SHORT[day] ?? day} ${slot.label}`,
            message: deltaMh > 0 ? `${fmtNum(deltaMh)} Meals/h über Slot-Ziel` : `${fmtNum(Math.abs(deltaMh))} Meals/h unter Slot-Ziel`,
            action: "Linienbelegung, Ziel-Meals/h oder Linienkapazität anpassen.",
          });
        }
      }
    }

    for (const day of platingCalendarDays) {
      for (const line of day.lineSummaries) {
        if (line.utilization > 1.02) {
          hints.push({
            key: `line-util-${day.day}-${line.lineIdx}`,
            severity: "error",
            domain: "slot",
            location: `${DAY_SHORT[day.day] ?? day.day} Linie ${line.lineIdx + 1}`,
            message: `${fmtNum(Math.round(line.utilization * 100))}% Linienauslastung`,
            action: "Volumen auf andere Slots oder Linien verteilen.",
          });
        }
      }
    }

    return hints.sort((left, right) => {
      if (left.severity !== right.severity) return left.severity === "error" ? -1 : 1;
      return left.location.localeCompare(right.location, "de");
    });
  }, [
    activeLineIdxByDay,
    allocatedPortionsByCell,
    cockpitRunReadiness,
    lineCapacityByLane,
    platingCalendarDays,
    runTargetsByRecipe,
    schedule,
    targetMealsBySlot,
    volumeCoverageRows,
  ]);

  const collisionHintsByCell = useMemo(() => {
    const map = new Map<string, LineCollisionHint[]>();
    for (const hint of collisionHints) {
      if (!hint.cellKey) continue;
      const list = map.get(hint.cellKey) ?? [];
      list.push(hint);
      map.set(hint.cellKey, list);
    }
    return map;
  }, [collisionHints]);

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
              <span>∑ <strong>{fmtNum(recipePlanTotal || totalVolume)}</strong> Portionen</span>
              <span className={openVolumeTotal > 0 ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                offen <strong>{fmtNum(Math.round(openVolumeTotal))}</strong>
              </span>
              <span><strong>{recipes.length}</strong> Rezepte</span>
              <span><strong>{Object.values(schedule).filter(Boolean).length}</strong> Slots belegt</span>
            </div>
            {weekIntel && (
              <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-800 ring-1 ring-emerald-200">Eigene {fmtNum(weekIntel.factoryRecipeCount)}</span>
                <span className="rounded-full bg-sky-50 px-2 py-0.5 font-semibold text-sky-800 ring-1 ring-sky-200">Hybrid {fmtNum(weekIntel.hybridRecipeCount)}</span>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800 ring-1 ring-amber-200">Zulieferung {fmtNum(weekIntel.suppliedRecipeCount)}</span>
                {!weekIntel.hasTruthData && (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 font-semibold text-violet-800 ring-1 ring-violet-200">WO {fmtNum(weekIntel.workOrderCount)} · Target {fmtNum(weekIntel.totalTargetPortions)}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
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
              onClick={handleRefresh}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              title="Daten neu laden und Ramp-Up Snapshot aufzeichnen"
            >
              🔄 Aktualisieren
            </button>
            <button
              onClick={() => autoPlanFromTargets()}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              title={hasSavedManufacturingPlan ? "Füllt freie Slots anhand des gesicherten Manufacturing-Plans automatisch" : "Füllt freie Slots und meldet Manufacturing, was nachgezogen werden muss"}
            >
              🤖 Auto-Plan
            </button>
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  const { getFirebase } = await import("./firebase");
                  const { doc, setDoc } = await import("firebase/firestore");
                  const { db } = getFirebase();

                  const cockpitByDay: Record<string, Array<{ slot: string; line: number; code: string; name: string; portions: number; run: 1 | 2 }>> = {};
                  const producedBefore = new Map<string, number>();
                  for (const d of DAYS) cockpitByDay[d] = [];
                  for (const day of DAYS) {
                    for (const slot of SLOTS) {
                      for (const li of activeLineIdxByDay[day] ?? []) {
                        const recipe = schedule[`${day}|${slot.key}|${li}`];
                        if (!recipe) continue;
                        const lineTarget = Math.max(0, lineCapacityByLane[String(li)] ?? 0);
                        const slotPortions = Math.round(portionsInSlotByLineCapacity(lineTarget, slot.key));
                        const targets = runTargetsByRecipe.get(recipe.code) ?? lineRunTargetsForRecipe(recipe);
                        const before = producedBefore.get(recipe.code) ?? 0;
                        const run: 1 | 2 = before < targets.firstRunTarget ? 1 : 2;
                        const portions = Math.min(slotPortions, Math.max(0, targets.totalTarget - before));
                        producedBefore.set(recipe.code, before + portions);
                        cockpitByDay[day]?.push({
                          slot: slot.key,
                          line: li + 1,
                          code: recipe.code,
                          name: recipe.name,
                          portions,
                          run,
                        });
                      }
                    }
                  }

                  await setDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`), {
                    week,
                    savedAt: new Date().toISOString(),
                    schedule,
                    comments,
                    targetMealsBySlot,
                    lineCapacityByLane,
                    platingLineCount,
                    dayLineCount,
                    runSplitByRecipe,
                    cockpitPlan: cockpitByDay,
                    cockpitBuiltAt: new Date().toISOString(),
                  }, { merge: true });

                  setSaveOk(true);
                  setAutoPlanNotice("Cockpit aus Plating-Plan aufgebaut und gespeichert.");
                  setTimeout(() => setSaveOk(false), 3000);
                  setTimeout(() => setAutoPlanNotice(""), 3000);
                } catch (err) {
                  alert(`Cockpit aufbauen fehlgeschlagen: ${(err as Error).message}`);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50"
              title="Baut die Cockpit-Linienplanung aus dem aktuellen Plating-Plan und speichert automatisch"
            >
              ➡ Cockpit aufbauen
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
        {forecastVarianceRows.length > 0 && (
          <div className="mt-2 rounded-xl border-2 border-rose-300 bg-rose-50 px-4 py-3">
            <div className="text-sm font-black tracking-wide text-rose-800">FORECAST-FLUKTUATION AKTIV - RUN 2 WIRD DYNAMISCH ANGEPASST</div>
            <div className="mt-1 text-xs font-semibold text-rose-700">
              {forecastAlertStamp ? `Letzte erkannte Aenderung: ${forecastAlertStamp}.` : "Forecast-Werte weichen von den Planwerten ab."} Ziel-Logik: Run 1 bleibt stabil, die Differenz geht automatisch in Run 2.
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-rose-800">Auto-Trigger ab Δ</span>
              <input
                type="number"
                min={0}
                step={10}
                value={forecastAutoThreshold}
                onChange={(event) => setForecastAutoThreshold(Math.max(0, Number(event.target.value) || 0))}
                className="w-24 rounded-md border border-rose-300 bg-white px-2 py-1 text-right font-bold text-rose-800"
              />
              <span className="font-semibold text-rose-700">Portionen</span>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {(forecastAlertRows.length > 0 ? forecastAlertRows : forecastVarianceRows.slice(0, 6)).map((row) => (
                <div key={`forecast-alert-${row.code}`} className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs">
                  <div className="font-black text-rose-800">{row.code}</div>
                  <div className="truncate text-slate-600" title={row.recipeName}>{row.recipeName}</div>
                  <div className="mt-1 flex items-center justify-between tabular-nums gap-2">
                    <span className="text-slate-500">Plan {fmtNum(row.targetPortions)}</span>
                    <span className="text-slate-500">Forecast {fmtNum(row.forecastPortions)}</span>
                    <span className={`${row.delta > 0 ? "text-rose-700" : "text-emerald-700"} font-black`}>{row.delta > 0 ? `+${fmtNum(row.delta)}` : fmtNum(row.delta)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {rampUpChanges.length > 0 && !rampUpBannerDismissed && (
          <div className="mt-2 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black tracking-wide text-amber-800">
                  &#9888; {rampUpChanges.length} {rampUpChanges.length === 1 ? "Rezept hat" : "Rezepte haben"} neue Portionszahlen
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {rampUpChanges.map(c => (
                    <div key={c.code} className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs flex items-center gap-2">
                      <span className="font-black text-amber-900">{c.code}</span>
                      <span className="text-slate-500 tabular-nums">{fmtNum(c.oldTotal)} → {fmtNum(c.newTotal)}</span>
                      <DeltaBadge delta={c.delta} />
                    </div>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setRampUpBannerDismissed(true)}
                className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold hover:bg-amber-300 transition-colors"
                title="Schließen"
              >&#x2715;</button>
            </div>
          </div>
        )}
        {!hasSavedManufacturingPlan && (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">
            Reihenfolge: erst Manufacturing Calendar planen und dort "Plan sichern" klicken. Danach nutzt die Plating-Automatik den gesicherten Küchenplan fuer Run 1 und Run 2.
          </div>
        )}
        {hasSavedManufacturingPlan && (
          <div className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
            Manufacturing-Plan live geladen{manufacturingSnapshot?.savedAtLabel ? `: ${manufacturingSnapshot.savedAtLabel}` : ""}. Auto-Plan nutzt diese Run-/Submeal-Daten und zieht offene Plating-Mengen automatisch nach.
          </div>
        )}
        {openVolumeTotal > 0 && (
          <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">
            Offenes Plating-Volumen: {fmtNum(Math.round(openVolumeTotal))} Portionen.
            {hasSavedManufacturingPlan
              ? " Wird gegen den Manufacturing Calendar automatisch nachverplant."
              : " Wird automatisch vorgeplant; Manufacturing bekommt parallel den Nachzieh-Auftrag."}
          </div>
        )}
        {collisionHints.length > 0 && (
          <div className="mt-2 rounded-xl border-2 border-rose-300 bg-white px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-black tracking-wide text-rose-800">
                Kollisionen direkt bearbeiten: {collisionHints.filter((item) => item.severity === "error").length} kritisch · {collisionHints.filter((item) => item.severity === "warn").length} Hinweise
              </div>
              <button
                onClick={handleCorrectCollisions}
                className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-black text-white hover:bg-rose-800"
              >
                Auto-Plan korrigieren
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {collisionHints.slice(0, 8).map((item) => (
                <div key={item.key} className={`rounded-lg border px-3 py-2 text-xs ${collisionTone(item.severity)}`}>
                  <div className="font-black">{item.location}</div>
                  <div className="mt-0.5 font-semibold">{item.message}</div>
                  <div className="mt-1 opacity-75">{item.action}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {showHelp && (
          <div className="mt-3 rounded-xl bg-slate-50 ring-1 ring-slate-200 p-4 text-xs text-slate-700 space-y-3">
            <div className="font-bold text-sm text-slate-800 mb-1">Bedienung – Factor OPS Planner · Linienplanung</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
              <div><span className="font-semibold text-slate-900">📋 Plating Linien Plannung</span> – Wechselt zum Raster-Tab: 7 Tage × 9 Zeitslots × 3 P-Linien. Rezepte per Drag&amp;Drop aus dem Rezept-Pool (rechts) in die Slots ziehen.</div>
              <div><span className="font-semibold text-slate-900">🍳 KET</span> – Kitchen Equipment Tracking: zeigt alle Produktionsaufträge (Work Orders) aus dem Google Sheet, geordnet nach Produktionstag. Cards per Drag&amp;Drop in andere Tage verschieben, Klick auf Status schaltet weiter.</div>
              <div><span className="font-semibold text-slate-900">QR / URL</span> – Öffnet ein Modal mit QR-Code und direktem Link zu dieser Woche. Link direkt in Teams/WhatsApp teilen – Empfänger landen sofort auf der richtigen KW.</div>
              <div><span className="font-semibold text-slate-900">🤖 Auto-Plan</span> – Füllt freie Slots küchengeführt und im festen Batch-Split-Schema (MHD + Fulfillment), immer über alle 3 Plating-Linien. Bereits belegte Slots werden nicht überschrieben.</div>
              <div><span className="font-semibold text-slate-900">💾 Plan sichern</span> – Speichert die komplette Planung (Schedule, KET-Status, Zielwerte) in Firestore. Alle anderen Planer sehen die Änderungen sofort (Echtzeit-Sync).</div>
              <div><span className="font-semibold text-slate-900">Rezept-Pool (rechts)</span> – Zeigt alle Rezepte der KW mit Volumen pro Markt. Von hier per Drag&amp;Drop in Slots ziehen. Volumen-Balance unten zeigt Fortschritt.</div>
              <div><span className="font-semibold text-slate-900">P-Linienleistung</span> – Manuelle Soll-Kapazität (Portionen/h) pro Linie. Wird für Auto-Plan und Delta-Berechnung verwendet.</div>
              <div><span className="font-semibold text-slate-900">Ist / Ziel-Spalte</span> – Zeigt berechnete Meals/h des Slots vs. Zielwert. Grün = ±8%, gelb/rot = Abweichung. Zielwert direkt bearbeitbar.</div>
              <div><span className="font-semibold text-slate-900">JSON aktualisieren</span> – Das Rezept-Pool und KET-Daten kommen aus dem Google-Sheet-Dump unter <code className="bg-slate-100 px-1 rounded">public/data/</code>. Bei neuer KW: <code className="bg-slate-100 px-1 rounded">npm run dump</code> oder Script ausführen.</div>
            </div>
          </div>
        )}
      </div>

      {/* ─── LINIENPLANUNG ────────────────────────────────────────────────── */}
      <div className="grid gap-4 items-start xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="card p-4 xl:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-sm font-black text-slate-900">Plating-Kalender</div>
                <div className="mt-1 text-xs text-slate-500">
                  Live-Auslastung nach gespeicherter Kapazitaet, aktiven Linien und aktuellen Slot-Belegungen.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 ring-1 ring-slate-200">
                  {DAY_LINE_COUNT_ORDER.map((day) => (
                    <span
                      key={`calendar-day-line-count-${day}`}
                      className="rounded-md bg-white px-2 py-1 text-[11px] font-black text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                      title={`Kernvorgabe ${day}: ${dayLineCount[day]} Plating-Linie(n)`}
                    >
                      {DAY_SHORT[day] ?? day} {dayLineCount[day]}L
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {LINES.map((line, li) => (
                    <label key={`calendar-cap-${line}`} className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-slate-700 ring-1 ring-slate-200">
                      <span className="text-[10px] font-bold">{line.replace("P-Linie ", "P")}</span>
                      <input
                        type="number"
                        min={0}
                        step={50}
                        value={lineCapacityByLane[String(li)] ?? 0}
                        onChange={(event) => {
                          const value = Math.max(0, Number(event.target.value) || 0);
                          setLineCapacityByLane(prev => ({ ...prev, [String(li)]: value }));
                        }}
                        className="w-16 rounded-md border border-slate-200 px-1.5 py-0.5 text-right text-[11px] font-bold tabular-nums disabled:bg-slate-100 disabled:text-slate-400"
                      />
                      <span className="text-[10px] text-slate-400">/h</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {[
                { label: "Geplant", value: fmtNum(Math.round(platingCalendarTotals.planned)), tone: "text-slate-900" },
                { label: "Kapazitaet", value: fmtNum(Math.round(platingCalendarTotals.capacity)), tone: "text-indigo-700" },
                { label: "Offen", value: fmtNum(Math.round(platingCalendarTotals.open)), tone: "text-emerald-700" },
                { label: "Auslastung", value: `${Math.round(platingCalendarTotals.utilization * 100)}%`, tone: platingCalendarTotals.utilization > 1 ? "text-rose-700" : platingCalendarTotals.utilization >= 0.85 ? "text-amber-700" : "text-slate-900" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{stat.label}</div>
                  <div className={`mt-1 text-lg font-black tabular-nums ${stat.tone}`}>{stat.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
              {platingCalendarDays.map((day) => {
                const pct = Math.round(day.utilization * 100);
                const barTone = day.utilization > 1 ? "bg-rose-500" : day.utilization >= 0.85 ? "bg-amber-400" : "bg-emerald-500";
                return (
                  <div key={`plating-calendar-${day.day}`} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-black text-slate-900">{day.day}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {day.recipeCount} Meal{day.recipeCount !== 1 ? "s" : ""} · {dayLineCount[day.day]} Linie{dayLineCount[day.day] !== 1 ? "n" : ""}
                        </div>
                      </div>
                      <div className={`rounded-full px-2 py-0.5 text-[11px] font-black tabular-nums ${day.utilization > 1 ? "bg-rose-100 text-rose-700" : day.utilization >= 0.85 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {pct}%
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${barTone}`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] font-semibold tabular-nums text-slate-600">
                      <span>{fmtNum(Math.round(day.planned))} geplant</span>
                      <span>{fmtNum(Math.round(day.capacity))} Kapa</span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {day.lineSummaries.map((line) => {
                        const linePct = Math.round(line.utilization * 100);
                        const lineTone = line.utilization > 1 ? "bg-rose-400" : line.utilization >= 0.85 ? "bg-amber-400" : "bg-sky-500";
                        return (
                          <div key={`${day.day}-line-${line.lineIdx}`} className="rounded-md bg-slate-50 px-2 py-1.5 ring-1 ring-slate-100">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="font-bold text-slate-700">P-Linie {line.lineIdx + 1}</span>
                              <span className="font-semibold tabular-nums text-slate-500">{fmtNum(Math.round(line.planned))}/{fmtNum(Math.round(line.capacity))}</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white">
                              <div className={`h-full rounded-full ${lineTone}`} style={{ width: `${Math.min(100, linePct)}%` }} />
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {line.recipes.slice(0, 4).map((recipe) => (
                                <span key={`${day.day}-${line.lineIdx}-${recipe.code}`} className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-600 ring-1 ring-slate-200">
                                  {recipe.code}
                                </span>
                              ))}
                              {line.recipes.length > 4 && (
                                <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-400 ring-1 ring-slate-200">+{line.recipes.length - 4}</span>
                              )}
                              {line.recipes.length === 0 && <span className="text-[10px] font-semibold text-slate-300">frei</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Schedule Grid ─────────────────────────────────────────────── */}
          <div className="min-w-0 overflow-x-auto pb-2">
          <div className="min-w-[980px] space-y-3 pr-2">
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
                    const fallbackTarget = (activeLineIdxByDay[day] ?? []).reduce((sum, li) => sum + Math.max(0, lineCapacityByLane[String(li)] ?? 0), 0);
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
                            const cellCollisions = collisionHintsByCell.get(cellKey) ?? [];
                            const disabledLine = !(activeLineIdxByDay[day] ?? []).includes(li);
                            if (disabledLine) {
                              return (
                                <div key={cellKey} className="min-h-[5rem] rounded-xl border border-dashed border-slate-200 bg-slate-100/70 flex items-center justify-center text-[10px] font-semibold text-slate-400">
                                  deaktiviert
                                </div>
                              );
                            }
                            // MHD-Verletzung prüfen:
                            // DAYS = [Fr=0, Sa=1, So=2, Mo=3, Di=4, Mi=5, Do=6]
                            // Versand = Fr folgende Woche → daysBeforeShipping = 7 - dayIndex
                            // Fisch (maxGap=2): Plating muss spätestens Mi (idx 5) oder Do (idx 6) → Verletzung wenn idx < 5
                            // Non-Fisch (maxGap=6): Verletzung wenn idx < 1 (nur Fr ist kritisch)
                            const dayIdx = DAYS.indexOf(day);
                            const mhdViolation = r != null && (
                              r.isSeafood ? dayIdx < 5 : dayIdx < 1
                            );
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
                                mhdViolation={mhdViolation}
                                collisions={cellCollisions}
                                volumeHistory={r ? (rampUpHistoryMap.get(r.code) ?? []).map(s => s.volumes[r.code] ?? 0) : undefined}
                                volumeDelta={r ? rampUpChanges.find(c => c.code === r.code)?.delta : undefined}
                                volumeSnapshots={r ? (rampUpHistoryMap.get(r.code) ?? []) : undefined}
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
          </div>

          {/* ── Right Panel: Recipe Pool + Volume Balance ─────────────────── */}
          <div className="w-full min-w-0 space-y-3 xl:sticky xl:top-4">

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
              <div className="mb-3 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
                <div className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-500">Kernvorgabe Linien je Tag</div>
                <div className="grid grid-cols-2 gap-1">
                  {DAY_LINE_COUNT_ORDER.map((day) => (
                    <label key={`day-line-setting-${day}`} className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1 ring-1 ring-slate-100">
                      <span className="text-[11px] font-bold text-slate-600">{DAY_SHORT[day] ?? day}</span>
                      <select
                        value={dayLineCount[day]}
                        onChange={(event) => {
                          const value = Number(event.target.value) as DayLineCount;
                          setDayLineCount((prev) => ({ ...prev, [day]: value }));
                        }}
                        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] font-black text-indigo-700"
                      >
                        {([0, 1, 2, 3] as const).map((count) => (
                          <option key={count} value={count}>{count}L</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
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
              <div className="mt-3 space-y-2">
                <div className="rounded-md bg-indigo-50 px-2 py-2 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">
                  Steuerung: Mo 1L · Di 3L · Mi 3L · Do 3L · Fr 2L · Sa 1L. Auto-Plan rechnet pro Tag exakt mit diesen Linienlimits.
                </div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500">
                Tageslinien + Linienleistung werden von der Auto-Planung berücksichtigt und mitgespeichert.
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
                    planningRole={planningOasis?.recipes[recipe.code]?.planningRole}
                    scheduledDays={scheduledDaysByCode.has(recipe.code)
                      ? [...DAYS].filter(d => scheduledDaysByCode.get(recipe.code)!.has(d))
                      : undefined}
                    scheduledPortions={scheduledPortions.get(recipe.code)}
                    onDragStart={() => onDragStartPool(recipe)}
                    volumeHistory={(rampUpHistoryMap.get(recipe.code) ?? []).map(s => s.volumes[recipe.code] ?? 0)}
                    volumeDelta={rampUpChanges.find(c => c.code === recipe.code)?.delta}
                    volumeSnapshots={rampUpHistoryMap.get(recipe.code)}
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
                  const maxPortions = SLOTS.reduce((sum, slot) => {
                    return sum + (activeLineIdxByDay[day] ?? []).reduce((lineSum, li) => {
                      return lineSum + portionsInSlotByLineCapacity(lineCapacityByLane[String(li)] ?? 0, slot.key);
                    }, 0);
                  }, 0);
                  const pct = maxPortions > 0 ? Math.min(100, (totalMh / maxPortions) * 100) : 0;
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

      {/* ── QR / URL Modal ───────────────────────────────────────────────── */}
      {showQrModal && (() => {
        const shareUrl = `${window.location.origin}${window.location.pathname}?week=${encodeURIComponent(week)}`;
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
