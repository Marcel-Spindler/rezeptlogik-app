// Fertigstellungs-Prognose — verknüpft mehrere im Postblast-Live-Feature
// bereits vorhandene Datenquellen (eigene Wiegungen, Wiegungen anderer WOs
// desselben Sub-Rezepts, RTI-Holding-Puffer) zu einer ETA je WO/Meal.
//
// Zwei Tempo-Quellen, in dieser Reihenfolge versucht:
// 1) "eigene-wiegung" — Tempo aus den HEUTIGEN Wiegungen dieser einen WO.
// 2) "sub-rezept-schnitt" — hat diese WO selbst noch zu wenig/keine eigenen
//    Wiegungen (z.B. noch nicht gestartet), aber ANDERE WOs desselben
//    Sub-Rezepts (egal aus welchem Meal — dieselbe Zubereitung läuft überall
//    mit vergleichbarem Tempo durch dieselbe Station) haben schon produziert,
//    wird deren durchschnittliches Tempo als Referenz genutzt.
// Gibt es keine von beidem, bleibt die ETA bewusst null statt einer
// erfundenen Zahl (gleiche Philosophie wie computeShiftSummary/
// analyzeShrinkProjection in productionAgent.ts).
//
// Meal-Ebene: ein Meal ist erst plate-bereit, wenn ALLE seine WOs durch sind
// — die Meal-ETA ist daher die ETA der langsamsten (limitierenden) offenen
// WO, nicht ein über alle Sub-Rezepte gemitteltes Tempo (das würde schnelle
// und langsame Zubereitungen unsinnig vermischen).
import type { PostblastEntry } from "./gsheetTypes";
import type { MealProgress, WoMatchedStatus } from "./postblastMatch";

export type PaceSource = "eigene-wiegung" | "sub-rezept-schnitt" | "keine";

export interface WoEta {
  wo: WoMatchedStatus;
  remainingKg: number;
  paceKgPerHour: number;
  paceSource: PaceSource;
  etaHours: number | null;
  etaTime: Date | null;
}

export interface MealEta {
  remainingKg: number;
  etaHours: number | null;
  etaTime: Date | null;
  // Die offene WO, die den Meal-Abschluss zeitlich bestimmt (langsamste
  // vorhersagbare WO) — null, wenn das Meal schon fertig ist oder für KEINE
  // offene WO überhaupt ein Tempo (eigen oder Sub-Rezept-Schnitt) vorliegt.
  limitingWo: WoMatchedStatus | null;
  // Offene WOs ohne jede Tempo-Referenz — die Meal-ETA (falls vorhanden)
  // berücksichtigt diese NICHT und kann daher zu optimistisch sein, wenn
  // gerade eine davon in Wahrheit die langsamste wird.
  unpredictableWos: WoMatchedStatus[];
}

