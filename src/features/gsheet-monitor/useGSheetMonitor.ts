// GSheet Monitor – React Hooks für Live-Sheet-Daten.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EtData, ForecastData, GSheetChange, GSheetConfig, LinePlaitingData, PostblastData, PreblastData, ProductionPlanData, ProductionPlanWeekOption, RecipeProfilData, RtiData, ShortsTrackerData } from "./gsheetTypes";
import { GSHEET_REGISTRY } from "./gsheetRegistry";
import { createPoller } from "./gsheetPoller";
import { parseRti } from "./parsers/parseRti";
import { parsePostblast } from "./parsers/parsePostblast";
import { parsePreblast } from "./parsers/parsePreblast";
import { parseEt } from "./parsers/parseEt";
import { parseLinePlaiting } from "./parsers/parseLinePlaiting";
import { parseProductionPlan } from "./parsers/parseProductionPlan";
import { parseForecast } from "./parsers/parseForecast";
import { parseRecipeProfil } from "./parsers/parseRecipeProfil";
import { parseShortsTracker } from "./parsers/parseShortsTracker";

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
// Frueher trug Marcel den neuen Tab-Link/gid jede KW manuell im
// Vorstellungsplan-View ein (localStorage-Persistenz). Jetzt liest der lokale
// WMS-Server (scripts/wms-local-server.ts, Endpunkt /production-plan-weeks)
// live alle Tabs aus, die dem Muster "W{NN} - Plating Plan [WIP]" folgen, und
// useProductionPlanSelection waehlt automatisch "aktuelle KW + 1" -- neue
// Wochen-Tabs, die Marcel im Sheet anlegt, tauchen beim naechsten Poll von
// selbst auf, kein manuelles Verlinken mehr noetig.
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
const PRODUCTIONPLAN_POLL_MS = 60_000;
const PRODUCTIONPLAN_WEEKS_POLL_MS = 60_000;

export interface ProductionPlanWeeksState {
  weeks: ProductionPlanWeekOption[];
  currentHfWeek: string | null;
  sheetId: string | null;
  loading: boolean;
  error: string | null;
  forceRefresh: () => Promise<void>;
}

export function useProductionPlanWeeks(): ProductionPlanWeeksState {
  const [weeks, setWeeks] = useState<ProductionPlanWeekOption[]>([]);
  const [currentHfWeekState, setCurrentHfWeekState] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/production-plan-weeks", { signal, cache: "no-store" });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; weeks?: ProductionPlanWeekOption[]; currentHfWeek?: string; sheetId?: string } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Production-Plan-Wochenliste antwortete mit ${res.status}`);
    setWeeks(body.weeks ?? []);
    setCurrentHfWeekState(body.currentHfWeek ?? null);
    setSheetId(body.sheetId ?? null);
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
      finally { setLoading(false); }
    }

    void poll();
    const timer = setInterval(poll, PRODUCTIONPLAN_WEEKS_POLL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [fetchOnce]);

  const forceRefresh = useCallback(async () => {
    try { await fetchOnce(); } catch (err) { setError((err as Error).message); }
  }, [fetchOnce]);

  return { weeks, currentHfWeek: currentHfWeekState, sheetId, loading, error, forceRefresh };
}

export interface ProductionPlanSelection {
  selected: ProductionPlanWeekOption | null;
  autoOption: ProductionPlanWeekOption | null;
  isAuto: boolean;
  select: (week: number) => void;
  resetToAuto: () => void;
}

