export interface PlanAssistantSource {
  key: string;
  label: string;
  detail: string;
}

const TOOL_SOURCES: Record<string, { label: string; detail: string }> = {
  get_recipe_detail: { label: "Rezeptdaten", detail: "Rezeptstruktur, Zutaten und Prozessdaten" },
  get_backfill_detail: { label: "Backfills", detail: "Nachproduktionsbedarf und Rohwaren-Machbarkeit" },
  get_wo_trace: { label: "WO-Abgleich", detail: "App, KET, PET, WMS und Postblast" },
  get_capacity_overview: { label: "Kapazitätsanalyse", detail: "Stationen, Pools und Wochenboard" },
  get_plating_plan: { label: "Plating-Plan", detail: "gespeicherter Wochenplan" },
  get_day_plating_plan: { label: "Tages-Linienplan", detail: "Linien, Rüstungen und Carry-over" },
  generate_plating_plan: { label: "Plating-Simulation", detail: "regelbasierter Wochenplan-Entwurf" },
  generate_day_plating_plan: { label: "Tagesplan-Simulation", detail: "regelbasierte Linienzuweisung" },
  simulate_plan_change: { label: "Plan-Simulation", detail: "Änderung vor dem Speichern geprüft" },
  simulate_plating_change: { label: "Plating-Simulation", detail: "Tageslast vor dem Speichern geprüft" },
  simulate_day_plating_change: { label: "Tagesplan-Simulation", detail: "Linienänderung vor dem Speichern geprüft" },
};

export function buildPlanAssistantSources(input: {
  week: string;
  dataGeneratedAt: string;
  hasReconciliation: boolean;
  hasBackfills: boolean;
  hasPlatingPlan: boolean;
  steps: Array<{ tool: string }>;
}): PlanAssistantSource[] {
  const sources: PlanAssistantSource[] = [{
    key: "week-plan",
    label: "Wochenplan",
    detail: `${input.week} · Datenstand ${input.dataGeneratedAt || "unbekannt"}`,
  }];
  if (input.hasReconciliation) sources.push({ key: "reconciliation", label: "WO-Abgleich", detail: "aktueller Quellenabgleich" });
  if (input.hasBackfills) sources.push({ key: "backfills", label: "Backfills", detail: "aktuelle Nachproduktionssignale" });
  if (input.hasPlatingPlan) sources.push({ key: "plating", label: "Plating-Plan", detail: "gespeicherter Wochenplan" });
  for (const step of input.steps) {
    const source = TOOL_SOURCES[step.tool];
    if (source && !sources.some((entry) => entry.label === source.label)) {
      sources.push({ key: `tool:${step.tool}`, ...source });
    }
  }
  return sources;
}