function paceFromEntries(entries: readonly PostblastEntry[]): number | null {
  if (entries.length < 2) return null;
  const timestamps = entries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  if (timestamps.length < 2) return null;
  const elapsedHours = (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000;
  if (elapsedHours <= 0) return null;
  const totalKg = entries.reduce((s, e) => s + e.weightKg, 0);
  return totalKg > 0 ? totalKg / elapsedHours : null;
}

function ownLivePace(wo: WoMatchedStatus): number | null {
  const today = new Date().toISOString().slice(0, 10);
  const todays = wo.weighings.filter(e => e.date === today);
  if (todays.length < 2) return null;
  const timestamps = todays.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  if (timestamps.length < 2) return null;
  const elapsedHours = (Date.now() - Math.min(...timestamps)) / 3_600_000;
  if (elapsedHours <= 0) return null;
  const totalKg = todays.reduce((s, e) => s + e.weightKg, 0);
  return totalKg > 0 ? totalKg / elapsedHours : null;
}

function peerPace(wo: WoMatchedStatus, allMatched: readonly WoMatchedStatus[]): number | null {
  const paces = allMatched
    .filter(p => p.workOrder !== wo.workOrder && p.subRecipe === wo.subRecipe)
    .map(p => paceFromEntries(p.weighings))
    .filter((p): p is number => p != null);
  if (paces.length === 0) return null;
  return paces.reduce((s, p) => s + p, 0) / paces.length;
}

export function estimateWoEta(wo: WoMatchedStatus, allMatched: readonly WoMatchedStatus[] = []): WoEta {
  const remainingKg = Math.max(0, wo.plannedKg - wo.actualKg);
  if (remainingKg <= 0) {
    return { wo, remainingKg: 0, paceKgPerHour: 0, paceSource: "eigene-wiegung", etaHours: 0, etaTime: new Date() };
  }

  const own = ownLivePace(wo);
  const pace = own ?? peerPace(wo, allMatched);
  const paceSource: PaceSource = own != null ? "eigene-wiegung" : pace != null ? "sub-rezept-schnitt" : "keine";
  if (pace == null) return { wo, remainingKg, paceKgPerHour: 0, paceSource, etaHours: null, etaTime: null };

  const etaHours = remainingKg / pace;
  return { wo, remainingKg, paceKgPerHour: pace, paceSource, etaHours, etaTime: new Date(Date.now() + etaHours * 3_600_000) };
}

export function estimateMealEta(meal: MealProgress, allMatched: readonly WoMatchedStatus[]): MealEta {
  const open = meal.workOrders.filter(w => w.hasPlan && w.plannedKg > 0 && !w.isComplete);
  const remainingKg = open.reduce((s, w) => s + Math.max(0, w.plannedKg - w.actualKg), 0);
  if (open.length === 0) return { remainingKg: 0, etaHours: 0, etaTime: new Date(), limitingWo: null, unpredictableWos: [] };

  const perWo = open.map(w => estimateWoEta(w, allMatched));
  const predictable = perWo.filter((e): e is WoEta & { etaHours: number; etaTime: Date } => e.etaHours != null);
  const unpredictableWos = perWo.filter(e => e.etaHours == null).map(e => e.wo);

  if (predictable.length === 0) return { remainingKg, etaHours: null, etaTime: null, limitingWo: null, unpredictableWos };

  const slowest = predictable.reduce((a, b) => (a.etaHours > b.etaHours ? a : b));
  return { remainingKg, etaHours: slowest.etaHours, etaTime: slowest.etaTime, limitingWo: slowest.wo, unpredictableWos };
}

// ─── Menschenlesbare Begründung ─────────────────────────────────────────────
// Einmal implementiert, von Chat (postblastChat.ts) UND den proaktiven
// Empfehlungen (productionAgent.ts) genutzt — jede "bald fertig"-Aussage der
// KI muss WANN (Uhrzeit) und WARUM (Tempo-Quelle, limitierende WO, Holding-
// Puffer) mitliefern, nie nur eine nackte Einschätzung ohne Begründung.

function paceSourceNote(source: PaceSource): string {
  return source === "sub-rezept-schnitt" ? " (Ø anderer WOs dieses Sub-Rezepts, noch keine eigene Wiegung)" : "";
}

export function describeWoEtaReasoning(wo: WoMatchedStatus, allMatched: readonly WoMatchedStatus[]): string {
  if (wo.isComplete) return `"${wo.subRecipe}" (WO ${wo.workOrder}) ist bereits fertig.`;
  if (!wo.hasPlan) return `"${wo.subRecipe}" (WO ${wo.workOrder}) hat kein bekanntes Soll — keine Prognose möglich.`;
  const eta = estimateWoEta(wo, allMatched);
  if (eta.etaHours == null) {
    return `"${wo.subRecipe}" (WO ${wo.workOrder}): noch ${eta.remainingKg.toFixed(0)} kg offen, aber weder eigene Wiegungen noch Referenzwerte anderer WOs dieses Sub-Rezepts — keine Prognose möglich.`;
  }
  const clock = eta.etaTime!.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const holdingNote = wo.platingHoldingKg > 0.5 ? ` | ${wo.platingHoldingKg.toFixed(0)} kg Holding-Puffer laut RTI bereits vorhanden` : "";
  return `"${wo.subRecipe}" (WO ${wo.workOrder}): noch ${eta.remainingKg.toFixed(0)} kg offen, bei ${eta.paceKgPerHour.toFixed(0)} kg/h${paceSourceNote(eta.paceSource)} voraussichtlich fertig ca. ${clock} Uhr (in ~${eta.etaHours.toFixed(1)} h)${holdingNote}.`;
}

export function describeMealEtaReasoning(meal: MealProgress, allMatched: readonly WoMatchedStatus[]): string {
  if (meal.completedWOs === meal.totalWOs) {
    return `${meal.recipeCode} "${meal.recipeName}" ist bereits fertig — kann geplatet werden.`;
  }
  const eta = estimateMealEta(meal, allMatched);
  if (eta.etaHours == null) {
    return `${meal.recipeCode} "${meal.recipeName}": noch ${eta.remainingKg.toFixed(0)} kg offen, aber weder eigene Wiegungen noch Referenzwerte anderer WOs — keine Prognose möglich.`;
  }
  const clock = eta.etaTime!.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const limiting = eta.limitingWo ? ` — limitiert durch "${eta.limitingWo.subRecipe}" (WO ${eta.limitingWo.workOrder})` : "";
  const holding = meal.workOrders.reduce((s, w) => s + w.platingHoldingKg, 0);
  const holdingNote = holding > 0.5 ? ` Bereits ${holding.toFixed(0)} kg Holding-Puffer laut RTI vorhanden.` : "";
  const uncertain = eta.unpredictableWos.length > 0
    ? ` ⚠ ${eta.unpredictableWos.length} weitere offene WO${eta.unpredictableWos.length > 1 ? "s" : ""} ohne jede Tempo-Referenz (${eta.unpredictableWos.map(w => `"${w.subRecipe}"`).join(", ")}) — könnte später werden.`
    : "";
  return `${meal.recipeCode} "${meal.recipeName}": noch ${eta.remainingKg.toFixed(0)} kg offen, voraussichtlich fertig ca. ${clock} Uhr (in ~${eta.etaHours.toFixed(1)} h)${limiting}.${holdingNote}${uncertain}`;
}
