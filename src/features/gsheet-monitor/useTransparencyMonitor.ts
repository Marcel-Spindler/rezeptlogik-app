// Transparency Plan – React-Hooks. Eigene Datei statt useGSheetMonitor.ts
// weiter aufzublähen (dort schon 450+ Zeilen). Ein generischer Kern-Hook
// (Fetch+Parse+Poll, kopiert vom bestehenden useRecipeProfilMonitor-Muster),
// darüber dünne benannte Wrapper pro Tab. Server-seitiges Gegenstück:
// scripts/wms-local-server.ts (TRANSPARENCY_TAB_REGISTRY, Route
// /transparency-sheet?tab=<key>) — die Tab-Keys hier MÜSSEN exakt mit dem
// Server-Registry übereinstimmen.
import { useCallback, useEffect, useState } from "react";
import type {
  TransparencyWeighingData, TransparencyFlowData, TransparencyPlanningCheckData, TransparencyRtemData,
  TransparencyForecastData, TransparencyWmsWoData, TransparencyEtData, TransparencyInputKitchenData,
  TransparencySleevingData, TransparencyPrintingData, TransparencyBenlOutboundData,
  TransparencyPlatingExecutionData, TransparencyPlatingHoldingData, TransparencyKitchenKpiData,
  TransparencyIssueTrackerData, TransparencyRawTabData,
} from "./transparencyTypes";
import { parseWeighingLedger } from "./parsers/transparency/parseWeighingLedger";
import { parseTotalOverview } from "./parsers/transparency/parseTotalOverview";
import { parsePlanningCheck } from "./parsers/transparency/parsePlanningCheck";
import { parseRtem } from "./parsers/transparency/parseRtem";
import { parseTransparencyForecast } from "./parsers/transparency/parseTransparencyForecast";
import { parseWmsWo, parseTransparencyEt, parseInputKitchen } from "./parsers/transparency/parseWoStatus";
import { parseSleeving, parsePrinting, parseBenlOutbound } from "./parsers/transparency/parseLogistics";
import { parsePlatingExecution, parseCountingPlatingHolding } from "./parsers/transparency/parseExecution";
import { parseKitchenKpis, parseIssueTracker } from "./parsers/transparency/parseKpiLog";

export interface TransparencyMonitorState<T> {
  data: T | null;
  lastUpdate: number | null;
  isPolling: boolean;
  error: string | null;
  forceRefresh: () => Promise<void>;
}

async function fetchTransparencyTabRows(tab: string, signal?: AbortSignal): Promise<string[][]> {
  const res = await fetch(`/api/transparency-sheet?tab=${encodeURIComponent(tab)}`, { signal, cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; rows?: string[][] } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error || `Transparency-Sheet-Server antwortete mit ${res.status}`);
  return body.rows ?? [];
}

