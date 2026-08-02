// wmsCache.ts – reads the top-level `wmsCache/workorders` Firestore doc that
// scripts/sync-wms-cache.ts (one-shot, personal-SSO Snowflake pull) writes.
// This is a manually-refreshed cache, not realtime data — a plain getDoc is
// enough, no onSnapshot listener needed. The doc may not exist yet.

import type { WorkOrderEntry } from "./types";

export interface WmsWorkorderCacheRow {
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
}

// The underlying WMS view reports some work-order/sub-meal combinations more
// than once (seen in production: same wo+submeal duplicated with different
// uom, e.g. "LBS" and "G", and sometimes a truncated description). Keep one
// row per (woNumber, submealItemNumber), preferring the most complete
// description so sub-recipe-name matching downstream has the best chance.
function dedupeWorkorderRows(rows: WmsWorkorderCacheRow[]): WmsWorkorderCacheRow[] {
  const byKey = new Map<string, WmsWorkorderCacheRow>();
  for (const row of rows) {
    const key = `${row.woNumber}::${row.submealItemNumber}`;
    const existing = byKey.get(key);
    if (!existing || (row.submealItemDescription?.length ?? 0) > (existing.submealItemDescription?.length ?? 0)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

// Real calendar-current hfWeek (Factor-KW = ISO-KW + 1), independent of
// whatever week the recipe planner happens to have selected. The GSheet-fed
// weekRecipes pipeline can run weeks behind (seen in production: stuck at
// W28 while it's actually W32) -- live kitchen work orders must follow the
// real calendar, not that lag, or current data would get filtered out as
// "wrong week" by mistake.
export function currentHfWeek(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  const year = d.getUTCFullYear();
  const week = isoWeek + 1;
  return week <= 52 ? `${year}-W${String(week).padStart(2, "0")}` : `${year + 1}-W01`;
}

// Bounds cache rows to the given hfWeek (e.g. "2026-W31") plus the following
// week — the sync script already fetches a ~4-week window, but the cache is
// shared across whichever week is relevant, so this trims it down to what's
// actually current instead of mixing in older weeks and making the list
// unreadable. "week" on cache rows is "YYYYWW" and already uses this app's
// hfWeek convention (verified against real data).
export function filterRowsToWeekWindow(
  rows: WmsWorkorderCacheRow[],
  hfWeek: string,
): { kept: WmsWorkorderCacheRow[]; droppedWeeks: string[] } {
  const m = hfWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return { kept: rows, droppedWeeks: [] };
  const year = Number(m[1]);
  const week = Number(m[2]);
  const thisWeekCode = `${year}${String(week).padStart(2, "0")}`;
  const nextWeekCode = week + 1 <= 52 ? `${year}${String(week + 1).padStart(2, "0")}` : `${year + 1}01`;
  const allowed = new Set([thisWeekCode, nextWeekCode]);

  const kept: WmsWorkorderCacheRow[] = [];
  const droppedWeeks = new Set<string>();
  for (const row of rows) {
    if (allowed.has(row.week)) kept.push(row);
    else if (row.week) droppedWeeks.add(row.week);
  }
  return { kept, droppedWeeks: [...droppedWeeks].sort() };
}

export async function fetchWmsWorkorderCache(): Promise<{ rows: WmsWorkorderCacheRow[]; generatedAt: string } | null> {
  try {
    const [{ getFirebase }, { collection, doc, getDoc }] = await Promise.all([
      import("./firebase"),
      import("firebase/firestore"),
    ]);
    const { db } = getFirebase();
    const snap = await getDoc(doc(collection(db, "wmsCache"), "workorders"));
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    const rawRows: WmsWorkorderCacheRow[] = Array.isArray(data?.rows) ? data.rows : [];
    return { rows: dedupeWorkorderRows(rawRows), generatedAt: data?.pushedAt ?? data?.generatedAt ?? "" };
  } catch {
    return null;
  }
}

// CAVEAT: this mapping is a best-effort, field-name-based guess — NOT yet
// verified against real production data. woNumber is passed through as-is
// (its Snowflake format is unknown and may not match the usual "23-175"
// convention); recipeCode is extracted from mealItemDescription with the
// same regex convention used elsewhere in this app, and is "" on no match.
// Field access below is defensive: cache rows come from an external,
// unverified Snowflake pull, so a missing field or an unparseable
// productionTime must degrade to "" rather than throw.
export function wmsWorkorderRowToEntry(row: WmsWorkorderCacheRow): WorkOrderEntry {
  const recipeCode = (row.mealItemDescription ?? "").trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
  let kitchenDay = "";
  if (row.productionTime) {
    const d = new Date(row.productionTime);
    if (!isNaN(d.getTime())) kitchenDay = d.toISOString().slice(0, 10);
  }
  const plannedMeals = row.plates ?? row.quantity ?? 0;

  return {
    run: 0,
    kitchenDay,
    workOrder: row.woNumber,
    recipeId: row.submealItemNumber || undefined,
    recipeCode,
    recipeName: row.mealItemDescription,
    subRecipe: row.submealItemDescription,
    plannedMeals,
    targetPortions: row.plates ?? row.quantity ?? undefined,
    woCookedPortions: undefined,
    cookedPortionsExcess: undefined,
    stagingKg: 0,
    kitchenKg: 0,
    postKg: 0,
    yieldPct: 0,
    cookMethods: undefined,
    stagingStatus: undefined,
    stagingComment: undefined,
    kitchenStatus: row.status?.trim() || undefined,
    unlockedEta: undefined,
    workOrderComment: undefined,
    logisticTarget: undefined,
  };
}
