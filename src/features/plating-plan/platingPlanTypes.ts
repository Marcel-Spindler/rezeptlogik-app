// Wochen-Plating-Plan — 1:1-Abbild von Marcels „Plating Plan"-GSheet.
// Links: Meals + Demand (Ramp-Up). Rechts: die 7 KW-Tage, Meals in Runs verplant.
// Phase 1: Wochenplan (Demand → Runs → Buffer → Split → Tag).
// Phase 2: täglicher Linienplan je Tag — Runs auf Plating-Linien sequenziert,
//   Changeover-minimiert (Allergen/Protein), Highrunner-Linie, Carry-over
//   unfertiger Mengen auf den Folgetag.  Siehe platingDayLogic.ts.

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
  changeoverAllergenMin: number;  // Reinigung bei Allergen-Wechsel (Phase 2, ~30)
  changeoverProteinMin: number;   // Full Changeover bei Protein-Typ-Wechsel (Phase 2, ~60)
}

// ── Phase 2: täglicher Linienplan ────────────────────────────────────────────

export type ProteinType = "chicken" | "beef" | "pork" | "seafood" | "veggie" | "other";

/** Ein Meal-Run auf einer Linie an einem Tag. */
export interface PlatingSlot {
  code: string;
  name: string;
  runIndex: number;               // welcher Run des Meals (1 / 2)
  portions: number;               // an dem Tag auf der Linie zu platen
  seq: number;                    // Reihenfolge auf der Linie (0-basiert)
  startMin: number;               // Start ab Schichtbeginn (Minuten)
  endMin: number;
  changeoverBeforeMin: number;    // Umrüstzeit vor diesem Slot (0 / 30 / 60)
  changeoverReason: "allergen" | "protein" | null;
  allergens: string;
  proteinType: ProteinType;
  seafood: boolean;
  complexity: number | null;
  /** Portionen, die nicht mehr in die Schicht passten → Folgetag. */
  carryOver?: number;
}

export interface PlatingLinePlan {
  line: number;                   // 1..N
  role: "highrunner" | "flex" | "overload";
  slots: PlatingSlot[];
  platingMin: number;             // reine Plating-Zeit
  changeoverMin: number;          // Summe Umrüsten
  availableMin: number;           // hours × 60
  changeovers: number;
  overCapacity: boolean;
}

export interface PlatingCarryItem {
  code: string;
  name: string;
  portions: number;
}

export interface PlatingDayPlan {
  day: PlatingDay;
  lines: PlatingLinePlan[];
  carryInFromPrev: PlatingCarryItem[];   // vom Vortag übernommen
  carryOutToNext: PlatingCarryItem[];    // reicht der Tag nicht → Folgetag
  generatedAt: string;
  source: "generated" | "edited" | "ai";
}

export interface PlatingWeekPlan {
  week: string;                // "2026-W37"
  params: PlatingPlanParams;   // Stellschrauben (First Run %, Puffer, Schwelle, Rate)
  generatedAt: string;         // ISO — letzter „Generieren"-Lauf
  updatedAt: string;           // ISO — letzte Änderung (auch manuell / KI)
  meals: PlatingMealPlan[];
  dayCapacity: Partial<Record<PlatingDay, PlatingDayCapacity>>;
  /** Phase 2: pro Tag der sequenzierte Linienplan (aus den verplanten Runs). */
  dailyPlans?: Partial<Record<PlatingDay, PlatingDayPlan>>;
  source: "generated" | "edited" | "ai";
}

export const PLATING_PLAN_CHANGED_EVENT = "rezeptlogik:plating-plan-changed";
