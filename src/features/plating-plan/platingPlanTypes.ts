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
  stations: string[];          // Grill/Cup/Butter/Oven/Braiser/Slice (aus X-Markierungen)
  complexity: number | null;   // # Subs als grobe Komplexität (Sheet-„Complexity Score" fehlt in der App)
  /** Freitext-Notiz je Meal (wie die Kommentar-Spalte im Sheet). */
  note?: string;
}

export interface PlatingDayCapacity {
  lines: number;               // Plating-Linien an dem Tag
  hours: number;               // verfügbare Plating-Stunden
}

export interface PlatingWeekPlan {
  week: string;                // "2026-W37"
  firstRunPct: number;         // 0.62 .. 0.70 (pro KW)
  generatedAt: string;         // ISO — letzter „Generieren"-Lauf
  updatedAt: string;           // ISO — letzte Änderung (auch manuell / KI)
  meals: PlatingMealPlan[];
  dayCapacity: Partial<Record<PlatingDay, PlatingDayCapacity>>;
  source: "generated" | "edited" | "ai";
}

export const PLATING_PLAN_CHANGED_EVENT = "rezeptlogik:plating-plan-changed";
