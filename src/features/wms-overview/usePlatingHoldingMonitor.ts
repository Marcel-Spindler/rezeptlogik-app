// WMS Übersicht – Live-Poller nur für Plating Holding (PLH). Eigener, leichter
// Hook statt fetchAllWmsStations, damit Verbraucher wie Backfills nicht den
// kompletten 8-Stationen-Funnel mitziehen, nur um den Holding-Puffer zu kennen.
import { useEffect, useRef, useState } from "react";
import { fetchPlatingHoldingRows } from "./wmsFetch";
import type { StoredRow } from "./wmsTypes";

const POLL_MS = 60_000;

export interface PlatingHoldingMonitorState {
  rows: StoredRow[] | null;
  lastUpdate: number | null;
  error: string | null;
}

export function usePlatingHoldingMonitor(): PlatingHoldingMonitorState {
  const [rows, setRows] = useState<StoredRow[] | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;

    async function poll() {
      try {
        const fetched = await fetchPlatingHoldingRows();
        if (disposedRef.current) return;
        setRows(fetched);
        setLastUpdate(Date.now());
        setError(null);
      } catch (e) {
        if (disposedRef.current) return;
        // Kein Fehler-Zustand für die UI erzwingen — lokaler Server/Cloud
        // Function können schlicht (noch) nicht erreichbar sein, dann bleibt
        // rows einfach null und die Anreicherung fällt weg (siehe combineBackfills.ts).
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      disposedRef.current = true;
      window.clearInterval(timer);
    };
  }, []);

  return { rows, lastUpdate, error };
}
