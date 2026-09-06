import { describe, expect, it } from "vitest";
import { buildPlanAssistantSources } from "../features/plan-assistant/planAssistantSources";

describe("buildPlanAssistantSources", () => {
  it("nennt Kontextstand und tatsächlich ausgefuehrte Werkzeuge", () => {
    const sources = buildPlanAssistantSources({
      week: "2026-W37",
      dataGeneratedAt: "2026-09-04T10:00:00.000Z",
      hasReconciliation: true,
      hasBackfills: true,
      hasPlatingPlan: false,
      reconciliationStatus: "live",
      backfillsStatus: "offline",
      steps: [{ tool: "get_wo_trace" }, { tool: "simulate_plan_change" }],
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Wochenplan", detail: "2026-W37 · Datenstand 2026-09-04T10:00:00.000Z" }),
      expect.objectContaining({ label: "WO-Abgleich" }),
      expect.objectContaining({ label: "Backfills", status: "offline", detail: "Küchen-/Plating-Feeds nicht verbunden" }),
      expect.objectContaining({ label: "Plan-Simulation" }),
    ]));
  });

  it("nimmt keine erfundene Werkzeugquelle auf", () => {
    const sources = buildPlanAssistantSources({
      week: "2026-W37", dataGeneratedAt: "", hasReconciliation: false, hasBackfills: false, hasPlatingPlan: false,
      steps: [{ tool: "unbekanntes_tool" }],
    });

    expect(sources).toHaveLength(1);
  });
});