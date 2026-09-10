// Platierte Portionen je Meal-Code über ein längeres Fenster als der globale
// RedzoneProvider (der nur 24 h zieht).
//
// Nötig für die "noch platierbar"-Rechnung im Postblast-Monitor / Plating
// Dashboard: ein Montag früh platierter Run muss auch Freitag noch von der
// Brutto-Menge abgezogen werden, sonst zeigt "Fortschritt je Meal" die ganze
// Wochenproduktion als platierbar an, obwohl der erste Run längst raus ist.
//
// Eigener Fetch mit eigenem Lookback, damit die 24-h-Kennzahlen anderswo
// (RedzoneMonitorPanel "Portionen fertig (24h)", Vorstellungsplan-KPI) davon
// unberührt bleiben. Die Zähl-Logik spiegelt buildPlatedByCodeMap
// (redzoneHelpers.ts): fertige UND laufende Plating-Runs mit Output zählen.
import { useEffect, useState } from "react";
import type { RedzoneStatusResponse } from "./redzoneTypes";
import { enrichRun } from "./redzoneResolve";

const POLL_MS = 60_000;
const DEFAULT_HOURS = 72;

export interface PlatedMealTotals {
  /** Meal-Code → schon platierte Portionen (Redzone, fertige + laufende Runs). */
  platedByMealCode: Map<string, number>;
  loading: boolean;
  error: string | null;
}

export function usePlatedMealTotals(hours: number = DEFAULT_HOURS): PlatedMealTotals {
  const [state, setState] = useState<PlatedMealTotals>({
    platedByMealCode: new Map(),
    loading: true,
    error: null,
  });

  useEffect(() => {
    let disposed = false;

    const run = async () => {
      try {
        const res = await fetch(`/api/redzone-plating-status?hours=${hours}`, { cache: "no-store" });
        const data: RedzoneStatusResponse = await res
          .json()
          .catch(() => ({ ok: false }) as RedzoneStatusResponse);
        if (disposed) return;
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        const map = new Map<string, number>();
        for (const row of data.rows) {
          const r = enrichRun(row);
          if (r.areaName !== "Plating" || !r.mealCode || !r.outCount) continue;
          map.set(r.mealCode, (map.get(r.mealCode) ?? 0) + r.outCount);
        }
        setState({ platedByMealCode: map, loading: false, error: null });
      } catch (e) {
        if (!disposed) {
          setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
        }
      }
    };

    void run();
    const timer = setInterval(run, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [hours]);

  return state;
}
