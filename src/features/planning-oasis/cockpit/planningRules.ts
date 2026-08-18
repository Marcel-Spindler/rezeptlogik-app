import type { PlannerDay } from "../../../lib/planner";
import type { WeekRecipe } from "../../../core/types";
import type { AutoFulfillmentBatch } from "./slotScheduling";

export type PlanningRulesConfig = {
  /** Portionsgrenze: bis zu dieser Menge nur 1 Run (1 Schicht). */
  singleRunMaxPortions: number;
  /** Anteil Run 1 / Frühschicht in % (0–100). Rest = Run 2 / Spätschicht. */
  firstRunPct: number;
  /** BENL: Anteil fertig geplatet am Donnerstag (0–100). Rest geht auf Freitag. */
  benlThuPct: number;
  /** BENL: Anteil am Freitag — wird automatisch als 100 − benlThuPct berechnet. */
  benlFriPct: number;
  /** Nordics (DK/SE): Anteil fertig gekocht bis Freitag (0–100). Rest geht auf Samstag. */
  nordicsFriPct: number;
  /** Nordics: Anteil am Samstag — wird automatisch als 100 − nordicsFriPct berechnet. */
  nordicsSatPct: number;
  /** DE: spätester Kochfertig-Tag der Produktionswoche. */
  deLatestCookDay: PlannerDay;
  /** Fisch-Rezept-Codes: Lead-Time wird auf 0 gesetzt (so spät wie möglich kochen). */
  fishRecipeCodes: string[];
};

export const DEFAULT_PLANNING_RULES: PlanningRulesConfig = {
  singleRunMaxPortions: 2000,
  firstRunPct: 70,
  benlThuPct: 40,
  benlFriPct: 60,
  nordicsFriPct: 90,
  nordicsSatPct: 10,
  deLatestCookDay: "Sa",
  fishRecipeCodes: [],
};

const STORAGE_KEY = "rezeptlogik-planning-rules-v1";

export function loadPlanningRules(): PlanningRulesConfig {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_PLANNING_RULES };
    const parsed = JSON.parse(raw) as Partial<PlanningRulesConfig>;
    return { ...DEFAULT_PLANNING_RULES, ...parsed };
  } catch {
    return { ...DEFAULT_PLANNING_RULES };
  }
}

export function savePlanningRules(rules: PlanningRulesConfig): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
    }
  } catch {
    // Quota überschritten — ignorieren
  }
}

const DAY_ORDER: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function pct(total: number, percent: number): number {
  return Math.max(0, Math.round((total * percent) / 100));
}

/**
 * Berechnet marktbasierte Fulfillment-Batches (Plating-/Kochfertig-Tage) für ein Rezept.
 * BENL → Do/Fr-Split, Nordics → Fr/Sa-Split, DE → deLatestCookDay.
 * Gibt sorted AutoFulfillmentBatch[] zurück, die als split-Spec in den Board-Notizen gespeichert werden.
 */
export function resolveMarketFulfillmentBatches(
  weekRecipe: WeekRecipe | undefined,
  portionMultiplier: number,
  rules: PlanningRulesConfig,
): AutoFulfillmentBatch[] {
  const vol = weekRecipe?.verdenVolume ?? { BENL: 0, DKSE: 0, DE: 0 };
  const benl = Math.max(0, Math.round((vol.BENL ?? 0) * portionMultiplier));
  const nordics = Math.max(0, Math.round((vol.DKSE ?? 0) * portionMultiplier));
  const de = Math.max(0, Math.round((vol.DE ?? 0) * portionMultiplier));
  const total = benl + nordics + de;
  if (total <= 0) return [];

  const dayTotals = new Map<PlannerDay, number>();
  const add = (day: PlannerDay, n: number) => {
    if (n > 0) dayTotals.set(day, (dayTotals.get(day) ?? 0) + n);
  };

  // BENL: Donnerstag-Anteil + Rest auf Freitag
  if (benl > 0) {
    const benlThu = pct(benl, rules.benlThuPct);
    add("Do", benlThu);
    add("Fr", benl - benlThu);
  }

  // Nordics: Freitag-Anteil + Rest auf Samstag
  if (nordics > 0) {
    const nordicsFri = pct(nordics, rules.nordicsFriPct);
    add("Fr", nordicsFri);
    add("Sa", nordics - nordicsFri);
  }

  // DE: einmalig am spätesten konfigurierten Tag
  if (de > 0) {
    add(rules.deLatestCookDay, de);
  }

  if (dayTotals.size === 0) return [{ day: "Fr", portions: total }];

  return [...dayTotals.entries()]
    .sort((a, b) => DAY_ORDER.indexOf(a[0]) - DAY_ORDER.indexOf(b[0]))
    .map(([day, portions]) => ({ day, portions }));
}

/** Gibt true zurück wenn das Rezept als Fisch-Rezept konfiguriert ist (Lead-Time = 0). */
export function isFishRecipe(recipeCode: string, rules: PlanningRulesConfig): boolean {
  return rules.fishRecipeCodes.some(
    code => code.trim().toUpperCase() === recipeCode.trim().toUpperCase(),
  );
}

