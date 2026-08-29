// WMS Übersicht – Live-Poller für den kompletten Lagerbestand (T_STORED_ITEM, VF).
// Eigener leichter Hook analog usePlatingHoldingMonitor, damit Verbraucher wie
// Backfills den Vollbestand für die Rohware-Bestandsprüfung nutzen können, ohne
// die "Lager Komplett"-View mitzuziehen. Läuft nur mit lokalem WMS-Server (3141) —
// online bleibt `rows` null und die Anreicherung fällt weg.
import { useEffect, useRef, useState } from "react";
import { fetchFullInventory } from "./wmsFetch";
import type { FullInventoryRow } from "./wmsTypes";

// fetchFullInventory cached selbst 10 Min + Fallback auf Cache — ein 5-Min-Poll
// hält die Daten frisch, ohne Snowflake unnötig zu belasten.
const POLL_MS = 5 * 60_000;

export interface FullInventoryMonitorState {
  rows: FullInventoryRow[] | null;
  lastUpdate: number | null;
  generatedAt: string | null;
  error: string | null;
}

export function useFullInventoryMonitor(): FullInventoryMonitorState {
  const [rows, setRows] = useState<FullInventoryRow[] | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;

    async function poll() {
      try {
        // maxRetries: 0 — Hintergrund-Poller, kein Warten auf einen (evtl. gar
        // nicht laufenden) lokalen Server; persistGet-Cache greift trotzdem.
        const res = await fetchFullInventory({ limit: 200000, maxRetries: 0 });
        if (disposedRef.current) return;
        setRows(res.rows);
        setGeneratedAt(res.generatedAt);
        setLastUpdate(Date.now());
        setError(null);
      } catch (e) {
        if (disposedRef.current) return;
        // Kein Fehler-Zustand für die UI erzwingen — lokaler Server/Cloud Function
        // können schlicht nicht erreichbar sein, dann bleibt rows null.
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

  return { rows, lastUpdate, generatedAt, error };
}
