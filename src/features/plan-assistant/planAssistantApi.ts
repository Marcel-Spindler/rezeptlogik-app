// Anwenden der KI-Vorschläge auf den Wochen-Plating-Plan (Firestore).
// Der Chat-Netzwerkteil steckt in planAssistantAgent.ts.

import {
  PLATING_PLAN_CHANGED_EVENT, type PlatingDay, type PlatingWeekPlan,
} from "../plating-plan/platingPlanTypes";
import { normalizeDay } from "./planAssistantTools";
import type { DayPlatingProposal } from "./planAssistantTypes";

// ─── Plating-Plan (Firestore) ──────────────────────────────────────────────

export async function applyPlatingWeekPlan(plan: PlatingWeekPlan): Promise<{ ok: boolean; error?: string }> {
  try {
    const { savePlatingWeekPlan } = await import("../plating-plan/platingWeekPlanFirestore");
    await savePlatingWeekPlan({ ...plan, source: "ai" });
    try { window.dispatchEvent(new CustomEvent(PLATING_PLAN_CHANGED_EVENT)); } catch { /* ignore */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** KI-Umsortierung EINES Tagesplans anwenden: Slot-Moves auf dailyPlans[day],
 *  neu rechnen (applyDayPlanMoves) und den Wochen-Plating-Plan speichern. */
export async function applyDayPlatingMoves(
  plan: PlatingWeekPlan, day: string, moves: DayPlatingProposal["moves"],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const pd = normalizeDay(day) as PlatingDay | null;
    if (!pd || !plan.dailyPlans?.[pd]) return { ok: false, error: `Kein Tagesplan für „${day}".` };
    if (!moves.length) return { ok: false, error: "Keine Verschiebungen im Vorschlag." };

    const { applyDayPlanMoves } = await import("../plating-plan/platingDayLogic");
    const { savePlatingWeekPlan } = await import("../plating-plan/platingWeekPlanFirestore");
    const { dayPlan, skipped } = applyDayPlanMoves(plan.dailyPlans[pd]!, plan, moves);
    if (skipped.length === moves.length) return { ok: false, error: `Keine Verschiebung ging: ${skipped.join("; ")}` };

    const next: PlatingWeekPlan = {
      ...plan,
      dailyPlans: { ...plan.dailyPlans, [pd]: dayPlan },
      source: "ai",
      updatedAt: new Date().toISOString(),
    };
    await savePlatingWeekPlan(next);
    try { window.dispatchEvent(new CustomEvent(PLATING_PLAN_CHANGED_EVENT)); } catch { /* ignore */ }
    return { ok: skipped.length === 0, error: skipped.length ? `Teilweise angewandt — übersprungen: ${skipped.join("; ")}` : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
