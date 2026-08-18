// KI-Planungsassistent: Kontext-Builder, API-Call und Tool-Definitionen.
// Browser → Vite-Proxy → local-db-server.mjs (Port 3142) → Gemini.
import type { PlannerDay, PlannerShift } from "../../../lib/planner";
import type { DataBundle, WeekRecipe } from "../../../core/types";
import type { PlanningRulesConfig } from "./planningRules";

// ─── Typen ──────────────────────────────────────────────────────────────────

export type ProposedAssignmentChange = {
  recipeCode: string;
  recipeName?: string;
  subRecipeId?: string;
  subRecipeName?: string;
  day: PlannerDay;
  shift: PlannerShift;
  targetPortions?: number;
  splitSpec?: string;
  reason: string;
};

export type PlanIssue = {
  severity: "critical" | "warning" | "info";
  description: string;
  affectedRecipes?: string[];
  suggestion?: string;
};

export type AIChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  proposedChanges?: { changes: ProposedAssignmentChange[]; summary: string };
  issues?: PlanIssue[];
  accepted?: boolean;
  rejected?: boolean;
};


// ─── Kontext-Builder ─────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("de-DE");
}

export type AnalysisRecipeSummary = {
  recipeCode: string;
  recipeName: string;
  assigned?: { day: PlannerDay; shift: PlannerShift; targetPortions?: number } | null;
  subRecipes: Array<{
    subRecipeId: string;
    subRecipeName: string;
    assigned?: { day: PlannerDay; shift: PlannerShift } | null;
    category: string;
  }>;
};

export function buildPlanningContext(
  week: string,
  data: DataBundle,
  planningRules: PlanningRulesConfig,
  portionMultiplier: number,
  analysisRecipes: AnalysisRecipeSummary[],
): string {
  const weekRecipes = data.weekRecipes.filter(r => r.hfWeek === week);
  const recipeLookup = Object.fromEntries(weekRecipes.map(r => [r.code, r])) as Record<
    string,
    WeekRecipe
  >;

  const recipeLines = analysisRecipes
    .map(r => {
      const wr = recipeLookup[r.recipeCode];
      const benl = Math.round((wr?.verdenVolume?.BENL ?? 0) * portionMultiplier);
      const nordics = Math.round((wr?.verdenVolume?.DKSE ?? 0) * portionMultiplier);
      const de = Math.round((wr?.verdenVolume?.DE ?? 0) * portionMultiplier);
      const total = Math.round((wr?.totalVerdenVolume ?? 0) * portionMultiplier);
      const mainPlan = r.assigned
        ? `→ Plan: ${r.assigned.day}/${r.assigned.shift} (${fmt(Math.round(r.assigned.targetPortions ?? total))} Ptn.)`
        : "→ NICHT GEPLANT";
      const subLines = r.subRecipes
        .map(s => {
          const slot = s.assigned ? `${s.assigned.day}/${s.assigned.shift}` : "OFFEN";
          return `    Sub [${s.subRecipeId}] "${s.subRecipeName}" (${s.category}) → ${slot}`;
        })
        .join("\n");
      return [
        `• ${r.recipeCode} "${r.recipeName}"`,
        `  Volumina: BENL ${fmt(benl)} / Nordics ${fmt(nordics)} / DE ${fmt(de)} = ${fmt(total)} Ptn.`,
        `  ${mainPlan}`,
        subLines,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return [
    `=== AKTUELLER PLANSTAND KW ${week} ===`,
    `Portionsfaktor (Uplift): ${portionMultiplier.toFixed(3)}x`,
    "",
    "=== PLANUNGSREGELN ===",
    `BENL Fulfillment: Donnerstag ${planningRules.benlThuPct}% / Freitag ${planningRules.benlFriPct}%`,
    `Nordics (DK/SE): Freitag ${planningRules.nordicsFriPct}% / Samstag ${planningRules.nordicsSatPct}%`,
    `DE: fertig bis ${planningRules.deLatestCookDay}`,
    `1 Run bis maximal: ${fmt(planningRules.singleRunMaxPortions)} Portionen`,
    `Frühschicht-Anteil (Run 1): ${planningRules.firstRunPct}%`,
    `Fisch-Rezepte (spätest möglich kochen): ${planningRules.fishRecipeCodes.length > 0 ? planningRules.fishRecipeCodes.join(", ") : "keine"}`,
    "",
    "=== REZEPTE UND ASSIGNMENTS ===",
    recipeLines || "(keine Rezepte für diese KW)",
    "",
    "=== REGELN FÜR DEINE VORSCHLÄGE ===",
    "- Sub-Rezepte müssen IMMER genau 1 Tag vor dem Main-Plating-Tag fertig sein",
    "- Produktionstage: Mo, Di, Mi, Do, Fr, Sa",
    "- S1 = Frühschicht, S2 = Spätschicht",
    "- Fisch-Rezepte: Main-Plating so spät wie möglich (letzter Markt-Batch-Tag)",
    "- propose_plan_change nur für tatsächlich notwendige Änderungen verwenden",
    "- check_plan_issues für Risikoanalyse und Warnungen verwenden",
  ].join("\n");
}

// ─── API-Call ────────────────────────────────────────────────────────────────

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function callPlanningAI(
  systemContext: string,
  history: HistoryMessage[],
  userMessage: string,
): Promise<{
  text: string;
  proposedChanges?: { changes: ProposedAssignmentChange[]; summary: string };
  issues?: PlanIssue[];
}> {
  const res = await fetch("/api/local-db/gemini-planning-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: systemContext, history, message: userMessage }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unbekannter Fehler");
    throw new Error(`KI-Fehler ${res.status}: ${err.slice(0, 300)}`);
  }

  const result = (await res.json()) as {
    text: string;
    toolName: string | null;
    toolInput: unknown;
  };

  let proposedChanges: { changes: ProposedAssignmentChange[]; summary: string } | undefined;
  let issues: PlanIssue[] | undefined;

  if (result.toolName === "propose_plan_change" && result.toolInput) {
    proposedChanges = result.toolInput as { changes: ProposedAssignmentChange[]; summary: string };
  } else if (result.toolName === "check_plan_issues" && result.toolInput) {
    issues = (result.toolInput as { issues: PlanIssue[] }).issues;
  }

  return { text: result.text, proposedChanges, issues };
}
