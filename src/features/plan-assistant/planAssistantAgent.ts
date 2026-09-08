// Agent-Schleife für „Frag den Plan". Läuft komplett im Client: baut den
// Live-Kontext, schickt einen Gemini-Turn an den Relay-Endpunkt, führt die
// zurückgegebenen (Lese-/Simulations-)Werkzeuge lokal gegen die App-Daten aus,
// speist die Ergebnisse zurück und wiederholt, bis das Modell final antwortet
// oder ein terminales Werkzeug (propose_plating_plan / propose_day_plating_change
// / check_plan_issues) ruft.

import type { DataBundle } from "../../core/types";
import { buildPlanContext } from "./planAssistantContext";
import { TOOL_DECLARATIONS, TERMINAL_TOOLS, executeClientTool, type ToolContext } from "./planAssistantTools";
import type { DayPlatingProposal, PlanIssue, PlatingProposal } from "./planAssistantTypes";
import { buildPlanAssistantSources, type PlanAssistantSource } from "./planAssistantSources";

const CHAT_URL = "/api/local-db/gemini-planning-chat";
const MAX_STEPS = 6;

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
export interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

interface RelayResponse {
  text?: string;
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason?: string | null;
  model?: string;
  error?: string;
}

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AgentOutcome {
  text: string;
  issues?: PlanIssue[];
  platingProposal?: PlatingProposal;
  dayPlatingProposal?: DayPlatingProposal;
  steps: AgentStep[];
  contents: GeminiContent[];
  sources: PlanAssistantSource[];
  error?: string;
}

async function relay(body: {
  context: string;
  contents: GeminiContent[];
  model: "flash" | "pro";
}): Promise<RelayResponse> {
  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: body.context, contents: body.contents, tools: TOOL_DECLARATIONS, model: body.model }),
    });
  } catch (e) {
    return { error: `Assistent nicht erreichbar: ${e instanceof Error ? e.message : String(e)}` };
  }
  const payload = (await res.json().catch(() => ({}))) as RelayResponse;
  if (!res.ok) return { error: payload.error || `HTTP ${res.status}` };
  return payload;
}

function asResponseObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
}

function shortSummary(name: string, result: unknown): string {
  const o = asResponseObject(result);
  if (o.error) return String(o.error);
  if (name === "get_recipe_detail") return String(o.name ?? o.code ?? "geladen");
  return "ok";
}

export async function runPlanAgent(params: {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  reconciliation: ToolContext["reconciliation"];
  backfills: ToolContext["backfills"];
  platingPlan: ToolContext["platingPlan"];
  reconciliationStatus?: "live" | "cache" | "offline";
  backfillsStatus?: "live" | "cache" | "offline";
  priorContents: GeminiContent[];
  userMessage: string;
  model: "flash" | "pro";
  onStep?: (step: AgentStep | { tool: "__thinking__"; args: Record<string, unknown>; ok: true; summary: string }) => void;
}): Promise<AgentOutcome> {
  const toolCtx: ToolContext = {
    data: params.data, week: params.week, upliftPercent: params.upliftPercent,
    reconciliation: params.reconciliation, backfills: params.backfills,
    platingPlan: params.platingPlan,
  };

  let context = "";
  try {
    context = buildPlanContext({
      data: params.data, week: params.week, upliftPercent: params.upliftPercent,
      reconciliation: params.reconciliation, backfills: params.backfills,
      platingPlan: params.platingPlan,
    });
  } catch (e) {
    context = `(Kontext-Aufbau fehlgeschlagen: ${e instanceof Error ? e.message : String(e)})`;
  }

  const contents: GeminiContent[] = [
    ...params.priorContents,
    { role: "user", parts: [{ text: params.userMessage }] },
  ];
  const steps: AgentStep[] = [];
  let lastText = "";
  const sources = () => buildPlanAssistantSources({
    week: params.week,
    dataGeneratedAt: params.data.generatedAt,
    hasReconciliation: !!params.reconciliation?.bySeverityRecipe.size,
    hasBackfills: !!params.backfills?.combined.length,
    hasPlatingPlan: !!params.platingPlan,
    reconciliationStatus: params.reconciliationStatus,
    backfillsStatus: params.backfillsStatus,
    steps,
  });

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await relay({ context, contents, model: params.model });
    if (resp.error) return { text: "", steps, contents, sources: sources(), error: resp.error };

    lastText = resp.text?.trim() || lastText;
    const calls = resp.functionCalls ?? [];

    if (!calls.length) {
      return { text: lastText || "(keine Antwort)", steps, contents, sources: sources() };
    }

    // Modell-Turn protokollieren
    contents.push({ role: "model", parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) });
    if (resp.text?.trim()) params.onStep?.({ tool: "__thinking__", args: {}, ok: true, summary: resp.text.trim() });

    // Terminale Werkzeuge → Schleife beenden, Payload rendern
    const terminal = calls.find(c => TERMINAL_TOOLS.has(c.name));
    if (terminal) {
      if (terminal.name === "check_plan_issues") {
        const issues = Array.isArray(terminal.args.issues) ? (terminal.args.issues as PlanIssue[]) : [];
        return { text: lastText || "Analyse:", issues, steps, contents, sources: sources() };
      }
      if (terminal.name === "propose_day_plating_change") {
        return {
          text: lastText || "Tagesplan-Umsortierung:",
          dayPlatingProposal: {
            day: String(terminal.args.day ?? ""),
            moves: (Array.isArray(terminal.args.moves) ? terminal.args.moves : []) as DayPlatingProposal["moves"],
            summary: String(terminal.args.summary ?? ""),
          },
          steps, contents, sources: sources(),
        };
      }
      if (terminal.name === "propose_plating_plan") {
        return {
          text: lastText || "Plating-Plan-Vorschlag:",
          platingProposal: {
            firstRunPct: typeof terminal.args.firstRunPct === "number" ? terminal.args.firstRunPct : undefined,
            moves: (Array.isArray(terminal.args.moves) ? terminal.args.moves : []) as PlatingProposal["moves"],
            notes: (Array.isArray(terminal.args.notes) ? terminal.args.notes : []) as PlatingProposal["notes"],
            regenerateDailyPlans: terminal.args.regenerateDailyPlans === true,
            summary: String(terminal.args.summary ?? ""),
          },
          steps, contents, sources: sources(),
        };
      }
      // Unbekanntes terminales Werkzeug — als Text zurückgeben.
      return { text: lastText || String(terminal.args.summary ?? "(Vorschlag)"), steps, contents, sources: sources() };
    }

    // Lese-/Simulations-Werkzeuge lokal ausführen und zurückspeisen
    const responseParts: GeminiPart[] = [];
    for (const call of calls) {
      const result = executeClientTool(call.name, call.args, toolCtx);
      const summary = shortSummary(call.name, result);
      const stepEntry: AgentStep = { tool: call.name, args: call.args, ok: !asResponseObject(result).error, summary };
      steps.push(stepEntry);
      params.onStep?.(stepEntry);
      responseParts.push({ functionResponse: { name: call.name, response: asResponseObject(result) } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return {
    text: lastText || "Abbruch: zu viele Werkzeug-Schritte ohne finale Antwort.",
    steps, contents, sources: sources(),
    error: lastText ? undefined : "Schritt-Limit erreicht",
  };
}