// Waehlt automatisch "aktuelle KW + 1" aus der Wochenliste. select() erlaubt
// spontanes Zurueckblaettern (z.B. um KW36 selbst noch mal zu pruefen),
// resetToAuto() kehrt zur automatischen Vorauswahl zurueck. Die manuelle Wahl
// wird bewusst NICHT persistiert (kein localStorage) -- beim naechsten
// Seitenaufruf/naechste Woche greift wieder automatisch "naechste KW".
export function useProductionPlanSelection(weeks: ProductionPlanWeekOption[], currentHfWeekLabel: string | null): ProductionPlanSelection {
  const [manualWeek, setManualWeek] = useState<number | null>(null);

  const targetWeekNum = useMemo(() => {
    const m = currentHfWeekLabel ? /W(\d{2})$/.exec(currentHfWeekLabel) : null;
    return m ? Number(m[1]) + 1 : null;
  }, [currentHfWeekLabel]);

  const autoOption = useMemo(() => {
    if (!weeks.length) return null;
    if (targetWeekNum != null) {
      const exact = weeks.find(w => w.week === targetWeekNum);
      if (exact) return exact;
    }
    // Naechste-Woche-Tab noch nicht angelegt -> die zeitlich naechstgelegene
    // verfuegbare Woche (Liste ist aufsteigend sortiert, siehe Server).
    return weeks[0];
  }, [weeks, targetWeekNum]);

  const selected = useMemo(() => {
    if (manualWeek != null) {
      const found = weeks.find(w => w.week === manualWeek);
      if (found) return found;
    }
    return autoOption;
  }, [weeks, manualWeek, autoOption]);

  return {
    selected,
    autoOption,
    isAuto: manualWeek == null,
    select: (week: number) => setManualWeek(week),
    resetToAuto: () => setManualWeek(null),
  };
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

// ─── Forecast & Recipe Profil: Live-Vergleich für den Production Plan ─────
// Siehe productionPlanLiveCheck.ts -- beide laufen unabhängig vom Production-
// Plan-Poller oben, damit ein Fehlschlag hier nie die Haupttabelle blockiert.
const FORECAST_POLL_MS = 60_000;

export function useForecastMonitor(week: string): GSheetMonitorState<ForecastData> {
  const [data, setData] = useState<ForecastData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/forecast?week=${encodeURIComponent(week)}`, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; rows?: string[][] } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Forecast-Server antwortete mit ${res.status}`);
    setData(parseForecast(body.rows ?? [], week));
    setLastUpdate(Date.now());
    setError(null);
  }, [week]);

  useEffect(() => {
    if (!week) return;
    const controller = new AbortController();
    setIsPolling(true);

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
    }

    void poll();
    const timer = setInterval(poll, FORECAST_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [week, fetchOnce]);

  const forceRefresh = useCallback(async () => {
    try { await fetchOnce(); }
    catch (err) { setError((err as Error).message); }
  }, [fetchOnce]);

  return { data, lastUpdate, changes: [], isPolling, error, forceRefresh };
}

// Recipe Profil ist global (nicht wochenweise) und aendert sich selten -- laengeres Poll-Intervall.
const RECIPE_PROFIL_POLL_MS = 300_000;

export function useRecipeProfilMonitor(): GSheetMonitorState<RecipeProfilData> {
  const [data, setData] = useState<RecipeProfilData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/recipe-profil`, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; rows?: string[][] } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Recipe-Profil-Server antwortete mit ${res.status}`);
    setData(parseRecipeProfil(body.rows ?? []));
    setLastUpdate(Date.now());
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setIsPolling(true);

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
    }

    void poll();
    const timer = setInterval(poll, RECIPE_PROFIL_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [fetchOnce]);

  const forceRefresh = useCallback(async () => {
    try { await fetchOnce(); }
    catch (err) { setError((err as Error).message); }
  }, [fetchOnce]);

  return { data, lastUpdate, changes: [], isPolling, error, forceRefresh };
}

// Shorts Tracker meldet Rohstoff-Engpässe, die sofort auffallen sollen ("hier
// wurde gerade eine neue Zeile eingetragen") -- ähnlich dringend wie Postblast/
// Preblast (30s), nicht wie das seltener wechselnde Recipe Profil.
const SHORTS_TRACKER_POLL_MS = 30_000;

export function useShortsTrackerMonitor(): GSheetMonitorState<ShortsTrackerData> {
  const [data, setData] = useState<ShortsTrackerData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/shorts-tracker`, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; rows?: string[][] } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Shorts-Tracker-Server antwortete mit ${res.status}`);
    setData(parseShortsTracker(body.rows ?? []));
    setLastUpdate(Date.now());
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setIsPolling(true);

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
    }

    void poll();
    const timer = setInterval(poll, SHORTS_TRACKER_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [fetchOnce]);

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
