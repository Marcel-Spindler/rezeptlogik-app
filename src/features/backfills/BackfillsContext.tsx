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
  type LinePlaitingSource,
} from "../gsheet-monitor/useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed, type MealProgress } from "../gsheet-monitor/postblastMatch";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { usePlatingHoldingMonitor } from "../wms-overview/usePlatingHoldingMonitor";
import { useFullInventoryMonitor } from "../wms-overview/useFullInventoryMonitor";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { buildSkuInfoIndex } from "../../lib/wmsSkuEnrichment";
import { combineBackfillSignals, detectCrossSourceAlerts } from "./combineBackfills";
import { computeBackfillFeasibility } from "./backfillFeasibility";
import type { BackfillAlert, BackfillFeasibility, CombinedBackfillNeed } from "./backfillTypes";

export interface BackfillsState {
  meals: MealProgress[];
  kitchenBackfill: BackfillNeed[];
  combined: CombinedBackfillNeed[];
  alerts: BackfillAlert[];
  criticalCount: number;
  // Alerts, die zum Handeln auffordern (critical + warning) — speist das app-weite
  // Banner/Badge. "Backfill nötig"-Meldungen (RTI-Rückstand, Küche durch) landen hier.
  actionableAlertCount: number;
  totalRecommendedPortions: number;
  // Rohware-Bestandsprüfung je Meal (recipeCode → Feasibility). Nur für Meals mit
  // recommendedBackfillPortions > 0 befüllt; leer, wenn der WMS-Vollbestand nicht
  // geladen ist (kein lokaler Server) — siehe backfillFeasibility.ts.
  feasibilityByMeal: Map<string, BackfillFeasibility>;
  fullInventoryConnected: boolean;
  fullInventoryLastUpdate: number | null;
  fullInventoryGeneratedAt: string | null;
  postblastConnected: boolean;
  preblastConnected: boolean;
  rtiConnected: boolean;
  linePlaitingConnected: boolean;
  wmsHoldingConnected: boolean;
  linePlaitingSource: LinePlaitingSource;
  linePlaitingActiveTab: string;      // "LinePlating W36" bzw. "gid=…" (Override)
  linePlaitingWeek: string;           // aus den Sheet-Daten geparste KW ("W36")
  linePlaitingStale: boolean;         // geladene KW ≠ erwartete KW → nicht verrechnet
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
  const linePlaitingSource = useLinePlaitingGid();
  const redzone = useRedzoneOptional();
  const wmsHolding = usePlatingHoldingMonitor();
  const fullInventory = useFullInventoryMonitor();
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

  // LinePlaiting-Tab automatisch aus der aufgelösten KW ("LinePlating W36") —
  // der manuelle gid-Override (linePlaitingSource) schlägt das, wenn gesetzt.
  const linePlaiting = useLinePlaitingMonitor(resolvedWeekNum ?? null, linePlaitingSource.gidOverride);

  // Frisch angelegte "LinePlating W{N}"-Tabs sind oft noch eine unbenannte Kopie
  // des Vorwochen-/Template-Tabs (KW im Kopf stimmt nicht). Solche Daten NICHT
  // als aktuelle Woche verrechnen. Bei manuellem Override vertrauen wir dem User.
  const expectedWeekLabel = resolvedWeekNum != null ? `W${String(resolvedWeekNum).padStart(2, "0")}` : "";
  const linePlaitingStale =
    !linePlaitingSource.gidOverride &&
    !!linePlaiting.data &&
    !!linePlaiting.data.week &&
    !!expectedWeekLabel &&
    linePlaiting.data.week !== expectedWeekLabel;
  const linePlaitingData = linePlaitingStale ? null : linePlaiting.data;

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
    () => combineBackfillSignals(kitchenBackfill, linePlaitingData, rti.data, redzone?.runs, wmsHolding.rows ?? undefined, skuInfoIndex),
    [kitchenBackfill, linePlaitingData, rti.data, redzone?.runs, wmsHolding.rows, skuInfoIndex],
  );

  const alerts = useMemo(() => detectCrossSourceAlerts(combined), [combined]);
  const criticalCount = useMemo(() => alerts.filter(a => a.severity === "critical").length, [alerts]);
  const actionableAlertCount = useMemo(
    () => alerts.filter(a => a.severity === "critical" || a.severity === "warning").length,
    [alerts],
  );
  const totalRecommendedPortions = useMemo(() => combined.reduce((s, c) => s + c.recommendedBackfillPortions, 0), [combined]);

  const feasibilityByMeal = useMemo<Map<string, BackfillFeasibility>>(
    () => (data ? computeBackfillFeasibility(combined, data, fullInventory.rows ?? undefined, skuInfoIndex) : new Map()),
    [combined, data, fullInventory.rows, skuInfoIndex],
  );

  const value: BackfillsState = {
    meals,
    kitchenBackfill,
    combined,
    alerts,
    criticalCount,
    actionableAlertCount,
    totalRecommendedPortions,
    feasibilityByMeal,
    fullInventoryConnected: !!fullInventory.rows && fullInventory.rows.length > 0,
    fullInventoryLastUpdate: fullInventory.lastUpdate,
    fullInventoryGeneratedAt: fullInventory.generatedAt,
    postblastConnected: !!postblast.data,
    preblastConnected: !!preblast.data,
    rtiConnected: !!rti.data,
    linePlaitingConnected: !!linePlaitingData,
    wmsHoldingConnected: !!wmsHolding.rows,
    linePlaitingSource,
    linePlaitingActiveTab: linePlaiting.activeTab,
    linePlaitingWeek: linePlaiting.data?.week ?? "",
    linePlaitingStale,
    linePlaitingLastUpdate: linePlaiting.lastUpdate,
    linePlaitingForceRefresh: linePlaiting.forceRefresh,
    selectedWeekNum: resolvedWeekNum,
    setSelectedWeekNum,
    availableWeekNums,
    isStaleWeek,
  };

  return <BackfillsContext.Provider value={value}>{children}</BackfillsContext.Provider>;
}
