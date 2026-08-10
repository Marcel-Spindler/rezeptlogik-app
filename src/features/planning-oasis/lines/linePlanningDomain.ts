// Domänen-Typen und Konstanten der Linienplanung: Plan-Tage, Slots, Linien,
// Kollisions-/Snapshot-Formate. Keine Logik, nur Formen.
import type { PlannerDay, PlannerScenario } from "../../../lib/planner";

export type LinePlanRecipe = {
  code: string;          // "FV0970A"
  name: string;          // full name
  totalPlanned: number;
  nordics: number;
  bnl: number;
  de: number;
  speedPerMin: number;   // portions/min on this line
  /** true wenn Rezept Fisch enthält (MHD 9 Tage) */
  isSeafood: boolean;
  /** true = Reinigungspause nach Rezeptwechsel (kein echtes Rezept) */
  isBreak?: boolean;
};

// Factor-Woche: Freitag (Produktion startet) → Donnerstag (Lieferwoche)
// Versandtag ist der Freitag NACH Donnerstag (= index 7, außerhalb des Arrays).
// MHD-Tage: Fisch 9d (maxGap=2d), Non-Fisch 13d (maxGap=6d).
// daysBeforeShipping für Index i = (DAYS.length - i) weil Donnerstag (idx 6) = 1 Tag vor Versand.
export const DAYS = ["Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag", "Montag"] as const;
export type PlanDay = (typeof DAYS)[number];

export type CockpitRunReadiness = {
  startDay: PlanDay;
  readyDay: PlanDay;
  dueDay: PlanDay;
  portions: number;
  submealCount: number;
};

export type ManufacturingPlanSnapshot = {
  savedAtIso: string;
  savedAtLabel?: string;
  week: string;
  scenarioId: string;
  scenarioName: string;
  assignments: PlannerScenario["assignments"];
  stats?: {
    plannedCount?: number;
    unplannedCount?: number;
  };
};

export type ForecastVarianceRow = {
  code: string;
  recipeName: string;
  forecastPortions: number;
  targetPortions: number;
  delta: number;
};

export type LineCollisionHint = {
  key: string;
  severity: "error" | "warn";
  domain: "volume" | "readiness" | "mhd" | "slot" | "run";
  location: string;
  message: string;
  action: string;
  cellKey?: string;
  recipeCode?: string;
};

// KET-Sheets liefern englische Wochentage – auf deutsche DAYS mappen
export const DAY_EN_TO_DE: Record<string, string> = {
  "Friday": "Freitag",
  "Saturday": "Samstag",
  "Sunday": "Sonntag",
  "Monday": "Montag",
  "Tuesday": "Dienstag",
  "Wednesday": "Mittwoch",
  "Thursday": "Donnerstag",
};

export const PLANNER_DAY_TO_PLAN_DAY: Record<PlannerDay, PlanDay> = {
  Mo: "Montag",
  Di: "Dienstag",
  Mi: "Mittwoch",
  Do: "Donnerstag",
  Fr: "Freitag",
  Sa: "Samstag",
  So: "Sonntag",
};

export const RUN_ONE_SUB_DAYS: readonly PlannerDay[] = ["So", "Mo", "Di", "Mi", "Do"];
export const RUN_TWO_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do", "Fr"];

export const RUN_PLATING_WINDOWS: Record<1 | 2, { startDay: PlanDay; dueDay: PlanDay }> = {
  1: { startDay: "Dienstag", dueDay: "Freitag" },
  2: { startDay: "Mittwoch", dueDay: "Samstag" },
};

export const SLOTS: ReadonlyArray<{ key: string; label: string; duration: number }> = [
  { key: "07:00-08:00", label: "07 – 08", duration: 60 },
  { key: "08:00-09:00", label: "08 – 09", duration: 60 },
  { key: "09:00-10:00", label: "09 – 10", duration: 60 },
  { key: "10:00-11:00", label: "10 – 11", duration: 60 },
  { key: "11:00-12:00", label: "11 – 12", duration: 60 },
  { key: "12:00-13:00", label: "12 – 13", duration: 60 },
  { key: "13:00-14:00", label: "13 – 14", duration: 60 },
  { key: "14:00-15:00", label: "14 – 15", duration: 60 },
  { key: "15:00-16:00", label: "15 – 16", duration: 60 },
  { key: "16:00-17:00", label: "16 – 17", duration: 60 },
];

export const LINES = ["P-Linie 1", "P-Linie 2", "P-Linie 3"] as const;
export type DayLineCount = 0 | 1 | 2 | 3;

export const DEFAULT_DAY_LINE_COUNT: Record<PlanDay, DayLineCount> = {
  Montag: 1,
  Dienstag: 3,
  Mittwoch: 3,
  Donnerstag: 3,
  Freitag: 2,
  Samstag: 1,
  Sonntag: 0,
};
export const DAY_LINE_COUNT_ORDER: readonly PlanDay[] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

export const MEAL_CHANGE_BREAK: LinePlanRecipe = {
  code: "__BREAK__",
  name: "Reinigung & Zählung (1h)",
  totalPlanned: 0, nordics: 0, bnl: 0, de: 0, speedPerMin: 0,
  isSeafood: false, isBreak: true,
};

export type ScheduleMap = Record<string, LinePlanRecipe | null>;  // key: `${day}|${slotKey}|${lineIdx}`

export const DAY_SHORT: Record<string, string> = {
  Freitag: "Fr", Samstag: "Sa", Sonntag: "So",
  Montag: "Mo", Dienstag: "Di", Mittwoch: "Mi", Donnerstag: "Do",
};
