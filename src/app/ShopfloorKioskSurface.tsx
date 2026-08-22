// Reduzierte Oberfläche für ?surface=shopfloor&dept=veggie|protein — gedacht
// für je einen Kiosk-Laptop pro Debox-Küche (Veggie und Protein sind zwei
// getrennte physische Stationen). Zeigt nur die WO-Liste dieser einen Küche,
// nach Allergenen sortiert (wenig zuerst, minimiert Reinigungsaufwand), mit
// einem großen "Fertig"-Klick pro WO — kein Rest der App drumherum.
import { useMemo } from "react";
import type { DataBundle } from "../core/types";
import { EQUIP_DEFAULTS } from "../features/ket-plan/ketTypes";
import { calcBatch } from "../features/ket-plan/ketLogic";
import { useKetRowsData } from "../features/ket-plan/useKetRowsData";
import { useGnHints } from "../features/ket-plan/useGnHints";
import { useShopfloorProgress } from "../features/ket-plan/useShopfloorProgress";
import { KetShopfloorDashboard } from "../features/ket-plan/KetShopfloorDashboard";
import type { BatchCalc } from "../features/ket-plan/ketTypes";

function resolveDept(): "veggie" | "protein" {
  const d = new URLSearchParams(window.location.search).get("dept");
  return d === "protein" ? "protein" : "veggie";
}

export function ShopfloorKioskSurface({ data, selectedWeek }: { data: DataBundle; selectedWeek: string }) {
  const dept = useMemo(resolveDept, []);
  const { ketRows, liveWeek } = useKetRowsData(data, selectedWeek, null);
  const gnHints = useGnHints();
  const { progress, setDone, syncError } = useShopfloorProgress(liveWeek);
  const emptyRunAssignments = useMemo(() => new Map<string, never>(), []);

  const calcMap = useMemo(() => {
    const m = new Map<string, BatchCalc>();
    for (const row of ketRows) m.set(row.key, calcBatch(row, EQUIP_DEFAULTS, data, undefined, undefined, gnHints));
    return m;
  }, [ketRows, data, gnHints]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="shrink-0 bg-[#0f2240] px-4 py-2 flex items-center gap-3">
        <div className="w-6 h-6 rounded-md bg-verden-600 flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold">F</span>
        </div>
        <span className="text-white text-xs font-bold">Shopfloor · {liveWeek}</span>
        <a href="/" className="ml-auto text-[10px] text-white/40 hover:text-white/70 transition-colors">
          Vollansicht öffnen
        </a>
      </header>
      <div className="flex-1 min-h-0">
        <KetShopfloorDashboard
          rows={ketRows}
          calcMap={calcMap}
          runAssignments={emptyRunAssignments}
          lockedDept={dept}
          progress={progress}
          onToggleDone={setDone}
          syncError={syncError}
          kiosk
        />
      </div>
    </div>
  );
}
