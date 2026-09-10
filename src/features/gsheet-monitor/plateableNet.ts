// "Noch platierbar" — zieht die schon platierten Portionen (Redzone) von der
// Brutto-Zahl platierbarer Meals ab.
//
// Die Brutto-Rechnung (computeMaxPlateable in PostblastLiveView /
// computeMealPlatable in PlatingActionBoard) summiert die Post-Blast-kg über
// ALLE Runs der laufenden Woche und teilt durch Gramm/Portion. Sobald das
// Plating den ersten Run rausgeschoben hat, steht dort also mehr "platierbar"
// als real im Kühlhaus liegt — der erste Run ist längst als Meal produziert.
//
// Redzone Live kennt die tatsächlich platierte Stückzahl je Meal-Code (fertige
// + laufende Plating-Runs). Die wird hier gegen die Brutto-Menge verrechnet,
// und zwar run-weise in Run-Reihenfolge (Run 1 zuerst) — das deckt sich mit
// "der erste Run ist schon durch". Wo keine saubere Run-Aufteilung möglich ist
// (nur ein Run, keine kg je Run), bleibt es beim reinen Portions-Abzug.
import type { MealProgress } from "./postblastMatch";
import { codeDigits } from "../../lib/helpers";

// Meal-Identität = die 4 Ziffern des Codes (wie codeKey in combineBackfills).
// Fängt Markt-Präfixe ("[DE] - FV1351A"), Buchstaben-Varianten (FV4063A/B) und
// Fremd-Codes (US "F00516E", "CF50176A") in EINEN Schlüssel — Redzone-Namen und
// Plan-Codes treffen sich hier.
export function mealCodeKey(recipeCode: string): string {
  return codeDigits(recipeCode).toUpperCase();
}

/** Schon plaitierte Portionen für ein Meal aus der kombinierten Map holen
 *  (Map ist auf `mealCodeKey` = 4-Ziffer-Identität gekeyed). */
export function platedForMeal(
  platedByMealCode: Map<string, number> | undefined,
  recipeCode: string,
): number {
  if (!platedByMealCode) return 0;
  return platedByMealCode.get(recipeCode) ?? platedByMealCode.get(mealCodeKey(recipeCode)) ?? 0;
}

export interface RunPlateStatus {
  run: number;
  /** Brutto-platierbare Meals, die dieser Run zur Gesamtmenge beiträgt. */
  grossMeals: number;
  /** Davon bereits durch Redzone-Output abgedeckt. */
  platedMeals: number;
  /** Noch platierbar aus diesem Run. */
  netMeals: number;
  /** true = dieser Run ist komplett platiert. */
  done: boolean;
}

export interface NetPlateable {
  /** Was die Brutto-Rechnung geliefert hat (ganze Woche, alle Runs). */
  grossMeals: number;
  /** Redzone: schon platierte Portionen für diesen Meal-Code. */
  platedMeals: number;
  /** Brutto minus platiert, nie negativ — das ist die ehrliche "jetzt platierbar"-Zahl. */
  netMeals: number;
  /** true = die gesamte produzierte Menge ist bereits platiert (Brutto > 0, Netto ≤ 0). */
  fullyPlated: boolean;
  /** true = mind. eine Portion ist platiert, aber es bleibt noch etwas übrig. */
  partiallyPlated: boolean;
  /** Aufteilung je internem Run — nur befüllt, wenn das Meal mehr als einen Run hat. */
  runs: RunPlateStatus[];
}

/**
 * @param meal         Meal inkl. WOs (liefert die Run-Aufteilung über wo.run / wo.actualKg)
 * @param grossMeals   Ergebnis der Brutto-Rechnung (computeMaxPlateable/computeMealPlatable)
 * @param platedMeals  platedByMealCode.get(meal.recipeCode) — Redzone, fertige + laufende Runs
 */
export function netPlateable(
  meal: MealProgress,
  grossMeals: number,
  platedMeals: number | undefined | null,
): NetPlateable {
  const plated = Math.max(0, Math.round(platedMeals ?? 0));
  const gross = Math.max(0, Math.round(grossMeals));
  const netTotal = Math.max(0, gross - plated);
  const fullyPlated = gross > 0 && netTotal <= 0;
  const partiallyPlated = plated > 0 && netTotal > 0;

  // Post-Blast-kg je internem Run — bestimmt, welcher Run wie viel zur
  // Brutto-Menge beiträgt (Reihenfolge: kleinste Run-Nummer zuerst).
  const kgByRun = new Map<number, number>();
  let totalKg = 0;
  for (const wo of meal.workOrders) {
    const r = wo.run ?? 1;
    kgByRun.set(r, (kgByRun.get(r) ?? 0) + wo.actualKg);
    totalKg += wo.actualKg;
  }
  const runNums = [...kgByRun.keys()].sort((a, b) => a - b);

  let runs: RunPlateStatus[] = [];
  if (runNums.length > 1 && totalKg > 0 && gross > 0) {
    // Brutto-Menge proportional zum kg-Anteil je Run aufteilen; den
    // Rundungsrest bekommt der letzte Run, damit die Summe exakt gross ergibt.
    let assignedGross = 0;
    const grossPerRun = runNums.map((r, i) => {
      if (i === runNums.length - 1) return gross - assignedGross;
      const g = Math.floor(gross * ((kgByRun.get(r) ?? 0) / totalKg));
      assignedGross += g;
      return g;
    });

    let remaining = plated;
    runs = runNums.map((r, i) => {
      const g = grossPerRun[i];
      const consumed = Math.min(remaining, g);
      remaining -= consumed;
      return { run: r, grossMeals: g, platedMeals: consumed, netMeals: g - consumed, done: g > 0 && g - consumed <= 0 };
    });
  }

  return { grossMeals: gross, platedMeals: plated, netMeals: netTotal, fullyPlated, partiallyPlated, runs };
}
