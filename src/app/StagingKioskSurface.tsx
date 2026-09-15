// Standalone-Surface für ?surface=staging — teilbares Dashboard für das
// Lager-Team (WOs today/morgen stagen + abhaken) und Planer (Datum verschieben).
// Gleiche Datenquelle wie KetBreakdownView: Live-WMS via useKetRowsData.
// Zusätzlich: Lagerplatz + MHD aus dem lokalen WMS-Server via useIngredientStock.
import { useMemo } from "react";
import type { DataBundle } from "../core/types";
import { EQUIP_DEFAULTS } from "../features/ket-plan/ketTypes";
import { calcBatch } from "../features/ket-plan/ketLogic";
import { useKetRowsData } from "../features/ket-plan/useKetRowsData";
import { useGnHints } from "../features/ket-plan/useGnHints";
import { useStagingProgress } from "../features/ket-plan/useStagingProgress";
import { useIngredientStock } from "../features/ket-plan/useIngredientStock";
import { StagingDashboard } from "../features/ket-plan/StagingDashboard";
import type { BatchCalc } from "../features/ket-plan/ketTypes";

export function StagingKioskSurface({ data, selectedWeek }: { data: DataBundle; selectedWeek: string }) {
  const { ketRows, liveWeek } = useKetRowsData(data, selectedWeek, null);
  const gnHints = useGnHints();
  const { progress, setStaged, setOffset, syncError } = useStagingProgress(liveWeek);

  const calcMap = useMemo(() => {
    const m = new Map<string, BatchCalc>();
    for (const row of ketRows) m.set(row.key, calcBatch(row, EQUIP_DEFAULTS, data, undefined, undefined, gnHints));
    return m;
  }, [ketRows, data, gnHints]);

  // Alle eindeutigen Zutaten-Namen für den WMS-Stock-Lookup sammeln
  const ingredientNames = useMemo(() => {
    const names = new Set<string>();
    for (const calc of calcMap.values()) {
      for (const ing of calc.ingredients) {
        if (ing.name && (ing.totalKg > 0 || (ing.totalPcs ?? 0) > 0)) names.add(ing.name);
      }
    }
    return [...names];
  }, [calcMap]);

  const { stockMap, stagingMap, serverAvailable } = useIngredientStock(ingredientNames);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <div className="flex-1 min-h-0">
        <StagingDashboard
          rows={ketRows}
          calcMap={calcMap}
          cookSchedules={data.cookSchedules ?? {}}
          week={liveWeek}
          progress={progress}
          stockMap={stockMap}
          stagingMap={stagingMap}
          serverAvailable={serverAvailable}
          onToggleStaged={setStaged}
          onOffsetChange={setOffset}
          syncError={syncError}
        />
      </div>
    </div>
  );
}
