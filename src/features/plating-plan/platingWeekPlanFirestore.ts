// Firestore-Anbindung des Wochen-Plating-Plans.
// Pfad: apps/rezeptlogik/platingWeekPlan/{week}   (getrennt von platingPlan/{week},
// das ist der importierte PET-Plan). Direkte Client-Writes wie im Rest der App.

import { getFirebase, doc, setDoc, onSnapshot } from "../../core/firebase";
import { DEFAULT_DAY_CAPACITY, resolvePlatingParams } from "./platingPlanLogic";
import type { PlatingWeekPlan } from "./platingPlanTypes";

const COLLECTION = "apps/rezeptlogik/platingWeekPlan";

/** Hebt Alt-Dokumente ohne `params`-Block auf das aktuelle Schema (Legacy:
 *  `firstRunPct` lag früher direkt am Plan, `dayCapacity` konnte fehlen). */
export function normalizePlatingWeekPlan(raw: unknown, week: string): PlatingWeekPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const legacyFrp = typeof r.firstRunPct === "number" ? { firstRunPct: r.firstRunPct } : {};
  const params = resolvePlatingParams(typeof r.week === "string" ? r.week : week, {
    ...legacyFrp,
    ...((r.params as Record<string, number> | undefined) ?? {}),
  });
  const rawCap = r.dayCapacity as PlatingWeekPlan["dayCapacity"] | undefined;
  const dayCapacity = rawCap && typeof rawCap === "object" && Object.keys(rawCap).length
    ? rawCap : { ...DEFAULT_DAY_CAPACITY };
  const now = new Date().toISOString();
  return {
    week: typeof r.week === "string" ? r.week : week,
    params,
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : (typeof r.updatedAt === "string" ? r.updatedAt : now),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
    meals: Array.isArray(r.meals) ? (r.meals as PlatingWeekPlan["meals"]) : [],
    dayCapacity,
    source: (r.source === "edited" || r.source === "ai" || r.source === "generated") ? r.source : "generated",
  };
}

export async function savePlatingWeekPlan(plan: PlatingWeekPlan): Promise<void> {
  const { db } = getFirebase();
  await setDoc(doc(db, COLLECTION, plan.week), {
    ...plan,
    firstRunPct: plan.params.firstRunPct, // Deprecated-Spiegel für Alt-Leser
    updatedAt: new Date().toISOString(),
  });
}

export function subscribePlatingWeekPlan(
  week: string,
  onData: (plan: PlatingWeekPlan | null) => void,
): () => void {
  let disposed = false;
  let unsub: (() => void) | undefined;
  try {
    const { db } = getFirebase();
    if (disposed) return () => { disposed = true; };
    unsub = onSnapshot(
      doc(db, COLLECTION, week),
      (snap) => onData(snap.exists() ? normalizePlatingWeekPlan(snap.data(), week) : null),
      () => onData(null),
    );
  } catch {
    onData(null);
  }
  return () => { disposed = true; unsub?.(); };
}
