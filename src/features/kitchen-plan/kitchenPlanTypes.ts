// Kochplan — Küche rückwärts aus dem Wochen-Plating-Plan + Cook Schedule.
// Der Plating-Plan legt fest, WANN ein Meal (je Run) geplatet wird; hier leiten
// wir ab, WELCHES Sub-Meal an WELCHEM Küchentag in WELCHER Schicht in WELCHER
// Reihenfolge zu fertigen ist — allergen-aufsteigend sequenziert, damit die Küche
// so selten wie möglich sauber machen muss.
//
// Küchentage: So · Mo · Di · Mi · Do · Fr  (Sa zu; So = Sonntag VOR der Woche,
//   für langen Vorlauf: Saucen/Marinaden/Brine/Spice). Mo–Fr laufen Früh + Spät,
//   So nur eine Schicht.
//
// Reine Typen, kein React. Siehe kitchenPlanLogic.ts.

import type { PlatingDay } from "../plating-plan/platingPlanTypes";
import type { KitchenArea } from "./kitchenAreas";

/** Küchentage in chronologischer Reihenfolge. „So" ist der Sonntag VOR der
 *  Plating-Woche (frühester Kochtag, langer Vorlauf). Sa ist die Küche zu. */
export const KITCHEN_DAYS: readonly PlatingDay[] = ["So", "Mo", "Di", "Mi", "Do", "Fr"];

export type KitchenShift = "früh" | "spät" | "tag";

/** Übergang zwischen zwei aufeinanderfolgenden Sub-Meals einer Station:
 *  none = gleiche Allergene · easy = Allergen nur zugefügt (kurze Rüstzeit) ·
 *  clean = Allergen weggefallen → volle Reinigung. */
export type KitchenChangeover = "none" | "easy" | "clean";

/** Ein Kochschritt aus dem Cook Schedule (Anzeige). */
export interface KitchenScheduleStep {
  shiftsBefore: number;
  label: string;
}

/** Ein Sub-Meal an einem Küchentag/einer Schicht — über alle Meals/Runs/Märkte
 *  aggregiert, die dieselbe Sub-Rezept-Identität dort brauchen. */
export interface KitchenSubJob {
  /** = subRecipeId__cookDay__shift (Buchstaben-Suffix-Meals teilen sich Subs). */
  key: string;
  subRecipeId: string;
  subRecipeName: string;
  area: KitchenArea;
  cookMethod: string;             // gematchte Cook-Method (für Tooltip)
  cookDay: PlatingDay;
  shift: KitchenShift;
  platingDays: PlatingDay[];      // Plating-Tage, die dieser Job bedient
  portions: number;              // Summe gepufferter Portionen
  kg: number;                    // Brutto-Input kg
  batches: number;
  activeCookMin: number;         // Batches × Σ Minuten/Batch (PFEI)
  allergens: string;             // sortiert, kommagetrennt (leer = allergenfrei)
  allergenCount: number;
  feedsMeals: { code: string; name: string }[];
  cookShifts: number;
  leadDays: number;              // effektiver Vorlauf (Plating-Tag − Kochtag)
  scheduleSteps: KitchenScheduleStep[];
  /** Sauce/Marinade/Brine/Spice/Thaw oder ≥ 3 Kochschichten → Richtung Sonntag. */
  longPrep: boolean;
  critical: boolean;             // Seafood oder komplexes Meal (cx ≥ 1.15)
  /** Küchentag ODER Schicht von Hand gesetzt. */
  overridden: boolean;
  /** Position in dieser Station/Schicht von Hand fixiert (sonst allergen-auto). */
  manualOrder: boolean;
  // ── Sequenz-Ableitung (innerhalb Station × Schicht) ──
  seq: number;
  startMin: number;
  endMin: number;
  changeoverBeforeMin: number;
  changeoverKind: KitchenChangeover;
}

/** Eine Station innerhalb einer Schicht eines Tages, allergen-sequenziert. */
export interface KitchenBlock {
  area: KitchenArea;
  shift: KitchenShift;
  jobs: KitchenSubJob[];
  kg: number;
  batches: number;
  activeCookMin: number;
  changeoverMin: number;
  cleanCount: number;            // volle Reinigungen (Allergen-Wegfall)
  easyCount: number;
  neededMin: number;             // activeCookMin + changeoverMin
  availableMin: number;
  overCapacity: boolean;
}

