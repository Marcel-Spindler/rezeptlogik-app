// Postblast Live Matching — verknüpft GSheet-Wiegungen mit geplanten Work Orders.
import type { PostblastData, PostblastEntry, RtiData, RtiSubRecipeEntry } from "./gsheetTypes";
import type { ProductionPlan } from "../../core/types";

export interface WoMatchedStatus {
  workOrder: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  plannedKg: number;
  actualKg: number;
  progressPct: number;
  deltaKg: number;
  isComplete: boolean;
  isCritical: boolean;
  run: number;
  weighings: PostblastEntry[];
  lastWeighing: string | null;
}

export interface MealProgress {
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  workOrders: WoMatchedStatus[];
  totalPlannedKg: number;
  totalActualKg: number;
  progressPct: number;
  completedWOs: number;
  totalWOs: number;
  criticalWOs: WoMatchedStatus[];
}

export interface BackfillNeed {
  // Letzte reguläre WO dieses Sub-Rezepts — nur zur internen Zuordnung/als
  // React-Key. KEINE Backfill-WO-Nummer wird hier vorgeschlagen oder erfunden;
  // die eigentliche Backfill-WO wird von Hand in einem anderen System angelegt.
  workOrder: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  missingKg: number;
  missingPct: number;
  // Fehlende Stückzahl (Portionen) — die für den Backfill relevante Zahl.
  estimatedPortions: number;
  priority: "critical" | "behind" | "on-track";
  // Bereits als Fertigware vorhandener Puffer laut RTI "Plating holding Kg" —
  // senkt den realen Bedarf, wird hier aber nur informativ ausgewiesen.
  platingHoldingKg: number;
  // true = "alle regulären WOs durch" stammt aus dem echten RTI-Status
  // ("done"/"no"), nicht nur aus unserer 95%-Gewichtsschätzung.
  rtiConfirmed: boolean;
}

function buildRtiIndex(rtiData: RtiData | null | undefined) {
  const byWo = new Map<string, RtiSubRecipeEntry>();
  for (const meal of rtiData?.meals ?? []) {
    for (const sub of meal.subRecipes) {
      byWo.set(sub.workOrder, sub);
    }
  }
  return { byWo };
}

