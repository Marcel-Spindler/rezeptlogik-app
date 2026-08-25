// Postblast Live Matching — verknüpft GSheet-Wiegungen mit geplanten Work Orders.
import type { PostblastData, PostblastEntry, PreblastData, RtiData, RtiSubRecipeEntry } from "./gsheetTypes";
import type { ProductionPlan } from "../../core/types";

export interface WoMatchedStatus {
  workOrder: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  plannedKg: number;
  // Post-Blast-Summe — das entscheidende Ist-Gewicht NACH dem Blast Chiller,
  // treibt progressPct/isComplete/isCritical/Backfill (siehe Kommentar unten).
  actualKg: number;
  progressPct: number;
  deltaKg: number;
  isComplete: boolean;
  isCritical: boolean;
  // false = diese WO stammt aus der ET-Master-Liste/dem Live-WMS-Cache, weil
  // für ihre Woche noch kein Mengenplan importiert wurde — es gibt also (noch)
  // kein Soll (auch keine Schätzung). isComplete/isCritical bleiben dafür
  // bewusst false, auch wenn schon gewogen wurde, damit "✓ FERTIG" nie etwas
  // ohne bekanntes Soll behauptet.
  hasPlan: boolean;
  // true = plannedKg ist keine echte Firestore-Zielmenge, sondern aus
  // Ziel-Portionen (KET/WMS) × Rezept-Gewicht/Portion (export-recipes.csv)
  // GESCHÄTZT — isComplete/isCritical gelten trotzdem, aber die UI markiert
  // das sichtbar ("≈ GESCHÄTZT"), damit niemand eine Schätzung mit einem
  // echten Soll verwechselt.
  isEstimated: boolean;
  // Pre-Blast-Summe — die Wiegung VOR dem Blast Chiller, bevor die Charge dort
  // an Menge verliert. Zählt NICHT zu progressPct/isComplete (das würde einen
  // Kühlverlust verschweigen), dient nur als früher Zwischenstatus und als
  // Referenz für shrinkKg.
  preBlastKg: number;
  // Kühlverlust = preBlastKg - actualKg. Nur berechnet, wenn für dieselbe WO
  // BEIDE Stufen vorliegen — sonst 0, damit kein Schwund aus unvollständigen
  // Daten erfunden wird (z.B. wenn nur Pre-Blast schon da ist).
  shrinkKg: number;
  shrinkPct: number;
  // true = schon pre-blast gewogen (Kitchen fertig, Charge im/nach dem
  // Blast Chiller), aber die entscheidende Post-Blast-Wiegung steht noch aus.
  // Verhindert, dass eine WO fälschlich als "kritisch/nichts passiert" gilt,
  // obwohl tatsächlich schon produziert wurde.
  awaitingPostBlast: boolean;
  // true = die Pre-Blast-Summe hat schon (annähernd) das Soll erreicht — es
  // ist unwahrscheinlich, dass noch ein weiterer Batch/Rack dieser WO durch
  // die Küche läuft. Gate für Warnungen/Früherkennung (siehe productionAgent):
  // solange das false ist, könnte "fehlende Post-Blast-Wiegung" schlicht
  // bedeuten, dass der nächste Batch noch kocht — kein Grund zur Sorge.
  preBlastLikelyDone: boolean;
  lastPreBlastWeighing: string | null;
  run: number;
  weighings: PostblastEntry[];
  lastWeighing: string | null;
  // Bereits als Fertigware vorhandener Puffer laut RTI "Plating holding Kg" —
  // unabhängig davon, ob diese WO schon einen Backfill-Bedarf ausgelöst hat
  // (siehe BackfillNeed.platingHoldingKg, das nur in der finalen Backfill-
  // Phase gefüllt ist). Hier je WO verfügbar, damit z.B. eine Fertigstellungs-
  // Prognose schon während der laufenden Produktion weiß, dass ein Teil des
  // Bedarfs bereits gedeckt ist.
  platingHoldingKg: number;
  rtiStatus: RtiSubRecipeEntry["status"] | null;
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
  // Pre-Blast-Wiegungen — optional: fehlt der Feed (noch nicht geladen), läuft
  // alles wie zuvor, nur ohne preBlastKg/shrink/awaitingPostBlast-Zusatzinfo.
  preblast: PreblastData | null | undefined,
  productionPlan: ProductionPlan | undefined,
  rtiData?: RtiData | null,
  // WOs, die nur über die ET-Master-Liste/den Live-WMS-Cache bekannt sind,
  // weil für ihre Woche noch kein Mengenplan importiert wurde (siehe
  // PostblastLiveView). Ohne dieses Flag würde plannedKg=0 die WO sofort als
  // "✓ FERTIG" markieren, sobald irgendetwas gewogen wurde — obwohl das Soll
  // schlicht unbekannt ist.
  unplannedWorkOrders?: ReadonlySet<string>,
  // WOs, deren plannedKg aus Ziel-Portionen × Rezept-Gewicht GESCHÄTZT wurde
  // (siehe PostblastLiveView) statt aus einem echten Firestore-Soll zu stammen.
  estimatedWorkOrders?: ReadonlySet<string>
): { matched: WoMatchedStatus[]; meals: MealProgress[]; backfill: BackfillNeed[] } {
  if (!productionPlan || !postblast) return { matched: [], meals: [], backfill: [] };

  const { byWo: rtiByWo } = buildRtiIndex(rtiData);
  const matched: WoMatchedStatus[] = [];

  for (const wo of productionPlan.rows) {
    const woNum = wo.workOrder;
    const hasPlan = !unplannedWorkOrders?.has(woNum);
    const isEstimated = hasPlan && (estimatedWorkOrders?.has(woNum) ?? false);
    const weighings = postblast.byWorkOrder.get(woNum) ?? [];
    const actualKg = weighings.reduce((s, e) => s + e.weightKg, 0);
    const preWeighings = preblast?.byWorkOrder.get(woNum) ?? [];
    const preBlastKg = preWeighings.reduce((s, e) => s + e.weightKg, 0);
    const shrinkKg = preBlastKg > 0 && actualKg > 0 ? Math.max(0, preBlastKg - actualKg) : 0;
    const shrinkPct = shrinkKg > 0 ? (shrinkKg / preBlastKg) * 100 : 0;
    const awaitingPostBlast = hasPlan && preBlastKg > 0 && actualKg === 0;
    const plannedKg = wo.postKg || wo.kitchenKg || wo.stagingKg || 0;
    // Eine WO kann über mehrere Batches/Racks laufen (mehrere Pre-Blast-
    // Wiegungen für dieselbe WO-Nummer) — ein einzelner fertiger Rack heißt
    // NICHT, dass die ganze WO durch die Küche ist, es könnte noch ein
    // weiterer Batch unterwegs sein. Erst wenn die Pre-Blast-Summe schon nah
    // ans Soll heranreicht, ist es wahrscheinlich, dass kein weiterer Batch
    // mehr kommt — nur dann darf "Post-Blast-Wiegung fehlt" als Warnsignal
    // gelten (siehe analyzeAwaitingPostBlast/analyzeShrinkProjection).
    const preBlastLikelyDone = hasPlan && plannedKg > 0 && preBlastKg >= plannedKg * 0.9;
    const progressPct = plannedKg > 0 ? (actualKg / plannedKg) * 100 : (actualKg > 0 && hasPlan ? 100 : 0);
    const deltaKg = actualKg - plannedKg;
    const isComplete = hasPlan && progressPct >= 95;
    // awaitingPostBlast ausgenommen: da wurde nachweislich schon produziert
    // (Pre-Blast-Gewicht da), das ist kein "nichts passiert"-Kritisch-Fall,
    // sondern wartet nur noch auf die zweite Wiegung.
    const isCritical = hasPlan && plannedKg > 0 && progressPct < 30 && actualKg === 0 && !awaitingPostBlast;
    const rtiEntry = rtiByWo.get(woNum);

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
      hasPlan,
      isEstimated,
      preBlastKg,
      shrinkKg,
      shrinkPct,
      awaitingPostBlast,
      preBlastLikelyDone,
      lastPreBlastWeighing: preWeighings.length > 0 ? preWeighings[preWeighings.length - 1].timestamp || null : null,
      run: wo.run ?? 1,
      weighings,
      lastWeighing: weighings.length > 0 ? weighings[weighings.length - 1].timestamp : null,
      platingHoldingKg: rtiEntry?.platingHoldingKg ?? 0,
      rtiStatus: rtiEntry?.status ?? null,
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
    // Nur WOs mit echtem Soll (plannedKg > 0) fließen in den Meal-Fortschritt
    // ein — sonst trägt eine WO ohne Soll ihre volle Ist-Menge zum Zähler bei,
    // ohne je etwas zum Nenner beizutragen, und treibt den % künstlich über
    // 100%, während andere WOs desselben Meals noch bei 0% stehen.
    const plannedWos = wos.filter(w => w.plannedKg > 0);
    const totalPlannedKg = plannedWos.reduce((s, w) => s + w.plannedKg, 0);
    const totalActualKg = plannedWos.reduce((s, w) => s + w.actualKg, 0);
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
  // (rtiByWo wurde oben schon für rtiStatus/platingHoldingKg je WO gebaut.)

  const bySubRecipeGroup = new Map<string, WoMatchedStatus[]>();
  for (const m of matched) {
    // Geschätzte Sollmengen (Portionen × Rezept-Gewicht statt echtem Firestore-
    // Soll) sollen nie einen Backfill auslösen — die Unsicherheit der Schätzung
    // würde sonst direkt eine echte WMS-Aktion anstoßen.
    if (m.plannedKg <= 0 || m.isEstimated) continue;
    const key = `${m.recipeCode}||${m.subRecipe}`;
    if (!bySubRecipeGroup.has(key)) bySubRecipeGroup.set(key, []);
    bySubRecipeGroup.get(key)!.push(m);
  }

  const backfill: BackfillNeed[] = [];
  for (const group of bySubRecipeGroup.values()) {
    const rtiStatuses = group.map(w => w.rtiStatus);
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
    const platingHoldingKg = group.reduce((s, w) => s + w.platingHoldingKg, 0);

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
