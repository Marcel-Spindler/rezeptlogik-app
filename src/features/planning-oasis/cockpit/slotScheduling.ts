// Slot-/Tages-Zuteilung für den Cockpit-Planer: welcher Tag/Schicht bekommt ein
// Rezept oder einen Sub-Rezept-Batch, Auto-Fulfillment-Splits (MHD-Smart / fixe
// Gewichtung), und die Kodierung von Split-Angaben in den Board-Notizen.
import type { ProcessSpec } from "../../../core/types";
import { fmtMin } from "../../../lib/equipment";
import {
  PLANNER_DAYS, PLANNER_SHIFTS,
  type PlannerDay, type PlannerShift, type PlannerPoolConflict, type PlannerStationConflict,
} from "../../../lib/planner";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

// ─── Fulfillment-Batch-Typen & Profile ──────────────────────────────────────

export type AutoFulfillmentBatch = { day: PlannerDay; portions: number };

export type AutoFulfillmentProfile = {
  id: string;
  label: string;
  mode: "mhd-smart" | "fixed";
  fallbackWeights?: Partial<Record<PlannerDay, number>>;
};

export const AUTO_FULFILLMENT_PROFILES: readonly AutoFulfillmentProfile[] = [
  { id: "auto", label: "Auto (niedrigste Last)", mode: "fixed", fallbackWeights: { Fr: 1 } },
] as const;

// ─── Manufacturing-Kalender-Spalten (Cockpit-eigener Kalender) ──────────────

export type ManufacturingDayColumn = { id: string; day: PlannerDay; label: string; lane: "prep" | "regular" };

export type ManufacturingDaySummary = {
  column: ManufacturingDayColumn;
  mainCount: number;
  subRunCount: number;
  mainPortions: number;
  subPortions: number;
  items: string[];
};

export const MANUFACTURING_DAYS: readonly ManufacturingDayColumn[] = [
  { id: "mo", day: "Mo", label: "Mo", lane: "regular" },
  { id: "di", day: "Di", label: "Di", lane: "regular" },
  { id: "mi", day: "Mi", label: "Mi", lane: "regular" },
  { id: "do", day: "Do", label: "Do", lane: "regular" },
  { id: "fr", day: "Fr", label: "Fr", lane: "regular" },
  { id: "sa", day: "Sa", label: "Sa", lane: "regular" },
  { id: "so", day: "So", label: "So", lane: "regular" },
];

// ─── Slot-Wahl (niedrigste Auslastung zuerst) ───────────────────────────────

export function slotValue(day: PlannerDay, shift: PlannerShift): string {
  return `${day}__${shift}`;
}

export function parseSlot(value: string): { day: PlannerDay; shift: PlannerShift } | null {
  const [day, shift] = value.split("__");
  if (!day || !shift) return null;
  if (!(PLANNER_DAYS as readonly string[]).includes(day)) return null;
  if (!(PLANNER_SHIFTS as readonly string[]).includes(shift)) return null;
  return { day: day as PlannerDay, shift: shift as PlannerShift };
}

export function plannerDayIndex(day: PlannerDay): number {
  return PLANNER_DAYS.indexOf(day);
}

const KITCHEN_DAYS = ["Mo", "Di", "Mi", "Do", "Fr"] as const;
export const REGULAR_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do"];

