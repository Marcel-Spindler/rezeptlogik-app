// GSheet Monitor – React Hooks für Live-Sheet-Daten.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EtData, GSheetChange, GSheetConfig, LinePlaitingData, PostblastData, PreblastData, RtiData } from "./gsheetTypes";
import { GSHEET_REGISTRY } from "./gsheetRegistry";
import { createPoller } from "./gsheetPoller";
import { parseRti } from "./parsers/parseRti";
import { parsePostblast } from "./parsers/parsePostblast";
import { parsePreblast } from "./parsers/parsePreblast";
import { parseEt } from "./parsers/parseEt";
import { parseLinePlaiting } from "./parsers/parseLinePlaiting";

type ParserFn = (rows: string[][]) => unknown;

const PARSERS: Record<string, ParserFn> = {
  rti: parseRti,
  preblast: parsePreblast,
  postblast: parsePostblast,
  et: parseEt,
  lineplaiting: parseLinePlaiting,
};

export interface GSheetMonitorState<T = unknown> {
  data: T | null;
  lastUpdate: number | null;
  changes: GSheetChange[];
  isPolling: boolean;
  error: string | null;
  forceRefresh: () => Promise<void>;
}

// Gemeinsamer Poller-Unterbau — nimmt Config+Parser direkt entgegen statt nur
// einen Registry-Key, damit auch dynamisch gebaute Configs (z.B. LinePlaiting
// mit wechselndem gid, siehe useLinePlaitingMonitor) dieselbe Logik nutzen.
function useConfiguredGSheetMonitor<T = unknown>(
  config: GSheetConfig | null,
  parser: ParserFn | null,
  missingConfigError: string,
): GSheetMonitorState<T> {
  const [data, setData] = useState<T | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [changes, setChanges] = useState<GSheetChange[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<ReturnType<typeof createPoller> | null>(null);

  useEffect(() => {
    if (!config) {
      setError(missingConfigError);
      setData(null);
      setIsPolling(false);
      return;
    }
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
        window.dispatchEvent(new CustomEvent("gsheet:change", { detail: { sheetKey: config.name, change, snapshot } }));
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
    // config wird per Wert verglichen (id+sheetTab+pollIntervalMs+parser) statt
    // per Objekt-Identität, weil dynamisch gebaute Configs bei jedem Render neu
    // entstehen können, sich aber inhaltlich meist nicht ändern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.id, config?.sheetTab, config?.pollIntervalMs, config?.parser, parser, missingConfigError]);

  const forceRefresh = useCallback(async () => {
    if (!pollerRef.current) return;
    await pollerRef.current.forceRefresh();
    const snap = pollerRef.current.getSnapshot();
    if (snap) {
      setData(snap.parsed as T);
      setLastUpdate(Date.now());
    }
  }, []);

  return { data, lastUpdate, changes, isPolling, error, forceRefresh };
}

export function useGSheetMonitor<T = unknown>(sheetKey: string): GSheetMonitorState<T> {
  const config = GSHEET_REGISTRY[sheetKey] ?? null;
  const parser = config ? PARSERS[config.parser] ?? null : null;
  return useConfiguredGSheetMonitor<T>(config, parser, `Sheet "${sheetKey}" nicht in Registry gefunden`);
}

export function useRtiMonitor(): GSheetMonitorState<RtiData> {
  return useGSheetMonitor<RtiData>("rti");
}

export function usePostblastMonitor(): GSheetMonitorState<PostblastData> {
  return useGSheetMonitor<PostblastData>("postblast");
}

export function usePreblastMonitor(): GSheetMonitorState<PreblastData> {
  return useGSheetMonitor<PreblastData>("preblast");
}

export function useEtMonitor(): GSheetMonitorState<EtData> {
  return useGSheetMonitor<EtData>("et");
}

// ─── LinePlaiting: eigene Datei, aber der Tab (gid) wechselt jede KW ────────
// Anders als postblast/preblast/rti/et (feste ID+gid in GSHEET_REGISTRY) kann
// das hier nicht statisch eingetragen werden — die Config wird zur Laufzeit
// aus dem in localStorage gemerkten gid gebaut. Update-UI: Backfills-Ansicht.
const LINEPLAITING_SHEET_ID = "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U";
const LINEPLAITING_GID_STORAGE_KEY = "lineplaiting_gid_v1";
// W35 (2026-08-23) als Startwert, damit die App auch ohne manuelles Update
// sofort Daten zeigt — jede neue KW braucht dann einen Klick auf "aktualisieren".
const LINEPLAITING_DEFAULT_GID = "793909911";

// Akzeptiert entweder eine komplette Sheet-URL (wie sie beim Kopieren aus dem
// Browser rauskommt, inkl. "#gid=...") oder einfach die nackte gid-Zahl.
export function extractGidFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = /[?&#]gid=(\d+)/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}

export function useLinePlaitingGid(): readonly [string, (input: string) => boolean] {
  const [gid, setGidState] = useState(() => {
    try { return localStorage.getItem(LINEPLAITING_GID_STORAGE_KEY) || LINEPLAITING_DEFAULT_GID; }
    catch { return LINEPLAITING_DEFAULT_GID; }
  });

  const setGid = useCallback((input: string): boolean => {
    const extracted = extractGidFromInput(input);
    if (!extracted) return false;
    setGidState(extracted);
    try { localStorage.setItem(LINEPLAITING_GID_STORAGE_KEY, extracted); } catch { /* quota */ }
    return true;
  }, []);

  return [gid, setGid] as const;
}

export function useLinePlaitingMonitor(gid: string): GSheetMonitorState<LinePlaitingData> {
  const config = useMemo<GSheetConfig>(() => ({
    id: LINEPLAITING_SHEET_ID,
    name: `LinePlaiting (gid=${gid})`,
    sheetTab: `gid=${gid}`,
    pollIntervalMs: 30_000,
    parser: "lineplaiting",
  }), [gid]);
  return useConfiguredGSheetMonitor<LinePlaitingData>(config, parseLinePlaiting, "Kein LinePlaiting-Tab konfiguriert");
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
