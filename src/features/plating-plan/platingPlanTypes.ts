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
  shift?: PlatingShift;        // Früh-/Spätschicht (nur bei shifts=2 am Tag)
  /** true, sobald der Run als produziert markiert ist (Phase 2 / manuell). */
  done?: boolean;
  /** Rest, der am nächsten Tag nachgeholt werden muss (Phase 2). */
  carryOver?: number;
  /** true = dieser Run entstand aus einem gedroppten Backfill-Bedarf (Plating-
   *  Linien-Bot), nicht aus der normalen Wochenplan-Generierung. */
  isBackfill?: boolean;
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
  /** Anzahl Sub-Meals (Komponenten am Plating). Treibt die Besetzung:
   *  Personen auf der Linie = subMealCount + 1 (ein Helfer pro Linie). 0 = unbekannt. */
  subMealCount: number;
  activeCookMin?: number;      // aktive Kochminuten (Recipe-Profil)
  passiveHoldMin?: number;     // Thaw/Marinade/Brine-Minuten (Recipe-Profil)
  /** Freitext-Notiz je Meal (wie die Kommentar-Spalte im Sheet). */
  note?: string;
}

export type PlatingShift = "früh" | "spät";

export interface PlatingDayCapacity {
  lines: number;               // Plating-Linien an dem Tag
  /** Verfügbare Plating-Stunden — immer TAGES-GESAMT, nie pro Schicht.
   *  Bei shifts=2 ist der Tagesgesamtwert fix shifts × PRODUCTION_SHIFT_HOURS
   *  (siehe unten) — das Feld wird dann automatisch gesetzt, nicht frei getippt. */
  hours: number;
  shifts?: 1 | 2;              // Anzahl Schichten, Default 1
}

/** Länge EINER realen Produktions-Schicht (Marcel: Produktionsmitarbeiter
 *  arbeiten 7,5 Stunden/Tag) — fix, unabhängig vom `hours`-Feld eines Tages.
 *  Bei shifts=2 gilt für jede Schicht (Früh/Spät) genau dieser Wert. */
export const PRODUCTION_SHIFT_HOURS = 7.5;

/** Tages-Gesamtstunden aus der Kapazität ableiten — bei shifts=2 IMMER
 *  shifts × PRODUCTION_SHIFT_HOURS (das `hours`-Feld wird dabei ignoriert,
 *  robust auch gegen ältere/veraltete Firestore-Dokumente). */
export function effectiveDayHours(cap: PlatingDayCapacity | undefined): number {
  const shifts = cap?.shifts ?? 1;
  return shifts >= 2 ? shifts * PRODUCTION_SHIFT_HOURS : (cap?.hours ?? 0);
}

/** Verfügbare Stunden EINER Schicht — fix PRODUCTION_SHIFT_HOURS bei shifts=2,
 *  sonst die Tages-Gesamtstunden (1 Schicht = der ganze Tag). */
export function shiftHours(cap: PlatingDayCapacity | undefined): number {
  return (cap?.shifts ?? 1) === 2 ? PRODUCTION_SHIFT_HOURS : effectiveDayHours(cap);
}

/** Stellschrauben des Wochen-Plating-Plans — im Sheet pro KW gepflegt, in der App
 *  editierbar und pro KW in Firestore gespeichert (früher hart im Code). */
export interface PlatingPlanParams {
  firstRunPct: number;            // 0.62..0.72 — Run-1-Anteil bei 2 Runs (Sheet „First Run assumptions")
  singleRunMaxDemand: number;     // Demand ≤ diesem Wert → 1 Run
  singleRunBuffer: number;        // +Puffer bei 1 Run  (Sheet-Formel, ~0.10)
  multiRunBuffer: number;         // +Puffer bei 2 Runs (Sheet „Buffer Assumption", ~0.05)
  platingRatePerLineHour: number; // Portionen/Linie/Stunde für die Kapazitätsrechnung
  changeoverEasyMin: number;      // Easy Changeover: nur Allergene ZUFÜGEN (milk → milk,sulphites), keine Reinigung (~10)
  changeoverAllergenMin: number;  // Volle Reinigung bei Allergen-WEGFALL (milk,sulphites → milk) (~30)
  /** Besetzung je Linie/Meal = ceil(subMealCount × platerFactor) + platingHelpers.
   *  platerFactor < 1 = mehrere Komponenten teilen sich eine Station (~0.7). */
  platerFactor: number;
  platingHelpers: number;         // feste Helfer je Linie (Deckel/Etikett/QC am Bandende, ~2)
}

// ── Phase 2/3: täglicher Linienplan ──────────────────────────────────────────

/** Art des Übergangs zwischen zwei aufeinanderfolgenden Slots (rein allergen-
 *  getrieben — Ziel: Tempo + wenig Reinigung):
 *  none  = identische Allergene → 0 min
 *  easy  = Allergene NUR zugefügt (milk → milk,sulphites) → kurze Rüstzeit, keine Reinigung
 *  allergen = Allergen weggefallen → volle Reinigung (= Saubermach-Aktion) */
export type ChangeoverKind = "none" | "easy" | "allergen";

/** Ein Meal-Run auf einer Linie an einem Tag. */
export interface PlatingSlot {
  code: string;
  name: string;
  runIndex: number;               // welcher Run des Meals (1 / 2)
  portions: number;               // an dem Tag auf der Linie zu platen
  seq: number;                    // Reihenfolge auf der Linie (0-basiert)
  startMin: number;               // Start ab Schichtbeginn (Minuten)
  endMin: number;
  changeoverBeforeMin: number;    // Umrüstzeit vor diesem Slot (0 / easy / allergen)
  changeoverReason: "easy" | "allergen" | null;
  changeoverKind?: ChangeoverKind;
  allergens: string;
  seafood: boolean;
  complexity: number | null;
  /** Sub-Meals dieses Meals + Besetzung (subMeals + 1 Helfer je Linie). */
  subMeals: number;
  headcount: number;
  /** Portionen, die nicht mehr in die Schicht passten → Folgetag. */
  carryOver?: number;
}

export interface PlatingLinePlan {
  line: number;                   // 1..N
  role: "highrunner" | "flex" | "overload";
  slots: PlatingSlot[];
  platingMin: number;             // reine Plating-Zeit
  changeoverMin: number;          // Summe Umrüsten (easy + Reinigungen)
  availableMin: number;           // hours × 60
  changeovers: number;            // Anzahl Saubermach-Aktionen (Allergen-Wegfall)
  easyChangeovers: number;        // Anzahl Easy Changeovers (nur zufügen)
  /** Spitzenbesetzung der Linie (max Slot-headcount) + Personenminuten (Σ headcount × Dauer). */
  peakHeadcount: number;
  manMinutes: number;
  overCapacity: boolean;
}

export interface PlatingCarryItem {
  code: string;
  name: string;
  portions: number;
  /** Seafood oder komplexes Meal → harte Deadline, Carry-over ist kritisch. */
  critical?: boolean;
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

export interface PlatingShiftLoad {
  shift: PlatingShift;
  portions: number;
  neededHours: number;
  availableHours: number;
  overCapacity: boolean;
  meals: number;
}