export interface KitchenShiftPlan {
  shift: KitchenShift;
  blocks: KitchenBlock[];        // eine je belegter Station
  kg: number;
  batches: number;
  neededMin: number;
  availableMin: number;
  cleanCount: number;
  overCapacity: boolean;
}

export interface KitchenDayPlan {
  day: PlatingDay;
  shiftModel: 1 | 2;
  shifts: KitchenShiftPlan[];
  totalKg: number;
  totalBatches: number;
  totalJobs: number;
  cleanCount: number;
}

/** Handverschiebung eines Sub-Meals: anderer Kochtag / andere Schicht /
 *  fixierte Position (order). */
export interface KitchenOverride {
  cookDay?: PlatingDay;
  shift?: KitchenShift;
  /** Fraktionaler Rang innerhalb Station × Schicht (klein = früh). */
  order?: number;
}

/** Stellschrauben — pro KW in Firestore gespeichert (Defaults sonst). */
export interface KitchenPlanParams {
  /** Vorlauf in Tagen je Anzahl Kochschichten (1 Shift = Kochtag = Plating−1). */
  leadDaysByShift: Record<1 | 2 | 3, number>;
  /** Fester Vorlauf-Override je gematchter Cook-Method (überschreibt leadDaysByShift). */
  methodLeadOverride: Record<string, number>;
  /** Am Sonntag (eine Schicht) wird die Vorarbeit gemacht, die am längsten
   *  dauert / den längsten Vorlauf braucht (Mehrschicht-Prozesse: Brine, Marinade,
   *  Slow-Cook, Sous-vide, Thaw — plus Halt-Komponenten wie Sauce/Butter/Spice),
   *  für Runs die bis `sundayCutoffDay` geplatet werden. Passt eine Station-Menge
   *  nicht mehr in die Sonntag-Schicht, wandert der kürzeste Rest auf Montag. */
  saucesToSunday: boolean;
  /** Spätester Plating-Tag, dessen Run-Menge noch auf den Sonntag darf (Default Mi). */
  sundayCutoffDay: PlatingDay;
  /** Andere lange Prozesse (≥ 3 Kochschichten) werden um so viele Tage vorgezogen. */
  longPrepExtraLeadDays: number;
  /** Mo–Fr laufen Früh + Spät (sonst eine Schicht/Tag). So immer nur eine. */
  dualShiftWeekdays: boolean;
  /** Verfügbare aktive Minuten je Station × Schicht (Werktag). Nur Überlast-Ampel. */
  weekdayShiftMin: number;
  /** Verfügbare aktive Minuten je Station am Sonntag (eine Schicht). */
  sundayShiftMin: number;
  /** Volle Reinigung bei Allergen-Wegfall (min). */
  changeoverCleanMin: number;
  /** Rüstzeit bei „nur Allergen zufügen" (min). */
  changeoverEasyMin: number;
}

export interface KitchenWeekPlan {
  week: string;
  generatedAt: string;
  updatedAt: string;
  params: KitchenPlanParams;
  overrides: Record<string, KitchenOverride>;
  /** Abgeleitet (nicht persistiert). */
  days: Partial<Record<PlatingDay, KitchenDayPlan>>;
  /** Sub-Meals, die keinem Meal im Plating-Plan zugeordnet werden konnten. */
  unresolvedMeals: string[];
  source: "generated" | "edited";
}

export const DEFAULT_KITCHEN_PARAMS: KitchenPlanParams = {
  leadDaysByShift: { 1: 1, 2: 2, 3: 3 },
  methodLeadOverride: {},
  saucesToSunday: true,
  sundayCutoffDay: "Mi",
  longPrepExtraLeadDays: 2,
  dualShiftWeekdays: true,
  // 7,5 h Schicht × ~1,5 parallele Geräte je Station — grober Default,
  // Marcel kalibriert je Station.
  weekdayShiftMin: 675,
  sundayShiftMin: 675,
  changeoverCleanMin: 30,
  changeoverEasyMin: 10,
};

export const KITCHEN_PLAN_CHANGED_EVENT = "rezeptlogik:kitchen-plan-changed";
