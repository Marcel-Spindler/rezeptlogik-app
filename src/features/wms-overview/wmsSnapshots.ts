// WMS Übersicht – Bilanz-Snapshots (localStorage-Persistenz für Vergleiche)
// + Timeline-Snapshots (Auto-Capture im Live-Mode für historische Rückverfolgung).
import type { SkuBilanzEntry } from "./wmsAggregate";
import type { MealOperation } from "./WmsMealOperations";

// ─── Manual Snapshot System ──────────────────────────────────────────────────

export const SNAPSHOT_KEY = "wms-snapshots-v2";
export const MAX_SNAPSHOTS = 15;

export type WmsSnapshot = {
  id: string;
  week: string;
  timestamp: string;
  label: string;
  bilanz: SkuBilanzEntry[];
};

export function loadSnapshots(): WmsSnapshot[] {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "[]") as WmsSnapshot[]; }
  catch { return []; }
}

export function persistSnapshot(week: string, bilanz: SkuBilanzEntry[]): void {
  const snap: WmsSnapshot = {
    id: String(Date.now()),
    week,
    timestamp: new Date().toISOString(),
    label: `${week} · ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`,
    bilanz,
  };
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify([snap, ...loadSnapshots()].slice(0, MAX_SNAPSHOTS))); }
  catch (_e) { /* localStorage not available or quota exceeded */ }
}

export function removeSnapshot(id: string): void {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(loadSnapshots().filter(s => s.id !== id))); }
  catch (_e) { /* localStorage not available */ }
}

// ─── Timeline Snapshot System (Auto-Capture) ─────────────────────────────────

export const TIMELINE_KEY = "wms-timeline-v1";
export const MAX_TIMELINE_SNAPSHOTS = 96;

export type TimelineSubmealState = {
  sku: string;
  name: string;
  required: number;
  gramsPerPortion: number;
  requiredPortions: number;
  total: number;
  totalPortions: number;
  gap: number;
  gapPortions: number;
  status: "ready" | "partial" | "missing";
  platingHolding: number;
  postBlast: number;
  debox: number;
  staging: number;
  sleeving: number;
};

export type TimelineMealState = {
  mealSku: string;
  mealName: string;
  recipeCode: string;
  required: number;
  finished: number;
  readinessPct: number;
  submeals: TimelineSubmealState[];
};

export type TimelineSnapshot = {
  id: string;
  timestamp: string;
  week: string;
  meals: TimelineMealState[];
  hash: string;
};

export function extractRecipeCode(desc: string): string {
  const m = String(desc ?? "").match(/\b(F[VE]\d{3,4}[A-Z]?)\b/);
  return m ? m[1] : "";
}

export function buildTimelineMealStates(mealOps: MealOperation[]): TimelineMealState[] {
  return mealOps.map(m => ({
    mealSku: m.sku,
    mealName: m.name,
    recipeCode: extractRecipeCode(m.name),
    required: m.required,
    finished: m.finished,
    readinessPct: m.readinessPct,
    submeals: m.submeals.map(s => ({
      sku: s.sku,
      name: s.name,
      required: s.required,
      gramsPerPortion: s.gramsPerPortion,
      requiredPortions: s.requiredPortions,
      total: s.total,
      totalPortions: s.totalPortions,
      gap: s.gap,
      gapPortions: s.gapPortions,
      status: s.status,
      platingHolding: s.inPlatingHolding,
      postBlast: s.inPostBlast,
      debox: s.inDebox,
      staging: s.inStaging,
      sleeving: s.inSleeving,
    })),
  }));
}

function timelineHash(meals: TimelineMealState[]): string {
  return meals.map(m => `${m.mealSku}:${m.readinessPct}:${m.finished}`).join("|");
}

export function loadTimeline(): TimelineSnapshot[] {
  try { return JSON.parse(localStorage.getItem(TIMELINE_KEY) ?? "[]") as TimelineSnapshot[]; }
  catch { return []; }
}

export function persistTimelineSnapshot(week: string, mealOps: MealOperation[]): boolean {
  const meals = buildTimelineMealStates(mealOps);
  const hash = timelineHash(meals);

  const existing = loadTimeline();
  if (existing.length > 0 && existing[0].hash === hash) return false;

  const snap: TimelineSnapshot = {
    id: String(Date.now()),
    timestamp: new Date().toISOString(),
    week,
    meals,
    hash,
  };

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const filtered = existing.filter(s => new Date(s.timestamp).getTime() > cutoff);

  try {
    localStorage.setItem(TIMELINE_KEY, JSON.stringify([snap, ...filtered].slice(0, MAX_TIMELINE_SNAPSHOTS)));
  } catch (_e) {
    try {
      const trimmed = [snap, ...filtered].slice(0, Math.floor(MAX_TIMELINE_SNAPSHOTS / 2));
      localStorage.setItem(TIMELINE_KEY, JSON.stringify(trimmed));
    } catch { /* storage full — give up */ }
  }
  return true;
}

