// Wochen-Plating-Plan — 1:1-Abbild von Marcels „Plating Plan"-GSheet.
// Links: Meals + Demand (Ramp-Up). Rechts: die 7 KW-Tage, Meals in Runs verplant.
// Phase 1: Wochenplan (Demand → Runs → Buffer → Split → Tag).
// Phase 2 (später): täglicher Plating-Plan mit Changeover / Highrunner / Carry-over.

import type { PlannerDay } from "../../lib/planner";

export type PlatingDay = PlannerDay; // "Mo".."So"
export const PLATING_DAYS: readonly PlatingDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export interface PlatingRun {
  runIndex: number;            // 1, 2, (3)
  portions: number;            // gepufferte Portionszahl für diesen Run
  day: PlatingDay | null;      // null = noch nicht verplant
  /** true, sobald der Run als produziert markiert ist (Phase 2 / manuell). */
  done?: boolean;
  /** Rest, der am nächsten Tag nachgeholt werden muss (Phase 2). */
  carryOver?: number;
}

export interface PlatingMealPlan {
  code: string;
  name: string;
  preference: string;
  demand: { benl: number; nord: number; de: number };
  totalDemand: number;         // benl + nord + de
  bufferedTotal: number;       // totalDemand × (1 + Buffer)
  runCount: number;            // 1 oder 2 (3)
  runs: PlatingRun[];
  allergens: string;
  seafood: boolean;            // fish / crustaceans → Regel „1. Run ≥ Mittwoch"
  stations: string[];          // Kochstationen (aus Recipe-Profil bzw. grob aus Cook-Methoden)
  /** Complexity Score (cx) aus dem Recipe-Profil: raw / median(raw), Median-Meal = 1.0.
   *  Steuert die Tag-Heuristik (komplex → 1. Run früh, einfach → Montags-Fill-up).
   *  Fallback ohne Recipe-Profil: grobe Schätzung aus # Subs. null = unbekannt. */
  complexity: number | null;
  activeCookMin?: number;      // aktive Kochminuten (Recipe-Profil)
  passiveHoldMin?: number;     // Thaw/Marinade/Brine-Minuten (Recipe-Profil)
  /** Freitext-Notiz je Meal (wie die Kommentar-Spalte im Sheet). */
  note?: string;
}

export interface PlatingDayCapacity {
  lines: number;               // Plating-Linien an dem Tag
  hours: number;               // verfügbare Plating-Stunden
}

/** Stellschrauben des Wochen-Plating-Plans — im Sheet pro KW gepflegt, in der App
 *  editierbar und pro KW in Firestore gespeichert (früher hart im Code). */
export interface PlatingPlanParams {
  firstRunPct: number;            // 0.62..0.72 — Run-1-Anteil bei 2 Runs (Sheet „First Run assumptions")
  singleRunMaxDemand: number;     // Demand ≤ diesem Wert → 1 Run
  singleRunBuffer: number;        // +Puffer bei 1 Run  (Sheet-Formel, ~0.10)
  multiRunBuffer: number;         // +Puffer bei 2 Runs (Sheet „Buffer Assumption", ~0.05)
  platingRatePerLineHour: number; // Portionen/Linie/Stunde für die Kapazitätsrechnung
}

export interface PlatingWeekPlan {
  week: string;                // "2026-W37"
  params: PlatingPlanParams;   // Stellschrauben (First Run %, Puffer, Schwelle, Rate)
  generatedAt: string;         // ISO — letzter „Generieren"-Lauf
  updatedAt: string;           // ISO — letzte Änderung (auch manuell / KI)
  meals: PlatingMealPlan[];
  dayCapacity: Partial<Record<PlatingDay, PlatingDayCapacity>>;
  source: "generated" | "edited" | "ai";
}

export const PLATING_PLAN_CHANGED_EVENT = "rezeptlogik:plating-plan-changed";
