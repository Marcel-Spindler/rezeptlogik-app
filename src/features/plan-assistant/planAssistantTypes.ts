// „Frag den Plan" — Typen für den KI-Planungsassistenten im Shell-Header.
// Der Client fährt die Agent-Schleife (planAssistantAgent.ts); der Backend-
// Endpunkt /api/local-db/gemini-planning-chat ist ein reiner Gemini-Relay
// ({ context, contents, tools, model } → { text, functionCalls }).

export type ChatRole = "user" | "assistant";

export interface PlanIssue {
  severity: "critical" | "warning" | "info";
  description: string;
  affectedRecipes?: string[];
  suggestion?: string;
}

/** Eine vom Modell vorgeschlagene Assignment-Änderung (Feld-Namen = Gemini-Tool). */
export interface PlanChange {
  recipeCode: string;
  subRecipeId?: string;
  day: string;
  shift: string;
  targetPortions?: number;
  splitSpec?: string;
  reason: string;
}

export interface PlanProposal {
  changes: PlanChange[];
  summary: string;
  /** UI-Status nach „Übernehmen". */
  applied?: boolean;
  appliedToNewScenario?: string;
  applyError?: string;
  /** Pro Change: konnte er angewandt werden? (Index-parallel zu changes) */
  results?: Array<{ ok: boolean; detail: string }>;
  /** Planner-Snapshot vor dem Anwenden — für „Rückgängig". */
  undoSnapshot?: string;
}

/** Ein Werkzeug-Aufruf des Agenten, für die „denkt nach"-Anzeige. */
export interface ChatStep {
  tool: string;
  summary: string;
  ok: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  issues?: PlanIssue[];
  proposal?: PlanProposal;
  steps?: ChatStep[];
  pending?: boolean;
}

/** Custom-Event, das der Assistent nach einem angewandten/zurückgenommenen
 *  Vorschlag feuert, damit das Cockpit-Wochenboard den localStorage-Planner
 *  neu liest. */
export const PLANNER_CHANGED_EVENT = "rezeptlogik:planner-changed";