// Generischer Kern-Hook: Fetch + Parse + Poll, identisch zum bestehenden
// useRecipeProfilMonitor-Muster in useGSheetMonitor.ts, nur parametrisiert.
export function useTransparencyTab<T>(tab: string, parser: (rows: string[][]) => T, pollMs: number): TransparencyMonitorState<T> {
  const [data, setData] = useState<T | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(
    async (signal?: AbortSignal) => {
      const rows = await fetchTransparencyTabRows(tab, signal);
      setData(parser(rows));
      setLastUpdate(Date.now());
      setError(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parser ist pro Aufrufer stabil (Modul-Funktion), tab/pollMs sind die eigentlichen Deps
    [tab]
  );

  useEffect(() => {
    const controller = new AbortController();
    setIsPolling(true);

    async function poll() {
      try { await fetchOnce(controller.signal); }
      catch (err) { if ((err as Error).name !== "AbortError") setError((err as Error).message); }
    }

    void poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [fetchOnce, pollMs]);

  const forceRefresh = useCallback(async () => {
    try { await fetchOnce(); }
    catch (err) { setError((err as Error).message); }
  }, [fetchOnce]);

  return { data, lastUpdate, isPolling, error, forceRefresh };
}

// Roh-Fallback für Tabs ohne dedizierten Parser (kaputte/leere/reine
// Referenz-Tabs) — macht sie über eine generische Tabelle sichtbar, ohne
// dass jeder einzeln vorab typisiert werden muss.
function parseRawTab(rows: string[][]): TransparencyRawTabData {
  return { rows, lastUpdated: Date.now() };
}
export function useTransparencyRawTab(tab: string, pollMs = 300_000): TransparencyMonitorState<TransparencyRawTabData> {
  return useTransparencyTab(tab, parseRawTab, pollMs);
}

// ── Kern-Tabs (Poll 60s — Produzierbarkeit soll zügig live sein) ──────────
export const useTransparencyWeighing = (): TransparencyMonitorState<TransparencyWeighingData> =>
  useTransparencyTab("importrange-weights", parseWeighingLedger, 60_000);
export const useTransparencyFlow = (): TransparencyMonitorState<TransparencyFlowData> =>
  useTransparencyTab("total-overview", parseTotalOverview, 60_000);
export const useTransparencyPlanningCheck = (): TransparencyMonitorState<TransparencyPlanningCheckData> =>
  useTransparencyTab("planning-check", parsePlanningCheck, 60_000);
// RTEM/Forecast ändern sich seltener als die Wiegungen selbst.
export const useTransparencyRtem = (): TransparencyMonitorState<TransparencyRtemData> =>
  useTransparencyTab("rtem", parseRtem, 120_000);
export const useTransparencyForecast = (): TransparencyMonitorState<TransparencyForecastData> =>
  useTransparencyTab("forecast", parseTransparencyForecast, 120_000);

// ── WO-/Stations-Status (60s) ──────────────────────────────────────────────
export const useTransparencyWmsWo = (): TransparencyMonitorState<TransparencyWmsWoData> =>
  useTransparencyTab("wms-wo", parseWmsWo, 60_000);
export const useTransparencyEtStatus = (): TransparencyMonitorState<TransparencyEtData> =>
  useTransparencyTab("et", parseTransparencyEt, 60_000);
export const useTransparencyInputKitchen = (): TransparencyMonitorState<TransparencyInputKitchenData> =>
  useTransparencyTab("input-kitchen", parseInputKitchen, 60_000);

// ── Logistik/Downstream (60s) ──────────────────────────────────────────────
function useTwoTabTransparency<T>(tabA: string, tabB: string, parser: (a: string[][], b: string[][]) => T, pollMs: number): TransparencyMonitorState<T> {
  const a = useTransparencyTab(tabA, (rows) => rows, pollMs);
  const b = useTransparencyTab(tabB, (rows) => rows, pollMs);
  const data = a.data && b.data ? parser(a.data, b.data) : null;
  const forceRefresh = useCallback(async () => { await Promise.all([a.forceRefresh(), b.forceRefresh()]); }, [a, b]);
  return {
    data,
    lastUpdate: a.lastUpdate && b.lastUpdate ? Math.max(a.lastUpdate, b.lastUpdate) : (a.lastUpdate ?? b.lastUpdate),
    isPolling: a.isPolling || b.isPolling,
    error: a.error ?? b.error,
    forceRefresh,
  };
}

export const useTransparencySleeving = (): TransparencyMonitorState<TransparencySleevingData> =>
  useTwoTabTransparency("sleeving-output", "sleeving-requirements", parseSleeving, 60_000);
export const useTransparencyPrinting = (): TransparencyMonitorState<TransparencyPrintingData> =>
  useTwoTabTransparency("printing-output", "printing-requirements", parsePrinting, 60_000);
export const useTransparencyBenlOutbound = (): TransparencyMonitorState<TransparencyBenlOutboundData> =>
  useTransparencyTab("benl-outbound", parseBenlOutbound, 60_000);

// ── Ausführung/Holding (60s) ────────────────────────────────────────────────
export const useTransparencyPlatingExecution = (): TransparencyMonitorState<TransparencyPlatingExecutionData> =>
  useTransparencyTab("plating-execution", parsePlatingExecution, 60_000);
export const useTransparencyPlatingHolding = (): TransparencyMonitorState<TransparencyPlatingHoldingData> =>
  useTransparencyTab("counting-plating-holding", parseCountingPlatingHolding, 60_000);

// ── KPI/Log (300s — ändert sich langsam) ───────────────────────────────────
export const useTransparencyKitchenKpis = (): TransparencyMonitorState<TransparencyKitchenKpiData> =>
  useTransparencyTab("kitchen-kpis", parseKitchenKpis, 300_000);
export const useTransparencyIssueTracker = (): TransparencyMonitorState<TransparencyIssueTrackerData> =>
  useTransparencyTab("issue-tracker", parseIssueTracker, 300_000);

// Alle Registry-Keys, die (noch) keinen dedizierten Parser haben — als Roh-
// Tabellen in einem "weitere Tabs"-Panel sichtbar. Lange Poll-Intervalle
// (v.a. "all-recipes" mit 38k Zeilen: stündlich statt minütlich).
export const TRANSPARENCY_RAW_FALLBACK_TABS: readonly { key: string; label: string; pollMs: number }[] = [
  { key: "ku", label: "KU", pollMs: 300_000 },
  { key: "ku-week", label: "KU Week", pollMs: 300_000 },
  { key: "printing-overview", label: "Printing Overview", pollMs: 300_000 },
  { key: "eaches-conversion", label: "Eaches Conversion", pollMs: 900_000 },
  { key: "manual-check", label: "Manual Check", pollMs: 300_000 },
  { key: "all-shortages", label: "All Shortages", pollMs: 300_000 },
  { key: "analysis-eli", label: "Analysis Eli", pollMs: 300_000 },
  { key: "stock-recount", label: "Stock Re-Count", pollMs: 300_000 },
  { key: "sheet82", label: "Sheet82 (ET-Duplikat)", pollMs: 300_000 },
  { key: "sheet93", label: "Sheet93 (Meal Specs)", pollMs: 900_000 },
  { key: "sum-of-all-recipes", label: "Sum of all recipes", pollMs: 300_000 },
  { key: "calculation-gewicht", label: "Calculation Gewicht per Workorder", pollMs: 300_000 },
  { key: "input-plating-sleeving", label: "Input Plating/Sleeving", pollMs: 300_000 },
  { key: "post-blast-wms", label: "Post Blast WMS", pollMs: 300_000 },
  { key: "kitchen-wms", label: "Kitchen WMS", pollMs: 300_000 },
  { key: "blast-overview", label: "Blast Overview", pollMs: 300_000 },
  { key: "all-recipes", label: "All Recipes (BOM-Export)", pollMs: 3_600_000 },
];
