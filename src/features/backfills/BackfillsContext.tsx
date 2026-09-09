// Backfills – globaler Provider. Führt Küche (Postblast/Pre-Blast-Gewichte),
// Plating (LinePlaiting) und RTI-Holding-Puffer laufend zu einer Liste
// zusammen und erkennt quellenübergreifende Frühwarnungen. Läuft IMMER (wie
// RedzoneProvider/WoReconciliationProvider), unabhängig davon, welcher Tab
// gerade offen ist — das ist die Grundlage für die app-weite Meldung.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { computeRtiBackfills, type RtiMealBackfill } from "./rtiBackfillCalculator";
import { sweepRtiInventory, type SubStockElsewhere } from "./rtiInventorySweep";
import { useSharedBackfillFlash } from "./sharedBackfillFlash";
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
  // Handlungs-Alerts, die in den letzten Minuten NEU aufgetaucht sind → hartes
  // Flackern + Alarmton im app-weiten Banner. Nach FRESH-Fenster wieder normal.
  freshAlertCount: number;
  // monoton steigend bei jedem neuen frischen Alert — Trigger für den Alarmton.
  freshAlertSeq: number;
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
  // RTI-Rechner pro Sub-Rezept (Backfill-Wächter-Grundlage) — enthält auch
  // Meals, deren Engpass schon zurückgewogen ist. combined/alerts bleiben die
  // app-weite Meldung, rtiMeals ist die volle Sub-Ebene für die Wächter-View.
  rtiMeals: RtiMealBackfill[];
  rtiLastUpdate: number | null;
  rtiForceRefresh: () => Promise<void>;
  // Pro offenem Engpass-Sub ("{mealCode}|{subName}"): steht die fertige
  // Komponente schon woanders im WMS (Chiller/Staging/Bulk, ohne Plating
  // Holding)? Leer ohne lokalen WMS-Server. Siehe rtiInventorySweep.ts.
  inventoryElsewhere: Map<string, SubStockElsewhere>;
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

// Ein Handlungs-Alert gilt so lange als "frisch" (→ Flackern + Ton).
const FRESH_MS = 15 * 60 * 1000;
// Alerts, die in den ersten Sekunden nach App-Start auftauchen, waren schon da —
// die lösen keinen Alarm aus. Erst danach neu Auftauchendes ist "frisch".
const STARTUP_GRACE_MS = 25 * 1000;

// Stabiler Schlüssel je Alert (die id wird bei jedem Render neu vergeben).
function alertKey(a: BackfillAlert): string {
  return `${a.recipeCode}|${a.title.split(":")[0].trim()}`;
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

  const rtiMeals = useMemo(() => computeRtiBackfills(rti.data), [rti.data]);
  const inventoryElsewhere = useMemo(
    () => sweepRtiInventory(rtiMeals, data, fullInventory.rows ?? undefined, skuInfoIndex),
    [rtiMeals, data, fullInventory.rows, skuInfoIndex],
  );
  const alerts = useMemo(() => detectCrossSourceAlerts(combined), [combined]);
  const criticalCount = useMemo(() => alerts.filter(a => a.severity === "critical").length, [alerts]);
  const actionableAlerts = useMemo(
    () => alerts.filter(a => a.severity === "critical" || a.severity === "warning"),
    [alerts],
  );
  const actionableAlertCount = actionableAlerts.length;
  const totalRecommendedPortions = useMemo(() => combined.reduce((s, c) => s + c.recommendedBackfillPortions, 0), [combined]);

  // ── Frisch-Erkennung → hartes Flackern + Alarmton im app-weiten Banner ─────
  // "frisch" = lokal zum ersten Mal gesehen (nachdem die App > STARTUP_GRACE_MS
  // läuft) ODER ein geteiltes Flacker-Signal aus Firestore (damit es bei ALLEN
  // gleichzeitig flackert — siehe sharedBackfillFlash.ts). Beim App-Start
  // vorhandene Alerts lösen nie den Alarm aus.
  const { active: sharedActive, at: sharedAt, keys: sharedKeys, broadcast: sharedBroadcast } = useSharedBackfillFlash();
  const mountedAtRef = useRef(Date.now());
  const seenAtRef = useRef<Record<string, number>>({});
  const freshSeqRef = useRef(0);
  const lastSharedAtRef = useRef(0);
  const [freshInfo, setFreshInfo] = useState<{ count: number; seq: number }>({ count: 0, seq: 0 });

  const recomputeFresh = useCallback(() => {
    const now = Date.now();
    const seen = seenAtRef.current;
    const liveKeys = new Set<string>();
    const newKeys: string[] = [];
    for (const a of actionableAlerts) {
      const key = alertKey(a);
      liveKeys.add(key);
      if (seen[key] == null) {
        seen[key] = now;
        if (now > mountedAtRef.current + STARTUP_GRACE_MS) newKeys.push(key);
      }
    }
    for (const k of Object.keys(seen)) if (!liveKeys.has(k)) delete seen[k];

    // Lokal neu erkannt → für alle anderen Apps broadcasten.
    if (newKeys.length > 0) sharedBroadcast(newKeys);

    const localFresh = actionableAlerts.filter(a => {
      const t = seen[alertKey(a)] ?? 0;
      return now - t < FRESH_MS && t > mountedAtRef.current + STARTUP_GRACE_MS;
    }).length;

    // Alarmton (freshSeq bumpen) bei eigener neuer Erkennung …
    if (newKeys.length > 0) freshSeqRef.current += 1;

    // … oder bei einem FREMDEN geteilten Signal für einen Backfill, den diese
    // App noch nicht selbst kennt (das eigene Echo hat nur bekannte Keys).
    if (sharedAt > lastSharedAtRef.current) {
      lastSharedAtRef.current = sharedAt;
      const foreignNew = sharedKeys.filter(k => seen[k] == null);
      if (sharedActive && foreignNew.length > 0) {
        freshSeqRef.current += 1;
        for (const k of foreignNew) seen[k] = sharedAt; // nicht nochmal lokal bumpen
      }
    }

    // Geteiltes Signal aktiv → alle aktuellen Handlungs-Alerts flackern.
    const count = sharedActive ? Math.max(localFresh, actionableAlerts.length) : localFresh;
    setFreshInfo(prev => (prev.count === count && prev.seq === freshSeqRef.current ? prev : { count, seq: freshSeqRef.current }));
  }, [actionableAlerts, sharedActive, sharedAt, sharedKeys, sharedBroadcast]);

  useEffect(() => { recomputeFresh(); }, [recomputeFresh]);
  // Frisch-Fenster läuft ohne neuen Alert einfach ab.
  useEffect(() => {
    if (freshInfo.count === 0) return;
    const t = window.setInterval(recomputeFresh, 30_000);
    return () => window.clearInterval(t);
  }, [freshInfo.count, recomputeFresh]);

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
    freshAlertCount: freshInfo.count,
    freshAlertSeq: freshInfo.seq,
    totalRecommendedPortions,
    feasibilityByMeal,
    fullInventoryConnected: !!fullInventory.rows && fullInventory.rows.length > 0,
    fullInventoryLastUpdate: fullInventory.lastUpdate,
    fullInventoryGeneratedAt: fullInventory.generatedAt,
    postblastConnected: !!postblast.data,
    preblastConnected: !!preblast.data,
    rtiConnected: !!rti.data,
    rtiMeals,
    rtiLastUpdate: rti.lastUpdate,
    rtiForceRefresh: rti.forceRefresh,
    inventoryElsewhere,
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
