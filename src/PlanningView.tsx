import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { DataBundle, DetailedSubRecipe, ProcessSpec, Recipe, ShelfLifeInfo, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, fmtMin, getStationCapacityView, getSubRecipeMassProfile, loadStationDeviceCounts, loadStationPools } from "./equipment";
import {
  assignmentKey,
  PLANNER_DAYS,
  PLANNER_SHIFTS,
  SHIFT_CAPACITY_MIN,
  analyzePlan,
  assignRecipe,
  computeBatchSplitPlan,
  createScenario,
  getActiveScenario,
  getWeekState,
  loadPlannerStorage,
  resetScenario,
  removeAssignment,
  savePlannerStorage,
  setActiveScenario,
  suggestAssignments,
  type PlannerDay,
  type PlannerShift,
  type PlannerPoolConflict,
  type PlannerStationConflict,
  type LinePlatingSummary,
  type LinePlatingEntry,
} from "./planner";
import { tl, type UiLocale } from "./i18n";
import { usePlanningOasisData } from "./planningOasisData";
import { exportAsTSV, exportAsExcel, exportAsPDF } from "./planExport";
import type { RunSplitPlan } from "./runPlanning";
import { calculateRunSplit } from "./runPlanning";
import { recordRampUpSnapshot, getRampUpHistory, type RampUpSnapshot, type RampUpChangeEvent } from "./rampUpHistory";

const PLANNER_UI_SETTINGS_STORAGE_KEY = "rezeptlogik-planner-ui-settings-v1";

type PlannerUiSettings = {
  shiftPresetId: string;
  shiftCount: number;
  showAutoSuggestions: boolean;
  showStationConflicts: boolean;
  showPoolConflicts: boolean;
  autoSplitProfileId: string;
};

type AutoFulfillmentBatch = {
  day: PlannerDay;
  portions: number;
};

type AutoFulfillmentProfile = {
  id: string;
  label: string;
  mode: "mhd-smart" | "fixed";
  fallbackWeights?: Partial<Record<PlannerDay, number>>;
};

const AUTO_FULFILLMENT_PROFILES: readonly AutoFulfillmentProfile[] = [
  {
    id: "mhd-smart",
    label: "MHD Smart (Fr/So aus Batch-Plan)",
    mode: "mhd-smart"
  },
  {
    id: "growth-fr-sa-so",
    label: "Growth (Fr/Sa/So)",
    mode: "fixed",
    fallbackWeights: {
      Fr: 0.55,
      Sa: 0.2,
      So: 0.25
    }
  }
] as const;

const SHIFT_MODEL_PRESETS = [
  {
    id: "single-current",
    label: "Aktuell: Einschicht",
    shortLabel: "Einschicht",
    shiftCount: 1,
    tone: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    note: "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.",
    areas: ["Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: {
      Warehouse: 0,
      Kitchen: 1,
      Printing: 0,
      Plating: 1,
      Fulfilment: 1,
      FSQA: 0
    }
  },
  {
    id: "double-ready",
    label: "Vorbereitet: 2 Schichten",
    shortLabel: "2 Schichten",
    shiftCount: 2,
    tone: "bg-amber-50 text-amber-900 ring-amber-200",
    note: "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: {
      Warehouse: 1,
      Kitchen: 2,
      Printing: 1,
      Plating: 2,
      Fulfilment: 2,
      FSQA: 1
    }
  },
  {
    id: "triple-ready",
    label: "Vorbereitet: 3 Schichten",
    shortLabel: "3 Schichten",
    shiftCount: 3,
    tone: "bg-sky-50 text-sky-900 ring-sky-200",
    note: "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment", "FSQA"],
    areaShiftPlan: {
      Warehouse: 2,
      Kitchen: 3,
      Printing: 1,
      Plating: 3,
      Fulfilment: 3,
      FSQA: 2
    }
  }
] as const;

const SHIFT_MODEL_AREAS = [
  { key: "Warehouse", sheets: ["W1", "W2", "W3", "W4"] },
  { key: "Kitchen", sheets: ["K1", "K2", "K3", "K4"] },
  { key: "Printing", sheets: ["Printing"] },
  { key: "Plating", sheets: ["P1", "P2", "P3", "P4"] },
  { key: "Fulfilment", sheets: ["FFM1", "FFM2", "FFM3", "FFM4"] },
  { key: "FSQA", sheets: ["QA1", "QA2", "QA3", "QA4", "QA5"] }
] as const;

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function RampUpSparkline({ values, width = 50, height = 14 }: { values: number[]; width?: number; height?: number }) {
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
  const lastPt = pts.split(" ").pop()!.split(",");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "inline-block", verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2" fill={stroke} />
    </svg>
  );
}

function RampUpDeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: "9px", fontWeight: 700,
      padding: "0 4px", borderRadius: "9999px",
      background: up ? "#ecfdf5" : "#fff1f2",
      color: up ? "#059669" : "#e11d48",
      border: `1px solid ${up ? "#a7f3d0" : "#fecdd3"}`,
    }}>
      {up ? "+" : ""}{fmtNum(delta)}
    </span>
  );
}

function slotValue(day: PlannerDay, shift: PlannerShift): string {
  return `${day}__${shift}`;
}

type ManufacturingDayColumn = {
  id: string;
  day: PlannerDay;
  label: string;
  lane: "prep" | "regular";
};

type ManufacturingDaySummary = {
  column: ManufacturingDayColumn;
  mainCount: number;
  subRunCount: number;
  mainPortions: number;
  subPortions: number;
  items: string[];
};

const MANUFACTURING_DAYS: readonly ManufacturingDayColumn[] = [
  { id: "prep-so", day: "So", label: "So (Prep)", lane: "prep" },
  { id: "mo", day: "Mo", label: "Mo", lane: "regular" },
  { id: "di", day: "Di", label: "Di", lane: "regular" },
  { id: "mi", day: "Mi", label: "Mi", lane: "regular" },
  { id: "do", day: "Do", label: "Do", lane: "regular" },
  { id: "fr", day: "Fr", label: "Fr", lane: "regular" },
  { id: "sa", day: "Sa", label: "Sa", lane: "regular" },
  { id: "so", day: "So", label: "So", lane: "regular" },
];

function parseSlot(value: string): { day: PlannerDay; shift: PlannerShift } | null {
  const [day, shift] = value.split("__");
  if (!day || !shift) return null;
  if (!(PLANNER_DAYS as readonly string[]).includes(day)) return null;
  if (!(PLANNER_SHIFTS as readonly string[]).includes(shift)) return null;
  return { day: day as PlannerDay, shift: shift as PlannerShift };
}

