import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "./core/types";
import { buildSkuInfoIndex, skuKey, weekPlannedSkuSet } from "./lib/wmsSkuEnrichment";

import { STATION_META, STATION_ORDER } from "./features/wms-overview/wmsTypes";
import type {
  AllData, BasePayload, InboundPayload, LoadState, SleevingPayload, StationKey,
  StoredPayload, WoDetailPayload, WorkordersPayload, WoTransactionRow,
} from "./features/wms-overview/wmsTypes";
import { fmtQty } from "./features/wms-overview/wmsFormat";
import { generateWmsWeeks, resolveSelectedWeekFromStationRows, weekNumFromHfWeek, woMatchesSelectedWeek } from "./features/wms-overview/wmsWeeks";
import { aggregateInbound, aggregateSleeving, aggregateStored, aggregateWorkorders, buildSkuBilanz, detectKettenbruch } from "./features/wms-overview/wmsAggregate";
import { loadSnapshots, loadTimeline, persistSnapshot, persistTimelineSnapshot, removeSnapshot } from "./features/wms-overview/wmsSnapshots";
import type { TimelineSnapshot, WmsSnapshot } from "./features/wms-overview/wmsSnapshots";
import { buildFunnel, buildLotStationMap, buildSkuStationMap } from "./features/wms-overview/wmsIndex";
import { woReadiness } from "./features/wms-overview/wmsWoLogic";
import { SectionCard } from "./features/wms-overview/WmsPrimitives";
import { SkuFunnelSection, TracePanel } from "./features/wms-overview/WmsFunnelAndTrace";
import { SkuDetailPanel } from "./features/wms-overview/WmsSkuDetailPanel";
import { DashboardKpi, PlanningCalendarCard, WeightGoalsCard } from "./features/wms-overview/WmsLeitwarteWidgets";
import { WoDetailPanel } from "./features/wms-overview/WmsWoDetailPanel";
import { MhdAlertBanner, YieldAlertBanner } from "./features/wms-overview/WmsAlertBanners";
import { ReadinessBadge } from "./features/wms-overview/WmsWoFlowWidgets";
import { WoListTable, WorkordersMealTable } from "./features/wms-overview/WmsWoTables";
import { InboundAggTable, SleevingAggTable, StoredAggTable } from "./features/wms-overview/WmsStationTables";
import { StationsBilanz, SnapshotPanel } from "./features/wms-overview/WmsBilanzPanels";
import { buildMealOperations, MealOperationsBoard } from "./features/wms-overview/WmsMealOperations";
import { WmsTimelinePanel } from "./features/wms-overview/WmsTimelineView";

