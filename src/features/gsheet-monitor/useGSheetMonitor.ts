// GSheet Monitor – React Hooks für Live-Sheet-Daten.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GSheetChange, GSheetSnapshot, RtiData } from "./gsheetTypes";
import { GSHEET_REGISTRY } from "./gsheetRegistry";
import { createPoller } from "./gsheetPoller";
import { parseRti } from "./parsers/parseRti";

type ParserFn = (rows: string[][]) => unknown;

const PARSERS: Record<string, ParserFn> = {
  rti: parseRti,
};

export interface GSheetMonitorState<T = unknown> {
  data: T | null;
  lastUpdate: number | null;
  changes: GSheetChange[];
  isPolling: boolean;
  error: string | null;
}

export function useGSheetMonitor<T = unknown>(sheetKey: string): GSheetMonitorState<T> {
  const [data, setData] = useState<T | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [changes, setChanges] = useState<GSheetChange[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<ReturnType<typeof createPoller> | null>(null);

  useEffect(() => {
    const config = GSHEET_REGISTRY[sheetKey];
    if (!config) {
      setError(`Sheet "${sheetKey}" nicht in Registry gefunden`);
      return;
    }

    const parser = PARSERS[config.parser];
    if (!parser) {
      setError(`Parser "${config.parser}" nicht registriert`);
      return;
    }

    const poller = createPoller(
      config,
      parser,
      (change, snapshot) => {
        setData(snapshot.parsed as T);
        setLastUpdate(snapshot.timestamp);
        setChanges(prev => [change, ...prev].slice(0, 20));
        setError(null);
        window.dispatchEvent(new CustomEvent("gsheet:change", { detail: { sheetKey, change, snapshot } }));
      },
      (err) => setError(err.message)
    );

    pollerRef.current = poller;
    setIsPolling(true);
    poller.start();

    // Initial data from first poll (before any change)
    const checkInitial = setInterval(() => {
      const snap = poller.getSnapshot();
      if (snap) {
        setData(snap.parsed as T);
        setLastUpdate(snap.timestamp);
        setError(null);
        clearInterval(checkInitial);
      }
    }, 500);

    return () => {
      poller.stop();
      clearInterval(checkInitial);
      setIsPolling(false);
      pollerRef.current = null;
    };
  }, [sheetKey]);

  return { data, lastUpdate, changes, isPolling, error };
}

export function useRtiMonitor(): GSheetMonitorState<RtiData> {
  return useGSheetMonitor<RtiData>("rti");
}

export function useGSheetChangeListener(callback: (event: { sheetKey: string; change: GSheetChange }) => void) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail;
      cbRef.current(detail);
    }
    window.addEventListener("gsheet:change", handler);
    return () => window.removeEventListener("gsheet:change", handler);
  }, []);
}
