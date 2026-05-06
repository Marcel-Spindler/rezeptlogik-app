/**
 * Yield-Verlust-Rechner für Rezeptlogik
 * 
 * Yield-Verlust ist der Prozentsatz Material, das bei der Verarbeitung verloren geht:
 * - yieldRatio = 0.7011 bedeutet: 70,11% kommt raus, 29,89% geht verloren
 * - Um von Rohware zu Fertigware zu kommen: Rohware * yieldRatio = Fertigware
 * - Um von Fertigware zu Rohware zu kommen: Fertigware / yieldRatio = Rohware
 * 
 * Alle Funktionen sind zu 100% yield-aware und können in beide Richtungen rechnen.
 */

export interface YieldScenario {
  type: "raw_to_finished" | "finished_to_raw" | "raw_to_meals" | "meals_to_raw";
  yieldRatio: number;     // 0.7011 = 70.11% output
  inputValue: number;      // in base unit (grams/ml)
  portionGrams: number;    // grams per portion
  mealCount?: number;      // for meal scenarios
}

export interface YieldResult {
  inputValue: number;
  outputValue: number;
  lossPercent: number;
  yieldRatio: number;
  inputLabel: string;
  outputLabel: string;
  mealCount?: number;
  explanation: string;
}

/**
 * Raw-Ware → Fertigware (mit Yield-Verlust)
 * Formel: Fertigware = Rohware * yieldRatio
 */
export function rawToFinished(
  rawGrams: number,
  yieldRatio: number
): YieldResult {
  if (yieldRatio <= 0 || yieldRatio > 1) {
    throw new Error(`Invalid yieldRatio: ${yieldRatio}. Must be between 0 and 1.`);
  }
  if (rawGrams < 0) {
    throw new Error(`Invalid rawGrams: ${rawGrams}. Must be >= 0.`);
  }

  const finishedGrams = rawGrams * yieldRatio;
  const lossGrams = rawGrams - finishedGrams;
  const lossPercent = (lossGrams / rawGrams) * 100;

  return {
    inputValue: rawGrams,
    outputValue: finishedGrams,
    lossPercent: isNaN(lossPercent) ? 0 : lossPercent,
    yieldRatio,
    inputLabel: "Rohware (g)",
    outputLabel: "Fertigware (g)",
    explanation: `${rawGrams.toFixed(0)}g Rohware × ${(yieldRatio * 100).toFixed(2)}% = ${finishedGrams.toFixed(0)}g Fertigware (${lossPercent.toFixed(2)}% Verlust)`
  };
}

/**
 * Fertigware → Rohware (Rückwärts-Berechnung mit Yield-Verlust)
 * Formel: Rohware = Fertigware / yieldRatio
 */
export function finishedToRaw(
  finishedGrams: number,
  yieldRatio: number
): YieldResult {
  if (yieldRatio <= 0 || yieldRatio > 1) {
    throw new Error(`Invalid yieldRatio: ${yieldRatio}. Must be between 0 and 1.`);
  }
  if (finishedGrams < 0) {
    throw new Error(`Invalid finishedGrams: ${finishedGrams}. Must be >= 0.`);
  }

  const rawGrams = finishedGrams / yieldRatio;
  const lossGrams = rawGrams - finishedGrams;
  const lossPercent = (lossGrams / rawGrams) * 100;

  return {
    inputValue: finishedGrams,
    outputValue: rawGrams,
    lossPercent: isNaN(lossPercent) ? 0 : lossPercent,
    yieldRatio,
    inputLabel: "Fertigware (g)",
    outputLabel: "Benötigte Rohware (g)",
    explanation: `${finishedGrams.toFixed(0)}g Fertigware ÷ ${(yieldRatio * 100).toFixed(2)}% = ${rawGrams.toFixed(0)}g Rohware benötigt (${lossPercent.toFixed(2)}% Verlust)`
  };
}

/**
 * Rohware → Meals (Rohware wird zu X Mahlzeiten mit Yield-Verlust)
 * Formel: MealCount = (Rohware * yieldRatio) / portionGrams
 */
