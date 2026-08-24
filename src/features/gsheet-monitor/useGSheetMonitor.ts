// GSheet Monitor – React Hooks für Live-Sheet-Daten.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EtData, GSheetChange, GSheetConfig, LinePlaitingData, PostblastData, PreblastData, ProductionPlanData, RtiData } from "./gsheetTypes";
import { GSHEET_REGISTRY } from "./gsheetRegistry";
import { createPoller } from "./gsheetPoller";
import { parseRti } from "./parsers/parseRti";
import { parsePostblast } from "./parsers/parsePostblast";
import { parsePreblast } from "./parsers/parsePreblast";
import { parseEt } from "./parsers/parseEt";
import { parseLinePlaiting } from "./parsers/parseLinePlaiting";
import { parseProductionPlan } from "./parsers/parseProductionPlan";

type ParserFn = (rows: string[][]) => unknown;

// productionplan ist bewusst NICHT hier eingetragen — dieser Source läuft
// über einen eigenen JSON-Poller (siehe useProductionPlanMonitor unten),
// nicht über den gemeinsamen CSV-Poller/createPoller wie alle anderen.
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

// ─── Production Plan: eigenes Sheet, Tab (gid) wechselt jede KW ────────────
// Wie LinePlaiting (siehe oben) kann die Config nicht statisch in
// GSHEET_REGISTRY stehen — Marcel trägt den neuen Tab-Link/gid jede KW im
// Vorstellungsplan-View ein. Startwert = Tab "W36 - Plating Plan [WIP]"
// (2026-08-24, aktuelle HF-Woche zum Bauzeitpunkt).
//
// Anders als die anderen GSheet-Quellen läuft dieser Poller NICHT über den
// anonymen gviz/tq-CSV-Export (fetchSheetCsv/createPoller): dieses Sheet lässt
// Text-Zellen ("Cup"/"Slicing") in den Tages-Matrix-Spalten dort still
// leer, während Zahlen korrekt ankommen (verifiziert per Sheets-API-
// Gegenprobe, FORMULA/UNFORMATTED_VALUE/FORMATTED_VALUE stimmen überein,
// nur der öffentliche CSV-Export lässt den Text weg). Stattdessen ruft dieser
// Hook den lokalen WMS-Server (scripts/wms-local-server.ts, Endpunkt
// /production-plan) auf, der per Service Account über die echte Sheets API
// liest — setzt voraus, dass `npm run start`/der lokale Dev-Server läuft.
const PRODUCTIONPLAN_GID_STORAGE_KEY = "productionplan_gid_v1";
const PRODUCTIONPLAN_DEFAULT_GID = "321735032";
const PRODUCTIONPLAN_POLL_MS = 60_000;

export function useProductionPlanGid(): readonly [string, (input: string) => boolean] {
  const [gid, setGidState] = useState(() => {
    try { return localStorage.getItem(PRODUCTIONPLAN_GID_STORAGE_KEY) || PRODUCTIONPLAN_DEFAULT_GID; }
    catch { return PRODUCTIONPLAN_DEFAULT_GID; }
  });

  const setGid = useCallback((input: string): boolean => {
    const extracted = extractGidFromInput(input);
    if (!extracted) return false;
    setGidState(extracted);
    try { localStorage.setItem(PRODUCTIONPLAN_GID_STORAGE_KEY, extracted); } catch { /* quota */ }
    return true;
  }, []);

  return [gid, setGid] as const;
}

export function useProductionPlanMonitor(gid: string): GSheetMonitorState<ProductionPlanData> {
  const [data, setData] = useState<ProductionPlanData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/production-plan?gid=${encodeURIComponent(gid)}`, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; rows?: string[][] } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error || `Production-Plan-Server antwortete mit ${res.status}`);
    }
    setData(parseProductionPlan(body.rows ?? []));
    setLastUpdate(Date.now());
    setError(null);
  }, [gid]);

  useEffect(() => {
    if (!gid) return;
    const controller = new AbortController();
    setIsPolling(true);

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
    }

    void poll();
    const timer = setInterval(poll, PRODUCTIONPLAN_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [gid, fetchOnce]);

  const forceRefresh = useCallback(async () => {
    try { await fetchOnce(); }
    catch (err) { setError((err as Error).message); }
  }, [fetchOnce]);

  return { data, lastUpdate, changes: [], isPolling, error, forceRefresh };
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
