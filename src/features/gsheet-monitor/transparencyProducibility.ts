// Transparency Plan – Produzierbarkeits-Engine. Eigene, transparente Regel
// statt die fragile Sheet-Formel ("Ready to plate?" in Easier
// overview/Total Easier overview, nur für ein manuell selektiertes Meal
// sichtbar) nachzubauen — Marcels Vorgabe: "mach das, was stabil die besten
// Ergebnisse liefert". Regel:
//
// 1. Für jedes Subrezept eines Meals (aus Transperancy Total Overview, über
//    alle zugehörigen Work Orders summiert): gewogenes Post-Blast-kg
//    (Importrange Weights) vs. geplantes Post-kg. "weighedComplete", wenn
//    das Verhältnis die Toleranzschwelle erreicht.
// 2. Ein Meal ist "ready", wenn ALLE seine Subrezepte weighedComplete sind,
//    "blocked", wenn noch KEINS davon angefangen ist, sonst "partial".
// 3. Kein Blackbox-Bool: jedes Subrezept trägt seinen eigenen Fortschritt
//    (pct, geplant/gewogen kg) für die Drilldown-Ansicht — wichtig, weil die
//    Sheet-Daten selbst fehleranfällig sind (siehe Issue-Tracker-Einträge zu
//    MSKU-/Breakdown-Tool-Gewichtsfehlern) und die Schwelle bei Bedarf
//    nachjustiert werden muss.
// 4. KW-Trennung: "Transperancy Total Overview" kumuliert Work Orders über
//    viele Wochen/Runs hinweg, OHNE selbst nach KW zu filtern — anders als
//    "Planning Check", das wirklich nur die aktuell laufende Woche zeigt.
//    Ohne Trennung würden alte/andere-Wochen-Reste als "Meal" auftauchen
//    oder deren Fortschritt sich mit der aktuellen Woche vermischen. Fix:
//    dieselbe Regel, die PostblastLiveView schon für Wiegungen nutzt — die
//    WO-Nummer trägt die KW als Präfix ("35-1" = KW35, weekPrefixFromWoNumber
//    in wms-overview/wmsWeeks.ts), das ist zuverlässiger als jedes freie
//    Datumsfeld im Sheet. Nur Work Orders mit passendem Präfix zählen für die
//    aktuelle Woche; Rezepte, die NICHT im aktuellen Planning-Check-Tab
//    stehen (= nicht Teil der laufenden Woche), landen separat in
//    "otherWeekMeals" statt in der Haupt-Meal-Liste.
//
// Schwellwert unten zentral als Konstante — hier anpassen, sobald sich zeigt,
// wie gut die Regel gegen echte Tage passt.
import type {
  TransparencyFlowData, TransparencyFlowRow, TransparencyWeighingData, TransparencyRtemData, TransparencyPlanningCheckData,
  MealProducibility, SubRecipeProducibility, TransparencyProducibilityResult, SubmealProducibilityStatus,
} from "./transparencyTypes";
import { weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";

const WEIGHED_COMPLETE_TOLERANCE = 0.98; // 98% des geplanten Post-kg gilt als "fertig gewogen"

function computeSubRecipeProducibility(
  subRecipeName: string,
  workOrders: string[],
  plannedPostKg: number,
  weighedPostKg: number,
  rtem: TransparencyRtemData | null
): SubRecipeProducibility {
  const pct = plannedPostKg > 0 ? (weighedPostKg / plannedPostKg) * 100 : null;
  const weighedComplete = plannedPostKg > 0
    ? weighedPostKg / plannedPostKg >= WEIGHED_COMPLETE_TOLERANCE
    : weighedPostKg > 0;

  const rtemRows = rtem?.bySubRecipeName.get(subRecipeName) ?? [];
  const actualRtiLeft = rtemRows.length
    ? rtemRows.reduce((s, r) => s + (r.actualRtiLeft ?? 0), 0)
    : null;

  return { subRecipeName, workOrders, plannedPostKg, weighedPostKg, pct, weighedComplete, actualRtiLeft };
}

function buildMeal(recipeCode: string, recipeName: string, flowRows: TransparencyFlowRow[], weighing: TransparencyWeighingData | null, rtem: TransparencyRtemData | null): MealProducibility {
  if (flowRows.length === 0) {
    return { recipeCode, recipeName, status: "unknown", subRecipes: [], blockedReasons: ["Keine Daten in Transperancy Total Overview für diese KW gefunden"] };
  }

  // Je Subrezept über alle Work Orders/Runs dieses Meals hinweg aggregieren.
  const bySubRecipe = new Map<string, { workOrders: Set<string>; plannedPostKg: number }>();
  for (const r of flowRows) {
    const key = r.subRecipeName || "(ohne Subrezept-Name)";
    if (!bySubRecipe.has(key)) bySubRecipe.set(key, { workOrders: new Set(), plannedPostKg: 0 });
    const entry = bySubRecipe.get(key)!;
    entry.workOrders.add(r.workOrder);
    entry.plannedPostKg += r.plannedPostKg ?? 0;
  }

  const subRecipes: SubRecipeProducibility[] = [];
  for (const [subRecipeName, { workOrders, plannedPostKg }] of bySubRecipe) {
    const woList = [...workOrders];
    const weighedPostKg = woList.reduce((s, wo) => s + (weighing?.postBlastKgByWorkOrder.get(wo) ?? 0), 0);
    subRecipes.push(computeSubRecipeProducibility(subRecipeName, woList, plannedPostKg, weighedPostKg, rtem));
  }
  subRecipes.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1));

  const allComplete = subRecipes.every((s) => s.weighedComplete);
  const noneStarted = subRecipes.every((s) => s.weighedPostKg <= 0);
  const status: SubmealProducibilityStatus = allComplete ? "ready" : noneStarted ? "blocked" : "partial";
  const blockedReasons = subRecipes
    .filter((s) => !s.weighedComplete)
    .map((s) => `${s.subRecipeName}: ${s.pct != null ? `${s.pct.toFixed(0)}%` : "kein Soll"} gewogen (${s.weighedPostKg.toFixed(1)}/${s.plannedPostKg.toFixed(1)} kg)`);

  return { recipeCode, recipeName, status, subRecipes, blockedReasons };
}

