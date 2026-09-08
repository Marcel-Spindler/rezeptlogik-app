// Firestore-Anbindung des Kochplans.
// Pfad: apps/rezeptlogik/kitchenPlan/{week}. Gespeichert wird NUR der persistente
// Teil (params + Sub-Meal-Overrides: Kochtag / Schicht / fixierte Position) — die
// abgeleiteten Tagespläne rechnet der Client aus dem Plating-Plan + DataBundle
// jedes Mal neu.

import { getFirebase, doc, setDoc, onSnapshot } from "../../core/firebase";
import type { PlatingDay } from "../plating-plan/platingPlanTypes";
import { resolveKitchenParams } from "./kitchenPlanLogic";
import type { KitchenOverride, KitchenPlanParams, KitchenShift } from "./kitchenPlanTypes";

const COLLECTION = "apps/rezeptlogik/kitchenPlan";
const VALID_DAYS = new Set<PlatingDay>(["So", "Mo", "Di", "Mi", "Do", "Fr"]);
const VALID_SHIFTS = new Set<KitchenShift>(["früh", "spät", "tag"]);

export interface KitchenPlanDoc {
  week: string;
  params: KitchenPlanParams;
  overrides: Record<string, KitchenOverride>;
  updatedAt: string;
  source: "generated" | "edited";
}

function normalizeOverride(raw: unknown): KitchenOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: KitchenOverride = {};
  if (typeof r.cookDay === "string" && VALID_DAYS.has(r.cookDay as PlatingDay)) out.cookDay = r.cookDay as PlatingDay;
  if (typeof r.shift === "string" && VALID_SHIFTS.has(r.shift as KitchenShift)) out.shift = r.shift as KitchenShift;
  if (typeof r.order === "number" && Number.isFinite(r.order)) out.order = r.order;
  return (out.cookDay || out.shift || out.order != null) ? out : null;
}

export function normalizeKitchenPlanDoc(raw: unknown, week: string): KitchenPlanDoc {
  const r = (raw ?? {}) as Record<string, unknown>;
  const params = resolveKitchenParams((r.params as Partial<KitchenPlanParams> | undefined) ?? undefined);
  const overrides: Record<string, KitchenOverride> = {};
  const rawOv = r.overrides;
  if (rawOv && typeof rawOv === "object") {
    for (const [key, val] of Object.entries(rawOv as Record<string, unknown>)) {
      const norm = normalizeOverride(val);
      if (norm) overrides[key] = norm;
    }
  }
  return {
    week: typeof r.week === "string" ? r.week : week,
    params,
    overrides,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
    source: r.source === "edited" ? "edited" : "generated",
  };
}

export async function saveKitchenPlanDoc(docData: KitchenPlanDoc): Promise<void> {
  const { db } = getFirebase();
  const clean = JSON.parse(JSON.stringify({
    week: docData.week,
    params: docData.params,
    overrides: docData.overrides,
    updatedAt: new Date().toISOString(),
    source: docData.source,
  }));
  await setDoc(doc(db, COLLECTION, docData.week), clean);
}

export function subscribeKitchenPlanDoc(
  week: string,
  onData: (doc: KitchenPlanDoc | null) => void,
): () => void {
  let disposed = false;
  let unsub: (() => void) | undefined;
  try {
    const { db } = getFirebase();
    if (disposed) return () => { disposed = true; };
    unsub = onSnapshot(
      doc(db, COLLECTION, week),
      (snap) => onData(snap.exists() ? normalizeKitchenPlanDoc(snap.data(), week) : null),
      () => onData(null),
    );
  } catch {
    onData(null);
  }
  return () => { disposed = true; unsub?.(); };
}