export function pickLowestLoadSlot(slotLoads: Map<string, number>, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const day of KITCHEN_DAYS) {
    for (const shift of activeShifts) {
      const key = slotValue(day, shift);
      const load = slotLoads.get(key) ?? 0;
      if (!best || load < best.load) best = { day, shift, load };
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

export function pickLowestLoadSlotWithFallback(slotLoads: Map<string, number>, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  return pickLowestLoadSlot(slotLoads, activeShifts) ?? pickLowestLoadSlot(slotLoads, PLANNER_SHIFTS);
}

export function pickLowestRegularSubSlot(slotLoads: Map<string, number>, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const day of REGULAR_SUB_DAYS) {
    for (const shift of activeShifts) {
      const key = slotValue(day, shift);
      const load = slotLoads.get(key) ?? 0;
      if (!best || load < best.load) best = { day, shift, load };
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

export function pickLowestRegularSubSlotWithFallback(slotLoads: Map<string, number>, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  return pickLowestRegularSubSlot(slotLoads, activeShifts) ?? pickLowestRegularSubSlot(slotLoads, PLANNER_SHIFTS);
}

export function pickLowestLoadSlotForDay(slotLoads: Map<string, number>, day: PlannerDay, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const shift of activeShifts) {
    const key = slotValue(day, shift);
    const load = slotLoads.get(key) ?? 0;
    if (!best || load < best.load) best = { day, shift, load };
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

export function pickLowestLoadSlotForDayWithFallback(slotLoads: Map<string, number>, day: PlannerDay, activeShifts: readonly PlannerShift[]): { day: PlannerDay; shift: PlannerShift } | null {
  return pickLowestLoadSlotForDay(slotLoads, day, activeShifts) ?? pickLowestLoadSlotForDay(slotLoads, day, PLANNER_SHIFTS);
}

// ─── Konflikt-Beschriftung ───────────────────────────────────────────────────

export function topConflictLabel(conflict: PlannerStationConflict): string {
  const missingDevices = Math.max(0, conflict.requiredDevices - conflict.deviceCount);
  if (conflict.totalMin > conflict.capacityMin) {
    return missingDevices > 0
      ? `+${fmtNum(missingDevices)} Gerät(e) nötig · Überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`
      : `Überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `teilt ${fmtNum(conflict.deviceCount)} Gerät(e) · ${fmtNum(conflict.requiredDevices)} gebraucht`;
}

export function topPoolConflictLabel(conflict: PlannerPoolConflict): string {
  const missingDevices = Math.max(0, conflict.requiredDevices - conflict.deviceCount);
  if (conflict.totalMin > conflict.capacityMin) {
    return missingDevices > 0
      ? `+${fmtNum(missingDevices)} Gerät(e) nötig · Pool überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`
      : `Pool überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `${fmtNum(conflict.requiredDevices)} Geräte im Pool nötig`;
}

export function extraDevicesLabel(deviceCount: number, requiredDevices: number): string {
  const missingDevices = Math.max(0, requiredDevices - deviceCount);
  if (missingDevices <= 0) return "aktuelles Equipment reicht";
  return `es fehlen ${fmtNum(missingDevices)} Gerät(e)`;
}

// ─── Auto-Fulfillment-Batches (MHD-Smart / fixe Gewichtung) ─────────────────

export function normalizeBatches(raw: AutoFulfillmentBatch[], totalTarget: number): AutoFulfillmentBatch[] {
  const cleaned = raw.filter(row => row.portions > 0).sort((a, b) => plannerDayIndex(a.day) - plannerDayIndex(b.day));
  if (cleaned.length === 0 || totalTarget <= 0) return [];
  const sum = cleaned.reduce((acc, row) => acc + row.portions, 0);
  if (sum <= 0) return [];
  const scaled = cleaned.map(row => ({ day: row.day, portions: Math.max(0, Math.round((row.portions / sum) * totalTarget)) }));
  const drift = totalTarget - scaled.reduce((acc, row) => acc + row.portions, 0);
  if (drift !== 0 && scaled[0]) scaled[0].portions += drift;
  return scaled.filter(row => row.portions > 0);
}

export function fixedBatchesFromProfile(totalTarget: number, profile: AutoFulfillmentProfile): AutoFulfillmentBatch[] {
  const weights = profile.fallbackWeights ?? { Fr: 1 };
  const raw = Object.entries(weights)
    .map(([day, weight]) => ({ day: day as PlannerDay, portions: Math.max(0, Number(weight) || 0) }))
    .filter(row => row.portions > 0);
  if (raw.length === 0) return [{ day: "Fr", portions: totalTarget }];
  return normalizeBatches(raw, totalTarget);
}

export function serializeBatchesForNote(batches: AutoFulfillmentBatch[]): string {
  return batches.map(row => `${row.day}:${row.portions}`).join("|");
}

export function resolveAutoBatches(
  _recipeCode: string,
  totalTarget: number,
  profile: AutoFulfillmentProfile,
): AutoFulfillmentBatch[] {
  if (totalTarget <= 0) return [];
  return fixedBatchesFromProfile(totalTarget, profile);
}

// ─── Sub-Rezept-Produktionstag (Lead-Time-Logik) ────────────────────────────

export function kitchenDayBackshift(day: PlannerDay, steps: number): PlannerDay {
  const idx = plannerDayIndex(day);
  const targetIdx = Math.max(0, idx - Math.max(0, steps));
  for (let i = targetIdx; i >= 0; i -= 1) {
    const candidate = PLANNER_DAYS[i];
    if (candidate && (KITCHEN_DAYS as readonly string[]).includes(candidate)) return candidate;
  }
  return "Mo";
}

export function avoidSaturday(day: PlannerDay): PlannerDay {
  return day === "Sa" ? "Fr" : day;
}

export function clampRegularSubDay(day: PlannerDay): PlannerDay {
  if (day === "So" || day === "Fr" || day === "Sa") return "Do";
  return day;
}

export function regularSubProductionDayForNeedDay(needDay: PlannerDay, leadDays: number): PlannerDay {
  return clampRegularSubDay(kitchenDayBackshift(needDay, leadDays));
}

export function distributedRunSubDay(_runIndex: number, subIndex: number): PlannerDay {
  return REGULAR_SUB_DAYS[subIndex % REGULAR_SUB_DAYS.length] ?? "Mo";
}

export function nearestUnusedRegularSubDay(day: PlannerDay, usedDays: Set<PlannerDay>): PlannerDay {
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

export function splitDuplicateSubBatchDays(days: PlannerDay[]): PlannerDay[] {
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

export function runSubBatchesForAssignment(
  _mainAssignment: { day: PlannerDay; targetPortions?: number; note?: string },
  _subAssignment: { targetPortions?: number },
  _fallbackPortions: number,
  _subIndex: number
): Array<{ label: string; portions: number; day: PlannerDay }> {
  return [];
}

export function isSundayLightPrepSub(_category: string, _spec?: ProcessSpec): boolean {
  return false;
}

export function isSundayPrepSub(_category: string, _spec?: ProcessSpec): boolean {
  return false;
}

export function subLeadDaysBeforeNeed(_category: string, _spec?: ProcessSpec): number {
  return 1;
}

export function preferredSubProductionDay(category: string, spec: ProcessSpec | undefined, needDay: PlannerDay, leadDays: number): PlannerDay {
  if (isSundayPrepSub(category, spec)) return "So";
  return regularSubProductionDayForNeedDay(needDay, leadDays);
}

// ─── Board-Notizen: Reason/Notes/Split-Spec-Kodierung ───────────────────────
// Notizfeld-Format: "reason=<Text>||notes=<Text incl. split=Tag:Menge|Tag:Menge>"

export function parseBoardNote(note?: string): { reason: string; notes: string } {
  const raw = String(note ?? "").trim();
  if (!raw) return { reason: "Planned", notes: "" };
  const [reasonPart, ...rest] = raw.split("||");
  const reason = reasonPart.startsWith("reason=") ? reasonPart.slice(7).trim() : "Planned";
  const notesPart = rest.find(part => part.startsWith("notes=")) ?? "";
  const notes = notesPart ? notesPart.slice(6).trim() : "";
  return { reason: reason || "Planned", notes };
}

export function buildBoardNote(reason: string, notes: string): string | undefined {
  const cleanReason = reason.trim();
  const cleanNotes = notes.trim();
  if (!cleanReason && !cleanNotes) return undefined;
  return `reason=${cleanReason || "Planned"}||notes=${cleanNotes}`;
}

export function extractSplitSpecFromNotes(notes: string): string {
  const raw = String(notes ?? "").trim();
  if (!raw) return "";
  const match = /(?:^|\s)split=([^\s]+)/i.exec(raw);
  return match?.[1]?.trim() ?? "";
}

export function stripSplitSpecFromNotes(notes: string): string {
  return String(notes ?? "")
    .replace(/(?:^|\s)split=[^\s]+/ig, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function composeBoardNotes(rawNotes: string, splitSpec: string): string {
  const notes = stripSplitSpecFromNotes(rawNotes);
  const split = splitSpec.trim();
  if (notes && split) return `${notes} split=${split}`;
  if (split) return `split=${split}`;
  return notes;
}

export function parseSplitSpecToBatches(splitSpec: string, fallbackDay: PlannerDay, totalTarget: number): AutoFulfillmentBatch[] {
  const tokens = splitSpec.split("|").map(part => part.trim()).filter(Boolean);
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
