// Fertigstellungs-Prognose — schätzt, wann ein Meal oder eine einzelne WO ihr
// Soll erreicht, basierend auf dem EIGENEN Wiege-Tempo dieses Meals/dieser WO
// heute (bewusst NICHT dem schichtweiten Tempo aus computeShiftSummary in
// productionAgent.ts — verschiedene Meals/Sub-Rezepte laufen mit sehr
// unterschiedlicher Geschwindigkeit durch die Küche, ein globaler Schnitt
// würde ein langsames Meal zu optimistisch und ein schnelles zu pessimistisch
// einschätzen). Gibt bewusst KEINE geratene Prognose zurück, wenn für das
// jeweilige Meal/die WO heute noch keine zwei eigenen Wiegungen vorliegen —
// etaHours/etaTime bleiben dann null, statt eine erfundene Zeit zu zeigen.
import type { PostblastData, PostblastEntry } from "./gsheetTypes";
import type { MealProgress, WoMatchedStatus } from "./postblastMatch";

export interface CompletionEta {
  remainingKg: number;
  paceKgPerHour: number;
  etaHours: number | null;
  etaTime: Date | null;
}

function noEta(remainingKg: number): CompletionEta {
  return { remainingKg, paceKgPerHour: 0, etaHours: null, etaTime: null };
}

function etaFromTodaysEntries(remainingKg: number, entries: PostblastEntry[]): CompletionEta {
  if (remainingKg <= 0) return { remainingKg: 0, paceKgPerHour: 0, etaHours: 0, etaTime: new Date() };
  const today = new Date().toISOString().slice(0, 10);
  const todays = entries.filter(e => e.date === today);
  if (todays.length < 2) return noEta(remainingKg);
  const timestamps = todays.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  if (timestamps.length < 2) return noEta(remainingKg);
  const elapsedHours = (Date.now() - Math.min(...timestamps)) / 3_600_000;
  if (elapsedHours <= 0) return noEta(remainingKg);
  const paceKgPerHour = todays.reduce((s, e) => s + e.weightKg, 0) / elapsedHours;
  if (paceKgPerHour <= 0) return noEta(remainingKg);
  const etaHours = remainingKg / paceKgPerHour;
  return { remainingKg, paceKgPerHour, etaHours, etaTime: new Date(Date.now() + etaHours * 3_600_000) };
}

// Meal-Ebene: Tempo aus ALLEN heutigen Wiegungen der WOs dieses Meals — nach
// WO-Nummer statt Sub-Rezept-Name gefiltert, weil derselbe Sub-Rezept-Name in
// mehreren Meals auftauchen kann (siehe KET-Composite-Sub-Rezepte), eine WO
// aber immer genau einem Meal gehört.
export function estimateMealEta(meal: MealProgress, postblast: PostblastData | null): CompletionEta {
  const remainingKg = Math.max(0, meal.totalPlannedKg - meal.totalActualKg);
  if (remainingKg <= 0) return etaFromTodaysEntries(0, []);
  if (!postblast) return noEta(remainingKg);
  const woSet = new Set(meal.workOrders.map(w => w.workOrder));
  const ownEntries = postblast.entries.filter(e => woSet.has(e.workOrder));
  return etaFromTodaysEntries(remainingKg, ownEntries);
}

// WO-Ebene: wo.weighings ist bereits auf diese eine WO-Nummer beschränkt
// (siehe postblastMatch.ts), braucht also keinen zusätzlichen Filter.
export function estimateWoEta(wo: WoMatchedStatus): CompletionEta {
  const remainingKg = Math.max(0, wo.plannedKg - wo.actualKg);
  return etaFromTodaysEntries(remainingKg, wo.weighings);
}