export function WmsKwOverviewView({ data }: { data: DataBundle }): JSX.Element {
  const allWmsWeeks = useMemo(() => generateWmsWeeks(2026, 1), []);

  const [selectedWeek, setSelectedWeek] = useState<string>(() => allWmsWeeks[allWmsWeeks.length - 1] ?? "");
  const [allData,      setAllData]      = useState<AllData | null>(null);
  const [loadState,    setLoadState]    = useState<LoadState>("idle");
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [generatedAt,  setGeneratedAt]  = useState<string | null>(null);
  const [rangeStart,   setRangeStart]   = useState<string | null>(null);
  const [rangeEnd,     setRangeEnd]     = useState<string | null>(null);
  const [search,       setSearch]       = useState("");
  const [detailSku,    setDetailSku]    = useState<string | null>(null);
  const [detailWo,     setDetailWo]     = useState<string | null>(null);
  const [woViewMode,   setWoViewMode]   = useState<"list" | "meal">("list");
  type CmdTab = "command" | "timeline" | "bilanz" | "inbound" | "workorders" | "staging" | "debox" | "postblast" | "platingHolding" | "plating" | "sleeving";
  const [activeTab, setActiveTab] = useState<CmdTab>("command");
  const [liveMode,     setLiveMode]     = useState(false);
  const [liveCountdown, setLiveCountdown] = useState(30);
  const [snapshots,    setSnapshots]    = useState<WmsSnapshot[]>(() => loadSnapshots());
  const [compareSnapId, setCompareSnapId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineSnapshot[]>(() => loadTimeline());
  // WO-Scope: nur Artikel zeigen, die in den Workorders der gewählten KW
  // als Submeal/Meal vorkommen. Default ON — liefert eine saubere 100%-Basis.
  const [weekScopeFilter, setWeekScopeFilter] = useState(true);
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveTickRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedWeekRef = useRef(selectedWeek);
  const doLoadRef       = useRef<((week: string) => Promise<void>) | null>(null);

  const selectedWeekNum = useMemo(() => weekNumFromHfWeek(selectedWeek), [selectedWeek]);
  const skuInfoIndex = useMemo(() => buildSkuInfoIndex(data, selectedWeek), [data, selectedWeek]);

  const doLoad = async (week: string, retryCount = 0) => {
    setLoadState("loading");
    setLoadError(null);
    if (retryCount === 0) setAllData(null);
    try {
      const p   = new URLSearchParams({ whId: "VF", week, limit: "50000", ts: String(Date.now()) });
      const pwo = new URLSearchParams({ whId: "VF", week, limit: "50000", ts: String(Date.now()) });
      const [plR, stgR, debR, pbR, slR, inR, woR, wodR, plhR] = await Promise.all([
        fetch(`/api/wms-plating?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-staging?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-debox?${p}`,      { cache: "no-store" }),
        fetch(`/api/wms-postblast?${p}`,  { cache: "no-store" }),
        fetch(`/api/wms-sleeving?${p}`,   { cache: "no-store" }),
        fetch(`/api/wms-inbound?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-workorders?${pwo}`,{ cache: "no-store" }),
        fetch(`/api/wms-wo-detail?${p}`,  { cache: "no-store" }),
        fetch(`/api/wms-plating-holding?${p}`, { cache: "no-store" }),
      ]);
      const ct = plR.headers.get("content-type") ?? "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) {
        if (retryCount < 3) {
          setLoadError(`Warte auf WMS-Server… (Versuch ${retryCount + 1}/3)`);
          await new Promise(r => setTimeout(r, 2500));
          return doLoad(week, retryCount + 1);
        }
        throw new Error(`WMS-Server nicht erreichbar (HTTP ${plR.status}). Lokalen Server starten: npm run wms:server`);
      }
      const [pl, stg, deb, pb, sl, inb, wo, wod, plh] = await Promise.all([
        plR.json()  as Promise<StoredPayload>,
        stgR.json() as Promise<StoredPayload>,
        debR.json() as Promise<StoredPayload>,
        pbR.json()  as Promise<StoredPayload>,
        slR.json()  as Promise<SleevingPayload>,
        inR.json()  as Promise<InboundPayload>,
        woR.ok ? woR.json() as Promise<WorkordersPayload> : woR.json().catch(() => ({})).then(body => {
          console.warn(`WMS WO-Endpoint Fehler HTTP ${woR.status}:`, body);
          return { ok: false, rows: [], error: `WO-Daten nicht verfügbar (HTTP ${woR.status}) — lokaler Server läuft? Snowflake verbunden?` } as WorkordersPayload;
        }),
        wodR.ok ? wodR.json() as Promise<WoDetailPayload> : Promise.resolve({ ok: true, rows: [] } as WoDetailPayload),
        plhR.ok ? plhR.json() as Promise<StoredPayload> : Promise.resolve({ ok: true, rows: [] } as StoredPayload),
      ]);
      for (const [label, pay] of [["Plating", pl], ["Staging", stg], ["Debox", deb], ["Post-Blast", pb], ["Sleeving", sl], ["Inbound", inb]] as [string, BasePayload][]) {
        if (!pay.ok) throw new Error(`${label}: ${pay.error ?? "Unbekannter Fehler"}`);
      }
      setAllData({ plating: pl, platingHolding: plh, staging: stg, debox: deb, postblast: pb, sleeving: sl, inbound: inb, workorders: wo, woDetail: wod });
      setGeneratedAt(pl.generatedAt ?? sl.generatedAt ?? inb.generatedAt ?? null);
      setRangeStart(pl.rangeStart ?? inb.rangeStart ?? null);
      setRangeEnd(pl.rangeEnd ?? inb.rangeEnd ?? null);
      setLoadState("ready");
    } catch (e) {
      if (retryCount < 3 && e instanceof TypeError && e.message.includes("fetch")) {
        setLoadError(`Warte auf WMS-Server… (Versuch ${retryCount + 1}/3)`);
        await new Promise(r => setTimeout(r, 2500));
        return doLoad(week, retryCount + 1);
      }
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState("error");
    }
  };

  doLoadRef.current = doLoad;

  useEffect(() => { selectedWeekRef.current = selectedWeek; }, [selectedWeek]);

  useEffect(() => {
    if (selectedWeek) void doLoad(selectedWeek);
  }, [selectedWeek]);

  useEffect(() => {
    if (!liveMode) {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
      if (liveTickRef.current)     clearInterval(liveTickRef.current);
      liveIntervalRef.current = null;
      liveTickRef.current = null;
      setLiveCountdown(30);
      return;
    }
    setLiveCountdown(30);
    liveIntervalRef.current = setInterval(() => {
      if (doLoadRef.current) void doLoadRef.current(selectedWeekRef.current);
      setLiveCountdown(30);
    }, 30_000);
    liveTickRef.current = setInterval(() => {
      setLiveCountdown(c => Math.max(0, c - 1));
    }, 1_000);
    return () => {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
      if (liveTickRef.current)     clearInterval(liveTickRef.current);
    };
  }, [liveMode]);

  // WICHTIG: der Fallback hier bleibt IMMER aktiv (nicht an weekScopeFilter
  // gekoppelt) - er kompensiert nicht bloß einen nachlaufenden Feed, sondern
  // den systematischen Unterschied zwischen "kw" (WEEKOFYEAR() = echte
  // Snowflake-ISO-Woche) und selectedWeekNum (HF-Woche = ISO-Woche + 1). Ohne
  // Fallback wäre wmsWeekNum immer genau 1 zu hoch und JEDE Station würde
  // leer bleiben. Sichtbar gemacht über wmsWeekFallbackActive unten, statt
  // stillschweigend zu wirken.
  const wmsWeekNum = useMemo(
    () => resolveSelectedWeekFromStationRows(selectedWeekNum, [
      allData?.workorders.rows ?? [],
      allData?.sleeving.rows ?? [],
      allData?.inbound.rows ?? [],
      allData?.staging.rows ?? [],
      allData?.debox.rows ?? [],
      allData?.postblast.rows ?? [],
      allData?.plating.rows ?? [],
    ]),
    [allData, selectedWeekNum],
  );
  const wmsWeekFallbackActive = allData != null && wmsWeekNum != null && wmsWeekNum !== selectedWeekNum;

  // ── WO-basierter SKU-Filter ─────────────────────────────────────────────
  // Workorders zuerst filtern (nur nach KW/WO-Nummer), dann daraus das Set
  // aller relevanten SKUs extrahieren. Bestands-Stationen werden anschließend
  // über dieses Set gefiltert — nicht über DB_CHANGE_COMMIT_TIME.
  const rawWorkorders = useMemo(
    () => (allData?.workorders.rows ?? []).filter((row) => woMatchesSelectedWeek(row.week, selectedWeek, row.woNumber)),
    [allData, selectedWeek],
  );
  const woSkuSet = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawWorkorders) {
      const sub = skuKey(r.submealItemNumber);
      const meal = skuKey(r.mealItemNumber);
      if (sub) set.add(sub);
      if (meal) set.add(meal);
    }
    return set;
  }, [rawWorkorders]);

  // Kombination: WO-basiert (wenn Daten vorhanden) + Rezeptplan-Fallback
  const weekSkus = useMemo(() => {
    if (woSkuSet.size > 0) return woSkuSet;
    return weekPlannedSkuSet(skuInfoIndex);
  }, [woSkuSet, skuInfoIndex]);

  const inWeekScope = useCallback(
    (itemNumber: string) => !weekScopeFilter || weekSkus.size === 0 || weekSkus.has(skuKey(itemNumber)),
    [weekScopeFilter, weekSkus],
  );

  // ── Filtered raw rows per station ─────────────────────────────────────────
  // Stored Items: nur über WO-SKU-Zugehörigkeit filtern (kein kw-Filter).
  // Transaktions-Daten (Sleeving, Inbound): zusätzlich nach kw filtern.
  const inWmsWeek = useCallback(
    (kw: number | null) => {
      if (!weekScopeFilter) return true;
      if (wmsWeekNum == null) return true;
      if (kw == null) return true;
      return kw === wmsWeekNum;
    },
    [weekScopeFilter, wmsWeekNum],
  );
  const rawPlating        = useMemo(() => (allData?.plating.rows         ?? []).filter(r => inWeekScope(r.itemNumber)), [allData, inWeekScope]);
  const rawPlatingHolding = useMemo(() => (allData?.platingHolding.rows  ?? []).filter(r => inWeekScope(r.itemNumber)), [allData, inWeekScope]);
  const rawStaging   = useMemo(() => (allData?.staging.rows    ?? []).filter(r => inWeekScope(r.itemNumber)), [allData, inWeekScope]);
  const rawDebox     = useMemo(() => (allData?.debox.rows      ?? []).filter(r => inWeekScope(r.itemNumber)), [allData, inWeekScope]);
  const rawPostblast = useMemo(() => (allData?.postblast.rows  ?? []).filter(r => inWeekScope(r.itemNumber)), [allData, inWeekScope]);
  const rawSleeving  = useMemo(() => (allData?.sleeving.rows ?? []).filter(r => inWmsWeek(r.kw) && inWeekScope(r.itemNumber)), [allData, inWmsWeek, inWeekScope]);
  const rawInbound   = useMemo(() => (allData?.inbound.rows  ?? []).filter(r => inWmsWeek(r.kw) && inWeekScope(r.itemNumber)), [allData, inWmsWeek, inWeekScope]);

  // ── Aggregated rows ───────────────────────────────────────────────────────
  const aggWorkorders     = useMemo(() => aggregateWorkorders(rawWorkorders), [rawWorkorders]);
  const aggInbound        = useMemo(() => aggregateInbound(rawInbound),       [rawInbound]);
  const aggStaging        = useMemo(() => aggregateStored(rawStaging),        [rawStaging]);
  const aggDebox          = useMemo(() => aggregateStored(rawDebox),          [rawDebox]);
  const aggPostblast      = useMemo(() => aggregateStored(rawPostblast),      [rawPostblast]);
  const aggSleeving       = useMemo(() => aggregateSleeving(rawSleeving),     [rawSleeving]);
  const aggPlating        = useMemo(() => aggregateStored(rawPlating),        [rawPlating]);
  const aggPlatingHolding = useMemo(() => aggregateStored(rawPlatingHolding), [rawPlatingHolding]);

  // ── Cross-station indices ─────────────────────────────────────────────────
  const skuMap = useMemo(
    () => allData ? buildSkuStationMap(allData, selectedWeek, wmsWeekNum) : new Map<string, Set<StationKey>>(),
    [allData, selectedWeek, wmsWeekNum],
  );
  const lotMap = useMemo(
    () => allData ? buildLotStationMap(allData) : new Map<string, Set<StationKey>>(),
    [allData],
  );

  // ── Funnel ────────────────────────────────────────────────────────────────
  const funnel = useMemo(
    () => allData ? buildFunnel(allData, skuMap, selectedWeek, wmsWeekNum) : [],
    [allData, skuMap, selectedWeek, wmsWeekNum],
  );

  const filteredWoDetails = useMemo(() => {
    const woNumbers = new Set(rawWorkorders.map((row) => row.woNumber).filter(Boolean));
    return (allData?.woDetail.rows ?? []).filter((row) => woNumbers.has(row.woNumber));
  }, [allData, rawWorkorders]);

  // ── WO Transaction Index ──────────────────────────────────────────────────
  const woTransactionMap = useMemo(() => {
    const map = new Map<string, WoTransactionRow[]>();
    for (const r of filteredWoDetails) {
      if (!r.woNumber) continue;
      if (!map.has(r.woNumber)) map.set(r.woNumber, []);
      map.get(r.woNumber)!.push(r);
    }
    return map;
  }, [filteredWoDetails]);

  // WO → Items index (for badges in station tables)
  const itemToWoMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (itemNumber: string, woNumber: string) => {
      const itemKey = itemNumber.toUpperCase();
      if (!itemKey || !woNumber) return;
      if (!map.has(itemKey)) map.set(itemKey, new Set());
      map.get(itemKey)!.add(woNumber);
    };
    for (const r of rawWorkorders) {
      add(r.submealItemNumber, r.woNumber);
      add(r.mealItemNumber, r.woNumber);
    }
    for (const r of filteredWoDetails) {
      if (!r.itemNumber || !r.woNumber) continue;
      add(r.itemNumber, r.woNumber);
    }
    return map;
  }, [filteredWoDetails, rawWorkorders]);

  const bilanz = useMemo(
    () => allData ? buildSkuBilanz(rawWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating) : [],
    [allData, rawWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating],
  );
  const mealOperations = useMemo(
    () => buildMealOperations(aggWorkorders, aggPlating, aggPlatingHolding, aggPostblast, aggDebox, aggStaging, aggSleeving, skuInfoIndex),
    [aggWorkorders, aggPlating, aggPlatingHolding, aggPostblast, aggDebox, aggStaging, aggSleeving, skuInfoIndex],
  );

  const compareSnap = useMemo(
    () => snapshots.find(s => s.id === compareSnapId) ?? null,
    [snapshots, compareSnapId],
  );

  // ── Trace / Detail ───────────────────────────────────────────────────────
  const handleTrace  = (sku: string) => {
    if (/^\d{1,2}-\d+$/.test(sku.trim()) && woTransactionMap.has(sku.trim())) {
      setDetailWo(sku.trim());
    } else {
      setSearch(sku);
    }
  };
  const handleDetail = (sku: string) => setDetailSku(sku);
  const handleWoDetail = (wo: string) => setDetailWo(wo);
  const handleSaveSnapshot = () => { persistSnapshot(selectedWeek, bilanz); setSnapshots(loadSnapshots()); };
  const handleDeleteSnapshot = (id: string) => { removeSnapshot(id); setSnapshots(loadSnapshots()); };

  // Auto-Snapshot im Live-Mode: bei jedem Refresh Timeline-Snapshot speichern
  useEffect(() => {
    if (loadState === "ready" && mealOperations.length > 0) {
      const saved = persistTimelineSnapshot(selectedWeek, mealOperations);
      if (saved) setTimeline(loadTimeline());
    }
  }, [loadState, mealOperations, selectedWeek]);
  const needle   = search.trim().toUpperCase();
  const isTrace  = needle.length > 0;

  const allStored = useMemo(
    () => [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating],
    [aggStaging, aggDebox, aggPostblast, aggPlating],
  );

  // Filtered counts for headers
  const filtCounts = useMemo(() => ({
    workorders: isTrace ? aggWorkorders.filter(m => m.mealSku.includes(needle) || m.submeals.some(s => s.submealItemNumber.toUpperCase().includes(needle))).length : aggWorkorders.length,
    inbound:    isTrace ? aggInbound.filter(r => r.sku.includes(needle) || r.rawRows.some(raw => [raw.poNumber, raw.lotNumber].some(f => String(f ?? "").toUpperCase().includes(needle)))).length : aggInbound.length,
    staging:    isTrace ? aggStaging.filter(r => r.sku.includes(needle)   || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggStaging.length,
    debox:      isTrace ? aggDebox.filter(r => r.sku.includes(needle)     || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggDebox.length,
    postblast:  isTrace ? aggPostblast.filter(r => r.sku.includes(needle) || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggPostblast.length,
    sleeving:   isTrace ? aggSleeving.filter(r => r.sku.includes(needle)).length : aggSleeving.length,
    plating:    isTrace ? aggPlating.filter(r => r.sku.includes(needle)   || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggPlating.length,
  }), [isTrace, needle, aggWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating]);

  const totalCounts: Record<StationKey, number> = {
    workorders: aggWorkorders.length, inbound: aggInbound.length,
    staging: aggStaging.length, debox: aggDebox.length, postblast: aggPostblast.length,
    platingHolding: aggPlatingHolding.length, sleeving: aggSleeving.length, plating: aggPlating.length,
  };

  const TAB_DEFS: { key: CmdTab; label: string; icon: string; count?: number; color?: string }[] = [
    { key: "command", label: "Leitwarte", icon: "🎯" },
    { key: "timeline", label: "Timeline", icon: "🕐", count: timeline.length },
    { key: "bilanz", label: "Bilanz", icon: "📊" },
    { key: "inbound", label: "Inbound", icon: "📦", count: totalCounts.inbound, color: "emerald" },
    { key: "workorders", label: "WO", icon: "📋", count: totalCounts.workorders, color: "violet" },
    { key: "staging", label: "Staging", icon: "🗄️", count: totalCounts.staging, color: "amber" },
    { key: "debox", label: "Debox", icon: "📂", count: totalCounts.debox, color: "orange" },
    { key: "postblast", label: "Post-Blast", icon: "❄️", count: totalCounts.postblast, color: "rose" },
    { key: "platingHolding", label: "PLH", icon: "🧊", count: totalCounts.platingHolding, color: "indigo" },
    { key: "plating", label: "Linie", icon: "🍽️", count: totalCounts.plating, color: "blue" },
    { key: "sleeving", label: "Sleeving", icon: "🔄", count: totalCounts.sleeving, color: "sky" },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ══ COMMAND BAR (sticky dark header) ══════════════════════════════ */}
      <div className="sticky top-0 z-40 bg-slate-900 text-white shadow-xl px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <span className="font-bold text-sm tracking-wide">WMS KOMMANDOZENTRALE</span>
            <span className="text-[10px] text-slate-400 font-mono">VF</span>
          </div>

          <select
            className="rounded bg-slate-800 border border-slate-600 px-2 py-1 text-xs font-mono text-slate-200"
            value={selectedWeek}
            onChange={e => setSelectedWeek(e.target.value)}
          >
            {allWmsWeeks.map(w => <option key={w} value={w}>{w}</option>)}
          </select>

          <button
            type="button"
            title={weekScopeFilter
              ? "Nur Artikel zeigen, die laut Rezeptplan für diese KW gebraucht werden (alle 7 Abteilungen)"
              : "Ungefiltert: alle Artikel aus dem Server-Zeitfenster zeigen, unabhängig von der gewählten KW"}
            className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors ${weekScopeFilter ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
            onClick={() => setWeekScopeFilter(v => !v)}
          >
            {weekScopeFilter ? `🎯 Nur KW ${selectedWeekNum ?? ""}` : "◯ Alle Artikel"}
          </button>

          <button
            type="button"
            className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors ${liveMode ? "bg-emerald-500 text-white animate-pulse" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
            onClick={() => setLiveMode(m => !m)}
          >
            {liveMode ? `⏺ LIVE ${liveCountdown}s` : "◯ Live"}
          </button>

          <button
            type="button"
            className="rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-[11px] font-bold disabled:opacity-40"
            onClick={() => void doLoad(selectedWeek)}
            disabled={loadState === "loading" || !selectedWeek}
          >
            {loadState === "loading" ? "Lädt…" : "⟳ Laden"}
          </button>

          {loadState === "ready" && (
            <div className="relative ml-auto">
              <input
                type="search"
                placeholder="⌘K  SKU / Ort / Los / WO…"
                className="rounded bg-slate-800 border border-slate-600 px-3 py-1 text-xs text-slate-200 w-64 placeholder:text-slate-500"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs" onClick={() => setSearch("")}>✕</button>}
            </div>
          )}

          {loadState === "ready" && generatedAt && (
            <div className="text-[10px] text-slate-500 font-mono">
              {rangeStart && rangeEnd && <span className="mr-2">{rangeStart}→{rangeEnd}</span>}
              {new Date(generatedAt).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>

        {wmsWeekFallbackActive && (
          <div className="mt-2 rounded bg-amber-900/40 border border-amber-600/50 px-2.5 py-1.5 text-[11px] text-amber-200">
            ⚠ Inbound/Sleeving/Staging/Debox/Post-Blast/Plating zeigen KW {wmsWeekNum} statt KW {selectedWeekNum} — Snowflake hat für die gewählte KW noch keine Einträge in diesen Stationen, es wird die letzte verfügbare Woche als Näherung gezeigt.
          </div>
        )}
      </div>

      {/* ══ ALERT STRIP ════════════════════════════════════════════════════ */}
      {loadState === "ready" && (
        <div className="px-3 pt-2 space-y-1.5">
          <MhdAlertBanner allStored={allStored} />
          <YieldAlertBanner aggSleeving={aggSleeving} bilanz={bilanz} itemToWoMap={itemToWoMap} />
        </div>
      )}

      {/* ══ KPI BAR (always visible when data loaded) ═════════════════════ */}
      {loadState === "ready" && allData && (
        <div className="px-3 pt-2">
          <DashboardKpi
            aggInbound={aggInbound} aggStaging={aggStaging} aggDebox={aggDebox}
            aggPostblast={aggPostblast} aggPlating={aggPlating} aggSleeving={aggSleeving}
            skuMap={skuMap}
          />
        </div>
      )}

      {/* ══ TAB NAVIGATION ═════════════════════════════════════════════════ */}
      {loadState === "ready" && allData && (
        <div className="sticky top-[52px] z-30 bg-white border-b border-slate-200 px-3 pt-2 shadow-sm">
          <div className="flex gap-0.5 overflow-x-auto">
            {TAB_DEFS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1 px-3 py-2 text-[11px] font-semibold rounded-t-lg whitespace-nowrap transition-colors ${
                  activeTab === t.key
                    ? "bg-slate-100 text-slate-900 border border-b-0 border-slate-200"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>{t.icon}</span>
                <span>{t.label}</span>
                {t.count != null && t.count > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-slate-200 text-[9px] font-mono">{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ══ CONTENT AREA ═══════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

        {/* ── Idle ──── */}
        {loadState === "idle" && (
          <div className="card p-10 text-center text-slate-400">
            <div className="text-3xl mb-3">🎯</div>
            <div className="text-xl font-semibold mb-2">WMS Kommandozentrale</div>
            <div className="text-sm">KW auswählen und auf „Laden" klicken um alle Stationen zu laden.</div>
          </div>
        )}

        {/* ── Loading ──── */}
        {loadState === "loading" && (
          <div className="card p-10 flex items-center justify-center gap-3 text-slate-500">
            <svg className="animate-spin w-6 h-6 text-emerald-600" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span>Lade alle Stationen für <strong>{selectedWeek}</strong>…</span>
          </div>
        )}

        {loadState === "error" && (
          <div className="card border-rose-300 bg-rose-50 p-5 text-rose-800 text-sm space-y-4">
            <div className="font-bold text-base">{loadError}</div>
            <div className="bg-white border border-rose-200 rounded-lg p-4 space-y-3 text-slate-700">
              <div className="font-bold text-slate-900">Server starten — Anleitung:</div>
              <ol className="list-decimal list-inside space-y-2 text-xs">
                <li>
                  <strong>Terminal öffnen</strong> (CMD, PowerShell, oder beliebiges Terminal) und ins Projekt navigieren:
                  <code className="block mt-1 bg-slate-100 rounded px-2 py-1 font-mono text-[11px] text-slate-800">cd C:\Users\MarcelSpindler\Documents\GitHub\rezeptlogik-app</code>
                </li>
                <li>
                  <strong>WMS-Server starten</strong> (verbindet sich mit Snowflake via SSO):
                  <code className="block mt-1 bg-slate-100 rounded px-2 py-1 font-mono text-[11px] text-slate-800">npm run wms:server</code>
                  <span className="text-slate-500 text-[10px] block mt-0.5">→ Öffnet den Browser für Snowflake-Login. Nach Login: "Snowflake verbunden."</span>
                </li>
                <li>
                  <strong>Dev-Server starten</strong> (in einem zweiten Terminal):
                  <code className="block mt-1 bg-slate-100 rounded px-2 py-1 font-mono text-[11px] text-slate-800">npm run dev</code>
                  <span className="text-slate-500 text-[10px] block mt-0.5">→ Öffnet http://localhost:5173 — startet den WMS-Server auch automatisch wenn noch nicht laufend</span>
                </li>
                <li>
                  <strong>Alternativ: Alles in einem Befehl</strong> (startet beides parallel):
                  <code className="block mt-1 bg-slate-100 rounded px-2 py-1 font-mono text-[11px] text-slate-800">npm run wms:server &amp; npm run dev</code>
                </li>
              </ol>
              <div className="border-t border-slate-200 pt-2 text-[11px] text-slate-500 space-y-1">
                <div><strong>Port 3141</strong> = WMS Snowflake Server (muss laufen)</div>
                <div><strong>Port 5173</strong> = Vite Dev-Server (die App)</div>
                <div>Falls nur "Server nicht erreichbar" kommt: <code className="bg-slate-100 px-1 rounded">http://localhost:3141/connect</code> im Browser aufrufen → SSO-Login abschließen</div>
              </div>
            </div>
            <button type="button" onClick={() => void doLoad(selectedWeek)}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold">
              ⟳ Erneut versuchen
            </button>
          </div>
        )}
        {loadState === "loading" && loadError && (
          <div className="card border-amber-300 bg-amber-50 p-4 text-amber-800 text-sm animate-pulse">{loadError}</div>
        )}

        {/* ── Data Tabs ──── */}
        {loadState === "ready" && allData && (
          <>
            {/* Trace Panel (always visible when tracing) */}
            {isTrace && <TracePanel sku={search} funnel={funnel} skuInfoIndex={skuInfoIndex} onClear={() => setSearch("")} />}

            {/* ─── TAB: Timeline ─── */}
            {activeTab === "timeline" && (
              <WmsTimelinePanel timeline={timeline} currentMeals={mealOperations} data={data} onTrace={handleTrace} />
            )}

            {/* ─── TAB: Leitwarte (Command) ─── */}
            {activeTab === "command" && (
              <div className="space-y-3">
                <MealOperationsBoard rows={mealOperations} onTrace={handleTrace} onWoDetail={handleWoDetail} />

                {/* Gesamtfluss: Aggregierte Mengen pro Station */}
                <div className="card p-4">
                  <div className="text-xs font-bold uppercase text-slate-500 mb-3">Aktiver Mengenstrom (Gesamt)</div>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {(STATION_ORDER.map(sk => ({ sk, qty: sk === "workorders" ? rawWorkorders.reduce((s, r) => s + (r.quantity ?? 0), 0)
                      : sk === "inbound" ? aggInbound.reduce((s, r) => s + r.totalReceived, 0)
                      : sk === "sleeving" ? aggSleeving.reduce((s, r) => s + r.net, 0)
                      : [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating].filter(r => {
                        if (sk === "staging") return aggStaging.includes(r);
                        if (sk === "debox") return aggDebox.includes(r);
                        if (sk === "postblast") return aggPostblast.includes(r);
                        return aggPlating.includes(r);
                      }).reduce((s, r) => s + r.totalQty, 0)
                    }))).map((item, i) => {
                      const m = STATION_META[item.sk];
                      return (
                        <React.Fragment key={item.sk}>
                          {i > 0 && <span className="text-slate-300 text-sm">→</span>}
                          <button type="button" onClick={() => setActiveTab(item.sk as CmdTab)} className={`flex flex-col items-center px-3 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[70px] hover:shadow-md transition-shadow cursor-pointer`}>
                            <span>{m.icon}</span>
                            <span className={`text-[9px] font-semibold ${m.textColor}`}>{m.label.split(" ")[0]}</span>
                            <span className="font-mono font-bold text-sm text-slate-800">{fmtQty(item.qty)}</span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>

                {/* Engpässe & Yield Alerts */}
                {bilanz.length > 0 && (() => {
                  const issues = bilanz.map(e => ({ e, kb: detectKettenbruch(e) })).filter(x => x.kb != null).sort((a, b) => {
                    const sev = { yield_loss: 0, stuck: 1, drop: 2 };
                    return (sev[a.kb!.severity] ?? 9) - (sev[b.kb!.severity] ?? 9);
                  }).slice(0, 8);
                  if (issues.length === 0) return (
                    <div className="card p-4 border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold text-center">
                      ✓ Keine Engpässe erkannt — alle Stationen laufen
                    </div>
                  );
                  return (
                    <div className="card p-4">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">⚡ Engpässe & Risiken ({issues.length})</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {issues.map(({ e, kb }) => (
                          <div key={e.sku} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer hover:shadow-sm ${kb!.severity === "yield_loss" ? "border-rose-300 bg-rose-50" : kb!.severity === "stuck" ? "border-amber-300 bg-amber-50" : "border-orange-200 bg-orange-50"}`}
                            onClick={() => handleTrace(e.sku)}>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${kb!.severity === "yield_loss" ? "bg-rose-200 text-rose-800" : kb!.severity === "stuck" ? "bg-amber-200 text-amber-800" : "bg-orange-200 text-orange-800"}`}>
                              {kb!.severity === "yield_loss" ? "YIELD" : kb!.severity === "stuck" ? "STUCK" : "DROP"}
                            </span>
                            <span className="font-mono text-xs text-slate-800 font-semibold">{e.sku}</span>
                            <span className="text-[10px] text-slate-600 truncate flex-1">{kb!.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Weight Tracking: Ziel vs. Ist */}
                <WeightGoalsCard goals={data.weightGoals} />

                {/* WO Readiness Overview */}
                {aggWorkorders.length > 0 && (
                  <div className="card p-4">
                    <div className="text-xs font-bold uppercase text-slate-500 mb-2">📋 WO-Readiness ({aggWorkorders.length} Meals)</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {aggWorkorders.slice(0, 8).map(meal => {
                        const readiness = woReadiness(meal.submeals, skuMap);
                        return (
                          <div key={meal.mealSku} className="rounded-lg border border-slate-200 px-3 py-2 cursor-pointer hover:bg-slate-50" onClick={() => handleTrace(meal.mealSku)}>
                            <div className="font-mono text-[10px] text-slate-600 truncate">{meal.mealSku}</div>
                            <div className="flex items-center justify-between mt-1">
                              <ReadinessBadge {...readiness} />
                              <span className="text-[10px] font-mono text-slate-500">{fmtQty(meal.totalQty)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* SKU Funnel (cross-station) */}
                {!isTrace && funnel.length > 0 && (
                  <SkuFunnelSection funnel={funnel} skuMap={skuMap} skuInfoIndex={skuInfoIndex} onTrace={handleTrace} />
                )}

                {/* Planning Calendar: Deadlines & Eskalationskontakte */}
                <PlanningCalendarCard calendar={data.planningCalendar} />

                {/* Snapshots */}
                <SnapshotPanel
                  snapshots={snapshots}
                  currentWeek={selectedWeek}
                  onCompare={setCompareSnapId}
                  compareId={compareSnapId}
                  onDelete={handleDeleteSnapshot}
                  onSave={handleSaveSnapshot}
                />
              </div>
            )}

            {/* ─── TAB: Bilanz ─── */}
            {activeTab === "bilanz" && bilanz.length > 0 && (
              <StationsBilanz
                bilanz={bilanz}
                compareSnap={compareSnap}
                week={selectedWeek}
                onTrace={handleTrace}
                onWoDetail={handleWoDetail}
                skuInfoIndex={skuInfoIndex}
              />
            )}

            {/* ─── TAB: Inbound ─── */}
            {activeTab === "inbound" && (
              <SectionCard stationKey="inbound" totalCount={totalCounts.inbound} filteredCount={isTrace ? filtCounts.inbound : undefined}>
                <InboundAggTable rows={aggInbound} skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Work Orders ─── */}
            {activeTab === "workorders" && (
              <SectionCard stationKey="workorders" totalCount={totalCounts.workorders} filteredCount={isTrace ? filtCounts.workorders : undefined}>
                {allData?.workorders.ok === false && (
                  <div className="mx-3 mt-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
                    {allData.workorders.error ?? "WO-Daten konnten nicht geladen werden."}
                  </div>
                )}
                <div className="flex items-center gap-1 px-3 pt-2 pb-1">
                  <button type="button" onClick={() => setWoViewMode("list")}
                    className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer ${woViewMode === "list" ? "bg-violet-100 text-violet-700 border border-violet-300" : "text-slate-500 hover:bg-slate-100"}`}>
                    WO-Liste
                  </button>
                  <button type="button" onClick={() => setWoViewMode("meal")}
                    className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer ${woViewMode === "meal" ? "bg-violet-100 text-violet-700 border border-violet-300" : "text-slate-500 hover:bg-slate-100"}`}>
                    Nach Meal
                  </button>
                </div>
                {woViewMode === "list" ? (
                  <WoListTable workorders={rawWorkorders} woTransactionMap={woTransactionMap} search={search} onWoDetail={handleWoDetail} onTrace={handleTrace} />
                ) : (
                  <WorkordersMealTable meals={aggWorkorders} skuMap={skuMap} search={search} weekNum={selectedWeekNum} onTrace={handleTrace} onDetail={handleDetail} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
                )}
              </SectionCard>
            )}

            {/* ─── TAB: Staging ─── */}
            {activeTab === "staging" && (
              <SectionCard stationKey="staging" totalCount={totalCounts.staging} filteredCount={isTrace ? filtCounts.staging : undefined}>
                <StoredAggTable rows={aggStaging} stationKey="staging" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Debox ─── */}
            {activeTab === "debox" && (
              <SectionCard stationKey="debox" totalCount={totalCounts.debox} filteredCount={isTrace ? filtCounts.debox : undefined}>
                <StoredAggTable rows={aggDebox} stationKey="debox" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Post-Blast ─── */}
            {activeTab === "postblast" && (
              <SectionCard stationKey="postblast" totalCount={totalCounts.postblast} filteredCount={isTrace ? filtCounts.postblast : undefined}>
                <StoredAggTable rows={aggPostblast} stationKey="postblast" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Plating ─── */}
            {activeTab === "platingHolding" && (
              <SectionCard stationKey="platingHolding" totalCount={totalCounts.platingHolding}>
                <StoredAggTable rows={aggPlatingHolding} stationKey="platingHolding" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {activeTab === "plating" && (
              <SectionCard stationKey="plating" totalCount={totalCounts.plating} filteredCount={isTrace ? filtCounts.plating : undefined}>
                <StoredAggTable rows={aggPlating} stationKey="plating" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Sleeving ─── */}
            {activeTab === "sleeving" && (
              <SectionCard stationKey="sleeving" totalCount={totalCounts.sleeving} filteredCount={isTrace ? filtCounts.sleeving : undefined}>
                <SleevingAggTable rows={aggSleeving} skuMap={skuMap} search={search} onTrace={handleTrace} onDetail={handleDetail} skuInfoIndex={skuInfoIndex} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} />
              </SectionCard>
            )}
          </>
        )}
      </div>

      {/* ══ OVERLAY PANELS ════════════════════════════════════════════════ */}
      {detailSku && allData && (
        <SkuDetailPanel
          sku={detailSku}
          allData={allData}
          funnel={funnel}
          selectedWeek={selectedWeek}
          weekNum={wmsWeekNum}
          onClose={() => setDetailSku(null)}
          onTrace={handleTrace}
          skuInfoIndex={skuInfoIndex}
        />
      )}

      {detailWo && allData && (
        <WoDetailPanel
          woNumber={detailWo}
          transactions={woTransactionMap.get(detailWo) ?? []}
          workorders={rawWorkorders}
          detailMeta={allData.woDetail}
          aggSleeving={aggSleeving}
          onClose={() => setDetailWo(null)}
          onTrace={(sku) => { setDetailWo(null); handleTrace(sku); }}
        />
      )}
    </div>
  );
}
