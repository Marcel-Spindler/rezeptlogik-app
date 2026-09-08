// Stellt zur Frage-Zeit einen frischen, kompakten Text-Snapshot aller verknüpften
// Planungs-Quellen zusammen — das ist der RAG-Kontext für „Frag den Plan".
// Reine Funktion, kein React. Bewusst terse gehalten (Token-Budget).

import type { DataBundle } from "../../core/types";
import { currentHfWeek } from "../../lib/hfWeek";
import { codeDigits, fmtNum } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";
import type { WoReconciliationState } from "../wo-reconciliation/WoReconciliationContext";
import type { BackfillsState } from "../backfills/BackfillsContext";
import { effectiveDayHours, PLATING_DAYS, type PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import { summarizePlatingPlan } from "../plating-plan/platingPlanLogic";
import { describeKitchenPlan, generateKitchenPlan } from "../kitchen-plan/kitchenPlanLogic";

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

  if (weekRecipes.length) {
    const totalPortions = weekRecipes.reduce((s, wr) => s + Math.round(getBaseVerdenVolume(wr) * mult), 0);
    const rows = weekRecipes
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(wr => {
        const base = Math.round(getBaseVerdenVolume(wr) * mult);
        const mk = [
          wr.verdenVolume.BENL ? `BENL ${fmtNum(wr.verdenVolume.BENL)}` : "",
          wr.verdenVolume.DKSE ? `DKSE ${fmtNum(wr.verdenVolume.DKSE)}` : "",
          wr.verdenVolume.DE ? `DE ${fmtNum(wr.verdenVolume.DE)}` : "",
        ].filter(Boolean).join(" ");
        return `- ${wr.code} ${wr.recipeName} · ${wr.preference} · Σ ${fmtNum(base)} (${mk})`;
      });
    lines.push(section(
      `Meals in ${week} (${weekRecipes.length}, Σ ${fmtNum(totalPortions)} Portionen inkl. Uplift)`,
      rows.join("\n"),
    ));
  } else {
    lines.push(section(`Meals in ${week}`, "Keine WeekRecipes für diese KW geladen."));
  }

  // ── Kochplan (aus Plating-Plan + Cook Schedule abgeleitet) ─────────────────
  if (platingPlan) {
    try {
      const kp = generateKitchenPlan(data, platingPlan);
      lines.push(section("Kochplan (Küchentage Mo–Fr)", describeKitchenPlan(kp)));
    } catch (e) {
      lines.push(section("Kochplan", `(nicht verfügbar: ${e instanceof Error ? e.message : String(e)})`));
    }
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

  // ── Plating-Regelwerk (für KI-Befüllung) ─────────────────────────────────
  const pRules = platingPlan?.params;
  const capEntries = platingPlan?.dayCapacity ?? {};
  const shiftDays = Object.entries(capEntries).filter(([, c]) => c && (c.shifts ?? 1) >= 2).map(([d]) => d);
  lines.push(section("Plating-Regelwerk", [
    "REGELN FÜR DEN WOCHEN-PLATING-PLAN (beim Generieren und Optimieren IMMER einhalten):",
    "",
    "1. DEMAND & RUNS:",
    `   - Demand = BENL + NORD + DE (3 Märkte, Verden-Volumen)`,
    `   - Demand ≤ ${pRules?.singleRunMaxDemand ?? 2250} → 1 Run, Puffer +${Math.round((pRules?.singleRunBuffer ?? 0.10) * 100)}%`,
    `   - Demand > ${pRules?.singleRunMaxDemand ?? 2250} → 2 Runs, Puffer +${Math.round((pRules?.multiRunBuffer ?? 0.05) * 100)}%`,
    `   - Bei 2 Runs: Run 1 (Hauptlauf) = ${Math.round((pRules?.firstRunPct ?? 0.70) * 100)}% des gepufferten Totals, Run 2 (Refire) = Rest`,
    "",
    "2. TAG-ZUWEISUNG:",
    "   - Hauptlauf (Run 1): Di/Mi/Do (3 Linien, hohe Kapazität)",
    "   - Refire (Run 2): nach dem Hauptlauf-Tag, Fr/Sa bevorzugt (2 Linien)",
    "   - Tage gleichmäßig belasten (niedrigste Auslastung bevorzugen)",
    "   - Bis Donnerstag muss jedes Meal mind. 1× verplant sein (CPT-Deadline)",
    "",
    "3. SEAFOOD-REGEL:",
    "   - Seafood (Fisch/Meeresfrüchte): Run 1 SO SPÄT WIE MÖGLICH (Do bevorzugt, dann Mi)",
    "   - Wenn beide Runs auf einen Tag passen (≤115% Auslastung): Seafood an EINEM Tag (Allergen-Minimierung)",
    "",
    "4. COMPLEXITY-REGEL:",
    "   - Komplexe Meals (cx ≥ 1.15): Run 1 FRÜH (Di bevorzugt) — mehr Zeit für Nacharbeit",
    "   - Einfache Meals (cx ≤ 0.80): flexibel, auch Montag (Spätschicht-Fill-up) erlaubt",
    "",
    "5. SCHICHTEN (Früh/Spätschicht):",
    `   - Tage mit 2 Schichten: ${shiftDays.length ? shiftDays.join(", ") : "keine (alle 1 Schicht)"}`,
    `   - Plating-Rate: ${fmtNum(pRules?.platingRatePerLineHour ?? 900)} Portionen/Linie/Stunde`,
    "   - Eine Schicht ist FIX 7,5 Stunden (Produktionsmitarbeiter-Schichtlänge), unabhängig vom hours-Feld eines Tages",
    "   - Bei 2 Schichten: Frühschicht füllen bis 7,5h × lines × rate, Spätschicht = Differenz (Tagesgesamt = 2 × 7,5h)",
    "   - Große Runs zuerst in die Frühschicht (Stabilität)",
    "   Kapazitäten je Tag (Gesamtstunden — bei 2 Schichten fix 2×7,5h, unabhängig vom gespeicherten hours-Wert):",
    ...Object.entries(capEntries)
      .filter(([, c]) => c && (c.lines ?? 0) > 0)
      .map(([d, c]) => `   - ${d}: ${c!.lines} Linien × ${effectiveDayHours(c)}h${(c!.shifts ?? 1) >= 2 ? " (2 Schichten × 7,5h)" : ""} gesamt`),
    "",
    "6. ALLERGEN-SEQUENZIERUNG (Phase 2, Tagesplan):",
    "   - Aufsteigend: wenige Allergene → viele (keine Reinigung bei nur Zufügen)",
    "   - Allergen-Wegfall = volle Reinigung (30 min) — minimieren!",
    "   - L1 (Highrunner): größter sauberer Block ohne Reinigung",
    "   - L2 (Flex): nimmt die Reinigungen auf",
    "",
    "7. QUALITÄTSKRITERIEN (ein guter Plan erfüllt ALLE):",
    "   - Kein Tag über Kapazität (Portionen ≤ lines × hours × shifts × rate)",
    "   - Seafood am spätestmöglichen Tag",
    "   - Tage gleichmäßig belastet (max. Abweichung < 15%)",
    "   - Alle Meals verplant (keine ungeplanten)",
    "   - Minimale Reinigungen im Tagesplan",
  ].join("\n")));

  lines.push(`\n(Tage: ${PLATING_DAYS.join(" ")}. Küche Mo–Fr. Nur Fakten aus diesem Kontext verwenden. Kochplan lesen: get_kitchen_plan (abgeleitet aus dem Plating-Plan). Wochen-Plating-Plan: generate_plating_plan → simulate_plating_change → propose_plating_plan. Risiko-Übersichten: check_plan_issues. BEI PLATING-ANFRAGEN IMMER: 1) generate_plating_plan, 2) Ergebnis prüfen, 3) simulate_plating_change mit Verbesserungen, 4) propose_plating_plan mit Zusammenfassung.)`);

  return lines.join("\n");
}