export function rawToMeals(
  rawGrams: number,
  yieldRatio: number,
  portionGrams: number
): YieldResult {
  if (yieldRatio <= 0 || yieldRatio > 1) {
    throw new Error(`Invalid yieldRatio: ${yieldRatio}. Must be between 0 and 1.`);
  }
  if (rawGrams < 0) {
    throw new Error(`Invalid rawGrams: ${rawGrams}. Must be >= 0.`);
  }
  if (portionGrams <= 0) {
    throw new Error(`Invalid portionGrams: ${portionGrams}. Must be > 0.`);
  }

  const finishedGrams = rawGrams * yieldRatio;
  const mealCount = Math.floor(finishedGrams / portionGrams);
  const lossGrams = rawGrams - finishedGrams;
  const lossPercent = (lossGrams / rawGrams) * 100;

  return {
    inputValue: rawGrams,
    outputValue: mealCount,
    lossPercent: isNaN(lossPercent) ? 0 : lossPercent,
    yieldRatio,
    mealCount,
    inputLabel: "Rohware (g)",
    outputLabel: "Mahlzeiten",
    explanation: `${rawGrams.toFixed(0)}g Rohware × ${(yieldRatio * 100).toFixed(2)}% = ${finishedGrams.toFixed(0)}g Fertigware ÷ ${portionGrams.toFixed(0)}g/Portion = ${mealCount} Mahlzeiten (${lossPercent.toFixed(2)}% Verlust)`
  };
}

/**
 * Meals → Rohware (Bestimme Rohware für X Mahlzeiten, inkl. Yield-Verlust)
 * Formel: Rohware = (MealCount * portionGrams) / yieldRatio
 */
export function mealsToRaw(
  mealCount: number,
  yieldRatio: number,
  portionGrams: number
): YieldResult {
  if (yieldRatio <= 0 || yieldRatio > 1) {
    throw new Error(`Invalid yieldRatio: ${yieldRatio}. Must be between 0 and 1.`);
  }
  if (mealCount < 0) {
    throw new Error(`Invalid mealCount: ${mealCount}. Must be >= 0.`);
  }
  if (portionGrams <= 0) {
    throw new Error(`Invalid portionGrams: ${portionGrams}. Must be > 0.`);
  }

  const finishedGramsNeeded = mealCount * portionGrams;
  const rawGramsNeeded = finishedGramsNeeded / yieldRatio;
  const lossGrams = rawGramsNeeded - finishedGramsNeeded;
  const lossPercent = (lossGrams / rawGramsNeeded) * 100;

  return {
    inputValue: mealCount,
    outputValue: rawGramsNeeded,
    lossPercent: isNaN(lossPercent) ? 0 : lossPercent,
    yieldRatio,
    mealCount,
    inputLabel: "Mahlzeiten",
    outputLabel: "Benötigte Rohware (g)",
    explanation: `${mealCount} Mahlzeiten × ${portionGrams.toFixed(0)}g/Portion = ${finishedGramsNeeded.toFixed(0)}g Fertigware ÷ ${(yieldRatio * 100).toFixed(2)}% = ${rawGramsNeeded.toFixed(0)}g Rohware benötigt (${lossPercent.toFixed(2)}% Verlust)`
  };
}

/**
 * Master-Dispatcher für alle Szenarien
 */
export function calculateYield(scenario: YieldScenario): YieldResult {
  switch (scenario.type) {
    case "raw_to_finished":
      return rawToFinished(scenario.inputValue, scenario.yieldRatio);
    case "finished_to_raw":
      return finishedToRaw(scenario.inputValue, scenario.yieldRatio);
    case "raw_to_meals":
      return rawToMeals(scenario.inputValue, scenario.yieldRatio, scenario.portionGrams);
    case "meals_to_raw":
      return mealsToRaw(scenario.mealCount || 0, scenario.yieldRatio, scenario.portionGrams);
    default:
      throw new Error(`Unknown scenario type: ${scenario.type}`);
  }
}
