// Backfills – globaler Provider. Führt Küche (Postblast/Pre-Blast-Gewichte),
// Plating (LinePlaiting) und RTI-Holding-Puffer laufend zu einer Liste
// zusammen und erkennt quellenübergreifende Frühwarnungen. Läuft IMMER (wie
// RedzoneProvider/WoReconciliationProvider), unabhängig davon, welcher Tab
// gerade offen ist — das ist die Grundlage für die app-weite Meldung.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAppState } from "../../app/AppContext";
import {
  useLinePlaitingGid,
  useLinePlaitingMonitor,
  usePostblastMonitor,
  usePreblastMonitor,
  useRtiMonitor,
} from "../gsheet-monitor/useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed, type MealProgress } from "../gsheet-monitor/postblastMatch";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { usePlatingHoldingMonitor } from "../wms-overview/usePlatingHoldingMonitor";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { buildSkuInfoIndex } from "../../lib/wmsSkuEnrichment";
import { combineBackfillSignals, detectCrossSourceAlerts } from "./combineBackfills";
import type { BackfillAlert, CombinedBackfillNeed } from "./backfillTypes";

export interface BackfillsState {
  meals: MealProgress[];
  kitchenBackfill: BackfillNeed[];
  combined: CombinedBackfillNeed[];
  alerts: BackfillAlert[];
  criticalCount: number;
  totalRecommendedPortions: number;
  postblastConnected: boolean;
  preblastConnected: boolean;
  rtiConnected: boolean;
  linePlaitingConnected: boolean;
  wmsHoldingConnected: boolean;
  linePlaitingGid: string;
  setLinePlaitingGid: (input: string) => boolean;
  linePlaitingLastUpdate: number | null;
  linePlaitingForceRefresh: () => Promise<void>;
  selectedWeekNum: number | null;
  setSelectedWeekNum: (wn: number | null) => void;
  availableWeekNums: number[];
  isStaleWeek: boolean;
}

const BackfillsContext = createContext<BackfillsState | null>(null);

export function useBackfills(): BackfillsState {
  const ctx = useContext(BackfillsContext);
  if (!ctx) throw new Error("useBackfills must be used within BackfillsProvider");
  return ctx;
}

export function useBackfillsOptional(): BackfillsState | null {
  return useContext(BackfillsContext);
}

export function BackfillsProvider({ children }: { children: ReactNode }) {
  const { data } = useAppState();
  const postblast = usePostblastMonitor();
  const preblast = usePreblastMonitor();
  const rti = useRtiMonitor();
  const [linePlaitingGid, setLinePlaitingGid] = useLinePlaitingGid();
  const linePlaiting = useLinePlaitingMonitor(linePlaitingGid);
  const redzone = useRedzoneOptional();
  const wmsHolding = usePlatingHoldingMonitor();
  const skuInfoIndex = useMemo(
    () => (data ? buildSkuInfoIndex(data, currentHfWeek()) : undefined),
    [data],
  );

  // ── KW-Auswahl mit Auto-Fallback ──────────────────────────────────────────
  const currentWeekNum = useMemo(() => weekNumFromHfWeek(currentHfWeek()), []);

  // Alle verfügbaren KW-Nummern aus dem Produktionsplan ermitteln
  const availableWeekNums = useMemo(() => {
    const weeks = new Set<number>();
    for (const r of data?.productionPlan?.rows ?? []) {
      const n = weekPrefixFromWoNumber(r.workOrder);
      if (n != null) weeks.add(n);
    }
    return [...weeks].sort((a, b) => a - b);
  }, [data?.productionPlan]);

  // User-Override — null = Auto-Modus (bevorzugt aktuelle KW, fällt auf letzte zurück)
  const [userSelectedWeekNum, setUserSelectedWeekNum] = useState<number | null>(null);

  const resolvedWeekNum = useMemo(() => {
    if (userSelectedWeekNum != null && availableWeekNums.includes(userSelectedWeekNum)) {
      return userSelectedWeekNum;
    }
    // Auto: aktuelle KW bevorzugt
    if (currentWeekNum != null && availableWeekNums.includes(currentWeekNum)) {
      return currentWeekNum;
    }
    // Fallback: höchste verfügbare KW (= letzte Woche mit Daten)
    return availableWeekNums.length > 0 ? availableWeekNums[availableWeekNums.length - 1] : currentWeekNum;
  }, [userSelectedWeekNum, availableWeekNums, currentWeekNum]);

  const isStaleWeek = resolvedWeekNum !== currentWeekNum;

  const setSelectedWeekNum = useCallback((wn: number | null) => {
    setUserSelectedWeekNum(wn);
  }, []);

  // Plan für die gewählte KW filtern
  const weekPlan = useMemo(() => {
    const rows = (data?.productionPlan?.rows ?? []).filter(r => weekPrefixFromWoNumber(r.workOrder) === resolvedWeekNum);
    return { week: data?.productionPlan?.week ?? currentHfWeek(), generatedAt: data?.productionPlan?.generatedAt ?? "", rows };
  }, [data?.productionPlan, resolvedWeekNum]);

  const { meals, backfill: kitchenBackfill } = useMemo(
    () => matchPostblastToWorkOrders(postblast.data, preblast.data, weekPlan, rti.data),
    [postblast.data, preblast.data, weekPlan, rti.data],
  );

  const combined = useMemo(
    () => combineBackfillSignals(kitchenBackfill, linePlaiting.data, rti.data, redzone?.runs, wmsHolding.rows ?? undefined, skuInfoIndex),
    [kitchenBackfill, linePlaiting.data, rti.data, redzone?.runs, wmsHolding.rows, skuInfoIndex],
  );

  const alerts = useMemo(() => detectCrossSourceAlerts(combined), [combined]);
  const criticalCount = useMemo(() => alerts.filter(a => a.severity === "critical").length, [alerts]);
  const totalRecommendedPortions = useMemo(() => combined.reduce((s, c) => s + c.recommendedBackfillPortions, 0), [combined]);

  const value: BackfillsState = {
    meals,
    kitchenBackfill,
    combined,
    alerts,
    criticalCount,
    totalRecommendedPortions,
    postblastConnected: !!postblast.data,
    preblastConnected: !!preblast.data,
    rtiConnected: !!rti.data,
    linePlaitingConnected: !!linePlaiting.data,
    wmsHoldingConnected: !!wmsHolding.rows,
    linePlaitingGid,
    setLinePlaitingGid,
    linePlaitingLastUpdate: linePlaiting.lastUpdate,
    linePlaitingForceRefresh: linePlaiting.forceRefresh,
    selectedWeekNum: resolvedWeekNum,
    setSelectedWeekNum,
    availableWeekNums,
    isStaleWeek,
  };

  return <BackfillsContext.Provider value={value}>{children}</BackfillsContext.Provider>;
}
