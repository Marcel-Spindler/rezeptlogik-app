// Anwenden / Zurücknehmen der KI-Vorschläge auf den (localStorage-)Planner.
// Der Chat-Netzwerkteil steckt in planAssistantAgent.ts.

import type { DataBundle } from "../../core/types";
import { codeDigits } from "../../lib/helpers";
import {
  assignRecipe, createScenario, getActiveScenario, loadPlannerStorage, savePlannerStorage,
} from "../../lib/planner";
import { buildBoardNote, composeBoardNotes } from "../planning-oasis/cockpit/slotScheduling";
import {
  PLATING_PLAN_CHANGED_EVENT, type PlatingDay, type PlatingWeekPlan,
} from "../plating-plan/platingPlanTypes";
import { normalizeDay, normalizeShift } from "./planAssistantTools";
import { PLANNER_CHANGED_EVENT, type DayPlatingProposal, type PlanChange } from "./planAssistantTypes";

function fireChanged() {
  try { window.dispatchEvent(new CustomEvent(PLANNER_CHANGED_EVENT)); } catch { /* ignore */ }
}

export interface ApplyResult {
  ok: boolean;
  results: Array<{ ok: boolean; detail: string }>;
  error?: string;
  undoSnapshot: string;
  scenarioName?: string;
}

export function applyPlanChanges(
  changes: PlanChange[],
  data: DataBundle,
  week: string,
  opts?: { newScenarioName?: string },
): ApplyResult {
  const undoSnapshot = JSON.stringify(loadPlannerStorage());
  if (!changes.length) return { ok: false, results: [], error: "Keine Änderungen im Vorschlag.", undoSnapshot };

  let storage = loadPlannerStorage();
  if (opts?.newScenarioName) {
    const from = getActiveScenario(storage, week);
    storage = createScenario(storage, week, opts.newScenarioName, from.id);
  }
  const scenario = getActiveScenario(storage, week);
  const results: Array<{ ok: boolean; detail: string }> = [];

  for (const change of changes) {
    const wr = data.weekRecipes.find(
      r => r.hfWeek === week && (r.code === change.recipeCode || codeDigits(r.code) === codeDigits(change.recipeCode)),
    );
    if (!wr) { results.push({ ok: false, detail: `${change.recipeCode}: kein Meal in ${week}` }); continue; }

    const day = normalizeDay(change.day);
    const shift = normalizeShift(change.shift);
    if (!day) { results.push({ ok: false, detail: `${change.recipeCode}: Tag „${change.day}" ungültig` }); continue; }
    if (!shift) { results.push({ ok: false, detail: `${change.recipeCode}: Schicht „${change.shift}" ungültig` }); continue; }

    const splitSpec = (change.splitSpec ?? "").trim();
    const note = buildBoardNote(`KI-Vorschlag: ${change.reason || "—"}`, composeBoardNotes("", change.subRecipeId ? "" : splitSpec));

    storage = assignRecipe(storage, week, scenario.id, wr, {
      subRecipeId: change.subRecipeId || undefined,
      day,
      shift,
      targetPortions: typeof change.targetPortions === "number" && Number.isFinite(change.targetPortions)
        ? Math.max(0, Math.round(change.targetPortions))
        : undefined,
      note,
    });
    results.push({ ok: true, detail: `${wr.code} → ${day}/${shift}${splitSpec ? ` (Split ${splitSpec})` : ""}` });
  }

  const anyApplied = results.some(r => r.ok);
  if (anyApplied) {
    savePlannerStorage(storage);
    fireChanged();
  }
  return {
    ok: anyApplied,
    results,
    error: anyApplied ? undefined : "Kein Vorschlag konnte angewandt werden.",
    undoSnapshot,
    scenarioName: opts?.newScenarioName,
  };
}

export function undoPlanChanges(snapshot: string): boolean {
  try {
    savePlannerStorage(JSON.parse(snapshot));
    fireChanged();
    return true;
  } catch {
    return false;
  }
}

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
