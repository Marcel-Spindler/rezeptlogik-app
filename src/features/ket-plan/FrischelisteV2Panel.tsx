// Frischeliste 2.0 – Hauptkomponente
// 2-Ebenen-Struktur: Oberbegriff (Middle Kitchen, Protein …) → Station (Braiser, Oven …)
// Filter: Kategorie (PHF/PTN), Tag (Mo–Fr), Oberbegriff/Station, Ansicht (Submeal/Einkauf)
import { useState, useMemo, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import type { DataBundle } from "../../core/types";
import {
  fetchPlanningSheet,
  fetchWeekDropdownTabs,
  getCachedPlanningSheet,
  type PlanningSheetData,
  type SheetDay,
  type SheetTab,
} from "../../lib/planningSheetApi";
import {
  buildV2Data,
  buildV2DataFallback,
  v2ToCsv,
  v2ToExcelRows,
  v2ToEinkaufExcelRows,
  v2ToPdfHtml,
  COOK_DAYS,
  STATION_ORDER,
  STATION_COLORS,
  GROUP_ORDER,
  GROUP_COLORS,
  CAT_COLORS,
  type V2Result,
  type V2Row,
  type V2StationGroup,
  type V2ParentGroup,
  type CatType,
  type StationType,
  type StationGroup,
  type DaysKg,
} from "./frischeV2Logic";

interface Props {
  data: DataBundle;
  weekLabel: string;
}

type ViewMode = "submeal" | "einkauf";
type SheetStatusType = "idle" | "loading" | "ok" | "error" | "fallback";

const DAY_SHORT: Record<SheetDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi",
  Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

function formatKg(kg: number): string {
  if (kg <= 0) return "—";
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  if (kg >= 100) return `${kg.toFixed(0)} kg`;
  if (kg >= 10) return `${kg.toFixed(1)} kg`;
  return `${kg.toFixed(2)} kg`;
}

function filteredTotal(daysKg: DaysKg, days: SheetDay[]): number {
  return days.reduce((s, d) => s + daysKg[d], 0);
}

function triggerDownload(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}


export function FrischelisteV2Panel({ data, weekLabel }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("submeal");
  const [catFilter, setCatFilter] = useState<Set<CatType>>(new Set(["PHF", "PTN"]));
  const [stationFilter, setStationFilter] = useState<Set<StationType>>(new Set());
  const [dayFilter, setDayFilter] = useState<Set<SheetDay>>(new Set(COOK_DAYS));

  const [selectedWeek, setSelectedWeek] = useState<string>(weekLabel);
  const [availableTabs, setAvailableTabs] = useState<SheetTab[]>([]);
  const [sheetData, setSheetData] = useState<PlanningSheetData | null>(() => getCachedPlanningSheet(weekLabel));
  const [sheetStatus, setSheetStatus] = useState<SheetStatusType>(
    getCachedPlanningSheet(weekLabel) ? "ok" : "idle",
  );
  const [sheetError, setSheetError] = useState("");

  // Aufgeklappte Oberbegriffe (alle standardmäßig auf)
  const [expandedGroups, setExpandedGroups] = useState<Set<StationGroup>>(new Set(GROUP_ORDER));
  // Aufgeklappte Stationen (alle standardmäßig auf)
  const [expandedStations, setExpandedStations] = useState<Set<StationType>>(new Set(STATION_ORDER));

  const [fallbackWeights] = useState<DaysKg>({
    Sunday: 0, Monday: 22000, Tuesday: 22000, Wednesday: 22000,
    Thursday: 15000, Friday: 22000, Saturday: 0,
  });

  const loadSheet = useCallback(async (week: string, force = false) => {
    setSheetStatus("loading");
    setSheetError("");
    try {
      const d = await fetchPlanningSheet(week, force);
      setSheetData(d);
      setSheetStatus("ok");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSheetError(msg);
      setSheetStatus("error");
      setSheetData(null);
    }
  }, []);

  useEffect(() => {
    fetchWeekDropdownTabs(weekLabel).then(setAvailableTabs).catch(() => {});
  }, [weekLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cached = getCachedPlanningSheet(selectedWeek);
    if (cached) { setSheetData(cached); setSheetStatus("ok"); }
    else loadSheet(selectedWeek, false);
  }, [selectedWeek]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Daten ────────────────────────────────────────────────────────────────────
  const result: V2Result = useMemo(() => {
    if (sheetData && sheetStatus === "ok") return buildV2Data(data, sheetData, catFilter);
    return buildV2DataFallback(data, selectedWeek, fallbackWeights, catFilter);
  }, [data, sheetData, sheetStatus, selectedWeek, catFilter, fallbackWeights]);

  const activeDays = useMemo<SheetDay[]>(
    () => COOK_DAYS.filter(d => dayFilter.has(d)),
    [dayFilter],
  );

  // Gefilterte Oberbegriffe + Stationen
  const visibleParents = useMemo<V2ParentGroup[]>(() => {
    if (stationFilter.size === 0) return result.parents;
    return result.parents
      .map(pg => ({
        ...pg,
        stations: pg.stations.filter(sg => stationFilter.has(sg.station)),
      }))
      .filter(pg => pg.stations.length > 0);
  }, [result.parents, stationFilter]);

  const visibleRows = useMemo<V2Row[]>(() => {
    const rows = viewMode === "einkauf" ? result.einkauf : result.allRows;
    if (stationFilter.size === 0) return rows;
    return rows.filter(r => stationFilter.has(r.station));
  }, [result, stationFilter, viewMode]);

  const filteredTotalKg = useMemo(
    () => filteredTotal(result.daysKg, activeDays),
    [result.daysKg, activeDays],
  );

  // ── Toggle-Funktionen ────────────────────────────────────────────────────────
  function toggleDay(d: SheetDay) {
    setDayFilter(prev => {
      const next = new Set(prev);
      if (next.has(d) && next.size > 1) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  function toggleGroup(g: StationGroup) {
    // Alle verfügbaren Stationen dieser Gruppe ermitteln
    const groupSts = result.stations
      .filter(sg => sg.stationGroup === g)
      .map(sg => sg.station);
    if (!groupSts.length) return;

    setStationFilter(prev => {
      const next = new Set(prev);
      const allActive = groupSts.every(s => next.has(s));
      if (allActive) {
        // Alle deselektieren
        groupSts.forEach(s => next.delete(s));
      } else {
        // Alle selektieren
        groupSts.forEach(s => next.add(s));
      }
      return next;
    });
  }

  function toggleStation(s: StationType) {
    setStationFilter(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  function toggleCat(c: CatType) {
    setCatFilter(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }

  function toggleExpandGroup(g: StationGroup) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  }

  function toggleExpandStation(s: StationType) {
    setExpandedStations(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  // Ist eine Gruppe im Stations-Filter "aktiv"? (alle Stationen der Gruppe selektiert)
  function groupFilterActive(g: StationGroup): boolean {
    const groupSts = result.stations.filter(sg => sg.stationGroup === g).map(sg => sg.station);
    return groupSts.length > 0 && groupSts.every(s => stationFilter.has(s));
  }

  function groupFilterPartial(g: StationGroup): boolean {
    const groupSts = result.stations.filter(sg => sg.stationGroup === g).map(sg => sg.station);
    return groupSts.some(s => stationFilter.has(s)) && !groupSts.every(s => stationFilter.has(s));
  }

  // ── Exports ──────────────────────────────────────────────────────────────────
  function downloadCsv() {
    const rows = viewMode === "einkauf" ? result.einkauf : result.allRows;
    const csv = v2ToCsv(rows, result.week, viewMode === "submeal");
    triggerDownload("﻿" + csv, "text/csv;charset=utf-8;", `${result.week}_Frischeliste-2.0.csv`);
  }

  function downloadExcel() {
    const wb = XLSX.utils.book_new();

    if (viewMode === "einkauf") {
      const phfRows = result.einkauf.filter(r => r.catType === "PHF");
      const ptnRows = result.einkauf.filter(r => r.catType === "PTN");
      const einkaufRows = v2ToEinkaufExcelRows(phfRows, ptnRows);
      const ws = XLSX.utils.aoa_to_sheet(einkaufRows);
      ws["!cols"] = [{ wch: 45 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, "Einkauf PHF+PTN");
    } else {
      const sheetRows = v2ToExcelRows(result.allRows, true);
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 8 }, { wch: 45 }, { wch: 18 }, { wch: 35 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, "Submeal");

      // Zweites Sheet: nach Gruppe + Station
      const stRows: (string | number)[][] = [
        ["Gruppe", "Station", "Kategorie", "Artikel", "SKU", "Submeal",
         "So", "Mo", "Di", "Mi", "Do", "Fr", "Gesamt (kg)"],
      ];
      for (const pg of result.parents) {
        stRows.push([`══ ${pg.group} ══ (${pg.totalKg.toFixed(1)} kg)`]);
        for (const sg of pg.stations) {
          stRows.push([`  ── ${sg.station} (${sg.totalKg.toFixed(1)} kg)`]);
          const sgRows = v2ToExcelRows(sg.all, true);
          stRows.push(...sgRows.slice(1));
        }
      }
      const ws2 = XLSX.utils.aoa_to_sheet(stRows);
      ws2["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 8 }, { wch: 45 }, { wch: 18 }, { wch: 35 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws2, "Nach Station");
    }

    XLSX.writeFile(wb, `${result.week}_Frischeliste-2.0.xlsx`);
  }

  function openPdf() {
    const filtered: V2Result = {
      ...result,
      parents: visibleParents,
      stations: visibleParents.flatMap(p => p.stations),
      allRows: visibleRows,
    };
    const html = v2ToPdfHtml(filtered, result.week, viewMode === "submeal", activeDays);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html); w.document.close();
  }

  const isEmpty = result.allRows.length === 0;
  const sheetWeek = sheetData?.week ?? "—";
  const weekMismatch = sheetData && sheetData.week !== selectedWeek;

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">

      {/* ── Toolbar ── */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-slate-100 bg-slate-50">
        <div className="flex flex-wrap items-start justify-between gap-3">

          {/* Linke Seite */}
          <div className="flex flex-col gap-2 min-w-0">

            {/* Sheet-Status + KW */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Quelle</span>
              {sheetStatus === "loading" && (
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 animate-pulse">Lade…</span>
              )}
              {sheetStatus === "ok" && (
                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                  result.recipeCount === 0
                    ? "bg-amber-50 border-amber-200 text-amber-700"
                    : "bg-emerald-50 border-emerald-200 text-emerald-700"
                }`}>
                  Live · {sheetWeek} · {sheetData!.rows.length} Rezepte im Sheet
                  {result.recipeCount === 0 && (
                    <span className="ml-1 font-normal opacity-80">
                      — KW im Sheet: {sheetWeek}, erwartet: {selectedWeek}
                    </span>
                  )}
                  {result.recipeCount > 0 && ` · ${result.recipeCount} gematchte`}
                </span>
              )}
              {sheetStatus === "error" && (
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-red-700" title={sheetError}>
                  Kein Sheet · Schätzung aktiv
                  {sheetError && (
                    <span className="ml-1 font-normal opacity-70">— {sheetError.slice(0, 80)}{sheetError.length > 80 ? "…" : ""}</span>
                  )}
                </span>
              )}
              {weekMismatch && (
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-700">
                  ⚠ KW stimmt nicht ({sheetWeek})
                </span>
              )}
              <button type="button" onClick={() => loadSheet(selectedWeek, true)} disabled={sheetStatus === "loading"}
                className="text-[10px] font-bold px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-40">
                ↻ Neu
              </button>
              {availableTabs.length > 0 && (
                <select value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)}
                  className="text-[10px] font-bold px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-700 hover:border-blue-300 cursor-pointer">
                  {availableTabs.map(t => {
                    const wm = t.title.match(/W(\d{1,2})/i);
                    const wNum = wm ? parseInt(wm[1]) : t.sheetId;
                    const wYear = new Date().getFullYear();
                    const wLabel = `${wYear}-W${wNum}`;
                    return <option key={t.sheetId} value={wLabel}>{t.title}</option>;
                  })}
                </select>
              )}
            </div>

            {/* Kat + Ansicht */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Kat</span>
              {(["PHF", "PTN"] as CatType[]).map(c => {
                const col = CAT_COLORS[c];
                const active = catFilter.has(c);
                return (
                  <button key={c} type="button" onClick={() => toggleCat(c)}
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${
                      active ? `${col.bg} ${col.text} ${col.border}` : "bg-white text-slate-400 border-slate-200 hover:border-slate-300"
                    }`}>{c}</button>
                );
              })}
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Ansicht</span>
              <button type="button" onClick={() => setViewMode("submeal")}
                className={`text-[10px] font-bold px-3 py-1 rounded-lg border transition-colors ${
                  viewMode === "submeal" ? "bg-[#1e3a5f] text-white border-[#1e3a5f]" : "bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700"
                }`}>
                Submeal
              </button>
              <button type="button" onClick={() => setViewMode("einkauf")}
                className={`text-[10px] font-bold px-3 py-1 rounded-lg border transition-colors ${
                  viewMode === "einkauf" ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-slate-500 border-slate-200 hover:border-emerald-400 hover:text-emerald-700"
                }`}>
                Einkauf
              </button>
            </div>

            {/* Oberbegriff-Filter */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Bereich</span>
              <button type="button" onClick={() => setStationFilter(new Set())}
                className={`text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors ${
                  stationFilter.size === 0 ? "bg-[#1e3a5f] text-white border-[#1e3a5f]" : "bg-white text-slate-500 border-slate-200 hover:border-blue-300"
                }`}>Alle</button>
              {GROUP_ORDER.filter(g => result.parents.some(p => p.group === g)).map(g => {
                const col = GROUP_COLORS[g];
                const active = groupFilterActive(g);
                const partial = groupFilterPartial(g);
                const pg = result.parents.find(p => p.group === g);
                return (
                  <button key={g} type="button" onClick={() => toggleGroup(g)}
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${
                      active
                        ? `${col.bg} ${col.text} ${col.border} ring-1 ring-white/30 ring-offset-1`
                        : partial
                          ? `${col.bg} ${col.text} ${col.border} opacity-60`
                          : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"
                    }`}>
                    {g}
                    {pg && <span className="ml-1 opacity-70 font-normal">{formatKg(filteredTotal(pg.daysKg, activeDays))}</span>}
                  </button>
                );
              })}
            </div>

            {/* Station-Filter (individuell) */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Station</span>
              {result.stations.map(sg => {
                const col = STATION_COLORS[sg.station];
                const active = stationFilter.has(sg.station);
                return (
                  <button key={sg.station} type="button" onClick={() => toggleStation(sg.station)}
                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border transition-colors ${
                      active
                        ? `${col.bg} ${col.text} ${col.border} ring-1 ring-current ring-offset-1`
                        : "bg-white text-slate-400 border-slate-200 hover:border-slate-400"
                    }`}>
                    {sg.station}
                    <span className="ml-0.5 opacity-50 font-normal">{formatKg(filteredTotal(sg.daysKg, activeDays))}</span>
                  </button>
                );
              })}
            </div>

            {/* Tages-Filter */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Tag</span>
              <button type="button" onClick={() => setDayFilter(new Set(COOK_DAYS))}
                className={`text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors ${
                  dayFilter.size === COOK_DAYS.length ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300"
                }`}>Alle</button>
              {COOK_DAYS.map(d => {
                const active = dayFilter.has(d);
                return (
                  <button key={d} type="button" onClick={() => toggleDay(d)}
                    className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${
                      active
                        ? "bg-indigo-600 text-white border-indigo-600 ring-1 ring-indigo-400 ring-offset-1"
                        : "bg-white text-slate-400 border-slate-200 hover:border-indigo-300 hover:text-indigo-600"
                    }`}>
                    {DAY_SHORT[d]}
                    {result.daysKg[d] > 0 && (
                      <span className={`ml-1 text-[9px] font-normal ${active ? "opacity-75" : "opacity-40"}`}>
                        {formatKg(result.daysKg[d])}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Rechte Seite: KPIs + Export */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="text-right">
              <div className="text-[13px] font-black text-slate-700">
                {formatKg(filteredTotalKg)}
                {activeDays.length < COOK_DAYS.length && (
                  <span className="ml-1 text-[10px] font-medium text-indigo-500">
                    {activeDays.map(d => DAY_SHORT[d]).join("+")}
                  </span>
                )}
              </div>
              <div className="text-[9px] text-slate-400">
                {result.allRows.length} Positionen · {result.recipeCount} Rezepte
              </div>
            </div>
            <div className="flex gap-1.5">
              {activeDays.map(d => (
                <div key={d} className="text-center">
                  <div className="text-[9px] font-bold text-indigo-400">{DAY_SHORT[d]}</div>
                  <div className="text-[10px] font-bold text-slate-600 tabular-nums">{formatKg(result.daysKg[d])}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={downloadCsv} disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-40">CSV</button>
              <button type="button" onClick={downloadExcel} disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-40">Excel</button>
              <button type="button" onClick={openPdf} disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40">PDF</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {sheetStatus === "loading" && result.allRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <div className="text-3xl mb-3 animate-spin">⏳</div>
            <div className="text-sm font-semibold">Lade Google Sheet…</div>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <div className="text-3xl mb-3">📋</div>
            <div className="text-sm font-semibold">Keine Daten für {selectedWeek}</div>
            <div className="text-xs mt-1">
              {sheetStatus === "error" ? "Sheet nicht erreichbar – KW vorhanden?" : "Kat-Filter prüfen"}
            </div>
          </div>
        ) : viewMode === "submeal" ? (
          <SubmealView
            parents={visibleParents}
            expandedGroups={expandedGroups}
            expandedStations={expandedStations}
            activeDays={activeDays}
            onToggleGroup={toggleExpandGroup}
            onToggleStation={toggleExpandStation}
          />
        ) : (
          <EinkaufView
            rows={visibleRows}
            activeDays={activeDays}
          />
        )}
      </div>
    </div>
  );
}

// ── Submeal-Ansicht (2-Ebenen) ────────────────────────────────────────────────

function SubmealView({
  parents, expandedGroups, expandedStations, activeDays, onToggleGroup, onToggleStation,
}: {
  parents: V2ParentGroup[];
  expandedGroups: Set<StationGroup>;
  expandedStations: Set<StationType>;
  activeDays: SheetDay[];
  onToggleGroup: (g: StationGroup) => void;
  onToggleStation: (s: StationType) => void;
}) {
  if (!parents.length) return (
    <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
      Keine Stationen für diesen Filter
    </div>
  );
  return (
    <div className="p-5 space-y-5">
      {parents.map(pg => (
        <ParentSection
          key={pg.group}
          pg={pg}
          expanded={expandedGroups.has(pg.group)}
          expandedStations={expandedStations}
          activeDays={activeDays}
          onToggleGroup={onToggleGroup}
          onToggleStation={onToggleStation}
        />
      ))}
    </div>
  );
}

function ParentSection({
  pg, expanded, expandedStations, activeDays, onToggleGroup, onToggleStation,
}: {
  pg: V2ParentGroup;
  expanded: boolean;
  expandedStations: Set<StationType>;
  activeDays: SheetDay[];
  onToggleGroup: (g: StationGroup) => void;
  onToggleStation: (s: StationType) => void;
}) {
  const col = GROUP_COLORS[pg.group];
  const groupTotal = filteredTotal(pg.daysKg, activeDays);

  return (
    <div className="rounded-xl overflow-hidden shadow-sm border border-slate-200">
      {/* Oberbegriff-Header */}
      <button type="button" onClick={() => onToggleGroup(pg.group)}
        className={`w-full flex items-center justify-between px-5 py-3 ${col.header} hover:brightness-90 transition-all`}>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-black uppercase tracking-widest">
            {pg.group}
          </span>
          <span className="text-[10px] font-bold opacity-70 px-2 py-0.5 rounded-full bg-white/20">
            {pg.stations.length} Station{pg.stations.length !== 1 ? "en" : ""}
          </span>
          <span className="text-[10px] opacity-60">
            {pg.stations.map(s => s.station).join(" · ")}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            {activeDays.map(d => (
              <div key={d} className="text-center">
                <div className="text-[8px] font-bold opacity-50">{DAY_SHORT[d]}</div>
                <div className="text-[9px] font-bold tabular-nums opacity-90">
                  {pg.daysKg[d] > 0 ? pg.daysKg[d].toFixed(0) : "—"}
                </div>
              </div>
            ))}
          </div>
          <span className="text-[13px] font-black whitespace-nowrap">{formatKg(groupTotal)}</span>
          <span className="text-[10px] opacity-50">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* Stationen darunter */}
      {expanded && (
        <div className="divide-y divide-slate-100 bg-white">
          {pg.stations.map(sg => (
            <StationSection
              key={sg.station}
              sg={sg}
              expanded={expandedStations.has(sg.station)}
              activeDays={activeDays}
              onToggle={onToggleStation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StationSection({
  sg, expanded, activeDays, onToggle,
}: {
  sg: V2StationGroup;
  expanded: boolean;
  activeDays: SheetDay[];
  onToggle: (s: StationType) => void;
}) {
  const col = STATION_COLORS[sg.station];
  const stTotal = filteredTotal(sg.daysKg, activeDays);

  return (
    <div>
      <button type="button" onClick={() => onToggle(sg.station)}
        className={`w-full flex items-center justify-between px-4 py-2 ${col.bg} hover:brightness-95 transition-all`}>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-black uppercase tracking-wide ${col.text}`}>{sg.station}</span>
          <span className={`text-[9px] font-bold border px-1.5 py-0.5 rounded-full ${col.badge}`}>
            {sg.all.length} Artikel
          </span>
          {sg.all.filter(r => r.catType === "PHF").length > 0 && (
            <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">
              PHF {sg.all.filter(r => r.catType === "PHF").length}
            </span>
          )}
          {sg.all.filter(r => r.catType === "PTN").length > 0 && (
            <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-pink-100 text-pink-700 border border-pink-200">
              PTN {sg.all.filter(r => r.catType === "PTN").length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-2">
            {activeDays.map(d => (
              <div key={d} className="text-center">
                <div className={`text-[7px] font-bold ${col.text} opacity-50`}>{DAY_SHORT[d]}</div>
                <div className={`text-[9px] font-bold tabular-nums ${col.text}`}>
                  {sg.daysKg[d] > 0 ? sg.daysKg[d].toFixed(0) : "—"}
                </div>
              </div>
            ))}
          </div>
          <span className={`text-[10px] font-black ${col.text} whitespace-nowrap`}>{formatKg(stTotal)}</span>
          <span className={`text-[8px] ${col.text} opacity-40`}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-4 py-1.5 font-bold text-slate-600 min-w-[180px]">Artikel</th>
                <th className="text-left px-2 py-1.5 font-bold text-slate-500">Kat</th>
                <th className="text-left px-2 py-1.5 font-bold text-slate-500 max-w-[140px]">Submeal</th>
                {activeDays.map(d => (
                  <th key={d} className="text-right px-2 py-1.5 font-bold text-slate-600 whitespace-nowrap min-w-[55px]">
                    {DAY_SHORT[d]}
                  </th>
                ))}
                <th className="text-right px-3 py-1.5 font-bold text-slate-700 whitespace-nowrap">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {sg.all.map((row, idx) => (
                <IngRow key={row.key} row={row} idx={idx} activeDays={activeDays} />
              ))}
            </tbody>
            <tfoot>
              <tr className={`border-t-2 border-slate-200 ${col.bg}`}>
                <td colSpan={3} className={`px-4 py-1.5 text-[10px] font-black ${col.text}`}>
                  {sg.station} Gesamt
                </td>
                {activeDays.map(d => (
                  <td key={d} className={`px-2 py-1.5 text-right font-bold tabular-nums text-[10px] ${col.text}`}>
                    {sg.daysKg[d] > 0 ? formatKg(sg.daysKg[d]) : "—"}
                  </td>
                ))}
                <td className={`px-3 py-1.5 text-right font-black tabular-nums ${col.text}`}>
                  {formatKg(stTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Einkauf-Ansicht: PHF + PTN getrennt, ohne Bereich/Station ────────────────

function EinkaufView({
  rows, activeDays,
}: {
  rows: V2Row[];
  activeDays: SheetDay[];
}) {
  const phfRows = rows.filter(r => r.catType === "PHF").sort((a, b) => b.totalKg - a.totalKg);
  const ptnRows = rows.filter(r => r.catType === "PTN").sort((a, b) => b.totalKg - a.totalKg);

  if (!rows.length) return (
    <div className="flex items-center justify-center h-32 text-slate-400 text-sm">Keine Artikel</div>
  );
  return (
    <div className="p-5 space-y-6">
      <EinkaufSection heading="PHF – Frischware" headBg="bg-orange-600" rows={phfRows} activeDays={activeDays} />
      <EinkaufSection heading="PTN – Proteine" headBg="bg-pink-700" rows={ptnRows} activeDays={activeDays} />
    </div>
  );
}

function EinkaufSection({
  heading, headBg, rows, activeDays,
}: {
  heading: string;
  headBg: string;
  rows: V2Row[];
  activeDays: SheetDay[];
}) {
  if (!rows.length) return null;
  const sectionTotal = rows.reduce((s, r) => s + filteredTotal(r.daysKg, activeDays), 0);

  return (
    <div className="rounded-xl overflow-hidden border border-slate-200 shadow-sm">
      <div className={`${headBg} text-white px-4 py-2.5 flex items-center justify-between`}>
        <span className="text-[12px] font-black uppercase tracking-widest">{heading}</span>
        <span className="text-[11px] font-bold opacity-80">{formatKg(sectionTotal)} · {rows.length} Artikel</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="text-left px-3 py-2 font-bold text-slate-500 w-7">#</th>
            <th className="text-left px-3 py-2 font-bold text-slate-600">Artikel</th>
            <th className="text-left px-2 py-2 font-bold text-slate-500">SKU</th>
            {activeDays.map(d => (
              <th key={d} className="text-right px-2 py-2 font-bold text-slate-600 whitespace-nowrap min-w-[52px]">
                {DAY_SHORT[d]}
              </th>
            ))}
            <th className="text-right px-3 py-2 font-bold text-slate-700">Gesamt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.key} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${
              idx % 2 === 0 ? "bg-white" : "bg-slate-50/40"
            }`}>
              <td className="px-3 py-1.5 text-slate-400 tabular-nums">{idx + 1}</td>
              <td className="px-3 py-1.5 font-medium text-slate-800">{row.name}</td>
              <td className="px-2 py-1.5 text-slate-400 font-mono text-[10px]">{row.ingredientId}</td>
              {activeDays.map(d => (
                <td key={d} className={`px-2 py-1.5 text-right tabular-nums ${
                  row.daysKg[d] > 0 ? "font-medium text-slate-800" : "text-slate-300"
                }`}>
                  {row.daysKg[d] > 0 ? row.daysKg[d].toFixed(1) : "—"}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-900">
                {formatKg(filteredTotal(row.daysKg, activeDays))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 bg-slate-100">
            <td colSpan={3} className="px-3 py-2 text-[10px] font-black text-slate-700">
              Gesamt ({rows.length})
            </td>
            {activeDays.map(d => (
              <td key={d} className="px-2 py-2 text-right font-bold tabular-nums text-slate-800 text-[10px]">
                {rows.reduce((s, r) => s + r.daysKg[d], 0) > 0
                  ? formatKg(rows.reduce((s, r) => s + r.daysKg[d], 0))
                  : "—"}
              </td>
            ))}
            <td className="px-3 py-2 text-right font-black tabular-nums text-slate-900">
              {formatKg(sectionTotal)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Zeile ─────────────────────────────────────────────────────────────────────

function IngRow({ row, idx, activeDays }: { row: V2Row; idx: number; activeDays: SheetDay[] }) {
  const rowTotal = filteredTotal(row.daysKg, activeDays);
  return (
    <tr className={`border-b border-slate-100 hover:bg-white/80 transition-colors ${
      idx % 2 === 0 ? "bg-white" : "bg-slate-50/30"
    }`}>
      <td className="px-4 py-1.5 font-medium text-slate-800">{row.name}</td>
      <td className="px-2 py-1.5"><CatBadge cat={row.catType} label={row.category} /></td>
      <td className="px-2 py-1.5 text-slate-500 max-w-[140px] truncate text-[10px]" title={row.submeal}>
        {row.submeal}
      </td>
      {activeDays.map(d => (
        <td key={d} className={`px-2 py-1.5 text-right tabular-nums ${
          row.daysKg[d] > 0 ? "font-medium text-slate-800" : "text-slate-300"
        }`}>
          {row.daysKg[d] > 0 ? row.daysKg[d].toFixed(1) : "—"}
        </td>
      ))}
      <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-900">{formatKg(rowTotal)}</td>
    </tr>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────

function CatBadge({ cat, label }: { cat: CatType; label: string }) {
  const col = CAT_COLORS[cat];
  return (
    <span className={`px-1.5 py-0.5 text-[9px] rounded font-black border ${col.bg} ${col.text} ${col.border}`}>
      {label || cat}
    </span>
  );
}

