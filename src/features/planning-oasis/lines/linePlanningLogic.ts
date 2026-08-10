// Reine Logik der Linienplanung: Rezept-Ableitung aus WeekRecipes, Run-Splits,
// Tages-/Slot-Arithmetik, den GSheet-Zeilen-Parser, den Schedule-Reducer und die
// Cockpit-Snapshot-/Reconcile-Brücke (liest/schreibt dieselben localStorage-Keys
// wie Planning OASE Cockpit — Vertrag muss exakt erhalten bleiben).
import type { CSSProperties } from "react";
import type { WeekRecipe } from "../../../core/types";
import type { PlannerDay, PlannerScenario } from "../../../lib/planner";
import { calculateRunSplit, type RunSplitPlan } from "../../../lib/runPlanning";
import {
  DAYS, DAY_EN_TO_DE, PLANNER_DAY_TO_PLAN_DAY, RUN_PLATING_WINDOWS,
  RUN_ONE_SUB_DAYS, RUN_TWO_SUB_DAYS, SLOTS, MEAL_CHANGE_BREAK,
  type CockpitRunReadiness, type LinePlanRecipe, type ManufacturingPlanSnapshot,
  type PlanDay, type DayLineCount, type ScheduleMap,
} from "./linePlanningDomain";

/** Heuristik: Rezeptname auf Fisch-Schlüsselwörter prüfen (kein Zugriff auf Zutaten nötig) */
export function detectSeafoodByName(name: string): boolean {
  return /salmon|shrimp|prawn|fish|seafood|cod|tuna|trout|hering|herring|lachs|garnele|forelle|kabeljau|thunfisch/i.test(name);
}

export function isProducedInVerden(recipe: WeekRecipe): boolean {
  const code = (recipe.code ?? "").toUpperCase();
  if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
  const total = (recipe.verdenVolume.BENL ?? 0) + (recipe.verdenVolume.DKSE ?? 0) + (recipe.verdenVolume.DE ?? 0);
  return total > 0;
}

