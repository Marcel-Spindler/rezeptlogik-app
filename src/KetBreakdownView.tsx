// KetBreakdownView.tsx – KET Plan → WO Breakdown → PDF
// Upload KET CSV directly; falls back to data.productionPlan.
// Equipment capacities are user-editable, saved to localStorage.

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { DataBundle, WorkOrderEntry } from "./core/types";
import { fetchWmsWorkorderCache, wmsWorkorderRowToEntry, filterRowsToWeekWindow, currentHfWeek } from "./lib/wmsCache";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "./features/wms-overview/wmsWeeks";
import { EQUIP_DEFAULTS, EQUIP_LABELS, LS_CAPS_KEY, type BatchCalc, type KetRow, type WoSortMode } from "./features/ket-plan/ketTypes";
import {
  calcBatch, fmtDateHeader, fmtKg, parseKetCsv, parseSortKey, statusColors, woEntriesToKetRows,
} from "./features/ket-plan/ketLogic";
import { buildPdf } from "./features/ket-plan/ketPdf";
import { EmptyState, KetWoOverview, MissingDataScreen } from "./features/ket-plan/KetSharedUi";
import { WoDetail } from "./features/ket-plan/KetWoDetail";


export function KetBreakdownView({ data }: { data: DataBundle }) {
  const liveWeek = currentHfWeek();
  const [csvRows, setCsvRows] = useState<KetRow[] | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showEquip, setShowEquip] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  // Right-hand main area: 'detail' = today's existing single-WO breakdown
  // (EmptyState/WoDetail), 'list' = full-width overview of ALL WOs. Kept
  // independent of selectedKey so switching back to the overview after
  // viewing a detail doesn't require deselecting anything.
  const [mainViewMode, setMainViewMode] = useState<"detail" | "list">("detail");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [woSortMode, setWoSortMode] = useState<WoSortMode>("date");
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  const [wmsDroppedWeeks, setWmsDroppedWeeks] = useState<string[]>([]);

  // productionPlan/liveWmsRows können viele Wochen gemischt enthalten (z.B. 219
  // KW33- neben 115 KW34-Zeilen) - ohne Filter gehen die aktuellen WOs in der
  // nach Datum sortierten Liste unter ("keine KW34-WOs" wirkt so, obwohl sie
  // da sind, nur hinter hunderten älteren Zeilen). Default an, abschaltbar für
  // den Fall dass man wirklich alle Wochen auf einmal sehen will.
  const [weekFilterEnabled, setWeekFilterEnabled] = useState(true);

  const [caps, setCaps] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(LS_CAPS_KEY);
      return saved ? { ...EQUIP_DEFAULTS, ...JSON.parse(saved) } : { ...EQUIP_DEFAULTS };
    } catch {
      return { ...EQUIP_DEFAULTS };
    }
  });
  const [capInputs, setCapInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries({ ...EQUIP_DEFAULTS }).map(([k, v]) => [k, String(v)]),
    ),
  );

  // "Hat Zeilen" reicht nicht - der GSheet→Firestore-Plan kann 300+ Zeilen für
  // längst vergangene Wochen halten, während die aktuelle Woche darin komplett
  // fehlt (das GSheet "Fertigstellungszeitplan" wurde für sie noch nicht
  // befüllt). Ohne diesen Check würde der Live-Snowflake-Fallback unten nie
  // greifen, obwohl productionPlan für die aktuelle Woche leer ist.
  const productionPlanHasLiveWeek = useMemo(() => {
    const rows = data.productionPlan?.rows;
    if (!rows?.length) return false;
    const liveWeekNum = weekNumFromHfWeek(liveWeek);
    if (liveWeekNum == null) return true; // can't tell - don't second-guess the trusted source
    return rows.some((row) => weekPrefixFromWoNumber(row.workOrder) === liveWeekNum);
  }, [data.productionPlan?.rows, liveWeek]);

  const ketRows = useMemo<KetRow[]>(() => {
    if (csvRows !== null) return csvRows;
    const rows = data.productionPlan?.rows;
    if (rows?.length && productionPlanHasLiveWeek) return woEntriesToKetRows(rows);
    if (liveWmsRows?.length) return woEntriesToKetRows(liveWmsRows);
    if (rows?.length) return woEntriesToKetRows(rows); // stale but still better than nothing
    return [];
  }, [csvRows, data.productionPlan?.rows, productionPlanHasLiveWeek, liveWmsRows]);

  // Lowest-priority fallback: only reach for the live WMS/Snowflake cache when
  // neither manual CSV nor the established GSheet→Firestore plan has rows for
  // the CURRENT week, so this unverified source can never silently override a
  // trusted one that's actually still current.
  useEffect(() => {
    if (csvRows !== null) return;
    if (productionPlanHasLiveWeek) return;
    let cancelled = false;
    fetchWmsWorkorderCache().then((res) => {
      if (cancelled || !res || !res.rows.length) return;
      // Bound to the currently selected week (+ next week, for kitchen data
      // that shows up a few days early) — the cache itself spans a wider
      // window, but showing all of it at once makes the list unreadable.
      const { kept, droppedWeeks } = filterRowsToWeekWindow(res.rows, liveWeek);
      // Map defensively: one malformed cache row (missing field / unparseable
      // timestamp) must be skipped, not throw and drop the whole fallback batch.
      const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
        try {
          acc.push(wmsWorkorderRowToEntry(row));
        } catch {
          /* skip malformed row */
        }
        return acc;
      }, []);
      if (cancelled) return;
      setWmsDroppedWeeks(droppedWeeks);
      if (mapped.length) setLiveWmsRows(mapped);
    });
    return () => { cancelled = true; };
  }, [csvRows, productionPlanHasLiveWeek, liveWeek]);

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (ketRows.length === 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      fileInputRef.current?.click();
    }
  }, [ketRows.length]);

  const calcMap = useMemo(() => {
    const m = new Map<string, BatchCalc>();
    for (const row of ketRows) m.set(row.key, calcBatch(row, caps, data));
    return m;
  }, [ketRows, caps, data]);

  const liveWeekNum = useMemo(() => weekNumFromHfWeek(liveWeek), [liveWeek]);
  const weekFilteredRows = useMemo(() => {
    if (!weekFilterEnabled || liveWeekNum == null) return ketRows;
    return ketRows.filter((row) => weekPrefixFromWoNumber(row.woNumber) === liveWeekNum);
  }, [ketRows, weekFilterEnabled, liveWeekNum]);

  const groups = useMemo(() => {
    const m = new Map<string, KetRow[]>();
    for (const row of weekFilteredRows) {
      if (!m.has(row.dateNeeded)) m.set(row.dateNeeded, []);
      m.get(row.dateNeeded)!.push(row);
    }
    return [...m.entries()].sort((a, b) => parseSortKey(a[0]) - parseSortKey(b[0]));
  }, [weekFilteredRows]);

  const needle = woSearch.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    const base = !needle
      ? groups
      : groups
          .map(([k, rows]) => [k, rows.filter((r) =>
            [r.woNumber, r.recipeCode, r.recipeName, r.subRecipeName].join(" ").toLowerCase().includes(needle)
          )] as [string, KetRow[]])
          .filter(([, rows]) => rows.length > 0);

    if (woSortMode === "date") return base;

    return base.map(([date, rows]) => {
      const sorted = [...rows].sort((a, b) => {
        switch (woSortMode) {
          case "wo":      return a.woNumber.localeCompare(b.woNumber, "de", { numeric: true });
          case "recipe":  return (a.subRecipeName || a.recipeName).localeCompare(b.subRecipeName || b.recipeName);
          case "status":  return a.kitchenStatus.localeCompare(b.kitchenStatus);
          case "batches": return (calcMap.get(b.key)?.batches ?? 0) - (calcMap.get(a.key)?.batches ?? 0);
          case "kg":      return (calcMap.get(b.key)?.totalKg ?? 0) - (calcMap.get(a.key)?.totalKg ?? 0);
          default:        return 0;
        }
      });
      return [date, sorted] as [string, KetRow[]];
    });
  }, [groups, needle, woSortMode, calcMap]);

  const filteredRows = filteredGroups.flatMap(([, rows]) => rows);

  const selectedRow = ketRows.find((r) => r.key === selectedKey) ?? null;
  const selectedCalc = selectedKey ? (calcMap.get(selectedKey) ?? null) : null;

  const handleFile = useCallback((file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseKetCsv(text);
      setCsvRows(parsed);
      setSelectedKey(parsed[0]?.key ?? null);
    };
    reader.readAsText(file, "utf-8");
  }, []);

  function saveCap(equip: string, raw: string) {
    const val = parseFloat(raw.replace(",", ".")) || 0;
    const next = { ...caps, [equip]: val };
    setCaps(next);
    try { localStorage.setItem(LS_CAPS_KEY, JSON.stringify(next)); } catch { /* */ }
  }

  const source: "CSV" | "Firestore" | "LiveWMS" | "FirestoreStale" | null =
    csvRows !== null
      ? "CSV"
      : data.productionPlan?.rows?.length && productionPlanHasLiveWeek
        ? "Firestore"
        : liveWmsRows && liveWmsRows.length
          ? "LiveWMS"
          : data.productionPlan?.rows?.length
            ? "FirestoreStale"
            : null;

  function printPdf(rows: KetRow[]) {
    const title = `KET Breakdown – ${new Date().toLocaleDateString("de-DE")}`;
    const html = buildPdf(rows, calcMap, caps, title, source);
    const w = window.open("", "_blank", "width=960,height=750");
    if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 450);
  }

  const totalBatches = weekFilteredRows.reduce((s, row) => s + (calcMap.get(row.key)?.batches ?? 0), 0);

  if (ketRows.length === 0) {
    return (
      <MissingDataScreen
        title="KET-Plan Daten fehlen"
        neededFile="KitchenOS KET-CSV"
        hint="Erwartet: Work Order Number, Recipe Name, Date Needed, Target Portions, Kitchen Status, Staging Status …"
        fileInputRef={fileInputRef}
        onFile={handleFile}
      />
    );
  }

  return (
    <div className="flex h-[calc(100vh-112px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════════════════════════════════════════════════
          LEFT SIDEBAR
      ════════════════════════════════════════════════════ */}
      <aside className="w-[280px] shrink-0 flex flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[0.15em] mb-1">
            KET Plan · WO Ausdruck
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white tabular-nums">{weekFilteredRows.length}</span>
            <span className="text-xs text-blue-300">WOs</span>
            {totalBatches > 0 && (
              <>
                <span className="text-blue-600">·</span>
                <span className="text-lg font-black text-blue-200 tabular-nums">{totalBatches}</span>
                <span className="text-xs text-blue-300">Batche</span>
              </>
            )}
          </div>
          {liveWeekNum != null && (
            <button
              type="button"
              title={weekFilterEnabled
                ? `Nur Work Orders mit "${liveWeekNum}-…"-Präfix zeigen (KW ${liveWeek})`
                : "Ungefiltert: Work Orders aller Wochen zeigen"}
              className={`mt-2 w-full rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors ${weekFilterEnabled ? "bg-blue-600 text-white" : "bg-white/10 text-blue-200 hover:bg-white/20"}`}
              onClick={() => setWeekFilterEnabled((v) => !v)}
            >
              {weekFilterEnabled
                ? `🎯 Nur KW ${liveWeekNum} (${ketRows.length - weekFilteredRows.length} ausgeblendet)`
                : `◯ Alle Wochen (${ketRows.length})`}
            </button>
          )}
          {source && (
            <div
              className={`text-[9px] mt-1 font-mono truncate ${source === "LiveWMS" ? "text-amber-300 font-bold" : source === "FirestoreStale" ? "text-red-400 font-bold" : "text-blue-400"}`}
            >
              {source === "CSV"
                ? `✓ ${csvFileName}`
                : source === "Firestore"
                  ? "Quelle: Firestore"
                  : source === "FirestoreStale"
                    ? `⚠ Quelle: Firestore (veraltet – ohne ${liveWeek})`
                    : "Quelle: Live WMS (Snowflake) – Feldzuordnung ungeprüft"}
            </div>
          )}
          {source === "LiveWMS" && wmsDroppedWeeks.length > 0 && (
            <div className="text-[9px] mt-0.5 text-blue-400/70 truncate" title={`Ausgeblendete KWs: ${wmsDroppedWeeks.join(", ")}`}>
              Gefiltert auf {liveWeek}{"/"}Folge-KW · {wmsDroppedWeeks.length} andere KW{wmsDroppedWeeks.length > 1 ? "s" : ""} ausgeblendet
            </div>
          )}
        </div>

        {/* CSV Upload */}
        <div className="px-3 py-2.5 border-b border-slate-100">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            title="KET CSV Datei hochladen"
            aria-label="KET CSV Datei hochladen"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-3 py-2.5 text-center transition-all select-none ${
              dragOver
                ? "border-blue-400 bg-blue-50 scale-[1.01]"
                : csvRows
                  ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                  : "border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50"
            }`}
          >
            <div className="text-xs font-bold text-slate-700">
              {csvRows ? `✓ ${csvFileName}` : "KET CSV hochladen"}
            </div>
            <div className="text-[9px] text-slate-400 mt-0.5">
              {csvRows
                ? <span className="text-emerald-600">{csvRows.length} Work Orders geladen</span>
                : "Klicken oder Datei ablegen · .csv"}
            </div>
          </div>
          {csvRows && (
            <button
              type="button"
              onClick={() => { setCsvRows(null); setCsvFileName(""); setSelectedKey(null); }}
              className="mt-1 w-full text-[9px] text-slate-400 hover:text-red-500 transition-colors"
            >
              × CSV entfernen (zurück zu Firestore)
            </button>
          )}
        </div>

        {/* Equipment capacities (collapsible) */}
        <div className="border-b border-slate-100">
          <button
            type="button"
            onClick={() => setShowEquip(!showEquip)}
            className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              Equipment-Kapazitäten
            </span>
            <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showEquip ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
          {showEquip && (
            <div className="px-3 pb-3 space-y-1">
              <p className="text-[9px] text-slate-400 mb-2">Effektive Kapazität pro Batch. Bestimmt Anzahl Batche.</p>
              {Object.entries(EQUIP_DEFAULTS).map(([equip]) => (
                <div key={equip} className="flex items-center gap-2">
                  <span className="flex-1 text-[10px] font-semibold text-slate-600 truncate">{EQUIP_LABELS[equip] ?? equip}</span>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={capInputs[equip] ?? String(caps[equip] ?? "")}
                    onChange={(e) => setCapInputs((p) => ({ ...p, [equip]: e.target.value }))}
                    onBlur={(e) => saveCap(equip, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveCap(equip, (e.target as HTMLInputElement).value)}
                    aria-label={`${equip} capacity kg`}
                    className="w-14 text-right text-xs font-bold border border-slate-200 rounded-lg px-1.5 py-1 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  />
                  <span className="text-[9px] text-slate-400 w-4">kg</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>
            <input
              type="search"
              placeholder="WO, Rezept, Sub-Rezept …"
              value={woSearch}
              onChange={(e) => setWoSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 focus:bg-white"
            />
          </div>
        </div>

        {/* WO Sort */}
        <div className="px-3 py-1.5 border-b border-slate-100 flex flex-wrap gap-1">
          {([ ["date","Datum"], ["wo","WO Nr"], ["recipe","Rezept"], ["status","Status"], ["batches","Batche↓"], ["kg","KG↓"] ] as [WoSortMode, string][]).map(([mode, label]) => (
            <button key={mode} type="button" onClick={() => setWoSortMode(mode)}
              className={`text-[9px] font-bold px-2 py-0.5 rounded-md border transition-colors ${
                woSortMode === mode
                  ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                  : "bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700"
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* WO List */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">Keine WOs gefunden</div>
          ) : (
            filteredGroups.map(([date, rows]) => (
              <div key={date} className="mb-1">
                <div className="sticky top-0 px-3 py-1.5 bg-slate-50/90 backdrop-blur-sm border-y border-slate-100 z-10">
                  <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                    {fmtDateHeader(date)}
                  </span>
                  <span className="ml-2 text-[9px] text-slate-300">{rows.length} WOs</span>
                </div>
                <div className="px-2 py-1 space-y-1">
                  {rows.map((row) => {
                    const calc = calcMap.get(row.key);
                    const isSelected = selectedKey === row.key;
                    const sc = statusColors(row.kitchenStatus);
                    const done = row.woCookedPortions ?? 0;
                    const pct = row.targetPortions > 0 ? (done / row.targetPortions) * 100 : 0;
                    return (
                      <button
                        type="button"
                        key={row.key}
                        onClick={() => setSelectedKey(row.key)}
                        className={`w-full text-left rounded-xl px-3 py-2.5 transition-all ${
                          isSelected
                            ? "bg-[#1e3a5f] shadow-md ring-2 ring-[#1e3a5f]/30"
                            : "bg-white hover:bg-slate-50 border border-slate-150 shadow-sm hover:shadow"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1 mb-1">
                          <span className={`text-[11px] font-black leading-tight ${isSelected ? "text-white" : "text-[#1e3a5f]"}`}>
                            WO {row.woNumber}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {calc && calc.batches > 0 && (
                              <span
                                className={`text-[9px] font-black px-1.5 py-0.5 rounded-md ${isSelected ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700"}`}
                                title={calc.primaryCapBibleMatch
                                  ? `Batche berechnet mit Kuechenbible-Kapazität "${calc.primaryCapBibleMatch.itemName}" (provisorisch)`
                                  : undefined}
                              >
                                {calc.primaryCapBibleMatch && <span aria-hidden="true">📖 </span>}
                                {calc.batches}×
                              </span>
                            )}
                            {calc && calc.totalKg > 0 && (
                              <span className={`text-[9px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                                {fmtKg(calc.totalKg)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className={`text-[10px] truncate leading-tight ${isSelected ? "text-blue-200" : "text-slate-600"}`}>
                          {row.subRecipeName || row.recipeName}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-md ${isSelected ? `${sc.bg} ${sc.text}` : `${sc.bg} ${sc.text}`}`}>
                            {row.kitchenStatus || "—"}
                          </span>
                          {pct > 0 && (
                            <div className={`flex-1 h-1 rounded-full overflow-hidden ${isSelected ? "bg-white/20" : "bg-slate-100"}`}>
                              <div
                                className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                                style={{ width: `${Math.min(100, pct)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Print buttons */}
        <div className="px-3 py-2.5 border-t border-slate-100 space-y-1.5 bg-slate-50/50">
          <button
            type="button"
            onClick={() => selectedRow && printPdf([selectedRow])}
            disabled={!selectedRow}
            className="w-full flex items-center justify-center gap-2 text-xs font-bold bg-[#1e3a5f] hover:bg-[#162d4a] disabled:opacity-30 disabled:cursor-not-allowed text-white py-2.5 rounded-xl transition-colors shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            PDF – Ausgewählte WO
          </button>
          <button
            type="button"
            onClick={() => printPdf(needle ? filteredRows : ketRows)}
            disabled={ketRows.length === 0}
            className="w-full text-xs font-bold bg-white hover:bg-slate-100 disabled:opacity-30 text-slate-600 py-2 rounded-xl transition-colors border border-slate-200"
          >
            PDF – Alle ({needle ? filteredRows.length : ketRows.length}) WOs
          </button>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════
          RIGHT DETAIL AREA
      ════════════════════════════════════════════════════ */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50/30 overflow-hidden">
        {/* Detail / Alle WOs toggle — its own bar so it stays visible
            regardless of mode and survives selecting/deselecting a WO. */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] border-b border-white/10">
          <div className="flex rounded-xl overflow-hidden border border-white/20">
            <button
              type="button"
              onClick={() => setMainViewMode("detail")}
              className={`text-[10px] font-bold px-3 py-2 transition-colors ${mainViewMode === "detail" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}
            >
              Detail
            </button>
            <button
              type="button"
              onClick={() => setMainViewMode("list")}
              className={`text-[10px] font-bold px-3 py-2 transition-colors ${mainViewMode === "list" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}
            >
              Alle WOs
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-w-0">
          {mainViewMode === "list" ? (
            <KetWoOverview
              groups={filteredGroups}
              calcMap={calcMap}
              selectedKey={selectedKey}
              onSelect={(key) => { setSelectedKey(key); setMainViewMode("detail"); }}
            />
          ) : !selectedRow ? (
            <EmptyState />
          ) : (
            <WoDetail
              row={selectedRow}
              calc={selectedCalc}
              onPrint={() => printPdf([selectedRow])}
              onCapChange={saveCap}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
