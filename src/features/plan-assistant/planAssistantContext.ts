// Stellt zur Frage-Zeit einen frischen, kompakten Text-Snapshot aller verknüpften
// Planungs-Quellen zusammen — das ist der RAG-Kontext für „Frag den Plan".
// Reine Funktion, kein React. Bewusst terse gehalten (Token-Budget).

import type { DataBundle } from "../../core/types";
import { currentHfWeek } from "../../lib/hfWeek";
import { codeDigits, fmtNum } from "../../lib/helpers";
import { getBaseVerdenVolume, loadStationDeviceCounts, loadStationPools, DEFAULT_SHIFT_MIN } from "../../lib/equipment";
import { analyzePlan, getActiveScenario, loadPlannerStorage, PLANNER_DAYS } from "../../lib/planner";
import type { WoReconciliationState } from "../wo-reconciliation/WoReconciliationContext";
import type { BackfillsState } from "../backfills/BackfillsContext";
import type { PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import { summarizePlatingPlan } from "../plating-plan/platingPlanLogic";

export interface PlanContextInput {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  reconciliation: WoReconciliationState | null;
  backfills: BackfillsState | null;
  platingPlan?: PlatingWeekPlan | null;
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed ? `\n### ${title}\n${trimmed}` : "";
}

export function buildPlanContext({ data, week, upliftPercent, reconciliation, backfills, platingPlan }: PlanContextInput): string {
  const lines: string[] = [];
  const realWeek = currentHfWeek();
  const mult = 1 + (upliftPercent || 0) / 100;

  lines.push(`## Planungs-Kontext (Live-Snapshot ${new Date().toLocaleString("de-DE")})`);
  lines.push(`Gewählte Planungs-KW: ${week}${week !== realWeek ? ` · aktuelle Kalender-KW: ${realWeek}` : ""}`);
  lines.push(`Uplift auf Portionen: +${upliftPercent || 0}%`);
  lines.push(`Konvention: HF-KW = echte ISO-KW + 1. Küche Mo–Fr, Sa/So zu. Schichten S1=Früh, S2=Spät.`);

  // ── Meals der Woche ─────────────────────────────────────────────────────────
  const weekRecipes = data.weekRecipes.filter(wr => wr.hfWeek === week);
  const storage = loadPlannerStorage();
  const scenario = getActiveScenario(storage, week);
  const assignById = scenario.assignments;

  if (weekRecipes.length) {
    const totalPortions = weekRecipes.reduce((s, wr) => s + Math.round(getBaseVerdenVolume(wr) * mult), 0);
    const rows = weekRecipes
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(wr => {
        const base = Math.round(getBaseVerdenVolume(wr) * mult);
        const a = assignById[wr.code];
        const plan = a ? `${a.day}/${a.shift}${a.targetPortions ? ` @${fmtNum(a.targetPortions)}` : ""}${a.note && /split=/.test(a.note) ? " (Split)" : ""}` : "—ungeplant—";
        const mk = [
          wr.verdenVolume.BENL ? `BENL ${fmtNum(wr.verdenVolume.BENL)}` : "",
          wr.verdenVolume.DKSE ? `DKSE ${fmtNum(wr.verdenVolume.DKSE)}` : "",
          wr.verdenVolume.DE ? `DE ${fmtNum(wr.verdenVolume.DE)}` : "",
        ].filter(Boolean).join(" ");
        return `- ${wr.code} ${wr.recipeName} · ${wr.preference} · Σ ${fmtNum(base)} (${mk}) · Plan: ${plan}`;
      });
    lines.push(section(
      `Meals in ${week} (${weekRecipes.length}, Σ ${fmtNum(totalPortions)} Portionen inkl. Uplift)`,
      rows.join("\n"),
    ));
  } else {
    lines.push(section(`Meals in ${week}`, "Keine WeekRecipes für diese KW geladen."));
  }

  // ── Wochenboard / Planner-Analyse ──────────────────────────────────────────
  try {
    const analysis = analyzePlan(data, week, scenario, {
      portionMultiplier: mult,
      shiftCapacityMin: DEFAULT_SHIFT_MIN,
      stationDeviceCounts: loadStationDeviceCounts(),
      stationPools: loadStationPools(),
    });
    const planLines: string[] = [];
    planLines.push(`Szenario: „${scenario.name}" · geplant ${analysis.plannedCount} · ungeplant ${analysis.unplannedCount}`);

    if (analysis.conflicts.length) {
      planLines.push(`\nStations-Engpässe (Auslastung > 100%):`);
      for (const c of analysis.conflicts.slice(0, 15)) {
        planLines.push(`- ${c.station} ${c.day}/${c.shift}: ${Math.round(c.utilizationPct)}% (${fmtNum(c.totalMin)}/${fmtNum(c.capacityMin)} min, ${c.deviceCount} Gerät(e), bräuchte ${c.requiredDevices}) — ${c.assignments.map(a => a.recipeCode).join(", ")}`);
      }
    } else {
      planLines.push(`Keine Stations-Engpässe.`);
    }
    if (analysis.poolConflicts.length) {
      planLines.push(`\nPool-Engpässe:`);
      for (const p of analysis.poolConflicts.slice(0, 10)) {
        planLines.push(`- Pool ${p.poolName} ${p.day}/${p.shift}: ${Math.round(p.utilizationPct)}% — ${p.assignments.map(a => `${a.recipeCode}(${a.station})`).join(", ")}`);
      }
    }
    const unplanned = analysis.recipes.filter(r => !r.assigned && !r.subRecipes.some(s => s.assigned));
    if (unplanned.length) {
      planLines.push(`\nUngeplante Meals: ${unplanned.map(r => r.recipeCode).join(", ")}`);
    }
    lines.push(section("Wochenboard-Analyse", planLines.join("\n")));
  } catch (e) {
    lines.push(section("Wochenboard-Analyse", `(nicht verfügbar: ${e instanceof Error ? e.message : String(e)})`));
  }

  // ── Production Plan (Firestore / KET) ──────────────────────────────────────
  const weekDigits = new Set(weekRecipes.map(wr => codeDigits(wr.code)));
  const ppRows = (data.productionPlan?.rows ?? []).filter(r => weekDigits.has(codeDigits(r.recipeCode)));
  if (ppRows.length) {
    const byWo = new Map<string, { code: string; name: string; meals: number; day: string; kStatus: string; sStatus: string }>();
    for (const r of ppRows) {
      const key = r.workOrder || `${r.recipeCode}-${r.subRecipe}`;
      const prev = byWo.get(key);
      if (!prev) {
        byWo.set(key, {
          code: r.recipeCode, name: r.recipeName, meals: r.plannedMeals || 0,
          day: r.kitchenDay || "", kStatus: r.kitchenStatus || "", sStatus: r.stagingStatus || "",
        });
      }
    }
    const rows = [...byWo.entries()].slice(0, 60).map(([wo, v]) =>
      `- WO ${wo}: ${v.code} ${v.name} · ${fmtNum(v.meals)} Meals · Küchentag ${v.day}${v.kStatus ? ` · Küche: ${v.kStatus}` : ""}${v.sStatus ? ` · Staging: ${v.sStatus}` : ""}`,
    );
    lines.push(section(`Production Plan / Work Orders (${byWo.size})`, rows.join("\n")));
  }

  // ── WO-Abgleich (App-Plan / KET / PET / Postblast / WMS) ───────────────────
  if (reconciliation && reconciliation.bySeverityRecipe.size) {
    const rows = [...reconciliation.bySeverityRecipe.entries()]
      .sort((a, b) => (a[1].severity === "critical" ? -1 : 1) - (b[1].severity === "critical" ? -1 : 1))
      .slice(0, 30)
      .map(([code, v]) => `- ${code}: ${v.severity === "critical" ? "KRITISCH" : "Abweichung"} in ${v.count} WO(s)`);
    lines.push(section("WO-Abgleich — Unstimmigkeiten zwischen den Quellen", rows.join("\n")));
  }

  // ── Backfill-Bedarf ───────────────────────────────────────────────────────
  if (backfills && backfills.combined.length) {
    const needs = backfills.combined
      .filter(c => (c.minNeededPortions ?? c.kitchenMissingPortions ?? 0) > 0 || c.platingShortagePortions > 0)
      .slice(0, 25)
      .map(c => {
        const feas = backfills.feasibilityByMeal.get(c.recipeCode);
        const need = c.minNeededPortions ?? c.kitchenMissingPortions ?? c.platingShortagePortions;
        const feasNote = feas ? ` · Rohware: ${feas.verdict} (${Math.round((feas.coveragePct ?? 0) * 100)}%)` : "";
        return `- ${c.recipeCode} ${c.recipeName}: ~${fmtNum(need)} Portionen nachzuproduzieren${c.kitchenPriority ? ` (Prio ${c.kitchenPriority})` : ""}${feasNote}`;
      });
    if (needs.length) {
      lines.push(section(`Backfill-Bedarf (Nachproduktion, ${needs.length})`, needs.join("\n")));
    }
  }

  // ── Planungs-Kalender / Deadlines ─────────────────────────────────────────
  const deadlines = data.planningCalendar?.deadlines ?? [];
  if (deadlines.length) {
    const rows = deadlines.slice(0, 20).map(d => `- ${JSON.stringify(d)}`);
    lines.push(section("Planungs-Kalender (Deadlines/Regeln)", rows.join("\n")));
  }

  // ── Weight Goals ──────────────────────────────────────────────────────────
  if (data.weightGoals?.length) {
    const rows = data.weightGoals.slice(0, 25).map((g) => `- ${JSON.stringify(g)}`);
    lines.push(section("Gewichts-Ziele (Ist vs. Soll)", rows.join("\n")));
  }

  // ── Wochen-Plating-Plan ──────────────────────────────────────────────────
  if (platingPlan) {
    lines.push(section(`Wochen-Plating-Plan (${platingPlan.source})`, summarizePlatingPlan(platingPlan)));
  } else {
    lines.push(section("Wochen-Plating-Plan", `Noch keiner für ${week}. generate_plating_plan erzeugt den Rohbau, propose_plating_plan legt ihn dem Nutzer vor.`));
  }

  lines.push(`\n(Tage: ${PLANNER_DAYS.join(" ")}. Nur Fakten aus diesem Kontext verwenden. Küchen-Wochenboard ändern: propose_plan_change. Wochen-Plating-Plan: generate_plating_plan → simulate_plating_change → propose_plating_plan. Risiko-Übersichten: check_plan_issues.)`);

  return lines.join("\n");
}