export function computeTransparencyProducibility(
  flow: TransparencyFlowData | null,
  weighing: TransparencyWeighingData | null,
  rtem: TransparencyRtemData | null,
  planningCheck: TransparencyPlanningCheckData | null,
  selectedWeekNum: number | null
): TransparencyProducibilityResult {
  const inWeek = (r: TransparencyFlowRow) => selectedWeekNum == null || weekPrefixFromWoNumber(r.workOrder) === selectedWeekNum;

  const currentWeekRecipeCodes = new Set(planningCheck?.rows.map((r) => r.recipeCode) ?? []);
  const allFlowRecipeCodes = new Set(flow?.byRecipeCode.keys() ?? []);

  const meals: MealProducibility[] = [];
  for (const recipeCode of currentWeekRecipeCodes) {
    if (!recipeCode) continue;
    const flowRows = (flow?.byRecipeCode.get(recipeCode) ?? []).filter(inWeek);
    const planRow = planningCheck?.byRecipeCode.get(recipeCode);
    const recipeName = planRow?.recipeName || flowRows[0]?.recipeName || recipeCode;
    meals.push(buildMeal(recipeCode, recipeName, flowRows, weighing, rtem));
  }
  meals.sort((a, b) => a.recipeName.localeCompare(b.recipeName));

  // Rezepte, die es nur über (evtl. andere-Wochen-)Work-Orders in Total
  // Overview gibt, aber NICHT im aktuellen Planning-Check-Tab stehen.
  const otherWeekMeals: MealProducibility[] = [];
  for (const recipeCode of allFlowRecipeCodes) {
    if (!recipeCode || currentWeekRecipeCodes.has(recipeCode)) continue;
    const flowRows = flow?.byRecipeCode.get(recipeCode) ?? [];
    const recipeName = flowRows[0]?.recipeName || recipeCode;
    otherWeekMeals.push(buildMeal(recipeCode, recipeName, flowRows, weighing, rtem));
  }
  otherWeekMeals.sort((a, b) => a.recipeName.localeCompare(b.recipeName));

  const byRecipeCode = new Map(meals.map((m) => [m.recipeCode, m] as const));

  return {
    byRecipeCode,
    meals,
    readyCount: meals.filter((m) => m.status === "ready").length,
    partialCount: meals.filter((m) => m.status === "partial").length,
    blockedCount: meals.filter((m) => m.status === "blocked").length,
    otherWeekMeals,
    weekNum: selectedWeekNum,
  };
}
