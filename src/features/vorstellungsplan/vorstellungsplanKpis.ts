// Vorstellungsplan – App-weite KPI-Kacheln (Backfills, Redzone, WMS) für die
// Präsentationsansicht. Backfills/Redzone laufen ohnehin app-weit (siehe
// BackfillsProvider/RedzoneProvider in App.tsx) und werden hier nur gelesen.
// WMS läuft NICHT app-weit — fetchAllWmsStations ruft live den lokalen WMS-
// Server (scripts/wms-local-server.ts) über mehrere Endpunkte auf. Weil diese
// Ansicht typischerweise LIVE vor Publikum steht, darf ein nicht erreichbarer
// WMS-Server die restliche Präsentation nie blockieren: eigener Ladezustand,
// niedriges maxRetries, Fehler landet nur in der einen Kachel als "–".
import { useEffect, useRef, useState } from "react";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { fetchAllWmsStations } from "../wms-overview/wmsFetch";
import { aggregateWorkorders } from "../wms-overview/wmsAggregate";
import { woMatchesSelectedWeek } from "../wms-overview/wmsWeeks";

export interface BackfillsKpi {
  criticalCount: number;
  totalRecommendedPortions: number;
  connected: boolean;
}

export interface RedzoneKpi {
  totalPlated: number;
  activeLineCount: number;
  connected: boolean;
}

export type WmsKpiStatus = "idle" | "loading" | "ready" | "error";

export interface WmsKpi {
  status: WmsKpiStatus;
  totalWoPortions: number | null;
  uniqueMeals: number | null;
}

export function useBackfillsKpi(): BackfillsKpi | null {
  const backfills = useBackfillsOptional();
  if (!backfills) return null;
  return {
    criticalCount: backfills.criticalCount,
    totalRecommendedPortions: backfills.totalRecommendedPortions,
    connected: backfills.postblastConnected || backfills.linePlaitingConnected,
  };
}

export function useRedzoneKpi(): RedzoneKpi | null {
  const redzone = useRedzoneOptional();
  if (!redzone) return null;
  return {
    totalPlated: redzone.totalPlated,
    activeLineCount: redzone.activeLineCount,
    connected: !redzone.loading && !redzone.error,
  };
}

// Best-effort: ein Fehlschlag (Server nicht erreichbar) darf nur diese eine
// Kachel betreffen, siehe Datei-Kommentar oben.
export function useWmsKpi(week: string): WmsKpi {
  const [state, setState] = useState<WmsKpi>({ status: "idle", totalWoPortions: null, uniqueMeals: null });
  const requestedWeekRef = useRef<string | null>(null);

  useEffect(() => {
    if (!week || requestedWeekRef.current === week) return;
    requestedWeekRef.current = week;
    let cancelled = false;
    setState({ status: "loading", totalWoPortions: null, uniqueMeals: null });

    (async () => {
      try {
        const result = await fetchAllWmsStations(week, { maxRetries: 1 });
        if (cancelled) return;
        const rows = result.data.workorders.rows.filter(r => woMatchesSelectedWeek(r.week, week));
        const agg = aggregateWorkorders(rows);
        const totalWoPortions = agg.reduce((sum, m) => sum + m.totalQty, 0);
        setState({ status: "ready", totalWoPortions, uniqueMeals: agg.length });
      } catch {
        if (!cancelled) setState({ status: "error", totalWoPortions: null, uniqueMeals: null });
      }
    })();

    return () => { cancelled = true; };
  }, [week]);

  return state;
}
