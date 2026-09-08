// Wochentags-Typ + Reihenfolge, geteilt von der Plating- und Küchen-Planung.
//
// Bis Sept. 2026 lag hier zusätzlich das „Cockpit"-Wochenboard: localStorage-
// Szenarien, analyzePlan (Stations-/Pool-Konflikte je Tag×Schicht), suggest-
// Assignments (Lead-Class rückwärts vom Plating-Tag) und computeBatchSplitPlan.
// Das Cockpit ist raus — die Küche wird jetzt in src/features/kitchen-plan/
// rückwärts aus dem Plating-Plan + Cook Schedule geplant. Historie:
// `git log -- src/PlanningView.tsx src/lib/planner.ts`.

export const PLANNER_DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
export type PlannerDay = typeof PLANNER_DAYS[number];

/** Küche in Verden: Mo–Fr besetzt, Sa/So zu (Produktion nur Mo–Fr). */
export const KITCHEN_OPEN_DAYS: ReadonlyArray<PlannerDay> = ["Mo", "Di", "Mi", "Do", "Fr"];

export function isKitchenOpen(day: PlannerDay): boolean {
  return KITCHEN_OPEN_DAYS.includes(day);
}