export function matchPostblastToWorkOrders(
  postblast: PostblastData | null,
  productionPlan: ProductionPlan | undefined,
  rtiData?: RtiData | null
): { matched: WoMatchedStatus[]; meals: MealProgress[]; backfill: BackfillNeed[] } {
  if (!productionPlan || !postblast) return { matched: [], meals: [], backfill: [] };

  const matched: WoMatchedStatus[] = [];

  for (const wo of productionPlan.rows) {
    const woNum = wo.workOrder;
    const weighings = postblast.byWorkOrder.get(woNum) ?? [];
    const actualKg = weighings.reduce((s, e) => s + e.rawWeightKg, 0);
    const plannedKg = wo.postKg || wo.kitchenKg || wo.stagingKg || 0;
    const progressPct = plannedKg > 0 ? (actualKg / plannedKg) * 100 : (actualKg > 0 ? 100 : 0);
    const deltaKg = actualKg - plannedKg;
    const isComplete = progressPct >= 95;
    const isCritical = plannedKg > 0 && progressPct < 30 && actualKg === 0;

    matched.push({
      workOrder: woNum,
      subRecipe: wo.subRecipe,
      recipeCode: wo.recipeCode,
      recipeName: wo.recipeName,
      plannedMeals: wo.plannedMeals,
      plannedKg,
      actualKg,
      progressPct: Math.min(progressPct, 100),
      deltaKg,
      isComplete,
      isCritical,
      run: wo.run ?? 1,
      weighings,
      lastWeighing: weighings.length > 0 ? weighings[weighings.length - 1].timestamp : null,
    });
  }

  // Gruppierung nach Meal (recipeCode)
  const mealMap = new Map<string, WoMatchedStatus[]>();
  for (const m of matched) {
    if (!mealMap.has(m.recipeCode)) mealMap.set(m.recipeCode, []);
    mealMap.get(m.recipeCode)!.push(m);
  }

  const meals: MealProgress[] = [];
  for (const [recipeCode, wos] of mealMap) {
    const totalPlannedKg = wos.reduce((s, w) => s + w.plannedKg, 0);
    const totalActualKg = wos.reduce((s, w) => s + w.actualKg, 0);
    meals.push({
      recipeCode,
      recipeName: wos[0].recipeName,
      plannedMeals: wos[0].plannedMeals,
      workOrders: wos,
      totalPlannedKg,
      totalActualKg,
      progressPct: totalPlannedKg > 0 ? Math.min((totalActualKg / totalPlannedKg) * 100, 100) : 0,
      completedWOs: wos.filter(w => w.isComplete).length,
      totalWOs: wos.length,
      criticalWOs: wos.filter(w => w.isCritical),
    });
  }
  meals.sort((a, b) => a.progressPct - b.progressPct);

  // Backfill-Berechnung: Was fehlt noch?
  // Ein Backfill wird erst vorgeschlagen, wenn ALLE regulären WOs eines Sub-Rezepts
  // (über alle Runs hinweg) bereits fertig gewogen sind und die Summe der Wiegungen
  // den Plan trotzdem nicht erreicht. Einzelne WOs, die im Schichtverlauf einfach
  // noch nicht an der Reihe waren, gelten NICHT als "Backfill nötig". Ist das RTI-
  // Sheet verbunden, gilt dessen Status ("done"/"no") als zusätzliche, verlässlichere
  // Quelle — inklusive Veto: markiert der Mensch eine WO im Sheet als "no" (kein
  // Backfill nötig, meist Überschuss), wird die ganze Gruppe übersprungen.
  const { byWo: rtiByWo } = buildRtiIndex(rtiData);

  const bySubRecipeGroup = new Map<string, WoMatchedStatus[]>();
  for (const m of matched) {
    if (m.plannedKg <= 0) continue;
    const key = `${m.recipeCode}||${m.subRecipe}`;
    if (!bySubRecipeGroup.has(key)) bySubRecipeGroup.set(key, []);
    bySubRecipeGroup.get(key)!.push(m);
  }

  const backfill: BackfillNeed[] = [];
  for (const group of bySubRecipeGroup.values()) {
    const rtiStatuses = group.map(w => rtiByWo.get(w.workOrder)?.status);
    if (rtiStatuses.some(s => s === "not-needed")) continue; // Mensch hat "kein Backfill" markiert

    const allRegularWosDone = group.every((w, idx) => w.isComplete || rtiStatuses[idx] === "done");
    if (!allRegularWosDone) continue; // reguläre WOs noch nicht alle durch

    const plannedKg = group.reduce((s, w) => s + w.plannedKg, 0);
    const actualKg = group.reduce((s, w) => s + w.actualKg, 0);
    const missingKg = Math.max(0, plannedKg - actualKg);
    if (missingKg < 0.5) continue;

    const anchor = group[group.length - 1];
    const missingPct = plannedKg > 0 ? (missingKg / plannedKg) * 100 : 0;
    const totalPlannedMeals = group.reduce((s, w) => s + w.plannedMeals, 0);
    const portionsPerKg = totalPlannedMeals > 0 && plannedKg > 0 ? totalPlannedMeals / plannedKg : 0;
    const platingHoldingKg = group.reduce((s, w) => s + (rtiByWo.get(w.workOrder)?.platingHoldingKg ?? 0), 0);

    backfill.push({
      workOrder: anchor.workOrder,
      subRecipe: anchor.subRecipe,
      recipeCode: anchor.recipeCode,
      recipeName: anchor.recipeName,
      missingKg,
      missingPct,
      estimatedPortions: Math.round(missingKg * portionsPerKg),
      priority: missingPct > 80 ? "critical" as const : missingPct > 40 ? "behind" as const : "on-track" as const,
      platingHoldingKg,
      rtiConfirmed: rtiStatuses.some(s => s === "done"),
    });
  }
  backfill.sort((a, b) => b.missingKg - a.missingKg);

  return { matched, meals, backfill };
}
