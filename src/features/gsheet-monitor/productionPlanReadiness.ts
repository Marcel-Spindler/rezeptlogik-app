// Gleicht die Live-Postblast-Produktion mit den "Ready"/"Min Needs"-Spalten
// aus dem F_VE-Production-Plan-Sheet ab (Tab "W{NN} - Plating Plan [WIP]").
//
// WICHTIG zur Semantik (verifiziert per Live-Dump am 2026-08-25, nicht nur
// geraten): "Ready Do/Fr/Sa" ist eine PORTIONEN-Zahl (kein Uhrzeit-Deadline —
// die Spalten enthalten reine Ganzzahlen, kein Zeitformat). "Min Needs" ist
// die vom Sheet selbst schon berechnete Differenz Ziel−Verfügbar für denselben
// Tag (negativ = Überschuss, siehe gsheetTypes.ts). Ob "Ready" pro Tag ein
// eigenständiges Ziel oder ein wochenweit konstanter Gesamtwert ist, ließ sich
// aus den Stichproben NICHT zweifelsfrei klären (beide beobachteten Zeilen
// hatten für Do/Fr/Sa denselben Wert) — deshalb wird hier bewusst NICHT ein
// eigener "X Stunden zu spät"-Wert erfunden, sondern nur die Sheet-eigenen
// Zahlen (Ready-Ziel, Min-Needs-Differenz) neben unserer live geschätzten
// Portionenzahl gezeigt. Der Mensch zieht den Schluss.
import type { ProductionPlanRow } from "./gsheetTypes";
import type { MealProgress } from "./postblastMatch";

export type ReadyCheckpoint = "thu" | "fri" | "sat";

export interface PlanReadinessCheck {
  code: string;
  checkpoint: ReadyCheckpoint;
  checkpointLabel: string;
  readyTargetPortions: number;
  // Aus unserem Live-Fortschritt geschätzt: geplante Meal-Portionen × kg-Fortschritt
  // (dieselbe Umrechnung wie estimatedPortions in postblastMatch.ts) — keine
  // eigene Portionen-Zählung, nur eine Näherung auf Basis der kg-Wiegungen.
  estimatedProducedPortions: number;
  // Direkt aus dem Sheet übernommen, nicht selbst berechnet (siehe Kommentar oben).
  sheetMinNeedsPortions: number | null;
}

const CHECKPOINTS: Record<ReadyCheckpoint, { label: string }> = {
  thu: { label: "Donnerstag" },
  fri: { label: "Freitag" },
  sat: { label: "Samstag" },
};

// Der naechste Ready-Checkpoint (Do/Fr/Sa) INNERHALB DER WOCHE, zu der "now"
// gehoert: So/Mo/Di/Mi/Do -> "Do", Fr -> "Fr", Sa -> "Sa". Ein Sonntag zaehlt
// bewusst schon zur NEUEN Woche (Do/Fr/Sa dieser neuen Woche), nicht zur alten
// - Voraussetzung ist, dass "row" aus genau der Wochen-Tab-Auswahl stammt, die
// zu "now" passt (siehe Aufrufer in PostblastLiveView: row kommt immer aus dem
// gerade ausgewaehlten Wochen-Tab). Fuer eine bewusst zurueckgeblaetterte
// vergangene Woche liefert das entsprechend einen fuer die alte Woche nicht
// mehr sinnvollen Checkpoint -- unkritisch, weil das nur eine informative
// Empfehlung ist, kein Automatismus.
export function nextReadyCheckpoint(now: Date): ReadyCheckpoint {
  const day = now.getDay(); // 0=So .. 6=Sa
  if (day === 5) return "fri";
  if (day === 6) return "sat";
  return "thu";
}

export function checkPlanReadiness(row: ProductionPlanRow, meal: MealProgress, now = new Date()): PlanReadinessCheck | null {
  const checkpoint = nextReadyCheckpoint(now);
  const readyTargetPortions = row.readyByDay[checkpoint];
  if (readyTargetPortions == null || readyTargetPortions <= 0) return null;

  const estimatedProducedPortions = meal.totalPlannedKg > 0
    ? meal.plannedMeals * (meal.totalActualKg / meal.totalPlannedKg)
    : 0;

  return {
    code: row.code,
    checkpoint,
    checkpointLabel: CHECKPOINTS[checkpoint].label,
    readyTargetPortions,
    estimatedProducedPortions,
    sheetMinNeedsPortions: row.minNeedsByDay[checkpoint],
  };
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

export function describePlanReadiness(check: PlanReadinessCheck): string {
  const gap = check.readyTargetPortions - check.estimatedProducedPortions;
  const gapNote = gap > 0
    ? `Live-Schätzung liegt ~${fmtInt(gap)} Portionen darunter`
    : `Live-Schätzung liegt bereits darüber`;
  const sheetNote = check.sheetMinNeedsPortions != null
    ? check.sheetMinNeedsPortions < 0
      ? ` | Plan-Sheet selbst meldet Überschuss (Min Needs ${fmtInt(check.sheetMinNeedsPortions)})`
      : ` | Plan-Sheet meldet ebenfalls einen Bedarf (Min Needs +${fmtInt(check.sheetMinNeedsPortions)})`
    : "";
  return `${check.code}: Plan-Ziel „Ready ${check.checkpointLabel}" = ${fmtInt(check.readyTargetPortions)} Portionen, live geschätzt aktuell ~${fmtInt(check.estimatedProducedPortions)} produziert (${gapNote}).${sheetNote}`;
}
