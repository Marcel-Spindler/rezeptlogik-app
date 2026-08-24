// WO-Abgleich – reine Join-/Vergleichslogik über alle Quellen, die dieselbe
// Work-Order-Nummer kennen: App-Produktionsplan, KET-Plan, PET-Plan,
// WMS-Submeals (Work Orders-Station, on-demand) und Postblast-Wiegungen.
// Keine Hooks/State hier — nur pure Funktionen, damit sowohl der globale
// WoReconciliationContext als auch spätere Auswertungen (Analyse der
// gespeicherten Snapshots) dieselbe Logik nutzen können.
import type { ProductionPlan } from "../../core/types";
import type { KetRow } from "../ket-plan/ketTypes";
import type { PetRow } from "../pet-plan/petTypes";
import type { PostblastData } from "../gsheet-monitor/gsheetTypes";
import { recipeWeightKey, type RecipeWeightLookup } from "../gsheet-monitor/parsers/parseExportRecipes";
import type { WorkorderRow } from "../wms-overview/wmsTypes";
import { weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import type { ReconcileSource, WoReconciliationRow } from "./woReconcileTypes";

// Ziel-Portionen × Gramm/Portion (aus export-recipes.csv) = geschätzte
// Ziel-Menge in kg. Gleiche Formel wie estimatePlannedKg in PostblastLiveView,
// hier dupliziert weil pure-only (keine Komponenten-Importe in diesem Modul).
function estimateKetKg(weights: RecipeWeightLookup | null, recipeCode: string, subRecipe: string, portions: number | null): number | null {
  if (!weights || !portions || portions <= 0) return null;
  const grams = weights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
  return grams == null ? null : (grams * portions) / 1000;
}

// Größte relative Abweichung zwischen den (mind. 2) vorhandenen Werten einer
// Gruppe unabhängig ermittelter Soll-Zahlen — schon das ist ein Signal, bevor
// überhaupt etwas gewogen wurde.
function relMismatch(values: (number | null)[], thresholdPct = 15): boolean {
  const present = values.filter((v): v is number => v != null && v > 0);
  if (present.length < 2) return false;
  const max = Math.max(...present);
  const min = Math.min(...present);
  return ((max - min) / max) * 100 > thresholdPct;
}

export function reconcileWorkOrders(
  productionPlan: ProductionPlan | undefined,
  ketRows: KetRow[] | null,
  petRows: PetRow[] | null,
  postblast: PostblastData | null,
  weights: RecipeWeightLookup | null,
  wmsWorkorders?: WorkorderRow[] | null,
): WoReconciliationRow[] {
  const appByWo = new Map<string, ProductionPlan["rows"][number]>();
  for (const r of productionPlan?.rows ?? []) if (r.workOrder) appByWo.set(r.workOrder, r);

  const ketByWo = new Map<string, KetRow>();
  for (const r of ketRows ?? []) if (r.woNumber) ketByWo.set(r.woNumber, r);

  const petByWo = new Map<string, PetRow>();
  for (const r of petRows ?? []) if (r._woNumber) petByWo.set(r._woNumber, r);

  const wmsByWo = new Map<string, WorkorderRow>();
  for (const r of wmsWorkorders ?? []) if (r.woNumber) wmsByWo.set(r.woNumber, r);

  const allWos = new Set<string>([
    ...appByWo.keys(), ...ketByWo.keys(), ...petByWo.keys(), ...wmsByWo.keys(),
    ...(postblast?.byWorkOrder.keys() ?? []),
  ]);

  const rows: WoReconciliationRow[] = [];
  for (const wo of allWos) {
    if (!wo) continue;
    const app = appByWo.get(wo);
    const ket = ketByWo.get(wo);
    const pet = petByWo.get(wo);
    const wms = wmsByWo.get(wo);
    const weighings = postblast?.byWorkOrder.get(wo) ?? [];

    const recipeCode = app?.recipeCode || ket?.recipeCode || pet?.recipeCode || wms?.mealItemNumber || "";
    const recipeName = app?.recipeName || ket?.recipeName || pet?.recipeName || wms?.mealItemDescription || "";
    const subRecipe = app?.subRecipe || ket?.subRecipeName || wms?.submealItemDescription || "";
    if (!recipeCode) continue; // ohne Rezept-Zuordnung nicht auswertbar

    const presentIn: ReconcileSource[] = [];
    if (app) presentIn.push("app");
    if (ket) presentIn.push("ket");
    if (pet) presentIn.push("pet");
    if (wms) presentIn.push("wms");
    if (weighings.length > 0) presentIn.push("postblast");

    const appPortions = app?.plannedMeals ?? null;
    const ketPortions = ket?.targetPortions ?? null;
    const petTarget = pet?.target ?? null;
    const petMapped = pet?.mapped ?? null;

    const appKg = app ? (app.postKg || app.kitchenKg || app.stagingKg || null) : null;
    const ketKg = ket ? estimateKetKg(weights, ket.recipeCode, ket.subRecipeName, ket.targetPortions) : null;
    const actualKg = weighings.length > 0 ? weighings.reduce((s, w) => s + w.weightKg, 0) : null;

    // Bestes verfügbares Soll (App bevorzugt, sonst KET-Schätzung) für den
    // Ist/Soll-Fortschritt — gleicher Fallback wie postblastMatch.ts.
    const plannedKgBest = appKg || ketKg || 0;
    const progressPct = plannedKgBest > 0 ? ((actualKg ?? 0) / plannedKgBest) * 100 : null;
    const isComplete = plannedKgBest > 0 && (progressPct ?? 0) >= 95;
    const isCritical = plannedKgBest > 0 && weighings.length === 0 && (progressPct ?? 0) < 30;

    const kgMismatch = relMismatch([appKg, ketKg]);
    const portionsMismatch = relMismatch([appPortions, ketPortions, petTarget]);
    // Nur werten, wenn überhaupt PET-Daten geladen sind — sonst wäre "fehlt in
    // PET" für JEDE WO wahr, nur weil niemand die CSV hochgeladen hat.
    const missingPetAssignment = !!petRows && petRows.length > 0 && !pet && (!!app || !!ket);

    // Severity bildet bewusst NUR Uneinigkeit zwischen den Quellen ab, nicht
    // den Produktionsfortschritt (isCritical/isComplete) — eine WO, die einfach
    // noch nicht dran war, ist keine "Unstimmigkeit" und soll die Liste nicht
    // mit Dauer-Rot fluten, nur weil noch nichts gewogen wurde.
    let severity: WoReconciliationRow["severity"] = "ok";
    if (kgMismatch && portionsMismatch) severity = "critical";
    else if (kgMismatch || portionsMismatch || missingPetAssignment) severity = "warn";

    rows.push({
      workOrder: wo,
      weekNum: weekPrefixFromWoNumber(wo),
      recipeCode, recipeName, subRecipe,
      presentIn,
      appPortions, ketPortions, petTarget, petMapped,
      appKg: appKg || null, ketKg, actualKg,
      progressPct, isComplete, isCritical,
      kgMismatch, portionsMismatch, missingPetAssignment,
      severity,
      weighingCount: weighings.length,
      lastWeighing: weighings.length ? weighings[weighings.length - 1].timestamp : null,
    });
  }

  return rows;
}

export function severityByRecipe(rows: WoReconciliationRow[]): Map<string, { severity: WoReconciliationRow["severity"]; count: number }> {
  const rank = { ok: 0, warn: 1, critical: 2 } as const;
  const map = new Map<string, { severity: WoReconciliationRow["severity"]; count: number }>();
  for (const row of rows) {
    if (row.severity === "ok") continue;
    const current = map.get(row.recipeCode);
    if (!current) { map.set(row.recipeCode, { severity: row.severity, count: 1 }); continue; }
    current.count += 1;
    if (rank[row.severity] > rank[current.severity]) current.severity = row.severity;
  }
  return map;
}
