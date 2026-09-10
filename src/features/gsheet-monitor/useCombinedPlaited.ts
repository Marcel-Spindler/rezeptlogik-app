// „Wie viel von jedem Meal ist schon plaitiert / steht als Fertigware rum" —
// EINE konsistente Quelle für alle Monitor-Panels (Fortschritt je Meal, Was
// kann ich plaiten?, Minimum Needs).
//
// Kombiniert (pro 4-Ziffer-Meal-Identität, siehe mealCodeKey):
//   1. LinePlaiting-Actuals über die ganze laufende KW  (Mensch-gepflegt)
//   2. Redzone-Output 24 h  (aus dem app-weiten RedzoneProvider)
//   3. Redzone-Output 72 h  (eigener Fetch, fängt Runs von vor >24 h)
// → je Meal das Maximum. LinePlaiting ist die Basis, Redzone hebt nur an.
//
// Plus: „{Tag} needs" des Plating-Teams und der Holding-Puffer je Meal
// (beides aus dem BackfillsProvider). Fehlt der BackfillsProvider (z. B. in
// Tests) oder zeigt er eine andere KW als der Aufrufer, fällt alles auf den
// reinen 72-h-Redzone-Wert zurück.
import { useMemo } from "react";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { usePlatedMealTotals } from "../redzone-live/usePlatedMealTotals";
import { mealCodeKey } from "./plateableNet";

export interface CombinedPlaited {
  /** 4-Ziffer-Meal-Identität → schon plaitierte Portionen (LinePlaiting ⊕ Redzone). */
  plaitedByCode: Map<string, number>;
  /** 4-Ziffer-Identität → LinePlaiting „{Tag} needs" (Plating-Team live). */
  platingTeamNeedByCode: Map<string, number>;
  /** 4-Ziffer-Identität → Fertigware-Puffer in Meal-Portionen (RTI „Available Mealcount"). */
  holdingMealsByCode: Map<string, number>;
  /** true = LinePlaiting/Holding-Daten flossen ein (BackfillsProvider da & gleiche KW). */
  linePlaitingMerged: boolean;
}

const EMPTY = new Map<string, number>();

export function useCombinedPlaited(expectedWeekNum: number | null): CombinedPlaited {
  const { platedByMealCode } = usePlatedMealTotals(); // 72-h-Redzone, volle Code-Keys
  const bf = useBackfillsOptional();

  // LinePlaiting/Holding nur verrechnen, wenn der Provider dieselbe KW zeigt wie
  // der Aufrufer — sonst wären es Zahlen der falschen Woche.
  const weekMatch = bf != null && (expectedWeekNum == null || bf.selectedWeekNum === expectedWeekNum);

  return useMemo(() => {
    const plaited = new Map<string, number>();

    // 72-h-Redzone (volle Codes) → auf 4-Ziffer-Identität umschlüsseln.
    for (const [code, n] of platedByMealCode) {
      if (!(n > 0)) continue;
      const k = mealCodeKey(code);
      plaited.set(k, Math.max(plaited.get(k) ?? 0, Math.round(n)));
    }

    // LinePlaiting-Actuals ⊕ 24-h-Redzone aus dem BackfillsProvider (schon 4-Ziffer).
    if (weekMatch) {
      for (const [k, n] of bf!.plaitedByCode) plaited.set(k, Math.max(plaited.get(k) ?? 0, n));
    }

    return {
      plaitedByCode: plaited,
      platingTeamNeedByCode: weekMatch ? bf!.platingTeamNeedByCode : EMPTY,
      holdingMealsByCode: weekMatch ? bf!.holdingMealsByCode : EMPTY,
      linePlaitingMerged: weekMatch,
    };
  }, [platedByMealCode, weekMatch, bf]);
}
