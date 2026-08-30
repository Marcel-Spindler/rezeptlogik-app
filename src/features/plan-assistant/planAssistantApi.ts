// Anwenden / Zurücknehmen der KI-Vorschläge auf den (localStorage-)Planner.
// Der Chat-Netzwerkteil steckt in planAssistantAgent.ts.

import type { DataBundle } from "../../core/types";
import { codeDigits } from "../../lib/helpers";
import {
  assignRecipe, createScenario, getActiveScenario, loadPlannerStorage, savePlannerStorage,
} from "../../lib/planner";
import { buildBoardNote, composeBoardNotes } from "../planning-oasis/cockpit/slotScheduling";
import { normalizeDay, normalizeShift } from "./planAssistantTools";
import { PLANNER_CHANGED_EVENT, type PlanChange } from "./planAssistantTypes";

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