function pickLowestLoadSlot(
  slotLoads: Map<string, number>,
  activeShifts: readonly PlannerShift[]
): { day: PlannerDay; shift: PlannerShift } | null {
  const kitchenDays = ["Mo", "Di", "Mi", "Do", "Fr"] as const;
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const day of kitchenDays) {
    for (const shift of activeShifts) {
      const key = slotValue(day, shift);
      const load = slotLoads.get(key) ?? 0;
      if (!best || load < best.load) {
        best = { day, shift, load };
      }
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

const REGULAR_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do"];
const RUN_ONE_SUB_DAYS: readonly PlannerDay[] = ["So", "Mo", "Di", "Mi"];
const RUN_TWO_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do"];

function pickLowestRegularSubSlot(
  slotLoads: Map<string, number>,
  activeShifts: readonly PlannerShift[]
): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const day of REGULAR_SUB_DAYS) {
    for (const shift of activeShifts) {
      const key = slotValue(day, shift);
      const load = slotLoads.get(key) ?? 0;
      if (!best || load < best.load) {
        best = { day, shift, load };
      }
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

function topConflictLabel(conflict: PlannerStationConflict): string {
  if (conflict.totalMin > conflict.capacityMin) {
    return `Überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `teilt ${fmtNum(conflict.deviceCount)} Gerät(e) · ${fmtNum(conflict.requiredDevices)} gebraucht`;
}

function topPoolConflictLabel(conflict: PlannerPoolConflict): string {
  if (conflict.totalMin > conflict.capacityMin) {
    return `Pool überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `${fmtNum(conflict.requiredDevices)} Geräte im Pool nötig`;
}

function loadPlannerUiSettings(): PlannerUiSettings {
  if (typeof window === "undefined") {
    return {
      shiftPresetId: "single-current",
      shiftCount: 1,
      showAutoSuggestions: true,
      showStationConflicts: true,
      showPoolConflicts: true,
      autoSplitProfileId: "mhd-smart"
    };
  }
  try {
    const raw = window.localStorage.getItem(PLANNER_UI_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        shiftPresetId: "single-current",
        shiftCount: 1,
        showAutoSuggestions: true,
        showStationConflicts: true,
        showPoolConflicts: true,
        autoSplitProfileId: "mhd-smart"
      };
    }
    const parsed = JSON.parse(raw) as Partial<PlannerUiSettings>;
    const shiftCount = Number(parsed.shiftCount ?? 1);
    const preset = SHIFT_MODEL_PRESETS.find(item => item.id === parsed.shiftPresetId)
      ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
      ?? SHIFT_MODEL_PRESETS[0];
    return {
      shiftPresetId: preset.id,
      shiftCount: shiftCount >= 1 && shiftCount <= 3 ? shiftCount : 1,
      showAutoSuggestions: parsed.showAutoSuggestions ?? true,
      showStationConflicts: parsed.showStationConflicts ?? true,
      showPoolConflicts: parsed.showPoolConflicts ?? true,
      autoSplitProfileId: AUTO_FULFILLMENT_PROFILES.some((profile) => profile.id === parsed.autoSplitProfileId)
        ? String(parsed.autoSplitProfileId)
        : "mhd-smart"
    };
  } catch {
    return {
      shiftPresetId: "single-current",
      shiftCount: 1,
      showAutoSuggestions: true,
      showStationConflicts: true,
      showPoolConflicts: true,
      autoSplitProfileId: "mhd-smart"
    };
  }
}

function plannerDayIndex(day: PlannerDay): number {
  return PLANNER_DAYS.indexOf(day);
}

function pickLowestLoadSlotForDay(
  slotLoads: Map<string, number>,
  day: PlannerDay,
  activeShifts: readonly PlannerShift[]
): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const shift of activeShifts) {
    const key = slotValue(day, shift);
    const load = slotLoads.get(key) ?? 0;
    if (!best || load < best.load) {
      best = { day, shift, load };
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

function normalizeBatches(raw: AutoFulfillmentBatch[], totalTarget: number): AutoFulfillmentBatch[] {
  const cleaned = raw
    .filter((row) => row.portions > 0)
    .sort((a, b) => plannerDayIndex(a.day) - plannerDayIndex(b.day));
  if (cleaned.length === 0 || totalTarget <= 0) return [];
  const sum = cleaned.reduce((acc, row) => acc + row.portions, 0);
  if (sum <= 0) return [];
  const scaled = cleaned.map((row) => ({
    day: row.day,
    portions: Math.max(0, Math.round((row.portions / sum) * totalTarget))
  }));
  const drift = totalTarget - scaled.reduce((acc, row) => acc + row.portions, 0);
  if (drift !== 0 && scaled[0]) scaled[0].portions += drift;
  return scaled.filter((row) => row.portions > 0);
}

function fixedBatchesFromProfile(totalTarget: number, profile: AutoFulfillmentProfile): AutoFulfillmentBatch[] {
  const weights = profile.fallbackWeights ?? { Fr: 1 };
  const raw = Object.entries(weights)
    .map(([day, weight]) => ({ day: day as PlannerDay, portions: Math.max(0, Number(weight) || 0) }))
    .filter((row) => row.portions > 0);
  if (raw.length === 0) return [{ day: "Fr", portions: totalTarget }];
  return normalizeBatches(raw, totalTarget);
}

function serializeBatchesForNote(batches: AutoFulfillmentBatch[]): string {
  return batches.map((row) => `${row.day}:${row.portions}`).join("|");
}

function resolveAutoBatches(
  recipeCode: string,
  totalTarget: number,
  profile: AutoFulfillmentProfile,
  batchSplitByRecipe: Map<string, AutoFulfillmentBatch[]>
): AutoFulfillmentBatch[] {
  if (totalTarget <= 0) return [];
  if (profile.mode === "fixed") return fixedBatchesFromProfile(totalTarget, profile);
  const fromPlanner = batchSplitByRecipe.get(recipeCode) ?? [];
  if (fromPlanner.length > 0) return normalizeBatches(fromPlanner, totalTarget);
  return [{ day: "Fr", portions: totalTarget }];
}

function kitchenDayBackshift(day: PlannerDay, steps: number): PlannerDay {
  const kitchenDays: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do", "Fr"];
  const idx = plannerDayIndex(day);
  const targetIdx = Math.max(0, idx - Math.max(0, steps));
  for (let i = targetIdx; i >= 0; i -= 1) {
    const candidate = PLANNER_DAYS[i];
    if (candidate && kitchenDays.includes(candidate)) return candidate;
  }
  return "Mo";
}

function avoidSaturday(day: PlannerDay): PlannerDay {
  return day === "Sa" ? "Fr" : day;
}

function clampRegularSubDay(day: PlannerDay): PlannerDay {
  if (day === "So" || day === "Fr" || day === "Sa") return "Do";
  return day;
}

function regularSubProductionDayForNeedDay(needDay: PlannerDay, leadDays: number): PlannerDay {
  return clampRegularSubDay(kitchenDayBackshift(needDay, leadDays));
}

function distributedRunSubDay(runIndex: number, subIndex: number): PlannerDay {
  const window = runIndex === 0 ? RUN_ONE_SUB_DAYS : RUN_TWO_SUB_DAYS;
  const offset = runIndex === 0 ? 0 : 2;
  return window[(subIndex + offset) % window.length] ?? window[0];
}

function nearestUnusedRegularSubDay(day: PlannerDay, usedDays: Set<PlannerDay>): PlannerDay {
  const preferred = clampRegularSubDay(day);
  if (!usedDays.has(preferred)) return preferred;
  const preferredIdx = REGULAR_SUB_DAYS.indexOf(preferred);
  for (let index = 0; index < preferredIdx; index += 1) {
    const earlier = REGULAR_SUB_DAYS[index];
    if (earlier && !usedDays.has(earlier)) return earlier;
  }
  for (let index = preferredIdx + 1; index < REGULAR_SUB_DAYS.length; index += 1) {
    const later = REGULAR_SUB_DAYS[index];
    if (later && !usedDays.has(later)) return later;
  }
  return preferred;
}

function splitDuplicateSubBatchDays(days: PlannerDay[]): PlannerDay[] {
  const result = [...days];
  const usedRegularDays = new Set<PlannerDay>();
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const day = result[index];
    if (day === "So") continue;
    const splitDay = nearestUnusedRegularSubDay(day, usedRegularDays);
    result[index] = splitDay;
    usedRegularDays.add(splitDay);
  }
  return result;
}

function runSubBatchesForAssignment(
  mainAssignment: { day: PlannerDay; targetPortions?: number; note?: string },
  subAssignment: { targetPortions?: number },
  fallbackPortions: number,
  subIndex: number
): Array<{ label: string; portions: number; day: PlannerDay }> {
  const mainPortions = Math.max(0, Math.round(mainAssignment.targetPortions ?? 0));
  const parsedNote = parseBoardNote(mainAssignment.note);
  const splitSpec = extractSplitSpecFromNotes(parsedNote.notes);
  const mainBatches = parseSplitSpecToBatches(splitSpec, mainAssignment.day, mainPortions);
  if (mainBatches.length <= 1) return [];
  const mainTotal = mainBatches.reduce((s, b) => s + b.portions, 0);
  if (mainTotal <= 0) return [];
  const subTotal = subAssignment.targetPortions ?? fallbackPortions;
  const batchDays = splitDuplicateSubBatchDays(mainBatches.map((_, bIdx) => distributedRunSubDay(bIdx, subIndex)));
  return mainBatches.map((batch, bIdx) => ({
    label: `B${bIdx + 1}`,
    portions: Math.max(0, Math.round(subTotal * batch.portions / mainTotal)),
    day: batchDays[bIdx] ?? distributedRunSubDay(bIdx, subIndex),
  }));
}

function isSundayPrepSub(category: string, spec?: ProcessSpec): boolean {
  const cat = String(category ?? "").toLowerCase();
  const family = String(spec?.productFamily ?? "").toLowerCase();
  return /thaw|marinade|marinated|mariniert|hand marinade|patty maker|spice|gewürz|gewuerz|butter/.test(cat) || family === "butter";
}

function subLeadDaysBeforeNeed(category: string, spec?: ProcessSpec): number {
  const cat = String(category ?? "").toLowerCase();
  const family = String(spec?.productFamily ?? "").toLowerCase();
  const maxHoldMin = Math.max(0, ...Object.values(spec?.holdTimeMin ?? {}).map((v) => Number(v) || 0));

  if (/brine|cure|ferment|inbound|raw receive/.test(cat) || maxHoldMin >= 24 * 60) return 3;
  if (isSundayPrepSub(category, spec)) return 0;
  if (/sauce|broth|stock|slow cook|braise/.test(cat) || maxHoldMin >= 12 * 60) return 2;
  if (/blast chiller|chill|cold hold|portion/.test(cat) || maxHoldMin >= 4 * 60) return 1;
  if (/grill|fry|sear|wok|hot finish|plating|oven/.test(cat)) return 1;
  return 1;
}

function preferredSubProductionDay(category: string, spec: ProcessSpec | undefined, needDay: PlannerDay, leadDays: number): PlannerDay {
  if (isSundayPrepSub(category, spec)) return "So";
  return regularSubProductionDayForNeedDay(needDay, leadDays);
}

function shiftCountLabel(shiftCount: number): string {
  if (shiftCount === 1) return "1 Schicht";
  return `${shiftCount} Schichten`;
}

function getShiftPreset(presetId: string, shiftCount: number) {
  return SHIFT_MODEL_PRESETS.find(item => item.id === presetId)
    ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
    ?? SHIFT_MODEL_PRESETS[0];
}

function shiftPresetLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Aktuell: Einschicht";
  if (presetId === "double-ready") return "Vorbereitet: 2 Schichten";
  return "Vorbereitet: 3 Schichten";
}

function shiftPresetShortLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Einschicht";
  if (presetId === "double-ready") return "2 Schichten";
  return "3 Schichten";
}

function shiftPresetNote(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.";
  if (presetId === "double-ready") return "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.";
  return "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.";
}

function shelfTone(status: ShelfLifeInfo["status"]): string {
  if (status === "critical") return "bg-rose-100 text-rose-800";
  if (status === "risk") return "bg-amber-100 text-amber-800";
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-700";
}

function getWeekSplit(data: DataBundle, week: string) {
  const rows = data.weekRecipes.filter(r => r.hfWeek === week);
  const dkse = rows.reduce((sum, row) => sum + row.verdenVolume.DKSE, 0);
  const de = rows.reduce((sum, row) => sum + row.verdenVolume.DE, 0);
  const benl = rows.reduce((sum, row) => sum + row.verdenVolume.BENL, 0);
  const deFriday = Math.round(de / 2);
  return {
    dkse,
    de,
    benl,
    benlFriday: benl,
    deFriday,
    deSunday: Math.max(0, de - deFriday)
  };
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

function stableHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

function recipeHue(seed: string): number {
  // Golden-ratio-based distribution: spreads hues maximally for any number of recipes
  const goldenRatio = 0.618033988749895;
  const h = ((stableHash(seed) & 0x7fffffff) * goldenRatio) % 1;
  return Math.round(h * 360);
}

function weekBoardRecipeTone(recipeCode: string): {
  hue: number;
  row: CSSProperties;
  sticky: CSSProperties;
  subRow: CSSProperties;
  subSticky: CSSProperties;
  slotActive: CSSProperties;
  slotIdle: CSSProperties;
  subPill: CSSProperties;
  mainPill: CSSProperties;
  infoButton: CSSProperties;
  code: CSSProperties;
  title: CSSProperties;
  badge: CSSProperties;
} {
  const hue = recipeHue(recipeCode);
  return {
    hue,
    row: {
      background: `linear-gradient(90deg, hsl(${hue} 66% 93%) 0%, hsl(${hue} 44% 97%) 26%, hsl(${hue} 35% 99%) 100%)`
    },
    sticky: {
      background: `linear-gradient(90deg, hsl(${hue} 70% 91%) 0%, hsl(${hue} 48% 97%) 100%)`,
      boxShadow: `inset 4px 0 0 hsl(${hue} 74% 52%)`
    },
    subRow: {
      background: `linear-gradient(90deg, hsl(${hue} 42% 97%) 0%, hsl(${hue} 26% 99%) 100%)`
    },
    subSticky: {
      backgroundColor: `hsl(${hue} 50% 98%)`
    },
    slotActive: {
      backgroundColor: "#ffffff",
      borderColor: `hsl(${hue} 44% 74%)`
    },
    slotIdle: {
      backgroundColor: `hsl(${hue} 46% 98%)`,
      borderColor: `hsl(${hue} 24% 86%)`
    },
    subPill: {
      backgroundColor: `hsl(${hue} 84% 92%)`,
      color: `hsl(${hue} 62% 26%)`,
      boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 66%)`
    },
    mainPill: {
      backgroundColor: `hsl(${hue} 72% 38%)`,
      color: "#ffffff",
      boxShadow: `inset 0 0 0 1px hsl(${hue} 78% 28%)`
    },
    infoButton: {
      backgroundColor: `hsl(${hue} 52% 98%)`,
      color: `hsl(${hue} 60% 28%)`,
      boxShadow: `inset 0 0 0 1px hsl(${hue} 48% 70%)`
    },
    code: {
      color: `hsl(${hue} 44% 32%)`
    },
    title: {
      color: `hsl(${hue} 52% 22%)`
    },
    badge: {
      backgroundColor: `hsl(${hue} 74% 90%)`,
      color: `hsl(${hue} 64% 24%)`,
      border: `1px solid hsl(${hue} 54% 70%)`
    }
  };
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeUom(value: string | undefined): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function isEachUom(uom: string | undefined): boolean {
  const token = normalizeUom(uom);
  return token === "ea" || token === "each" || token === "pcs" || token === "pc" || token === "piece" || token === "pieces";
}

function toKgEquivalent(value: number, uom: string | undefined): number | null {
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

function collectSubRecipeYieldPct(subRecipes: DetailedSubRecipe[], result: Map<string, number>) {
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

function findRecipeSubRecipe(recipe: Recipe, subRecipeId: string) {
  for (const market of Object.values(recipe.markets)) {
    for (const sub of market?.subRecipes ?? []) {
      if (sub.id === subRecipeId) return sub;
    }
  }
  return null;
}

function planningRecipeDigitKey(code: string): string {
  const match = /(\d{4,5})/.exec(String(code ?? ""));
  return match ? match[1] : String(code ?? "");
}

function resolvePlanningRecipe(data: DataBundle, code: string): Recipe | undefined {
  const exact = data.recipes[code];
  if (exact) return exact;
  const wanted = planningRecipeDigitKey(code);
  return Object.values(data.recipes).find((recipe) => planningRecipeDigitKey(recipe.code) === wanted);
}

// ── Parsing-Helfer für Bible/Master-GSheet-Hinweise ──────────────────────────

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
  return rowValues.map((cell) => String(cell ?? "").trim());
}

function infoDetectHeaderRow(rows: string[][], patterns: RegExp[]): number {
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonEmpty = row.filter((c) => c.length > 0).length;
    if (nonEmpty < 3) continue;
    const text = row.join(" | ").toLowerCase();
    const score = patterns.reduce((s, p) => s + (p.test(text) ? 1 : 0), 0) * 10 + nonEmpty;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function infoFindColIdx(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (patterns.some((p) => p.test(headers[i].toLowerCase()))) return i;
  }
  return -1;
}

function infoTokenize(value: string): string[] {
  return infoNorm(value).split(" ").filter((t) => t.length > 1);
}

/** Baut Kapazitäts- und Tray-Hinweise aus den GSheet-Dump-JSONs auf. */
function buildInfoHintsFromDumps(master: unknown, bibles: unknown): InfoHints {
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
  const bibleSheets  = Array.isArray((bibles  as GSheetDump)?.sheets) ? (bibles  as GSheetDump).sheets! : [];

  for (const sheet of masterSheets) {
    const title = String(sheet.title ?? "");
    const rows = Array.isArray(sheet.values) ? sheet.values.map(infoToCells) : [];

    if (/bd_master|breakdown_sup|bd_supervisors/i.test(title)) {
      const hIdx = infoDetectHeaderRow(rows.slice(0, 40), [/sub\s*recipe/i, /bible\s*ref/i, /kg/i]);
      if (hIdx >= 0 && rows[hIdx]) {
        const headers = rows[hIdx];
        const subIdx    = infoFindColIdx(headers, [/sub\s*recipe/i]);
        const subSubIdx = infoFindColIdx(headers, [/sub\s*-?sub\s*recipe/i]);
        const refIdx    = infoFindColIdx(headers, [/bible\s*ref/i]);
        const totalIdx  = infoFindColIdx(headers, [/total\s*size.*kg/i]);
        const brkIdx    = infoFindColIdx(headers, [/batch\s*breakdown.*kg/i]);
        const areaIdx   = infoFindColIdx(headers, [/area\s*associated/i, /^area/i]);
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
        const protIdx    = infoFindColIdx(headers, [/protein\s*type/i]);
        const cutIdx     = infoFindColIdx(headers, [/^cut/i]);
        const trayIdx    = infoFindColIdx(headers, [/tray\s*spec/i]);
        const piecesIdx  = infoFindColIdx(headers, [/est\.?\s*pieces/i]);
        const weightIdx  = infoFindColIdx(headers, [/weight.*kg/i]);
        for (let i = hIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          const cut     = cutIdx  >= 0 ? row[cutIdx]  : "";
          const protein = protIdx >= 0 ? row[protIdx] : "";
          const label   = cut || protein;
          if (!label) continue;
          const pcsFromTray = trayIdx   >= 0 ? infoParsePcs(row[trayIdx])        : null;
          const piecesNum   = piecesIdx >= 0 ? infoParseNum(row[piecesIdx])       : null;
          const trayPcs = pcsFromTray ?? piecesNum;
          if (trayPcs && trayPcs > 0) {
            const key = infoNorm(label);
            if (!trayHints.some((h) => h.key === key)) trayHints.push({ key, pcsPerTray: trayPcs });
            if (protein && cut) {
              const key2 = infoNorm(`${protein} ${cut}`);
              if (!trayHints.some((h) => h.key === key2)) trayHints.push({ key: key2, pcsPerTray: trayPcs });
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
        const capIdx  = infoFindColIdx(headers, [/capacity\s*wanne/i]);
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

function getSubRecipeInfo(
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
  const equipment   = capHint?.equipment ?? processSpec?.primaryStation ?? null;
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
    const fallback = Object.values(recipe.grossIngredients).find((l) => l && l.length > 0);
    grossList = fallback ?? [];
  }

  const aggregated = new Map<string, SubRecipeInfoIngredientRow>();

  for (const row of grossList) {
    const matchesSub = [row.subRecipe1, row.subRecipe2, row.subRecipe3]
      .some((name) => normalizeText(name) === normalizedSubName);
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
        ingredientId,
        ingredientName: row.ingredient,
        uom: row.uom,
        yieldRatio: ingredientYield,
        rawTotal,
        rawKg,
        finishedTotal,
        containerType: "",
        containerCount: 0,
        proBatchKg: null
      });
    }
  }

  // batchCount zuerst aus Gesamt-Rohgewicht aller Zutaten berechnen –
  // alle kg-Zutaten teilen sich dieselben Wannen (kein per-Zutat-Ansatz)
  const preRows = Array.from(aggregated.values());
  const totalRawKg = preRows.reduce((sum, row) => sum + (row.rawKg ?? 0), 0);
  const batchCount = capacityKg && capacityKg > 0 && totalRawKg > 0
    ? Math.ceil(totalRawKg / capacityKg)
    : null;

  const ingredientRows = preRows.map((row) => {
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
  const totalContainerCount = ingredientRows
    .filter((r) => isEachUom(r.uom))
    .reduce((s, r) => s + r.containerCount, 0);

  return {
    recipeCode,
    subRecipeId,
    subRecipeName: subRecipe.name,
    targetPortions,
    yieldRatio: fallbackYield,
    ingredientRows,
    totalRawKg,
    totalFinishedKg,
    totalContainerCount,
    capacityKg,
    equipment,
    batchCount,
    capacitySource
  };
}

export function PlanningView(
  { data, week, locale, upliftPercent = 0, selectedRecipe, onSelectRecipe, onPlanSnapshotSaved }:
  { data: DataBundle; week: string; locale: UiLocale; upliftPercent?: number; selectedRecipe?: string | null; onSelectRecipe?: (recipeCode: string) => void; onPlanSnapshotSaved?: () => void }
) {
  const { data: planningOasis } = usePlanningOasisData();
  const [storage, setStorage] = useState(() => loadPlannerStorage());
  const [newScenarioName, setNewScenarioName] = useState("");
  const [stationDeviceCounts] = useState(() => loadStationDeviceCounts());
  const [stationPools] = useState(() => loadStationPools());
  const [uiSettings, setUiSettings] = useState<PlannerUiSettings>(() => loadPlannerUiSettings());
  const [draggingCode, setDraggingCode] = useState<string | null>(null);
  const [draggingSubId, setDraggingSubId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [dragOverUnplanned, setDragOverUnplanned] = useState(false);
  const [expandedRecipes, setExpandedRecipes] = useState<Set<string>>(new Set());
  const [expandedBoardRecipes, setExpandedBoardRecipes] = useState<Set<string>>(new Set());
  const [boardEditor, setBoardEditor] = useState<WeekBoardEditorState | null>(null);
  const [subRecipeInfoRequest, setSubRecipeInfoRequest] = useState<SubRecipeInfoRequest | null>(null);
  const [infoHints, setInfoHints] = useState<InfoHints>(() => ({
    capacityHints: new Map(),
    pieceWeightKg: new Map(),
    trayHints: []
  }));
  const [boardDraft, setBoardDraft] = useState<WeekBoardEditorDraft>({
    shift: "S1",
    targetPortions: 0,
    reason: "Planned",
    splitSpec: "",
    notes: ""
  });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [calendarFullView, setCalendarFullView] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 1700;
  });
  const [savePlanStamp, setSavePlanStamp] = useState<string | null>(null);
  /** Manuelle Verschiebungen der Ghost-Pillen per Drag & Drop: tileKey → neuer Produktionstag */
  const [suggestOverrides, setSuggestOverrides] = useState<Record<string, PlannerDay>>({});
  const [draggingSuggestKey, setDraggingSuggestKey] = useState<string | null>(null);
  const [rampUpHistoryMap, setRampUpHistoryMap] = useState<Map<string, RampUpSnapshot[]>>(new Map());
  const [rampUpChanges, setRampUpChanges] = useState<RampUpChangeEvent[]>([]);
  const [rampUpBannerDismissed, setRampUpBannerDismissed] = useState(false);

  /** Raw schedule aus dem Linienplan (Firestore), keyed als "{PlanDay}|{slotKey}|{lineIdx}" */
  const [linePlanSchedule, setLinePlanSchedule] = useState<Record<string, { code: string; speedPerMin: number } | null>>({});
  const [linePlanCapacityByLane, setLinePlanCapacityByLane] = useState<Record<string, number>>({});
  const [linePlanRunSplitByRecipe, setLinePlanRunSplitByRecipe] = useState<Record<string, RunSplitPlan>>({});

  useEffect(() => {
    savePlannerStorage(storage);
  }, [storage]);

  // Ramp-Up Snapshot bei Datenwechsel aufzeichnen
  useEffect(() => {
    if (!data.weekRecipes?.length) return;
    const { changes, history } = recordRampUpSnapshot(week, data.weekRecipes);
    const allCodes = new Set(data.weekRecipes.filter(r => r.hfWeek === week).map(r => r.code));
    const histMap = new Map<string, RampUpSnapshot[]>();
    for (const code of allCodes) histMap.set(code, history.filter(s => code in s.volumes));
    setRampUpHistoryMap(histMap);
    if (changes.length > 0) {
      setRampUpChanges(changes);
      setRampUpBannerDismissed(false);
    }
  }, [data.weekRecipes, week]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PLANNER_UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
  }, [uiSettings]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!calendarFullView) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCalendarFullView(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [calendarFullView]);

  // Kapazitäts- und Tray-Hinweise aus den GSheet-Dumps laden (für Info-Modal)
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        setInfoHints(buildInfoHintsFromDumps(masterDump, biblesDump));
      } catch {
        // Hinweise optional – Berechnung arbeitet auch ohne
      }
    })();
    return () => { active = false; };
  }, []);

  // Linienplan aus Firestore laden – selbe Datenquelle wie LinePlanningView
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, onSnapshot } = await import("firebase/firestore");
        const { db } = getFirebase();
        // Wochenformat "2026-W19" → weekStr "19"
        const weekStr = week.includes("-W") ? week.split("-W")[1] : week;
        unsub = onSnapshot(
          doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`),
          (snap) => {
            if (snap.exists()) {
              const data = snap.data() as {
                schedule?: Record<string, { code: string; speedPerMin: number } | null>;
                cockpitPlan?: Record<string, Array<{ slot: string; line: number; code: string }>>;
                lineCapacityByLane?: Record<string, number>;
                runSplitByRecipe?: Record<string, RunSplitPlan>;
              };

              const fromSchedule = data.schedule ?? {};
              const hasSchedule = Object.keys(fromSchedule).length > 0;
              const fromCockpit: Record<string, { code: string; speedPerMin: number } | null> = {};
              if (!hasSchedule && data.cockpitPlan) {
                for (const [day, rows] of Object.entries(data.cockpitPlan)) {
                  for (const row of rows ?? []) {
                    const lineIdx = Math.max(0, Number(row.line ?? 1) - 1);
                    const slot = String(row.slot ?? "").trim();
                    const code = String(row.code ?? "").trim();
                    if (!day || !slot || !code) continue;
                    fromCockpit[`${day}|${slot}|${lineIdx}`] = { code, speedPerMin: 10 };
                  }
                }
              }

              setLinePlanSchedule(hasSchedule ? fromSchedule : fromCockpit);
              setLinePlanCapacityByLane(data.lineCapacityByLane ?? {});
              setLinePlanRunSplitByRecipe(data.runSplitByRecipe ?? {});
            } else {
              setLinePlanSchedule({});
              setLinePlanCapacityByLane({});
              setLinePlanRunSplitByRecipe({});
            }
          },
          () => { /* Fehler ignorieren – Linienplan ist optional */ }
        );
      } catch {
        // Firestore nicht verfügbar – Linienplan-Integration deaktiviert
      }
    })();
    return () => unsub?.();
  }, [week]);

  const weekState = useMemo(() => getWeekState(storage, week), [storage, week]);
  const scenario = useMemo(() => getActiveScenario(storage, week), [storage, week]);
  const portionMultiplier = 1 + upliftPercent / 100;
  const activePreset = useMemo(() => getShiftPreset(uiSettings.shiftPresetId, uiSettings.shiftCount), [uiSettings.shiftPresetId, uiSettings.shiftCount]);
  const activeShifts = useMemo(() => PLANNER_SHIFTS.slice(0, uiSettings.shiftCount), [uiSettings.shiftCount]);
  const analysis = useMemo(() => analyzePlan(data, week, scenario, {
    portionMultiplier,
    shiftCapacityMin: DEFAULT_SHIFT_MIN,
    stationDeviceCounts,
    stationPools
  }), [data, week, scenario, portionMultiplier, stationDeviceCounts, stationPools]);

  /**
   * Berechnet pro Rezept und Tag, welche Kapazität die Plating-Linien haben.
   * Schichten-Durations entsprechen den SLOTS aus LinePlanningView.
   * Muss VOR suggestions berechnet werden, da suggestAssignments den platDay
   * aus dem Linienplan als Anker für die rückwärtige Küchenplanung nutzt.
   */
  const linePlatingSummary = useMemo((): LinePlatingSummary => {
    const SLOT_DURATIONS: Record<string, number> = {
      "06:00-07:00": 60, "07:00-08:00": 60, "08:00-08:30": 30,
      "09:00-10:00": 60, "10:00-11:00": 60, "11:30-12:00": 30,
      "12:00-13:00": 60, "13:00-14:00": 60, "14:00-15:00": 60,
    };
    // Linienplan-Tagesbezeichnungen → PlannerDay
    const DAY_MAP: Record<string, PlannerDay> = {
      "Freitag": "Fr", "Samstag": "Sa", "Sonntag": "So",
      "Montag": "Mo", "Dienstag": "Di", "Mittwoch": "Mi", "Donnerstag": "Do",
    };
    const byRecipe: Record<string, LinePlatingEntry[]> = {};
    for (const [key, recipe] of Object.entries(linePlanSchedule)) {
      if (!recipe) continue;
      // Format: "{PlanDay}|{slotKey}|{lineIdx}"
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey, lineIdx] = parts;
      const platDay = DAY_MAP[dayDE ?? ""];
      if (!platDay) continue;
      const duration = SLOT_DURATIONS[slotKey ?? ""] ?? 60;
      const laneCapacity = linePlanCapacityByLane[lineIdx ?? ""];
      const portions = laneCapacity != null
        ? Math.round((Math.max(0, laneCapacity) / 60) * duration)
        : (recipe.speedPerMin ?? 10) * duration;
      const entries = (byRecipe[recipe.code] ??= []);
      const existing = entries.find(e => e.platDay === platDay);
      if (existing) {
        existing.capacityPortions += portions;
        existing.slotCount += 1;
      } else {
        entries.push({ platDay, capacityPortions: portions, slotCount: 1 });
      }
    }
    return { byRecipe };
  }, [linePlanSchedule, linePlanCapacityByLane]);

  const suggestions = useMemo(() => {
    if (!uiSettings.showAutoSuggestions) return {};
    return suggestAssignments(data, week, scenario, activeShifts, {
      portionMultiplier,
      shiftCapacityMin: DEFAULT_SHIFT_MIN,
      stationDeviceCounts,
      stationPools,
      lineSummary: linePlatingSummary,
    });
  }, [data, week, scenario, activeShifts, portionMultiplier, stationDeviceCounts, stationPools, uiSettings.showAutoSuggestions, linePlatingSummary]);
  const split = useMemo(() => getWeekSplit(data, week), [data, week]);
  const autoProfile = useMemo(() => {
    return AUTO_FULFILLMENT_PROFILES.find((profile) => profile.id === uiSettings.autoSplitProfileId)
      ?? AUTO_FULFILLMENT_PROFILES[0];
  }, [uiSettings.autoSplitProfileId]);

  const batchSplitPlan = useMemo(
    () => computeBatchSplitPlan(data, week, linePlatingSummary),
    [data, week, linePlatingSummary]
  );
  const batchSplitByRecipe = useMemo(() => {
    const map = new Map<string, AutoFulfillmentBatch[]>();
    for (const plan of batchSplitPlan) {
      map.set(plan.recipeCode, plan.batches.map((batch) => ({ day: batch.fulfillmentDay, portions: batch.portions })));
    }
    return map;
  }, [batchSplitPlan]);
  const weekIntel = planningOasis?.weeks[week] ?? null;
  const shelfRisk = useMemo(() => {
    const seen = new Set<string>();
    const rows: ShelfLifeInfo[] = [];
    for (const row of data.weekRecipes.filter(r => r.hfWeek === week)) {
      const recipe = resolvePlanningRecipe(data, row.code);
      if (!recipe) continue;
      for (const marketGross of Object.values(recipe.grossIngredients)) {
        for (const gi of marketGross ?? []) {
          if (!gi.ingredientId || seen.has(gi.ingredientId)) continue;
          seen.add(gi.ingredientId);
          const shelf = data.shelfLifeBySku?.[gi.ingredientId];
          if (shelf) rows.push(shelf);
        }
      }
    }
    return {
      total: rows.length,
      critical: rows.filter(r => r.status === "critical"),
      risk: rows.filter(r => r.status === "risk")
    };
  }, [data, week]);
  const recipeLookup = useMemo(() => Object.fromEntries(
    data.weekRecipes.filter(r => r.hfWeek === week).map(r => [r.code, r])
  ) as Record<string, WeekRecipe>, [data.weekRecipes, week]);
  const subRecipeInfo = useMemo(() => {
    if (!subRecipeInfoRequest) return null;
    return getSubRecipeInfo(
      data,
      subRecipeInfoRequest.recipeCode,
      subRecipeInfoRequest.subRecipeId,
      subRecipeInfoRequest.targetPortions,
      infoHints
    );
  }, [data, subRecipeInfoRequest, infoHints]);

  const assignmentsBySlot = useMemo(() => {
    const buckets: Record<string, Array<{ code: string; name: string; activeMin: number }>> = {};
    for (const recipe of analysis.recipes) {
      if (!recipe.assigned) continue;
      const key = slotValue(recipe.assigned.day, recipe.assigned.shift);
      (buckets[key] ??= []).push({ code: recipe.recipeCode, name: recipe.recipeName, activeMin: recipe.activeMin });
    }
    for (const rows of Object.values(buckets)) rows.sort((a, b) => b.activeMin - a.activeMin);
    return buckets;
  }, [analysis.recipes]);

  /** Wochenboard-Zuordnungen ohne Uhrzeit: nur Tag + Schicht. */
  const assignmentsByDayShift = useMemo(() => {
    type Tile = {
      key: string;
      code: string;
      subRecipeId?: string;
      name: string;
      activeMin: number;
      targetPortions?: number;
      order: number;
      shift: PlannerShift;
      kind: "main" | "sub";
      subCount: number; // für main-tile: Anzahl noch enthaltener Subs
      batchLabel?: string;
      /** Batch-Index 0-basiert (nur bei Split-Rezepten) */
      batchIndex?: number;
      /** Gesamt-Batch-Anzahl dieses Rezepts in der Woche */
      batchTotal?: number;
      /** Lead-Zeit in Küchentagen (nur kind=sub) */
      leadDays?: number;
      /** Bedarfstag des Haupt-Rezepts (= Ausgabe/Fulfillment-Start, kind=sub) */
      mainDay?: PlannerDay;
      category?: string;
      /** Ghost-Pill: automatisch aus BatchSplitPlan (noch nicht manuell bestätigt) */
      suggested?: boolean;
      /** Fulfillment-Tag (nur bei Ghost-Tiles, z.B. "Fr" oder "So") */
      fulfillmentDay?: PlannerDay;
      /** Empfohlener Produktionstag (nur bei Ghost-Tiles) */
      recommendedProdDay?: PlannerDay;
      /** Alle Sub-Rezepte bereits einzeln verplant → Ghost-Tile wird als solide Plating-Pille angezeigt */
      allSubsDone?: boolean;
      /** Linienkapazität für diesen Batch (in Portionen), wenn Linienplan vorhanden */
      lineCapacityPortions?: number;
      /** Differenz Forecast - Linienkapazität für das gesamte Rezept (positiv = Lücke) */
      lineCoverageGap?: number;
    };
    const buckets: Record<string, Tile[]> = {};
    for (const recipe of analysis.recipes) {
      if (recipe.assigned) {
        const mainAssignment = recipe.assigned;
        const remainingSubs = recipe.subRecipes.filter(s => !s.assigned).length;
        const targetPortions = Math.max(0, Math.round(mainAssignment.targetPortions ?? 0));
        const parsedNote = parseBoardNote(mainAssignment.note);
        const splitSpec = extractSplitSpecFromNotes(parsedNote.notes);
        const batches = parseSplitSpecToBatches(splitSpec, mainAssignment.day, targetPortions);
        const visibleBatches = batches.length > 0
          ? batches
          : [{ day: mainAssignment.day, portions: targetPortions > 0 ? targetPortions : Math.max(1, Math.round(recipe.activeMin)) }];
        const totalBatchPortions = Math.max(1, visibleBatches.reduce((sum, batch) => sum + batch.portions, 0));

        visibleBatches.forEach((batch, index) => {
          const slot = slotValue(batch.day, mainAssignment.shift);
          const weight = Math.max(0.15, batch.portions / totalBatchPortions);
          (buckets[slot] ??= []).push({
            key: `${recipe.recipeCode}::batch-${index + 1}-${batch.day}`,
            code: recipe.recipeCode,
            name: recipe.recipeName,
            activeMin: recipe.activeMin > 0 ? Math.max(15, Math.round(recipe.activeMin * weight)) : 0,
            targetPortions: batch.portions,
            order: (mainAssignment.order ?? Number.MAX_SAFE_INTEGER) + index * 0.01,
            shift: mainAssignment.shift,
            kind: "main",
            subCount: remainingSubs,
            batchLabel: visibleBatches.length > 1 ? `B${index + 1}` : undefined,
            batchIndex: visibleBatches.length > 1 ? index : undefined,
            batchTotal: visibleBatches.length > 1 ? visibleBatches.length : undefined
          });
        });
      }
      for (const sub of recipe.subRecipes) {
        if (!sub.assigned) continue;
        const subLeadDays = subLeadDaysBeforeNeed(sub.category, data.processSpecs?.[sub.subRecipeId]);
        (buckets[slotValue(sub.assigned.day, sub.assigned.shift)] ??= []).push({
          key: `${recipe.recipeCode}::${sub.subRecipeId}`,
          code: recipe.recipeCode,
          subRecipeId: sub.subRecipeId,
          name: `${sub.subRecipeName} (${recipe.recipeName})`,
          activeMin: Math.max(15, sub.activeMin),
          targetPortions: sub.assigned.targetPortions,
          order: sub.assigned.order ?? Number.MAX_SAFE_INTEGER,
          shift: sub.assigned.shift,
          kind: "sub",
          subCount: 0,
          leadDays: subLeadDays,
          mainDay: recipe.assigned?.day,
          category: sub.category
        });
      }
    }
    // Ghost-Pills / Derived Plating-Pills: unverplante Hauptrezepte → Empfehlung aus BatchSplitPlan
    // Wenn alle Sub-Rezepte bereits einzeln verplant sind → solide Plating-Pille statt Ghost
    const defaultShift: PlannerShift = activeShifts[0] ?? "S1";
    for (const recipe of analysis.recipes) {
      if (recipe.assigned) continue; // bereits manuell verplant → durch Fix 1 als solide Pille abgedeckt
      const plan = batchSplitPlan.find(p => p.recipeCode === recipe.recipeCode);
      if (!plan) continue;
      const plannableSubs = recipe.subRecipes;
      const allSubsDone = plannableSubs.length > 0 && plannableSubs.every(s => !!s.assigned);
      const totalBatches = plan.batches.length;
      plan.batches.forEach((batch, index) => {
        const tileKey = `${recipe.recipeCode}::suggest-${index}`;
        const overrideDay = suggestOverrides[tileKey];
        const slot = slotValue(overrideDay ?? avoidSaturday(batch.recommendedProductionDay), defaultShift);
        (buckets[slot] ??= []).push({
          key: tileKey,
          code: recipe.recipeCode,
          name: recipe.recipeName,
          activeMin: 0,
          targetPortions: batch.portions,
          order: Number.MAX_SAFE_INTEGER - 1,
          shift: defaultShift,
          kind: "main",
          subCount: recipe.subRecipes.filter(s => !s.assigned).length,
          batchLabel: totalBatches > 1 ? `B${index + 1}` : undefined,
          batchIndex: totalBatches > 1 ? index : undefined,
          batchTotal: totalBatches > 1 ? totalBatches : undefined,
          suggested: true,
          fulfillmentDay: batch.fulfillmentDay,
          recommendedProdDay: avoidSaturday(batch.recommendedProductionDay),
          allSubsDone,
          lineCapacityPortions: batch.lineCapacityPortions,
          lineCoverageGap: plan.lineCoverageGap,
        });
      });
    }

    for (const rows of Object.values(buckets)) {
      rows.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.kind !== b.kind) return a.kind === "sub" ? -1 : 1;
        return b.activeMin - a.activeMin || a.name.localeCompare(b.name);
      });
    }
    return buckets;
  }, [analysis.recipes, batchSplitPlan, activeShifts, suggestOverrides]);

  const stationsBySlot = useMemo(() => {
    return Object.fromEntries(
      Object.entries(analysis.stationLoadBySlot).map(([slot, loads]) => [
        slot,
        STATIONS
          .map(station => {
            const minutes = loads[station] ?? 0;
            const capacity = getStationCapacityView(minutes, stationDeviceCounts[station] ?? 1, DEFAULT_SHIFT_MIN);
            return { station, minutes, utilizationPct: capacity.utilizationPct, deviceCount: capacity.deviceCount };
          })
          .filter(row => row.minutes > 0)
          .sort((a, b) => b.utilizationPct - a.utilizationPct || b.minutes - a.minutes)
          .slice(0, 3)
      ])
    ) as Record<string, Array<{ station: string; minutes: number; utilizationPct: number; deviceCount: number }>>;
  }, [analysis.stationLoadBySlot, stationDeviceCounts]);

  // "Verfügbar" = Hauptrezept noch nicht geplant ODER es gibt noch ungeplante Subs
  const unplanned = analysis.recipes.filter(r => !r.assigned || r.subRecipes.some(s => !s.assigned));
  const visibleStationConflicts = uiSettings.showStationConflicts ? analysis.conflicts : [];
  const visiblePoolConflicts = uiSettings.showPoolConflicts ? analysis.poolConflicts : [];
  const visibleConflictCount = visibleStationConflicts.length + visiblePoolConflicts.length;
  const suggestionCount = Object.keys(suggestions).length;
  const activeShiftSummary = activeShifts.join(" / ");
  const manufacturingDaySummaries = useMemo((): ManufacturingDaySummary[] => {
    const rows = MANUFACTURING_DAYS.map((column) => ({
      column,
      mainCount: 0,
      subRunCount: 0,
      mainPortions: 0,
      subPortions: 0,
      items: [] as string[],
    }));
    const byColumnId = new Map(rows.map((row) => [row.column.id, row]));
    const addMain = (day: PlannerDay, portions: number, label: string) => {
      const column = MANUFACTURING_DAYS.find((item) => item.day === day && item.lane === "regular");
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.mainCount += 1;
      row.mainPortions += portions;
      if (row.items.length < 6) row.items.push(label);
    };
    const addSub = (day: PlannerDay, portions: number, label: string, prepSunday: boolean) => {
      const column = MANUFACTURING_DAYS.find((item) => item.day === day && (day === "So" && prepSunday ? item.lane === "prep" : item.lane === "regular"));
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.subRunCount += 1;
      row.subPortions += portions;
      if (row.items.length < 6) row.items.push(label);
    };

    for (const recipe of analysis.recipes) {
      const forecast = recipeLookup[recipe.recipeCode]?.totalVerdenVolume ?? 0;
      if (recipe.assigned && activeShifts.includes(recipe.assigned.shift)) {
        addMain(
          recipe.assigned.day,
          Math.max(0, Math.round(recipe.assigned.targetPortions ?? forecast)),
          `${recipe.recipeCode} Main`
        );
      }
      recipe.subRecipes.forEach((sub, subIndex) => {
        if (!sub.assigned || !activeShifts.includes(sub.assigned.shift)) return;
        const spec = data.processSpecs?.[sub.subRecipeId];
        const isPrepSub = isSundayPrepSub(sub.category, spec);
        const splitBatches = recipe.assigned
          ? runSubBatchesForAssignment(recipe.assigned, sub.assigned, forecast, subIndex)
          : [];
        if (splitBatches.length > 0) {
          for (const batch of splitBatches) {
            addSub(
              batch.day,
              batch.portions,
              `${recipe.recipeCode} ${batch.label} ${sub.subRecipeName}`,
              batch.day === "So" || isPrepSub
            );
          }
          return;
        }
        addSub(
          sub.assigned.day,
          Math.max(0, Math.round(sub.assigned.targetPortions ?? forecast)),
          `${recipe.recipeCode} ${sub.subRecipeName}`,
          sub.assigned.day === "So" && isPrepSub
        );
      });
    }
    return rows;
  }, [activeShifts, analysis.recipes, data.processSpecs, recipeLookup]);
  const areaRows = useMemo(() => SHIFT_MODEL_AREAS.map(area => ({
    ...area,
    shiftCount: activePreset.areaShiftPlan[area.key] ?? 0
  })), [activePreset]);

  function applyShiftPreset(presetId: string) {
    const preset = SHIFT_MODEL_PRESETS.find(item => item.id === presetId);
    if (!preset) return;
    setUiSettings(prev => ({
      ...prev,
      shiftPresetId: preset.id,
      shiftCount: preset.shiftCount
    }));
  }

  function updateAssignment(recipeCode: string, value: string) {
    const recipe = recipeLookup[recipeCode];
    if (!recipe) return;
    if (!value) {
      setStorage(prev => assignRecipe(prev, week, scenario.id, recipe));
      return;
    }
    const slot = parseSlot(value);
    if (!slot) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, recipe, slot));
  }

  function handleCreateScenario() {
    setStorage(prev => createScenario(prev, week, newScenarioName, scenario.id));
    setNewScenarioName("");
  }

  function applySuggestion(recipeCode: string) {
    const suggestion = suggestions[recipeCode];
    const recipe = recipeLookup[recipeCode];
    if (!suggestion || !recipe) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, recipe, { day: suggestion.day, shift: suggestion.shift }));
  }

  function handleDragStart(event: React.DragEvent, recipeCode: string, subRecipeId?: string) {
    const payload = subRecipeId ? `${recipeCode}::${subRecipeId}` : recipeCode;
    event.dataTransfer.setData("text/recipe-code", payload);
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "move";
    setDraggingCode(recipeCode);
    setDraggingSubId(subRecipeId ?? null);
  }

  function handleDragEnd() {
    setDraggingCode(null);
    setDraggingSubId(null);
    setDraggingSuggestKey(null);
    setDragOverSlot(null);
    setDragOverUnplanned(false);
  }

  function handleSuggestDragStart(event: React.DragEvent, tileKey: string) {
    event.dataTransfer.setData('text/suggest-key', tileKey);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingSuggestKey(tileKey);
  }

  function handleDropSuggestOnSlot(event: React.DragEvent, day: PlannerDay) {
    if (day === "Sa") return;
    const key = event.dataTransfer.getData('text/suggest-key') || draggingSuggestKey;
    if (!key) return;
    setSuggestOverrides(prev => ({ ...prev, [key]: day }));
    setDraggingSuggestKey(null);
    setDragOverSlot(null);
  }

  /** Liest Drop-Payload und löst Code+ggf. SubId auf. */
  function parseDropPayload(event: React.DragEvent): { recipe: WeekRecipe; subRecipeId?: string; subRecipeName?: string } | null {
    const raw = event.dataTransfer.getData("text/recipe-code")
      || event.dataTransfer.getData("text/plain")
      || (draggingSubId ? `${draggingCode}::${draggingSubId}` : draggingCode ?? "");
    if (!raw) return null;
    const [code, subId] = raw.split("::");
    const recipe = recipeLookup[code];
    if (!recipe) return null;
    let subName: string | undefined;
    if (subId) {
      const summary = analysis.recipes.find(r => r.recipeCode === code);
      subName = summary?.subRecipes.find(s => s.subRecipeId === subId)?.subRecipeName;
    }
    return { recipe, subRecipeId: subId || undefined, subRecipeName: subName };
  }

  function handleDropOnSlot(event: React.DragEvent, day: PlannerDay, shift: PlannerShift) {
    event.preventDefault();
    if (day === "Sa") {
      setDragOverSlot(null);
      handleDragEnd();
      return;
    }
    const parsed = parseDropPayload(event);
    setDragOverSlot(null);
    handleDragEnd();
    if (!parsed) return;
    const key = parsed.subRecipeId ? `${parsed.recipe.code}::${parsed.subRecipeId}` : parsed.recipe.code;
    const current = scenario.assignments[key];
    if (current && current.day === day && current.shift === shift) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, parsed.recipe, {
      day, shift,
      subRecipeId: parsed.subRecipeId,
      subRecipeName: parsed.subRecipeName
    }));
  }

  function handleDropOnUnplanned(event: React.DragEvent) {
    event.preventDefault();
    const parsed = parseDropPayload(event);
    setDragOverUnplanned(false);
    handleDragEnd();
    if (!parsed) return;
    setStorage(prev => removeAssignment(prev, week, scenario.id, parsed.recipe.code, parsed.subRecipeId));
  }

  function handleAutoplanRecipe(targetCode: string) {
    if (activeShifts.length === 0) return;
    setStorage((prev) => {
      const isShiftActive = (shift: PlannerShift | undefined): boolean => {
        return !!shift && activeShifts.includes(shift);
      };
      const weekState = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const analysisNow = analyzePlan(data, week, currentScenario, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const slotLoads = new Map<string, number>();
      const slotOrders = new Map<string, number>();

      const registerOrder = (day: PlannerDay, shift: PlannerShift, order?: number) => {
        const key = slotValue(day, shift);
        const current = slotOrders.get(key) ?? 0;
        if (typeof order === "number" && Number.isFinite(order)) {
          slotOrders.set(key, Math.max(current, Math.round(order)));
          return;
        }
        slotOrders.set(key, current + 1);
      };

      const nextOrder = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        const value = (slotOrders.get(key) ?? 0) + 1;
        slotOrders.set(key, value);
        return value;
      };

      const addLoad = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        slotLoads.set(key, (slotLoads.get(key) ?? 0) + 1);
      };
      // Seed loads with all currently planned items
      for (const recipe of analysisNow.recipes) {
        if (recipe.assigned && isShiftActive(recipe.assigned.shift)) {
          addLoad(recipe.assigned.day, recipe.assigned.shift);
          registerOrder(recipe.assigned.day, recipe.assigned.shift, recipe.assigned.order);
        }
        for (const sub of recipe.subRecipes) {
          if (sub.assigned && isShiftActive(sub.assigned.shift)) {
            addLoad(sub.assigned.day, sub.assigned.shift);
            registerOrder(sub.assigned.day, sub.assigned.shift, sub.assigned.order);
          }
        }
      }

      const targetRecipe = analysisNow.recipes.find(r => r.recipeCode === targetCode);
      if (!targetRecipe) return prev;
      const recipe = recipeLookup[targetCode]
        ?? data.weekRecipes.find((row) => row.hfWeek === week && row.code === targetCode)
        ?? ({ code: targetCode } as WeekRecipe);

      const nextAssignments = { ...currentScenario.assignments };

      const existingMain = nextAssignments[assignmentKey(targetCode)];
      const keepExistingMain = !!existingMain && existingMain.day !== "Sa" && isShiftActive(existingMain.shift);
      const mainTarget = Math.max(0, Math.round(existingMain?.targetPortions ?? recipe.totalVerdenVolume ?? 0));
      const batches = resolveAutoBatches(targetCode, mainTarget, autoProfile, batchSplitByRecipe);
      const platingDay = avoidSaturday(batches[0]?.day ?? existingMain?.day ?? "Fr");

      if (!keepExistingMain) {
        const slot = pickLowestLoadSlotForDay(slotLoads, platingDay, activeShifts)
          ?? pickLowestLoadSlot(slotLoads, activeShifts);
        if (slot) {
          nextAssignments[assignmentKey(targetCode)] = {
            recipeCode: targetCode,
            day: slot.day,
            shift: slot.shift,
            order: nextOrder(slot.day, slot.shift),
            targetPortions: mainTarget,
            note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
          };
          addLoad(slot.day, slot.shift);
        }
      } else if (existingMain) {
        nextAssignments[assignmentKey(targetCode)] = {
          ...existingMain,
          targetPortions: mainTarget,
          note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
        };
      }

      const openSubs = targetRecipe.subRecipes
        .filter(s => !s.assigned || s.assigned.day === "Sa" || !isShiftActive(s.assigned.shift))
        .sort((a, b) => b.activeMin - a.activeMin);

      for (const sub of openSubs) {
        const spec = data.processSpecs?.[sub.subRecipeId];
        const leadDays = subLeadDaysBeforeNeed(sub.category, spec);
        const preferredSubDay = preferredSubProductionDay(sub.category, spec, platingDay, leadDays);
        const slot = pickLowestLoadSlotForDay(slotLoads, preferredSubDay, activeShifts)
          ?? (preferredSubDay === "So" ? null : pickLowestRegularSubSlot(slotLoads, activeShifts))
          ?? pickLowestLoadSlot(slotLoads, activeShifts);
        if (!slot) continue;
        nextAssignments[assignmentKey(targetCode, sub.subRecipeId)] = {
          recipeCode: targetCode,
          subRecipeId: sub.subRecipeId,
          subRecipeName: sub.subRecipeName,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift),
          targetPortions: mainTarget,
          note: buildBoardNote("Auto/SubFromMain", `main=${mainTarget}||split=${serializeBatchesForNote(batches)}`)
        };
        addLoad(slot.day, slot.shift);
      }

      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [week]: {
            ...weekState,
            scenarios: weekState.scenarios.map((s) =>
              s.id === currentScenario.id ? { ...s, assignments: nextAssignments } : s
            )
          }
        }
      };
    });
  }

  function handleAutoPlanWeekBoard() {
    if (activeShifts.length === 0) return;
    setStorage((prev) => {
      const isShiftActive = (shift: PlannerShift | undefined): boolean => {
        return !!shift && activeShifts.includes(shift);
      };
      const isPlannerDay = (day: unknown): day is PlannerDay => {
        return typeof day === "string" && (PLANNER_DAYS as readonly string[]).includes(day);
      };
      const safePlannerDay = (day: unknown, fallback: PlannerDay = "Fr"): PlannerDay => {
        return isPlannerDay(day) ? day : fallback;
      };
      const weekState = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const analysisNow = analyzePlan(data, week, currentScenario, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const nextAssignments = { ...currentScenario.assignments };
      const autoTouchedKeys = new Set<string>();
      const slotLoads = new Map<string, number>();
      const slotOrders = new Map<string, number>();

      const registerOrder = (day: PlannerDay, shift: PlannerShift, order?: number) => {
        const key = slotValue(day, shift);
        const current = slotOrders.get(key) ?? 0;
        if (typeof order === "number" && Number.isFinite(order)) {
          slotOrders.set(key, Math.max(current, Math.round(order)));
          return;
        }
        slotOrders.set(key, current + 1);
      };

      const nextOrder = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        const value = (slotOrders.get(key) ?? 0) + 1;
        slotOrders.set(key, value);
        return value;
      };

      const addLoad = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        slotLoads.set(key, (slotLoads.get(key) ?? 0) + 1);
      };

      for (const recipe of analysisNow.recipes) {
        if (recipe.assigned && isShiftActive(recipe.assigned.shift)) {
          addLoad(recipe.assigned.day, recipe.assigned.shift);
          registerOrder(recipe.assigned.day, recipe.assigned.shift, recipe.assigned.order);
        }
        for (const sub of recipe.subRecipes) {
          if (!sub.assigned || !isShiftActive(sub.assigned.shift)) continue;
          addLoad(sub.assigned.day, sub.assigned.shift);
          registerOrder(sub.assigned.day, sub.assigned.shift, sub.assigned.order);
        }
      }

      const recipesByLoad = [...analysisNow.recipes]
        .sort((a, b) => b.totalActiveMin - a.totalActiveMin || a.recipeCode.localeCompare(b.recipeCode));

      for (const recipeSummary of recipesByLoad) {
        const weekRecipe = recipeLookup[recipeSummary.recipeCode]
          ?? data.weekRecipes.find((row) => row.hfWeek === week && row.code === recipeSummary.recipeCode)
          ?? ({ code: recipeSummary.recipeCode } as WeekRecipe);
        const mainKey = assignmentKey(recipeSummary.recipeCode);
        const existingMain = nextAssignments[mainKey] ?? recipeSummary.assigned;
        const keepExistingMain = !!existingMain && existingMain.day !== "Sa" && isShiftActive(existingMain.shift);
        const mainTarget = Math.max(0, Math.round(existingMain?.targetPortions ?? weekRecipe.totalVerdenVolume ?? 0));
        const batches = resolveAutoBatches(recipeSummary.recipeCode, mainTarget, autoProfile, batchSplitByRecipe);
        const platingDay = avoidSaturday(safePlannerDay(batches[0]?.day ?? existingMain?.day ?? "Fr"));

        if (!keepExistingMain) {
          const slot = pickLowestLoadSlotForDay(slotLoads, platingDay, activeShifts)
            ?? pickLowestLoadSlot(slotLoads, activeShifts);
          if (slot) {
            nextAssignments[mainKey] = {
              recipeCode: recipeSummary.recipeCode,
              day: slot.day,
              shift: slot.shift,
              order: nextOrder(slot.day, slot.shift),
              targetPortions: mainTarget,
              note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
            };
            autoTouchedKeys.add(mainKey);
            addLoad(slot.day, slot.shift);
          }
        } else if (existingMain) {
          nextAssignments[mainKey] = {
            ...existingMain,
            targetPortions: mainTarget,
            note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
          };
          autoTouchedKeys.add(mainKey);
        }
      }

      const refreshedAnalysis = analyzePlan(data, week, {
        ...currentScenario,
        assignments: nextAssignments
      }, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      for (const recipeSummary of refreshedAnalysis.recipes) {
        const mainAssigned = nextAssignments[assignmentKey(recipeSummary.recipeCode)];
        if (!mainAssigned) continue;
        const mainTarget = Math.max(0, Math.round(mainAssigned.targetPortions ?? 0));
        const batches = resolveAutoBatches(recipeSummary.recipeCode, mainTarget, autoProfile, batchSplitByRecipe);
        const needDay = avoidSaturday(safePlannerDay(batches[0]?.day ?? mainAssigned.day));
        const subIndexById = new Map(recipeSummary.subRecipes.map((sub, index) => [sub.subRecipeId, index]));

        const subsToAssign = recipeSummary.subRecipes
          .filter((sub) => !sub.assigned || sub.assigned.day === "Sa" || !isShiftActive(sub.assigned.shift))
          .sort((a, b) => b.activeMin - a.activeMin);

        for (const sub of subsToAssign) {
          const spec = data.processSpecs?.[sub.subRecipeId];
          const leadDays = subLeadDaysBeforeNeed(sub.category, spec);
          const subIndex = subIndexById.get(sub.subRecipeId) ?? 0;
          const preferredSubDay = batches.length > 1
            ? distributedRunSubDay(0, subIndex)
            : preferredSubProductionDay(sub.category, spec, needDay, leadDays);
          const slot = pickLowestLoadSlotForDay(slotLoads, preferredSubDay, activeShifts)
            ?? (preferredSubDay === "So" ? null : pickLowestRegularSubSlot(slotLoads, activeShifts))
            ?? pickLowestLoadSlot(slotLoads, activeShifts);
          if (!slot) continue;
          const subKey = assignmentKey(recipeSummary.recipeCode, sub.subRecipeId);
          nextAssignments[subKey] = {
            recipeCode: recipeSummary.recipeCode,
            subRecipeId: sub.subRecipeId,
            subRecipeName: sub.subRecipeName,
            day: slot.day,
            shift: slot.shift,
            order: nextOrder(slot.day, slot.shift),
            targetPortions: mainTarget,
            note: buildBoardNote("Auto/SubFromMain", `main=${mainTarget}||split=${serializeBatchesForNote(batches)}`)
          };
          autoTouchedKeys.add(subKey);
          addLoad(slot.day, slot.shift);
        }
      }

      // Sicherheitsnetz: wirklich jedes Rezept muss nach Auto-Plan ein Main-Assignment haben.
      for (const recipeSummary of recipesByLoad) {
        const weekRecipe = recipeLookup[recipeSummary.recipeCode]
          ?? data.weekRecipes.find((row) => row.hfWeek === week && row.code === recipeSummary.recipeCode)
          ?? ({ code: recipeSummary.recipeCode } as WeekRecipe);
        const mainKey = assignmentKey(recipeSummary.recipeCode);
        const currentMain = nextAssignments[mainKey];
        const hasValidMain = !!currentMain
          && isPlannerDay(currentMain.day)
          && isShiftActive(currentMain.shift);
        if (hasValidMain) continue;

        const fallbackTarget = Math.max(0, Math.round(currentMain?.targetPortions ?? weekRecipe.totalVerdenVolume ?? 0));
        const fallbackBatches = resolveAutoBatches(recipeSummary.recipeCode, fallbackTarget, autoProfile, batchSplitByRecipe);
        const fallbackDay = avoidSaturday(safePlannerDay(fallbackBatches[0]?.day ?? currentMain?.day ?? "Fr"));
        const slot = pickLowestLoadSlotForDay(slotLoads, fallbackDay, activeShifts)
          ?? pickLowestLoadSlot(slotLoads, activeShifts);
        if (!slot) continue;

        nextAssignments[mainKey] = {
          recipeCode: recipeSummary.recipeCode,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift),
          targetPortions: fallbackTarget,
          note: buildBoardNote("Auto/MainSafetyNet", `split=${serializeBatchesForNote(fallbackBatches)}`)
        };
        autoTouchedKeys.add(mainKey);
        addLoad(slot.day, slot.shift);
      }

      // Mo/Di sind echte Produktionstage: nach der Lead-Time-Planung verteilen wir
      // automatisch gesetzte Submeal-Arbeit aus den vollen Folgetagen zurück.
      const loadByAssignmentKey = new Map<string, number>();
      const categoryByAssignmentKey = new Map<string, string>();
      for (const recipeSummary of refreshedAnalysis.recipes) {
        loadByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode), recipeSummary.activeMin);
        for (const sub of recipeSummary.subRecipes) {
          loadByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode, sub.subRecipeId), sub.activeMin);
          categoryByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode, sub.subRecipeId), sub.category);
        }
      }

      const assignmentCountForDay = (day: PlannerDay): number => {
        return Object.values(nextAssignments)
          .filter((row) => row.day === day && isShiftActive(row.shift))
          .length;
      };

      const dayBalanceTargets: readonly PlannerDay[] = ["Mo", "Di"];
      for (const targetDay of dayBalanceTargets) {
        if (assignmentCountForDay(targetDay) > 0) continue;
        const candidate = [...autoTouchedKeys]
          .map((key) => ({ key, row: nextAssignments[key], activeMin: loadByAssignmentKey.get(key) ?? 0 }))
          .filter((item) => {
            if (!item.row || item.row.day === targetDay || !isShiftActive(item.row.shift)) return false;
            if (!item.row.subRecipeId) return false;
            if (!REGULAR_SUB_DAYS.includes(item.row.day)) return false;
            if (assignmentCountForDay(item.row.day) <= 1) return false;
            return !isSundayPrepSub(categoryByAssignmentKey.get(item.key) ?? "", data.processSpecs?.[item.row.subRecipeId]);
          })
          .sort((a, b) => {
            const sourceLoadDelta = assignmentCountForDay(b.row.day) - assignmentCountForDay(a.row.day);
            return sourceLoadDelta || b.activeMin - a.activeMin || a.key.localeCompare(b.key);
          })[0];

        const slot = pickLowestLoadSlotForDay(slotLoads, targetDay, activeShifts);
        if (!candidate || !slot) continue;
        const parsedNote = parseBoardNote(candidate.row.note);
        nextAssignments[candidate.key] = {
          ...candidate.row,
          day: targetDay,
          shift: slot.shift,
          order: nextOrder(targetDay, slot.shift),
          note: buildBoardNote(`Auto/${targetDay}Balance`, parsedNote.notes)
        };
        addLoad(targetDay, slot.shift);
      }

      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [week]: {
            ...weekState,
            scenarios: weekState.scenarios.map((s) =>
              s.id === currentScenario.id ? { ...s, assignments: nextAssignments } : s
            )
          }
        }
      };
    });
  }

  function openWeekBoardEditor(input: WeekBoardEditorState) {
    const key = assignmentKey(input.recipeCode, input.subRecipeId);
    const existing = scenario.assignments[key];
    const recipe = recipeLookup[input.recipeCode];
    const fallbackTarget = Math.max(0, Math.round(recipe?.totalVerdenVolume ?? 0));
    const parsedNote = parseBoardNote(existing?.note);
    const splitSpec = extractSplitSpecFromNotes(parsedNote.notes);
    setBoardDraft({
      shift: existing?.shift ?? input.shift,
      targetPortions: existing?.targetPortions ?? fallbackTarget,
      reason: parsedNote.reason,
      splitSpec,
      notes: stripSplitSpecFromNotes(parsedNote.notes)
    });
    setBoardEditor(input);
  }

  function saveWeekBoardEditor() {
    if (!boardEditor) return;
    const recipe = recipeLookup[boardEditor.recipeCode];
    if (!recipe) {
      setBoardEditor(null);
      return;
    }
    const targetPortions = Math.max(0, Math.round(boardDraft.targetPortions || 0));
    const splitForNote = boardEditor.subRecipeId ? "" : boardDraft.splitSpec;
    setStorage((prev) => assignRecipe(prev, week, scenario.id, recipe, {
      day: boardEditor.day,
      shift: boardDraft.shift,
      subRecipeId: boardEditor.subRecipeId,
      subRecipeName: boardEditor.subRecipeName,
      targetPortions,
      note: buildBoardNote(boardDraft.reason, composeBoardNotes(boardDraft.notes, splitForNote))
    }));
    setBoardEditor(null);
  }

  function clearWeekBoardEditorAssignment() {
    if (!boardEditor) return;
    setStorage((prev) => removeAssignment(prev, week, scenario.id, boardEditor.recipeCode, boardEditor.subRecipeId));
    setBoardEditor(null);
  }

  function handleSavePlanSnapshot() {
    if (typeof window === "undefined") return;
    const now = new Date();
    const stamp = now.toLocaleString("de-DE");
    const snapshot = {
      savedAtIso: now.toISOString(),
      savedAtLabel: stamp,
      week,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      assignments: scenario.assignments,
      stats: {
        plannedCount: analysis.plannedCount,
        unplannedCount: analysis.unplannedCount
      }
    };
    window.localStorage.setItem(`rezeptlogik-plan-snapshot-${week}`, JSON.stringify(snapshot));
    window.dispatchEvent(new CustomEvent("rezeptlogik:plan-snapshot-saved", {
      detail: {
        week,
        scenarioId: scenario.id,
        savedAtIso: snapshot.savedAtIso,
      }
    }));
    setSavePlanStamp(stamp);
    onPlanSnapshotSaved?.();
  }

  return (
    <div className="space-y-3 w-full max-w-none">
      <div className={calendarFullView
        ? "fixed inset-2 z-[120] flex h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-2 ring-slate-300"
        : "card p-0"
      }>
        <div className="border-b border-slate-200 bg-[linear-gradient(130deg,_rgba(241,245,249,1),_rgba(255,255,255,1)_40%,_rgba(236,253,245,0.65))] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[30px] leading-none font-semibold tracking-tight text-slate-900">Manufacturing Planning Calendar</h2>
              <p className="mt-2 text-xs text-slate-500">Wochenboard für Main- und Sub-Rezepte. Klick auf eine Zelle öffnet den Stückzahl-Dialog.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-300">{analysis.plannedCount} geplant</span>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-300">{unplanned.length} offen</span>
              {Object.keys(linePlanRunSplitByRecipe).length > 0 && (
                <span className="rounded-full bg-cyan-50 px-3 py-1 text-[11px] font-semibold text-cyan-800 ring-1 ring-cyan-300">
                  Plating Runs: {Object.keys(linePlanRunSplitByRecipe).length} Meals · Ziel 110%
                </span>
              )}
              <label className="flex items-center gap-1 rounded-md bg-white px-2 py-1 ring-1 ring-slate-300">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Auto-Profil</span>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700"
                  value={uiSettings.autoSplitProfileId}
                  onChange={(event) => setUiSettings((prev) => ({ ...prev, autoSplitProfileId: event.target.value }))}
                >
                  {AUTO_FULFILLMENT_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                  ))}
                </select>
              </label>
              <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800" onClick={handleAutoPlanWeekBoard}>
                Auto: Meals + Subs
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 ${calendarFullView ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-100"}`}
                onClick={() => setCalendarFullView((prev) => !prev)}
                title="Schaltet den Manufacturing Planning Calendar in die Vollansicht"
              >
                {calendarFullView ? "Vollansicht schließen" : "Vollansicht"}
              </button>
              <button
                className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
                onClick={handleSavePlanSnapshot}
                disabled={analysis.plannedCount === 0}
                title="Speichert den aktuellen Wochenplan als Snapshot für die Rundmail-Weitergabe"
              >
                Plan sichern
              </button>
              <button
                className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100 disabled:opacity-40"
                onClick={() => {
                  if (analysis.plannedCount === 0) return;
                  if (window.confirm(`Kalender für Szenario '${scenario.name}' wirklich leeren? ${analysis.plannedCount} Zuordnung(en) gehen verloren.`)) {
                    setStorage(prev => resetScenario(prev, week, scenario.id));
                  }
                }}
                disabled={analysis.plannedCount === 0}
              >
                Kalender leeren
              </button>
              {savePlanStamp && (
                <span className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-300">
                  Plan gesichert: {savePlanStamp}
                </span>
              )}
              {/* Export-Dropdown */}
              <div className="relative">
                <button
                  className="rounded-md bg-verde-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 flex items-center gap-1 disabled:opacity-40"
                  disabled={analysis.plannedCount === 0}
                  onClick={() => setExportMenuOpen(prev => !prev)}
                >
                  ↓ Export
                </button>
                {exportMenuOpen && (
                  <div
                    className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-slate-200 bg-white shadow-lg"
                    onMouseLeave={() => setExportMenuOpen(false)}
                  >
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsTSV(analysis, data, week, portionMultiplier); }}
                    >
                      📄 TSV (Excel-kompatibel)
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsExcel(analysis, data, week, portionMultiplier); }}
                    >
                      📊 Excel (.xls, 3 Tabs)
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsPDF(analysis, data, week, portionMultiplier); }}
                    >
                      🖨 PDF / Drucken
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {rampUpChanges.length > 0 && !rampUpBannerDismissed && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-black text-amber-800">
                  &#9888; Portionszahlen ge&auml;ndert&nbsp;&mdash;&nbsp;
                </span>
                <span className="text-xs text-amber-700">
                  {rampUpChanges.length} {rampUpChanges.length === 1 ? "Rezept" : "Rezepte"} betroffen:
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {rampUpChanges.map(c => (
                    <span key={c.code} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px]">
                      <span className="font-black text-amber-900">{c.code}</span>
                      <span className="tabular-nums text-slate-500">{fmtNum(c.oldTotal)} → {fmtNum(c.newTotal)}</span>
                      <RampUpDeltaBadge delta={c.delta} />
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setRampUpBannerDismissed(true)}
                className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold hover:bg-amber-300 transition-colors"
                title="Schlie&szlig;en"
              >&#x2715;</button>
            </div>
          </div>
        )}

        <div className={`w-full max-w-full overflow-x-auto overflow-y-visible pb-2 [scrollbar-gutter:stable] ${calendarFullView ? "flex-1" : ""}`}>
          <table className="w-max min-w-[1780px] border-collapse text-xs">
            <thead>
              <tr className="bg-white border-b border-slate-300">
                <th className="sticky left-0 z-20 bg-white px-3 py-2 text-left font-semibold text-slate-700 min-w-[320px]" rowSpan={2}>Recipes</th>
                <th className="sticky left-[320px] z-20 bg-white px-2 py-2 text-right font-semibold text-slate-700 min-w-[110px]" rowSpan={2}>Forecast / Runs</th>
                <th className="sticky left-[410px] z-20 bg-white px-2 py-2 text-center font-semibold text-slate-700 min-w-[70px]" rowSpan={2}>WIP</th>
                <th className="sticky left-[480px] z-20 bg-white px-2 py-2 text-right font-semibold text-slate-700 min-w-[90px]" rowSpan={2}>Mapped</th>
                {MANUFACTURING_DAYS.map((column) => (
                  <th key={column.id} colSpan={activeShifts.length} className="border-l border-slate-300 px-2 py-2 text-center font-semibold text-slate-700 min-w-[170px]">{column.label}</th>
                ))}
              </tr>
              <tr className="bg-white border-b border-slate-300">
                {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => (
                  <th key={`${column.id}-${shift}`} className="border-l border-slate-200 px-1 py-1 text-center font-medium text-slate-500">
                    {shift === "S1" ? "1st Shift" : shift === "S2" ? "2nd Shift" : "3rd Shift"}
                  </th>
                )))}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-[linear-gradient(90deg,_rgba(226,232,240,0.85),_rgba(241,245,249,0.9))]">
                <td colSpan={4 + MANUFACTURING_DAYS.length * activeShifts.length} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  {week} (Current) Recipes
                </td>
              </tr>
              {analysis.recipes.map((recipe) => {
                const wr = recipeLookup[recipe.recipeCode];
                const forecast = wr?.totalVerdenVolume ?? 0;
                const isExpanded = expandedBoardRecipes.has(recipe.recipeCode);
                const mainMapped = recipe.assigned?.targetPortions ?? (recipe.assigned ? forecast : 0);
                const tone = weekBoardRecipeTone(recipe.recipeCode);
                return (
                  <Fragment key={recipe.recipeCode}>
                    <tr key={recipe.recipeCode} className="border-b border-slate-300" style={tone.row}>
                      <td className="sticky left-0 z-10 border-r border-slate-200 px-3 py-2 align-top" style={tone.sticky}>
                        <div className="flex items-start gap-2">
                          <button
                            className="mt-0.5 rounded border border-slate-300 bg-white px-1 text-[10px] leading-4 text-slate-600 hover:bg-slate-100"
                            onClick={() => setExpandedBoardRecipes((prev) => {
                              const next = new Set(prev);
                              if (next.has(recipe.recipeCode)) next.delete(recipe.recipeCode);
                              else next.add(recipe.recipeCode);
                              return next;
                            })}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                              <div className="inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={tone.badge}>{recipe.recipeCode}</div>
                              <RampUpDeltaBadge delta={rampUpChanges.find(c => c.code === recipe.recipeCode)?.delta ?? 0} />
                            </div>
                            <button className="mt-1 block text-left text-sm font-semibold hover:text-verden-700" style={tone.title} onClick={() => onSelectRecipe?.(recipe.recipeCode)}>{recipe.recipeName}</button>
                            <div className="mt-0.5 text-[10px] text-slate-500">
                              {recipe.subRecipes.length} Sub-Rezepte
                              {!isExpanded && recipe.subRecipes.some(s => !s.assigned) && (
                                <span className="ml-1 font-bold text-amber-500" title="Unverplante Sub-Rezepte">!</span>
                              )}
                            </div>
                            {(() => {
                              const snaps = rampUpHistoryMap.get(recipe.recipeCode) ?? [];
                              const vals = snaps.map(s => s.volumes[recipe.recipeCode] ?? 0);
                              if (vals.length < 2) return null;
                              return (
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                                  <RampUpSparkline values={vals} width={48} height={14} />
                                  <span style={{ fontSize: 9, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                    {fmtNum(vals[0])} → {fmtNum(vals[vals.length - 1])}
                                  </span>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </td>
                      <td className="sticky left-[320px] z-10 border-r border-slate-200 px-2 py-2 align-top" style={tone.sticky}>
                        {(() => {
                          const rawVol = wr?.verdenVolume ?? { BENL: 0, DKSE: 0, DE: 0 };
                          const upliftedBnl     = Math.round((rawVol.BENL ?? 0) * portionMultiplier);
                          const upliftedNordics  = Math.round((rawVol.DKSE ?? 0) * portionMultiplier);
                          const upliftedDe      = Math.round((rawVol.DE   ?? 0) * portionMultiplier);
                          const rs = calculateRunSplit({ bnl: upliftedBnl, nordics: upliftedNordics, de: upliftedDe });
                          const upliftedTotal = upliftedBnl + upliftedNordics + upliftedDe;
                          const snaps = rampUpHistoryMap.get(recipe.recipeCode) ?? [];
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                              {/* Forecast (with uplift) */}
                              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                                <span className="font-semibold tabular-nums text-sm">{fmtNum(upliftedTotal)}</span>
                                {upliftPercent !== 0 && (
                                  <span style={{ fontSize: 9, color: upliftPercent > 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                                    {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
                                  </span>
                                )}
                              </div>
                              {/* Run 1 / Run 2 */}
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, marginTop: 2, borderTop: "1px solid #e2e8f0", paddingTop: 3 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>R1</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", fontVariantNumeric: "tabular-nums" }}>{fmtNum(rs.firstRun.total)}</span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>R2</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", fontVariantNumeric: "tabular-nums" }}>{fmtNum(rs.secondRun)}</span>
                                </div>
                                <div style={{ fontSize: 9, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                  Ziel {fmtNum(rs.upliftTotal)} (+10%)
                                </div>
                              </div>
                              {/* Ramp-up history */}
                              {snaps.length >= 2 && snaps.slice(-4).reverse().map((snap, idx) => (
                                <div key={snap.ts} style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                                  <span style={{ fontSize: 9, color: idx === 0 ? "#475569" : "#94a3b8", fontVariantNumeric: "tabular-nums", fontWeight: idx === 0 ? 600 : 400 }}>
                                    {snap.label}
                                  </span>
                                  <span style={{ fontSize: 9, color: idx === 0 ? "#475569" : "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                    {fmtNum(snap.volumes[recipe.recipeCode] ?? 0)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="sticky left-[410px] z-10 border-r border-slate-200 px-2 py-2 text-center text-slate-300" style={tone.sticky}></td>
                      <td className="sticky left-[480px] z-10 border-r border-slate-200 px-2 py-2 text-right font-semibold tabular-nums" style={tone.sticky}>{mainMapped > 0 ? fmtNum(mainMapped) : ""}</td>

                      {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => {
                        const day = column.day;
                        const slot = slotValue(day, shift);
                        const rows = assignmentsByDayShift[slot] ?? [];
                        const mainTiles = column.lane === "prep"
                          ? []
                          : rows.filter((row) => row.code === recipe.recipeCode && row.kind === "main");
                        const subTiles = rows.filter((row) => row.code === recipe.recipeCode && row.kind === "sub");
                        const hasReal = mainTiles.some(t => !t.suggested);
                        const hasAny = mainTiles.length > 0;
                        const isDragOverThis = dragOverSlot === slot;
                        return (
                          <td
                            key={`${recipe.recipeCode}-${column.id}-${shift}`}
                            className="border-l border-slate-200 p-1 align-top"
                            onDragOver={(e) => {
                              if (day === "Sa") return;
                              const hasSuggest = !!(e.dataTransfer.getData("text/suggest-key") || draggingSuggestKey);
                              const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCode);
                              if (hasSuggest || hasRecipe) {
                                e.preventDefault();
                                setDragOverSlot(slot);
                              }
                            }}
                            onDragLeave={() => { if (dragOverSlot === slot) setDragOverSlot(null); }}
                            onDrop={(e) => {
                              const hasSuggest = !!(e.dataTransfer.getData("text/suggest-key") || draggingSuggestKey);
                              const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCode);
                              if (!hasSuggest && !hasRecipe) return;
                              e.preventDefault();
                              if (hasSuggest) {
                                handleDropSuggestOnSlot(e, day);
                                return;
                              }
                              handleDropOnSlot(e, day, shift);
                            }}
                          >
                            <div className="min-h-[66px] rounded border p-1 hover:border-slate-300" style={isDragOverThis ? { ...tone.slotActive, outline: '2px dashed currentColor' } : hasReal ? tone.slotActive : tone.slotIdle} onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift })}>
                              <div className="space-y-1">
                                {mainTiles.map((mainTile) => {
                                  // Ghost-Pill / Plating-Pill: aus BatchSplitPlan
                                  if (mainTile.suggested) {
                                    // Liniengetriebene Kapazitätsinfo
                                    const isLineDriven = mainTile.lineCapacityPortions !== undefined;
                                    const gapPlan = mainTile.lineCoverageGap; // positiv = Lücke, negativ = Überschuss
                                    const gapPortions = gapPlan !== undefined ? Math.abs(gapPlan) : 0;
                                    const hasGap = gapPlan !== undefined && gapPlan > 0;
                                    const hasSurplus = gapPlan !== undefined && gapPlan < 0;
                                    const titleSuffix = isLineDriven
                                      ? ` | Linienkapazität: ${fmtNum(mainTile.lineCapacityPortions!)} Port.${hasGap ? ` ⚠ ${fmtNum(gapPortions)} fehlen` : hasSurplus ? ` ✓ ${fmtNum(gapPortions)} Überschuss` : " ✓ gedeckt"}`
                                      : "";

                                    // Alle Sub-Rezepte verplant → solide Plating-Pille
                                    if (mainTile.allSubsDone) {
                                      const labelPortions = mainTile.targetPortions
                                        ?? recipe.assigned?.targetPortions
                                        ?? forecast;
                                      const platLabel = `${mainTile.batchLabel ? mainTile.batchLabel + " " : ""}Plan ${fmtNum(labelPortions)}`;
                                      return (
                                        <div key={mainTile.key}>
                                          <button
                                            draggable
                                            onDragStart={(e) => handleSuggestDragStart(e, mainTile.key)}
                                            onDragEnd={handleDragEnd}
                                            onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift }); }}
                                            className="w-full rounded-full px-2 py-0.5 text-left text-[10px] font-bold flex items-center gap-1 cursor-grab active:cursor-grabbing"
                                            style={tone.mainPill}
                                            title={`Alle Sub-Rezepte verplant → Plating am ${mainTile.fulfillmentDay}: ${fmtNum(mainTile.targetPortions ?? forecast)} Portionen. Klick zum Bestätigen.${titleSuffix}`}
                                          >
                                            <span className="flex-1">{platLabel}</span>
                                            {isLineDriven && (
                                              <span className="shrink-0 text-[9px]" title="Linienplan aktiv">🔗</span>
                                            )}
                                            {mainTile.fulfillmentDay && (
                                              <span className="shrink-0 rounded bg-white/60 px-1 text-[9px] font-black">{mainTile.fulfillmentDay}</span>
                                            )}
                                          </button>
                                        </div>
                                      );
                                    }
                                    // Ghost-Pill: noch nicht alle Subs verplant
                                    const ghostLabel = `${mainTile.batchLabel ? mainTile.batchLabel + " " : ""}${fmtNum(mainTile.targetPortions ?? forecast)} · Plating ${mainTile.fulfillmentDay}`;
                                    // Randfarbe bei Kapazitätslücke: rot, bei Überschuss: grün
                                    const gapOutlineColor = hasGap
                                      ? "hsl(0 70% 50%)"
                                      : hasSurplus
                                        ? "hsl(140 60% 42%)"
                                        : `hsl(${tone.hue} 52% 52%)`;
                                    return (
                                      <div key={mainTile.key}>
                                        <button
                                          draggable
                                          onDragStart={(e) => handleSuggestDragStart(e, mainTile.key)}
                                          onDragEnd={handleDragEnd}
                                          onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift }); }}
                                          className="w-full rounded-full px-2 py-0.5 text-left text-[10px] font-semibold flex items-center gap-1 cursor-grab active:cursor-grabbing"
                                          style={{
                                            backgroundColor: `hsl(${tone.hue} 64% 93%)`,
                                            color: `hsl(${tone.hue} 58% 28%)`,
                                            outline: `1.5px dashed ${gapOutlineColor}`,
                                            outlineOffset: '-1.5px',
                                          }}
                                          title={`Deadline: ${fmtNum(mainTile.targetPortions ?? forecast)} Port. platen → Plating-Tag ${mainTile.fulfillmentDay} · empf. Küche: ${mainTile.recommendedProdDay ?? "–"}${titleSuffix}`}
                                        >
                                          <span className="flex-1">{ghostLabel}</span>
                                          {isLineDriven && (
                                            <span className="shrink-0 text-[9px]" title="Aus Linienplanung">🔗</span>
                                          )}
                                          {hasGap && (
                                            <span
                                              className="shrink-0 rounded px-1 text-[9px] font-black"
                                              style={{ backgroundColor: "hsl(0 70% 50%)", color: '#fff' }}
                                              title={`Kapazitätslücke: ${fmtNum(gapPortions)} Portionen fehlen auf der Linie`}
                                            >⚠{fmtNum(gapPortions)}</span>
                                          )}
                                          {hasSurplus && (
                                            <span
                                              className="shrink-0 rounded px-1 text-[9px] font-black"
                                              style={{ backgroundColor: "hsl(140 60% 42%)", color: '#fff' }}
                                              title={`Linie hat ${fmtNum(gapPortions)} Portionen Überschusskapazität`}
                                            >✓</span>
                                          )}
                                          {mainTile.fulfillmentDay && (
                                            <span
                                              className="shrink-0 rounded px-1 text-[9px] font-black"
                                              style={{ backgroundColor: `hsl(${tone.hue} 52% 52%)`, color: '#fff' }}
                                            >{mainTile.fulfillmentDay}</span>
                                          )}
                                        </button>
                                      </div>
                                    );
                                  }
                                  const isSplit = !!mainTile.batchLabel;
                                  const bIdx = mainTile.batchIndex ?? 0;
                                  const bTotal = mainTile.batchTotal ?? 1;
                                  const isFirst = bIdx === 0;
                                  const isLast = bIdx === bTotal - 1;
                                  // Richtungspfeil: zeigt woher/wohin der Batch geht
                                  const chevronLeft  = !isFirst ? "‹ " : "";
                                  const chevronRight = !isLast  ? " ›" : "";
                                  // Connector-Bar: horizontaler farbiger Streifen über dem Pill
                                  const connBar: CSSProperties | null = isSplit ? {
                                    background: isFirst
                                      ? `linear-gradient(90deg, hsl(${tone.hue} 68% 52%) 55%, transparent 100%)`
                                      : isLast
                                        ? `linear-gradient(90deg, transparent 0%, hsl(${tone.hue} 68% 52%) 45%)`
                                        : `hsl(${tone.hue} 68% 52%)`,
                                    opacity: 0.55,
                                  } : null;
                                  return (
                                    <div key={mainTile.key} className="space-y-0.5">
                                      {connBar && <div className="-mx-1 h-0.5 rounded-full" style={connBar} />}
                                      <button
                                        draggable
                                        onDragStart={(event) => handleDragStart(event, recipe.recipeCode)}
                                        onDragEnd={handleDragEnd}
                                        onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift }); }}
                                        className="w-full rounded-full px-2 py-0.5 text-left text-[10px] font-bold cursor-grab active:cursor-grabbing"
                                        style={tone.mainPill}
                                        title={isSplit ? `Batch ${bIdx + 1} von ${bTotal} · ${mainTile.batchLabel}` : undefined}
                                      >
                                        <span className="opacity-60">{chevronLeft}</span>
                                        {mainTile.batchLabel ? `${mainTile.batchLabel} ` : ""}Plan:{fmtNum(mainTile.targetPortions ?? forecast)} | Min:{fmtMin(mainTile.activeMin)}
                                        <span className="opacity-60">{chevronRight}</span>
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              {!hasAny && <div className="pt-4 text-center text-[10px] text-slate-200"></div>}
                            </div>
                          </td>
                        );
                      }))}
                    </tr>

                    {isExpanded && recipe.subRecipes.map((sub, subIndex) => {
                      const subMapped = sub.assigned?.targetPortions ?? (sub.assigned ? forecast : 0);
                      const subSpec = data.processSpecs?.[sub.subRecipeId];
                      const sundayPrep = isSundayPrepSub(sub.category, subSpec);
                      const subLeadDays = subLeadDaysBeforeNeed(sub.category, subSpec);
                      const leadLabel = subLeadDays > 0 ? `D-${subLeadDays}` : null;
                      const leadTooltip = leadLabel && recipe.assigned?.day
                        ? `${sub.category} → ${leadLabel} vor Bedarfstag ${recipe.assigned.day}`
                        : undefined;
                      // Precompute sub-batch split: Run 1/2 follow the main split but never collapse onto the same submeal day.
                      const subBatches: Array<{ label: string; portions: number; day: PlannerDay }> = (() => {
                        if (!sub.assigned || !recipe.assigned) return [];
                        return runSubBatchesForAssignment(recipe.assigned, sub.assigned, forecast, subIndex);
                      })();
                      const hasBatchSplit = subBatches.length > 1;
                      return (
                        <tr key={`${recipe.recipeCode}-${sub.subRecipeId}`} className="border-b border-slate-200" style={tone.subRow}>
                          <td className="sticky left-0 z-10 border-r border-slate-200 px-3 py-1.5" style={tone.subSticky}>
                            <div className="pl-8">
                              <div className="font-mono text-[10px]" style={tone.code}>{sub.subRecipeId}</div>
                              <div className="text-xs font-semibold" style={tone.title}>{sub.subRecipeName}</div>
                              <div className="text-[10px] text-slate-500">{sub.category}</div>
                            </div>
                          </td>
                          <td className="sticky left-[320px] z-10 border-r border-slate-200 px-2 py-1.5 text-right tabular-nums" style={tone.subSticky}>{fmtNum(forecast)}</td>
                          <td className="sticky left-[410px] z-10 border-r border-slate-200 px-2 py-1.5 text-center text-slate-300" style={tone.subSticky}></td>
                          <td className="sticky left-[480px] z-10 border-r border-slate-200 px-2 py-1.5 text-right tabular-nums" style={tone.subSticky}>{subMapped > 0 ? fmtNum(subMapped) : ""}</td>
                          {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => {
                            const day = column.day;
                            const hasPrepBatch = hasBatchSplit && subBatches.some(batch => batch.day === "So");
                            const usesPrepSunday = sundayPrep || hasPrepBatch;
                            const visibleInColumn = column.lane === "prep" ? usesPrepSunday : !(day === "So" && usesPrepSunday);
                            const slot = slotValue(day, shift);
                            const isAssigned = visibleInColumn && sub.assigned?.day === day && sub.assigned?.shift === shift;
                            const batchesHere = visibleInColumn && hasBatchSplit && sub.assigned?.shift === shift
                              ? subBatches.filter(b => b.day === day)
                              : [];
                            const isActive = hasBatchSplit ? batchesHere.length > 0 : isAssigned;
                            const isDragOverThis = dragOverSlot === slot;
                            return (
                              <td
                                key={`${sub.subRecipeId}-${column.id}-${shift}`}
                                className="border-l border-slate-200 p-1 align-top"
                                onDragOver={(e) => {
                                  if (day === "Sa") return;
                                  const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCode);
                                  if (hasRecipe) {
                                    e.preventDefault();
                                    setDragOverSlot(slot);
                                  }
                                }}
                                onDragLeave={() => { if (dragOverSlot === slot) setDragOverSlot(null); }}
                                onDrop={(e) => {
                                  const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCode);
                                  if (!hasRecipe) return;
                                  e.preventDefault();
                                  handleDropOnSlot(e, day, shift);
                                }}
                              >
                                <div
                                  className="min-h-[50px] rounded border p-1 hover:border-slate-300"
                                  style={isDragOverThis ? { ...tone.slotActive, outline: "2px dashed currentColor" } : isActive ? tone.slotActive : tone.slotIdle}
                                  onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName })}
                                >
                                  {hasBatchSplit && batchesHere.length > 0 ? (
                                    <div className="space-y-1">
                                      {batchesHere.map((batch) => (
                                        <button
                                          key={batch.label}
                                          draggable
                                          onDragStart={(event) => handleDragStart(event, recipe.recipeCode, sub.subRecipeId)}
                                          onDragEnd={handleDragEnd}
                                          onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName }); }}
                                          className="w-full rounded-full px-2 py-0.5 text-left text-[10px] font-bold cursor-grab active:cursor-grabbing"
                                          style={tone.subPill}
                                          title={leadTooltip}
                                        >
                                          <span className="opacity-60 mr-0.5">{batch.label}</span>{fmtNum(batch.portions)}
                                          {leadLabel && <span className="ml-1 rounded-full bg-white/50 px-1 text-[9px] font-bold opacity-80">{leadLabel}</span>}
                                        </button>
                                      ))}
                                    </div>
                                  ) : !hasBatchSplit && isAssigned ? (
                                    <div className="flex items-center gap-1">
                                      <button
                                        draggable
                                        onDragStart={(event) => handleDragStart(event, recipe.recipeCode, sub.subRecipeId)}
                                        onDragEnd={handleDragEnd}
                                        onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName }); }}
                                        className="min-w-0 flex-1 rounded-full px-2 py-0.5 text-left text-[10px] font-bold cursor-grab active:cursor-grabbing"
                                        style={tone.subPill}
                                        title={leadTooltip}
                                      >
                                        {fmtNum(sub.assigned?.targetPortions ?? forecast)}
                                        {leadLabel && <span className="ml-1 rounded-full bg-white/50 px-1 text-[9px] font-bold opacity-80">{leadLabel}</span>}
                                      </button>
                                      <button
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSubRecipeInfoRequest({
                                            recipeCode: recipe.recipeCode,
                                            recipeName: recipe.recipeName,
                                            subRecipeId: sub.subRecipeId,
                                            subRecipeName: sub.subRecipeName,
                                            day,
                                            shift,
                                            targetPortions: sub.assigned?.targetPortions ?? forecast,
                                            leadDays: subLeadDays,
                                            mainDay: recipe.assigned?.day,
                                            category: sub.category
                                          });
                                        }}
                                        className="h-5 w-5 shrink-0 rounded-full text-[10px] font-bold"
                                        style={tone.infoButton}
                                        title={leadTooltip ?? "Sub-Info"}
                                      >
                                        i
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="pt-3 text-center text-[10px] text-slate-200"></div>
                                  )}
                                </div>
                              </td>
                            );
                          }))}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-slate-900">Tages-Zusammenrechnung Manufacturing</h3>
              <p className="mt-0.5 text-xs text-slate-500">B1-Submeals: So (Prep) bis Mi · B2-Submeals: Mo bis Do · Freitag/Samstag bleiben frei für Submeal-Runs.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right text-xs sm:grid-cols-3">
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Jobs</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.mainCount + row.subRunCount, 0))}</div>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Main Port.</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.mainPortions, 0))}</div>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Sub Port.</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.subPortions, 0))}</div>
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {manufacturingDaySummaries.map((row) => {
              const totalPortions = row.mainPortions + row.subPortions;
              const jobCount = row.mainCount + row.subRunCount;
              const subShare = totalPortions > 0 ? Math.round((row.subPortions / totalPortions) * 100) : 0;
              return (
                <div key={`mfg-summary-${row.column.id}`} className={`rounded-lg border p-3 ${jobCount > 0 ? "border-emerald-200 bg-emerald-50/70" : "border-slate-200 bg-slate-50"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-black text-slate-900">{row.column.label}</div>
                      <div className="text-[10px] font-semibold uppercase text-slate-400">{row.column.lane === "prep" ? "Prep-Fenster B1" : row.column.day === "Sa" ? "frei halten" : "Reguläre Produktion"}</div>
                    </div>
                    <div className={`rounded-full px-2 py-1 text-xs font-black ${jobCount > 0 ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-500"}`}>{jobCount} Jobs</div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Total</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(totalPortions)}</div>
                    </div>
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Main</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(row.mainPortions)}</div>
                    </div>
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Sub</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(row.subPortions)}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-emerald-600" style={{ width: `${subShare}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] font-semibold text-slate-500">
                    <span>Main-Jobs {fmtNum(row.mainCount)}</span>
                    <span>Sub-Run-Jobs {fmtNum(row.subRunCount)}</span>
                  </div>
                  <div className="mt-3 min-h-[92px] rounded border border-white/70 bg-white/70 px-2 py-2">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Was wird gemacht</div>
                    <div className="space-y-1 text-[11px] leading-tight text-slate-600">
                      {row.items.length > 0 ? row.items.slice(0, 8).map((item, index) => (
                        <div key={`${row.column.id}-${index}-${item}`} className="truncate" title={item}>
                          <span className="mr-1 font-mono text-[10px] text-slate-400">{index + 1}.</span>{item}
                        </div>
                      )) : <div className="pt-4 text-center italic text-slate-400">{row.column.day === "Sa" ? "frei, nichts einplanen" : "keine Jobs geplant"}</div>}
                      {row.items.length > 8 && <div className="font-semibold text-slate-400">+ {fmtNum(row.items.length - 8)} weitere Jobs</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      {boardEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4" onClick={() => setBoardEditor(null)}>
          <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl ring-1 ring-slate-300" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between rounded-t-xl bg-emerald-700 px-4 py-2 text-white">
              <div className="text-sm font-semibold">{boardEditor.subRecipeId ? "Create sub-recipe work order" : "Create recipe work order"}</div>
              <button className="text-lg leading-none" onClick={() => setBoardEditor(null)}>×</button>
            </div>
            <div className="space-y-3 px-4 py-3">
              <div className="rounded bg-slate-100 px-3 py-2">
                <div className="text-[11px] text-slate-500">Recipe</div>
                <div className="text-sm font-semibold text-slate-900">{boardEditor.recipeCode} {analysis.recipes.find((row) => row.recipeCode === boardEditor.recipeCode)?.recipeName ?? ""}</div>
                {boardEditor.subRecipeId && <div className="mt-1 text-xs text-slate-700">{boardEditor.subRecipeName ?? boardEditor.subRecipeId}</div>}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600">
                  Scheduled day
                  <input className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardEditor.day} readOnly />
                </label>
                <div>
                  <div className="text-xs font-semibold text-slate-600">Shift</div>
                  <div className="mt-1 grid grid-cols-3 gap-1">
                    {activeShifts.map((shift) => (
                      <button key={`edit-${shift}`} className={`rounded border px-2 py-2 text-sm font-semibold ${boardDraft.shift === shift ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-600"}`} onClick={() => setBoardDraft((prev) => ({ ...prev, shift }))}>
                        {shift === "S1" ? "1st shift" : shift === "S2" ? "2nd shift" : "3rd shift"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600">
                  Target
                  <input type="number" min={0} className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardDraft.targetPortions} onChange={(event) => setBoardDraft((prev) => ({ ...prev, targetPortions: Math.max(0, Number(event.target.value) || 0) }))} />
                </label>
                <label className="text-xs font-semibold text-slate-600">
                  Creation Reason
                  <select className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardDraft.reason} onChange={(event) => setBoardDraft((prev) => ({ ...prev, reason: event.target.value }))}>
                    <option value="Planned">Planned</option>
                    <option value="Forecast">Forecast adjustment</option>
                    <option value="Urgent">Urgent fix</option>
                  </select>
                </label>
              </div>
              {!boardEditor.subRecipeId && (
                <label className="text-xs font-semibold text-slate-600">
                  Split spec (optional, e.g. Fr:1200|Sa:900|So:700)
                  <input
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                    placeholder="Fr:1200|Sa:900|So:700"
                    value={boardDraft.splitSpec}
                    onChange={(event) => setBoardDraft((prev) => ({ ...prev, splitSpec: event.target.value.trim() }))}
                  />
                </label>
              )}
              <label className="text-xs font-semibold text-slate-600">
                Notes
                <textarea className="mt-1 h-20 w-full resize-none rounded border border-slate-300 px-2 py-2 text-sm" placeholder="Add notes about this work order" value={boardDraft.notes} onChange={(event) => setBoardDraft((prev) => ({ ...prev, notes: event.target.value }))} />
              </label>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
              <button className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-semibold text-rose-700" onClick={clearWeekBoardEditorAssignment}>Remove assignment</button>
              <div className="flex gap-2">
                <button className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700" onClick={() => setBoardEditor(null)}>Cancel</button>
                <button className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white" onClick={saveWeekBoardEditor}>Save & Lock</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subRecipeInfoRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4" onClick={() => setSubRecipeInfoRequest(null)}>
          <div className="w-full max-w-4xl rounded-xl bg-white shadow-2xl ring-1 ring-slate-300" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between rounded-t-xl bg-amber-600 px-4 py-2 text-white">
              <div className="text-sm font-semibold">Subrezept-Info · {subRecipeInfoRequest.subRecipeName}</div>
              <button className="text-lg leading-none" onClick={() => setSubRecipeInfoRequest(null)}>×</button>
            </div>
            <div className="space-y-3 px-4 py-3">
              {/* ── Meta-Info ──────────────────────────────────────────────── */}
              <div className="grid gap-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-700 md:grid-cols-4">
                <div><span className="font-semibold">Rezept:</span> {subRecipeInfoRequest.recipeCode}</div>
                <div><span className="font-semibold">Tag/Schicht:</span> {subRecipeInfoRequest.day} / {subRecipeInfoRequest.shift}</div>
                <div><span className="font-semibold">Menge:</span> {fmtNum(subRecipeInfoRequest.targetPortions)} Portionen</div>
                <div><span className="font-semibold">Yield:</span> {subRecipeInfo ? `${fmtNum(subRecipeInfo.yieldRatio * 100, 1)}%` : "-"}</div>
              </div>

              {/* ── Equipment & Kapazität ──────────────────────────────────── */}
              {subRecipeInfo && (
                <div className="grid gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-900 md:grid-cols-4">
                  <div>
                    <span className="font-semibold">Equipment:</span>{" "}
                    {subRecipeInfo.equipment ?? <span className="italic text-orange-400">unbekannt</span>}
                  </div>
                  <div>
                    <span className="font-semibold">Kapazität/Batch:</span>{" "}
                    {subRecipeInfo.capacityKg != null
                      ? `${fmtNum(subRecipeInfo.capacityKg, 1)} kg`
                      : <span className="italic text-orange-400">unbekannt</span>}
                    <span className="ml-1 text-[10px] font-normal text-orange-500">
                      ({subRecipeInfo.capacitySource === "bible" ? "Bible" : subRecipeInfo.capacitySource === "process-spec" ? "PFEI" : "–"})
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold">Rohware gesamt:</span>{" "}
                    {fmtNum(subRecipeInfo.totalRawKg, 2)} kg
                  </div>
                  <div>
                    <span className="font-semibold">Batches:</span>{" "}
                    {subRecipeInfo.batchCount != null
                      ? <span className="font-bold text-orange-800">{subRecipeInfo.batchCount}</span>
                      : <span className="italic text-orange-400">–</span>}
                  </div>
                </div>
              )}

              {/* ── Lead-Zeit-Erklärung ─────────────────────────────────────── */}
              {(() => {
                const ld = subRecipeInfoRequest.leadDays;
                const mDay = subRecipeInfoRequest.mainDay;
                const cat = subRecipeInfoRequest.category;
                if (!ld && !mDay) return null;

                const ruleExplanation =
                  ld >= 3 ? "Kategorie erfordert ≥ 3 Tage Vorlauf (Brine / Cure / Ferment / Lagerzeit ≥ 24 h)" :
                  ld === 2 ? "Kategorie erfordert 2 Tage Vorlauf (Sauce / Marinade / Slow Cook / Lagerzeit ≥ 12 h)" :
                  "Kategorie erfordert 1 Tag Vorlauf (Grill / Blast Chiller / Portion / Standardprozess)";

                return (
                  <div className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                    <span className="mt-0.5 shrink-0 rounded-full bg-sky-600 px-2 py-0.5 text-[11px] font-bold text-white">D-{ld}</span>
                    <div className="space-y-1">
                      <div className="font-semibold">Warum liegt dieses Sub hier?</div>
                      <div>{ruleExplanation}</div>
                      {cat && <div className="text-sky-700">Kategorie: <span className="font-semibold">{cat}</span></div>}
                      {mDay && (
                        <div>
                          Bedarfstag (Fulfillment-Start): <span className="font-semibold">{mDay}</span>
                          {" → "} Sub fertig bis: <span className="font-semibold">{subRecipeInfoRequest.day}</span>
                          {" "}({ld} Küchentag{ld !== 1 ? "e" : ""} früher)
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ── Zutaten-Tabelle ─────────────────────────────────────────── */}
              {subRecipeInfo && subRecipeInfo.ingredientRows.length > 0 ? (
                <>
                  <div className="overflow-x-auto rounded border border-slate-200">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-semibold">Artikel</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Menge (roh)</th>
                          <th className="px-2 py-1.5 text-right font-semibold">kg (roh)</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Yield</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Fertigware</th>
                          <th className="px-2 py-1.5 text-right font-semibold">kg/Batch</th>
                          <th className="px-2 py-1.5 text-left font-semibold">Container</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Anz.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subRecipeInfo.ingredientRows.map((row) => (
                          <tr key={`${row.ingredientId}-${row.uom}`} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-2 py-1.5 text-slate-800">{row.ingredientName}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                              {fmtNum(row.rawTotal, 1)} {row.uom}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                              {row.rawKg != null ? `${fmtNum(row.rawKg, 2)} kg` : "–"}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                              {fmtNum(row.yieldRatio * 100, 1)}%
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                              {fmtNum(row.finishedTotal, 1)} {row.uom}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-sky-700 font-semibold">
                              {row.proBatchKg != null ? `${fmtNum(row.proBatchKg, 2)} kg` : "–"}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">{row.containerType}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-900">
                              {row.containerCount > 0 ? fmtNum(row.containerCount) : "–"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 border-slate-200 bg-amber-50 text-xs font-semibold text-amber-900">
                        <tr>
                          <td className="px-2 py-1.5">Gesamt</td>
                          <td className="px-2 py-1.5" />
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(subRecipeInfo.totalRawKg, 2)} kg</td>
                          <td className="px-2 py-1.5" />
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(subRecipeInfo.totalFinishedKg, 2)} kg</td>
                          <td className="px-2 py-1.5" />
                          <td className="px-2 py-1.5">
                            {subRecipeInfo.batchCount != null && (
                              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px]">
                                {subRecipeInfo.batchCount} Wanne{subRecipeInfo.batchCount !== 1 ? "n" : ""}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{subRecipeInfo.totalContainerCount > 0 ? `${fmtNum(subRecipeInfo.totalContainerCount)} Tray${subRecipeInfo.totalContainerCount !== 1 ? "s" : ""}` : "–"}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              ) : (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Für dieses Subrezept wurden keine passenden Artikel im Gross-Ingredients-Dump gefunden.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{tl(locale, "Wochenplaner")} · {week}</h2>
            <p className="mt-1 text-sm text-slate-500">
              Lokaler Szenario-Planer im Browser. Keine Firestore-Schreibvorgänge, keine Live-Risiken.
              {upliftPercent !== 0 ? ` Aktiver Planfaktor: ${upliftPercent > 0 ? "+" : ""}${upliftPercent}%.` : ""}
            </p>
          </div>
          <div className="rounded-full bg-verden-50 px-3 py-1 text-xs font-semibold text-verden-700 ring-1 ring-verden-200">
            {tl(locale, "Planungsmodus")}: {shiftPresetLabel(locale, activePreset.id)}
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">

          {/* ── Linke Spalte: Schichtmodell ───────────────────────────── */}
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Schichtmodell")}</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {SHIFT_MODEL_PRESETS.map(preset => {
                  const selected = preset.id === activePreset.id;
                  return (
                    <button
                      key={preset.id}
                      className={`rounded-xl px-3 py-2.5 text-left ring-1 transition-colors ${selected ? preset.tone : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
                      onClick={() => applyShiftPreset(preset.id)}
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="text-sm font-semibold leading-tight">{shiftPresetLabel(locale, preset.id)}</span>
                        <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${selected ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>
                          {selected ? (locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active") : (locale === "de" ? "1 Klick" : locale === "nl" ? "1 klik" : "1 click")}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-snug opacity-75">{shiftPresetNote(locale, preset.id)}</div>
                      <div className="mt-1.5 text-[10px] opacity-60 leading-tight">{locale === "de" ? "Bereiche" : locale === "nl" ? "Gebieden" : "Areas"}: {preset.areas.join(" · ")}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                {locale === "de" ? "Aktiv im Planner" : locale === "nl" ? "Actief in planner" : "Active in planner"}: <span className="font-medium">{activeShiftSummary}</span> · {locale === "de" ? "Fulfilment kann im 3-Schicht-Modell auf 3 Assembly Lines laufen." : locale === "nl" ? "Fulfilment kan in het 3-ploegenmodel op 3 assembly lines draaien." : "Fulfilment can run on 3 assembly lines in the 3-shift model."}
              </div>
            </div>

            {/* Bereich-Schichten-Tabelle */}
            <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Bereich" : locale === "nl" ? "Gebied" : "Area"}</th>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Schichten" : locale === "nl" ? "Ploegen" : "Shifts"}</th>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Excel-Gruppen" : locale === "nl" ? "Excel-groepen" : "Excel groups"}</th>
                  </tr>
                </thead>
                <tbody>
                  {areaRows.map(area => (
                    <tr key={area.key} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-medium text-slate-700 whitespace-nowrap">{area.key}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className={`inline-flex rounded-full px-2 py-0.5 font-semibold ${area.shiftCount > 0 ? "bg-verden-50 text-verden-700 ring-1 ring-verden-200" : "bg-slate-100 text-slate-500"}`}>
                          {area.shiftCount > 0 ? shiftCountLabel(area.shiftCount) : tl(locale, "aus")}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-slate-500">{area.sheets.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Rechte Spalte: Kapazität / Automatik / Szenarien ─────── */}
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Kapazitätsprüfungen")}</div>
              <div className="space-y-2">
                <ToggleChip
                  label={tl(locale, "Stationskonflikte")}
                  enabled={uiSettings.showStationConflicts}
                  locale={locale}
                  onClick={() => setUiSettings(prev => ({ ...prev, showStationConflicts: !prev.showStationConflicts }))}
                />
                <ToggleChip
                  label={tl(locale, "Poolkonflikte")}
                  enabled={uiSettings.showPoolConflicts}
                  locale={locale}
                  onClick={() => setUiSettings(prev => ({ ...prev, showPoolConflicts: !prev.showPoolConflicts }))}
                />
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Automatik")}</div>
              <ToggleChip
                label={tl(locale, "Auto-Vorschläge")}
                enabled={uiSettings.showAutoSuggestions}
                locale={locale}
                onClick={() => setUiSettings(prev => ({ ...prev, showAutoSuggestions: !prev.showAutoSuggestions }))}
              />
              <div className="mt-2 text-[11px] text-slate-500">
                {locale === "de" ? "Offene Rezepte bekommen nur dann Slot-Empfehlungen, wenn diese Automatik aktiv ist." : locale === "nl" ? "Open recepten krijgen alleen slotvoorstellen als deze automatiek actief is." : "Open recipes only receive slot suggestions when this automation is enabled."}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Szenarioverwaltung")}</div>
              <div className="space-y-2">
                <select
                  className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                  value={scenario.id}
                  onChange={e => setStorage(prev => setActiveScenario(prev, week, e.target.value))}
                >
                  {weekState.scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                  value={newScenarioName}
                  placeholder={locale === "de" ? "Neues Szenario..." : locale === "nl" ? "Nieuw scenario..." : "New scenario..."}
                  onChange={e => setNewScenarioName(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className="btn flex-1" onClick={handleCreateScenario}>{tl(locale, "Klonen")}</button>
                  <button className="btn flex-1" onClick={() => setStorage(prev => resetScenario(prev, week, scenario.id))}>{tl(locale, "Leeren")}</button>
                </div>
              </div>
            </div>
          </div>

        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <PlannerStat label={tl(locale, "Geplant")} value={fmtNum(analysis.plannedCount)} accent />
          <PlannerStat label={tl(locale, "Offen")} value={fmtNum(analysis.unplannedCount)} />
          <PlannerStat label={tl(locale, "Konflikte")} value={fmtNum(visibleConflictCount)} accent={visibleConflictCount > 0} />
          <PlannerStat label={tl(locale, "Szenario")} value={scenario.name} />
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <PlannerStat label={tl(locale, "Schichten aktiv")} value={fmtNum(activeShifts.length)} />
          <PlannerStat label={tl(locale, "Slots/Woche")} value={fmtNum(MANUFACTURING_DAYS.length * activeShifts.length)} />
          <PlannerStat label={tl(locale, "Vorschläge")} value={fmtNum(suggestionCount)} accent={uiSettings.showAutoSuggestions && suggestionCount > 0} />
          <PlannerStat label={tl(locale, "Modell")} value={shiftPresetShortLabel(locale, activePreset.id)} />
        </div>
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">{tl(locale, "Shelf-Life-Risiko der Woche")}</span>
            <span className="pill bg-slate-200 text-slate-700">{locale === "de" ? "Kundenziel: 7 Tage Rest" : locale === "nl" ? "Klantdoel: 7 dagen restant" : "Customer target: 7 days remaining"}</span>
            <span className="pill bg-slate-200 text-slate-700">{locale === "de" ? "Sheet-Matches" : locale === "nl" ? "Sheet-matches" : "Sheet matches"}: {fmtNum(shelfRisk.total)}</span>
            <span className={`pill ${shelfTone(shelfRisk.critical.length > 0 ? "critical" : shelfRisk.risk.length > 0 ? "risk" : "ok")}`}>
              {tl(locale, "kritisch")} {fmtNum(shelfRisk.critical.length)} · {locale === "de" ? "knapp" : locale === "nl" ? "krap" : "tight"} {fmtNum(shelfRisk.risk.length)}
            </span>
          </div>
          {(shelfRisk.critical.length > 0 || shelfRisk.risk.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {shelfRisk.critical.slice(0, 6).map(item => (
                <span key={`critical-${item.skuCode}`} className={`pill ${shelfTone(item.status)}`}>
                  {item.skuCode} · MLOR {item.mlorRaw ?? "-"} · Open {item.openShelfLifeRaw ?? "-"}
                </span>
              ))}
              {shelfRisk.risk.slice(0, Math.max(0, 6 - shelfRisk.critical.length)).map(item => (
                <span key={`risk-${item.skuCode}`} className={`pill ${shelfTone(item.status)}`}>
                  {item.skuCode} · MLOR {item.mlorRaw ?? "-"} · Open {item.openShelfLifeRaw ?? "-"}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-semibold text-slate-700">{tl(locale, "Wochenrhythmus Montag bis Sonntag")}</h3>
          <span className="text-xs text-slate-500">{shiftPresetShortLabel(locale, activePreset.id)} {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"} · {activeShiftSummary}</span>
        </div>
        <div className="text-[11px] text-slate-500 mb-2">
          {locale === "de"
            ? "Backward-Plan: Plating Fr (DK/SE + BENL + DE Split 1) und So (DE Split 2). Subrezepte werden rueckwaerts ueber Lead-Zeit eingeplant. MHD: Fisch 9 Tage, sonst 13 Tage."
            : locale === "nl"
              ? "Backward-plan: plating Vr (DK/SE + BENL + DE Split 1) en Zo (DE Split 2). Sub-recepten via lead time rugwaarts. THT: vis 9 d, anders 13 d."
              : "Backward plan: plating Fri (DK/SE + BENL + DE Split 1) and Sun (DE Split 2). Sub-recipes scheduled backwards by lead time. Shelf life: fish 9d, else 13d."}
        </div>
        <div className="grid md:grid-cols-7 gap-2 text-sm">
          <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-amber-700">Mo · S1</div>
            <div className="mt-1 font-semibold">Inbound KW-1</div>
            <div className="mt-1 text-[11px] text-slate-700">Rohwarenannahme &amp; Quality-Gate fuer die laufende KW.</div>
            <div className="mt-1 text-[11px] text-slate-600">Lange Vorlaeufe: Brining, Curing, Marinade ueber Nacht.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Di · S1</div>
            <div className="mt-1 font-semibold">Subrezepte L3</div>
            <div className="mt-1 text-[11px] text-slate-600">Saucen, Bruehen, Slow-Cook, Butter-Family. Liquide in Schalen vorbereiten.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Mi · S1</div>
            <div className="mt-1 font-semibold">Subrezepte L2</div>
            <div className="mt-1 text-[11px] text-slate-600">Blast-Chiller, chilled Hold, Portionierung mit Vorlauf.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Do · S1</div>
            <div className="mt-1 font-semibold">Wochenstart Plating-Prep</div>
            <div className="mt-1 text-[11px] text-slate-600">Vortags-Prep fuer Fr (Cutting, chilled Prep, Hot-Cook-Setup).</div>
          </div>
          <div className="rounded-xl bg-verden-50 ring-1 ring-verden-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-verden-700">Fr · S1</div>
            <div className="mt-1 font-semibold">Plating + Fulfillment 1</div>
            <div className="mt-1 text-xs text-slate-700">DK/SE komplett: <b>{fmtNum(split.dkse)}</b></div>
            <div className="text-xs text-slate-700">BENL komplett: <b>{fmtNum(split.benlFriday)}</b></div>
            <div className="text-xs text-slate-700">DE Split 1: <b>{fmtNum(split.deFriday)}</b></div>
          </div>
          <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3 relative">
            <div className="text-[10px] uppercase tracking-wide text-rose-600">Sa</div>
            <div className="mt-1 font-semibold text-rose-700">Kueche nicht besetzt</div>
            <div className="mt-1 text-[11px] text-rose-700/80">Keine Produktion. Vorprod fuer So muss spaetestens Fr abgeschlossen sein.</div>
            <span className="absolute top-2 right-2 pill bg-rose-100 text-rose-700">geschlossen</span>
          </div>
          <div className="rounded-xl bg-blue-50 ring-1 ring-blue-200 p-3 relative">
            <div className="text-[10px] uppercase tracking-wide text-blue-700">So</div>
            <div className="mt-1 font-semibold">Fulfillment 2 (nur Versand)</div>
            <div className="mt-1 text-xs text-slate-700">DE Split 2: <b>{fmtNum(split.deSunday)}</b></div>
            <div className="mt-1 text-[11px] text-slate-600">Kueche zu — Plating-Ware kommt aus Fr-Vorprod (gekuehlt gehalten).</div>
            <span className="absolute top-2 right-2 pill bg-rose-100 text-rose-700">Kueche zu</span>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Batch-Split nach MHD &amp; Fulfillment-Tag</h3>
          <span className="text-[11px] text-slate-500">Kunde: 7 Tage Rest · Fisch MHD 9d, sonst 13d</span>
        </div>
        <div className="text-[11px] text-slate-500 mb-3">
          Sa &amp; So ist die Kueche in Verden nicht besetzt — produziert wird ausschliesslich Mo–Fr.
          Wenn DE am Sonntag gefulfillt wird, muss dieselbe SKU oft auf zwei Produktionstage gesplittet
          werden, damit beim Kunden noch 7 Tage Rest-MHD ankommen. Die Empfehlung unten zeigt pro Rezept
          die zwei Chargen mit Fenster und empfohlenem Produktionstag (immer Mo–Fr).
        </div>
        {batchSplitPlan.length === 0 ? (
          <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-xs text-slate-500">
            Keine Rezepte mit Volumen in dieser KW.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-1.5 pr-2">Rezept</th>
                  <th className="text-left py-1.5 pr-2">MHD</th>
                  <th className="text-left py-1.5 pr-2">Charge</th>
                  <th className="text-right py-1.5 pr-2">Portionen</th>
                  <th className="text-left py-1.5 pr-2">Fenster</th>
                  <th className="text-left py-1.5 pr-2">Empfohlen</th>
                  <th className="text-left py-1.5 pr-2">Begruendung</th>
                </tr>
              </thead>
              <tbody>
                {batchSplitPlan.slice(0, 30).map(plan => {
                  const tone = weekBoardRecipeTone(plan.recipeCode);
                  return plan.batches.map((batch, idx) => (
                  <tr
                    key={`${plan.recipeCode}-${batch.fulfillmentDay}`}
                    className="border-b border-slate-100"
                    style={plan.batches.length > 1 ? tone.subRow : tone.row}
                  >
                    {idx === 0 ? (
                      <td className="py-1.5 pr-2 align-top" rowSpan={plan.batches.length}>
                        <div className="inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold" style={tone.badge}>{plan.recipeCode}</div>
                        <div className="mt-1 text-[11px]" style={tone.title}>{plan.recipeName}</div>
                        {plan.batches.length > 1 && (
                          <span className="pill bg-amber-100 text-amber-800 mt-1">Split-Pflicht</span>
                        )}
                      </td>
                    ) : null}
                    {idx === 0 ? (
                      <td className="py-1.5 pr-2 align-top" rowSpan={plan.batches.length}>
                        <span className={`pill ${plan.isSeafood ? "bg-cyan-100 text-cyan-800" : "bg-slate-100 text-slate-700"}`}>
                          {plan.isSeafood ? "Fisch · 9d" : "Standard · 13d"}
                        </span>
                      </td>
                    ) : null}
                    <td className="py-1.5 pr-2">
                      <div className="font-semibold" style={tone.code}>{batch.fulfillmentDay}</div>
                      <div className="text-[10px] text-slate-500">{batch.fulfillmentLabel}</div>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(batch.portions)}</td>
                    <td className="py-1.5 pr-2">{batch.earliestProductionDay}–{batch.latestProductionDay}</td>
                    <td className="py-1.5 pr-2">
                      <span className="pill" style={tone.subPill}>{batch.recommendedProductionDay}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-[11px] text-slate-600">{batch.reason}</td>
                  </tr>
                ));})}
              </tbody>
            </table>
            {batchSplitPlan.length > 30 && (
              <div className="mt-2 text-[11px] text-slate-500">
                … {batchSplitPlan.length - 30} weitere Rezepte ohne Splitanforderung ausgeblendet.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{tl(locale, "Konflikte & Engpässe")}</h3>
        <div className="space-y-2">
          {visibleStationConflicts.length === 0 && visiblePoolConflicts.length === 0 && (
            <div className="rounded-lg bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 px-3 py-2 text-sm">
              {locale === "de" ? "Aktuell keine Konflikte im aktiven Szenario." : locale === "nl" ? "Momenteel geen conflicten in het actieve scenario." : "Currently no conflicts in the active scenario."}
            </div>
          )}
          {visibleStationConflicts.slice(0, 8).map(conflict => (
            <div key={`${conflict.day}-${conflict.shift}-${conflict.station}`} className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-amber-900">
                  {conflict.day} · {conflict.shift} · {conflict.station}
                </div>
                <div className="text-xs font-medium text-amber-800">{topConflictLabel(conflict)}</div>
              </div>
              <div className="mt-1 text-[11px] text-amber-800">
                Geräte: {fmtNum(conflict.deviceCount)} · Kapazität: {fmtMin(conflict.capacityMin)} · Auslastung: {fmtNum(conflict.utilizationPct, 0)}%
              </div>
              <div className="mt-1 space-y-1 text-xs text-amber-900">
                {conflict.assignments.map((row, index) => {
                  const tone = weekBoardRecipeTone(row.recipeCode);
                  return (
                  <div key={`${row.recipeCode}-${index}`} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="mr-1 inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={tone.badge}>{row.recipeCode}</span>
                      <span>{row.recipeName}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                );})}
              </div>
            </div>
          ))}
          {visiblePoolConflicts.slice(0, 6).map(conflict => (
            <div key={`${conflict.day}-${conflict.shift}-${conflict.poolName}`} className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-rose-900">
                  {conflict.day} · {conflict.shift} · Pool {conflict.poolName}
                </div>
                <div className="text-xs font-medium text-rose-800">{topPoolConflictLabel(conflict)}</div>
              </div>
              <div className="mt-1 text-[11px] text-rose-800">
                Geräte im Pool: {fmtNum(conflict.deviceCount)} · Kapazität: {fmtMin(conflict.capacityMin)} · Auslastung: {fmtNum(conflict.utilizationPct, 0)}%
              </div>
              <div className="mt-1 space-y-1 text-xs text-rose-900">
                {conflict.assignments.slice(0, 6).map((row, index) => (
                  <div key={`${row.recipeCode}-${row.station}-${index}`} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="mr-1 inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={weekBoardRecipeTone(row.recipeCode).badge}>{row.recipeCode}</span>
                      {row.station} · {row.recipeName}
                    </span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-700">{tl(locale, "Rezept-Zuordnung")}</h3>
          <span className="text-xs text-slate-500">{locale === "de" ? "Direkt in Tag/Schicht legen oder wieder entfernen" : locale === "nl" ? "Direct in dag/ploeg zetten of weer verwijderen" : "Assign directly to day/shift or remove again"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">{tl(locale, "Code")}</th>
                <th className="text-left py-1.5 pr-2">{tl(locale, "Rezept")}</th>
                <th className="text-right py-1.5 pr-2">Σ {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"}</th>
                <th className="text-left py-1.5 pr-2">{tl(locale, "Top-Stationen")}</th>
                {uiSettings.showAutoSuggestions && <th className="text-left py-1.5 pr-2">{tl(locale, "Vorschlag")}</th>}
                <th className="text-left py-1.5">{tl(locale, "Plan-Slot")}</th>
              </tr>
            </thead>
            <tbody>
              {analysis.recipes.map(recipe => {
                const current = recipe.assigned ? slotValue(recipe.assigned.day, recipe.assigned.shift) : "";
                const tone = weekBoardRecipeTone(recipe.recipeCode);
                return (
                  <tr key={recipe.recipeCode} className="border-b last:border-0" style={selectedRecipe === recipe.recipeCode ? tone.row : tone.subRow}>
                    <td className="py-1.5 pr-2">
                      <span className="inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={tone.badge}>{recipe.recipeCode}</span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <button className="text-left hover:text-verden-700" style={tone.title} onClick={() => onSelectRecipe?.(recipe.recipeCode)}>
                        {recipe.recipeName}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">{fmtMin(recipe.activeMin)}</td>
                    <td className="py-1.5 pr-2 text-xs text-slate-600">
                      {recipe.topStations.map(s => `${s.station} ${fmtMin(s.minutes)}`).join(" · ") || "—"}
                    </td>
                    {uiSettings.showAutoSuggestions && (
                      <td className="py-1.5 pr-2 text-xs text-slate-600">
                        {suggestions[recipe.recipeCode] ? (
                          <div className="space-y-1">
                            <button className="btn" style={tone.subPill} onClick={() => applySuggestion(recipe.recipeCode)}>
                              {suggestions[recipe.recipeCode].day} · {suggestions[recipe.recipeCode].shift}
                            </button>
                            <div className="text-[10px] text-slate-500">{suggestions[recipe.recipeCode].reason}</div>
                          </div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                    )}
                    <td className="py-1.5">
                      <select
                        className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-sm"
                        value={current}
                        onChange={e => updateAssignment(recipe.recipeCode, e.target.value)}
                      >
                        <option value="">{tl(locale, "nicht geplant")}</option>
                        {MANUFACTURING_DAYS.filter((column) => column.lane === "regular").map(column => activeShifts.map(shift => {
                          const value = slotValue(column.day, shift);
                          return <option key={value} value={value}>{column.label} · {shift}</option>;
                        }))}
                      </select>
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

function PlannerStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function ToggleChip({ label, enabled, onClick, locale }: { label: string; enabled: boolean; onClick: () => void; locale: UiLocale }) {
  return (
    <button
      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm ring-1 ${enabled ? "bg-verden-50 text-verden-800 ring-verden-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-100"}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${enabled ? "bg-verden-600 text-white" : "bg-slate-200 text-slate-600"}`}>
        {enabled ? tl(locale, "an") : tl(locale, "aus")}
      </span>
    </button>
  );
}

type WeekBoardEditorState = {
  recipeCode: string;
  day: PlannerDay;
  shift: PlannerShift;
  subRecipeId?: string;
  subRecipeName?: string;
};

type WeekBoardEditorDraft = {
  shift: PlannerShift;
  targetPortions: number;
  reason: string;
  splitSpec: string;
  notes: string;
};

type SubRecipeInfoRequest = {
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  day: PlannerDay;
  shift: PlannerShift;
  targetPortions: number;
  /** Lead-Zeit in Küchentagen vor dem Bedarfstag (Fulfillment-Start) */
  leadDays: number;
  /** Tag des Haupt-Rezepts (= Plating / Need-Day), damit klar ist warum der Sub hier liegt */
  mainDay?: PlannerDay;
  category: string;
};

type SubRecipeInfoIngredientRow = {
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

type SubRecipeInfoView = {
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

// ── Bible/Master-Hint-Typen für Sub-Rezept-Info-Modal ─────────────────────────
type InfoCapacityHint = {
  key: string;
  capacityKg: number;
  equipment: string | null;
};

type InfoTrayHint = {
  key: string;
  pcsPerTray: number;
};

type InfoHints = {
  capacityHints: Map<string, InfoCapacityHint>;
  pieceWeightKg: Map<string, number>;
  trayHints: InfoTrayHint[];
};

function parseBoardNote(note?: string): { reason: string; notes: string } {
  const raw = String(note ?? "").trim();
  if (!raw) return { reason: "Planned", notes: "" };
  const [reasonPart, ...rest] = raw.split("||");
  const reason = reasonPart.startsWith("reason=") ? reasonPart.slice(7).trim() : "Planned";
  const notesPart = rest.find((part) => part.startsWith("notes=")) ?? "";
  const notes = notesPart ? notesPart.slice(6).trim() : "";
  return { reason: reason || "Planned", notes };
}

function buildBoardNote(reason: string, notes: string): string | undefined {
  const cleanReason = reason.trim();
  const cleanNotes = notes.trim();
  if (!cleanReason && !cleanNotes) return undefined;
  return `reason=${cleanReason || "Planned"}||notes=${cleanNotes}`;
}

function extractSplitSpecFromNotes(notes: string): string {
  const raw = String(notes ?? "").trim();
  if (!raw) return "";
  const match = /(?:^|\s)split=([^\s]+)/i.exec(raw);
  return match?.[1]?.trim() ?? "";
}

function stripSplitSpecFromNotes(notes: string): string {
  return String(notes ?? "")
    .replace(/(?:^|\s)split=[^\s]+/ig, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function composeBoardNotes(rawNotes: string, splitSpec: string): string {
  const notes = stripSplitSpecFromNotes(rawNotes);
  const split = splitSpec.trim();
  if (notes && split) return `${notes} split=${split}`;
  if (split) return `split=${split}`;
  return notes;
}

function parseSplitSpecToBatches(splitSpec: string, fallbackDay: PlannerDay, totalTarget: number): AutoFulfillmentBatch[] {
  const tokens = splitSpec
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) return totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];

  const parsed: AutoFulfillmentBatch[] = [];
  for (const token of tokens) {
    const [rawDay, rawPortions] = token.split(":");
    if (!rawDay || !rawPortions) continue;
    const day = rawDay.trim() as PlannerDay;
    if (!(PLANNER_DAYS as readonly string[]).includes(day)) continue;
    const portions = Math.max(0, Math.round(Number(rawPortions) || 0));
    if (portions <= 0) continue;
    parsed.push({ day, portions });
  }
  if (parsed.length === 0) return totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];
  return normalizeBatches(parsed, totalTarget > 0 ? totalTarget : parsed.reduce((s, row) => s + row.portions, 0));
}