export function deriveRecipesFromWeekRecipes(weekRecipes: WeekRecipe[], requestedWeek: string, upliftFactor = 1): LinePlanRecipe[] {
  return weekRecipes
    .filter(recipe => recipe.hfWeek === requestedWeek)
    .filter(isProducedInVerden)
    .filter((recipe, index, all) => all.findIndex(other => other.code === recipe.code) === index)
    .sort((a, b) => b.totalVerdenVolume - a.totalVerdenVolume)
    .map(recipe => ({
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

export function defaultLineCapacityMap(): Record<string, number> {
  return { "0": 1200, "1": 1200, "2": 1200 };
}

export function defaultDayLineCountMap(): Record<PlanDay, DayLineCount> {
  return { Montag: 1, Dienstag: 3, Mittwoch: 3, Donnerstag: 3, Freitag: 2, Samstag: 1, Sonntag: 0 };
}

export function normalizeDayLineCountMap(input?: Record<string, number> | null): Record<PlanDay, DayLineCount> {
  const next = defaultDayLineCountMap();
  for (const day of DAYS) {
    const raw = input?.[day];
    if (raw === 0 || raw === 1 || raw === 2 || raw === 3) next[day] = raw;
  }
  return next;
}

export function parseNum(s: unknown): number {
  if (typeof s !== "string") return 0;
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

export function recipeHue(code: string): number {
  // Gleiche Hue-Range wie in der linken Rezeptliste (App).
  return 18 + (stableHash(code) % 300);
}

export function recipeTone(code: string): { base: CSSProperties; code: CSSProperties; title: CSSProperties } {
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

export function nameShort(name: string, max = 30): string {
  const trimmed = name.replace(/\[.*?\]/g, "").trim();
  return trimmed.length > max ? trimmed.substring(0, max - 1) + "…" : trimmed;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

export function planningRoleTone(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "bg-sky-50 text-sky-800 ring-sky-200";
  if (role === "supplied") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-emerald-50 text-emerald-800 ring-emerald-200";
}

export function planningRoleLabel(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "Hybrid";
  if (role === "supplied") return "Zulieferung";
  return "Eigene Produktion";
}

function slotDuration(slotKey: string): number {
  return SLOTS.find(s => s.key === slotKey)?.duration ?? 0;
}

export function portionsInSlotByLineCapacity(lineCapacityPerHour: number, slotKey: string): number {
  return (Math.max(0, lineCapacityPerHour) / 60) * slotDuration(slotKey);
}

export function runSplitForLineRecipe(recipe: LinePlanRecipe): RunSplitPlan {
  return calculateRunSplit({ bnl: recipe.bnl, nordics: recipe.nordics, de: recipe.de });
}

export function lineRunTargetsForRecipe(recipe: LinePlanRecipe): { firstRunTarget: number; secondRunTarget: number; totalTarget: number } {
  const split = runSplitForLineRecipe(recipe);
  const totalTarget = Math.max(0, Math.round(recipe.totalPlanned || split.baseTotal));
  const firstRunTarget = Math.max(0, Math.min(totalTarget, split.firstRun.total || 0));
  return { firstRunTarget, secondRunTarget: Math.max(0, totalTarget - firstRunTarget), totalTarget };
}

export function normalizePlanDay(raw: string): PlanDay | null {
  const clean = String(raw ?? "").trim();
  if (!clean) return null;
  if ((DAYS as readonly string[]).includes(clean)) return clean as PlanDay;
  if ((["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as readonly string[]).includes(clean)) {
    return PLANNER_DAY_TO_PLAN_DAY[clean as PlannerDay];
  }
  const mapped = DAY_EN_TO_DE[clean];
  return mapped && (DAYS as readonly string[]).includes(mapped) ? mapped as PlanDay : null;
}

export function planDayIndex(day: PlanDay): number {
  const index = DAYS.indexOf(day);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function planDayCompare(left: PlanDay, right: PlanDay): number {
  return planDayIndex(left) - planDayIndex(right);
}

export function runReadyDayIndex(day: PlanDay, run: 1 | 2): number {
  if (run === 1 && day === "Sonntag") return -1;
  const order: PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const index = order.indexOf(day);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function laterRunReadyDay(left: PlanDay, right: PlanDay, run: 1 | 2): PlanDay {
  return runReadyDayIndex(left, run) >= runReadyDayIndex(right, run) ? left : right;
}

export function nextPlanDay(day: PlanDay): PlanDay {
  const idx = planDayIndex(day);
  return idx < DAYS.length - 1 ? DAYS[idx + 1] : day;
}

export function parseLineBoardNote(note?: string): { notes: string } {
  const raw = String(note ?? "").trim();
  if (!raw) return { notes: "" };
  const notesPart = raw.split("||").find(part => part.startsWith("notes=")) ?? "";
  return { notes: notesPart ? notesPart.slice(6).trim() : "" };
}

// ─── Cockpit-Snapshot-Brücke (Vertrag mit Planning OASE Cockpit, siehe Phase 4) ──

export function loadManufacturingPlanSnapshot(week: string): ManufacturingPlanSnapshot | null {
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

export function manufacturingSnapshotSignature(snapshot: ManufacturingPlanSnapshot | null): string {
  if (!snapshot) return "";
  return JSON.stringify(snapshot.assignments ?? {});
}

export function extractLineSplitSpec(notes: string): string {
  const match = /(?:^|\s)split=([^\s]+)/i.exec(String(notes ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

export function parseLineSplitSpecToBatches(
  splitSpec: string,
  fallbackDay: PlannerDay,
  totalTarget: number,
): Array<{ day: PlannerDay; portions: number }> {
  const tokens = splitSpec.split("|").map(part => part.trim()).filter(Boolean);
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

export function resolveCockpitRunBatches(
  mainBatches: Array<{ day: PlannerDay; portions: number }>,
  targets: { firstRunTarget: number; secondRunTarget: number },
): Partial<Record<1 | 2, { day: PlannerDay; portions: number }>> {
  const runOneFromSplit = mainBatches.find(batch => batch.day === "Fr") ?? mainBatches[0];
  const runTwoFromSplit = mainBatches.find(batch => batch.day === "So") ?? mainBatches[1];
  const out: Partial<Record<1 | 2, { day: PlannerDay; portions: number }>> = {};
  if (targets.firstRunTarget > 0) {
    out[1] = { day: runOneFromSplit?.day ?? "Fr", portions: Math.max(0, Math.round(runOneFromSplit?.portions ?? targets.firstRunTarget)) };
  }
  if (targets.secondRunTarget > 0) {
    out[2] = { day: runTwoFromSplit?.day ?? "So", portions: Math.max(0, Math.round(runTwoFromSplit?.portions ?? targets.secondRunTarget)) };
  }
  return out;
}

export function distributedRunSubDay(runIndex: number, subIndex: number): PlannerDay {
  const window = runIndex === 0 ? RUN_ONE_SUB_DAYS : RUN_TWO_SUB_DAYS;
  const offset = runIndex === 0 ? 0 : 2;
  return window[(subIndex + offset) % window.length] ?? window[0];
}

/**
 * Bewertet Tag `day` für einen Run anhand tatsächlicher Küchen-Bereitschaft.
 * Gate: 0 wenn Küche noch nicht fertig (day < readyDay) oder Deadline überschritten.
 * Höchste Bewertung genau am readyDay (sofort starten sobald Küche fertig).
 */
export function cockpitScoreForDay(day: PlanDay, rule: CockpitRunReadiness): number {
  const dayIdx = planDayIndex(day);
  const readyIdx = planDayIndex(rule.readyDay);
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
export function cockpitRunForDay(day: PlanDay): 1 | 2 | null {
  const idx = planDayIndex(day);
  const in1 = idx >= planDayIndex(RUN_PLATING_WINDOWS[1].startDay) && idx <= planDayIndex(RUN_PLATING_WINDOWS[1].dueDay);
  const in2 = idx >= planDayIndex(RUN_PLATING_WINDOWS[2].startDay) && idx <= planDayIndex(RUN_PLATING_WINDOWS[2].dueDay);
  if (in1 && !in2) return 1;
  if (in2 && !in1) return 2;
  return null; // Mi/Do: in beiden Runs → nach Produktionsstand entscheiden
}

export function emptyRunProduction(): Record<1 | 2, number> {
  return { 1: 0, 2: 0 };
}

export function slotFitsRemaining(slotPortions: number, remaining: number): boolean {
  if (remaining <= 0) return false;
  if (slotPortions <= remaining) return true;
  const toleratedOver = Math.max(150, slotPortions * 2.0);
  return slotPortions - remaining <= toleratedOver;
}

export function mhdRunWindow(recipe: LinePlanRecipe, run: 1 | 2): ReadonlyArray<PlanDay> {
  if (recipe.isSeafood) {
    return run === 1 ? ["Dienstag", "Mittwoch"] : ["Mittwoch", "Donnerstag", "Freitag"];
  }
  return run === 1 ? ["Dienstag", "Mittwoch", "Donnerstag"] : ["Mittwoch", "Donnerstag", "Freitag", "Samstag"];
}

export function recommendedRunDay(run: 1 | 2): PlanDay {
  return run === 1 ? "Mittwoch" : "Freitag";
}

export function runWindowScore(day: PlanDay, window: ReadonlyArray<PlanDay>, preferred: PlanDay): number {
  if (day === preferred) return 1;
  if (window.includes(day)) return 0.72;
  return 0.06;
}

export function planDayDistance(a: PlanDay, b: PlanDay): number {
  const order: PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai < 0 || bi < 0) return 3;
  return Math.abs(ai - bi);
}

export function runBadgeTone(run: 1 | 2): string {
  return run === 1 ? "bg-indigo-50 text-indigo-700 border-indigo-200" : "bg-teal-50 text-teal-700 border-teal-200";
}

export function collisionTone(severity: "error" | "warn"): string {
  return severity === "error" ? "border-rose-300 bg-rose-50 text-rose-900" : "border-amber-300 bg-amber-50 text-amber-900";
}

export function collisionPillTone(severity: "error" | "warn"): string {
  return severity === "error" ? "bg-rose-100 text-rose-800 ring-rose-300" : "bg-amber-100 text-amber-800 ring-amber-300";
}

// ─── GSheet-Zeilen-Parser ────────────────────────────────────────────────────

export function parseLineplanning(rows: string[][]): {
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

// ─── Schedule-Reducer ────────────────────────────────────────────────────────

export type ScheduleAction =
  | { type: "assign"; key: string; recipe: LinePlanRecipe }
  | { type: "remove"; key: string }
  | { type: "swap"; from: string; to: string }
  | { type: "load"; schedule: ScheduleMap };

export function scheduleReducer(state: ScheduleMap, action: ScheduleAction): ScheduleMap {
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

export function normalizeMealChangeBreaks(input: ScheduleMap, lineIdxs: number[]): ScheduleMap {
  const next: ScheduleMap = { ...input };
  for (const day of DAYS) {
    for (const li of lineIdxs) {
      const meals = SLOTS
        .map(slot => next[`${day}|${slot.key}|${li}`] ?? null)
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

export function schedulesEqual(left: ScheduleMap, right: ScheduleMap): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) return false;
  }
  return true;
}
