// Equipment-Übersichts-Panel für den KET Breakdown — interaktives Tages-Dashboard.
// Pro Tag: Station-Cards mit Auslastungs-Bars, aufklappbare WO-Listen, Chiller-Dots.
import { useMemo, useState } from "react";
import type { BatchCalc, KetRow } from "./ketTypes";
import type { RunInfo } from "./ketRunLogic";
import { parseDateShift } from "./ketLogic";
import { computeFullResourceDemand, type RunDemand, type StationDemand, SHIFT_HOURS } from "./ketEquipmentSummary";
import { CHILLER_CFG, type ChillerKey } from "../blast-chiller/blastChillerLogic";

// ── Helfer ─────────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, string> = {
  "1": "Mo", "2": "Di", "3": "Mi", "4": "Do", "5": "Fr", "6": "Sa", "0": "So",
};

function weekdayLabel(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return WEEKDAYS[String(d.getDay())] ?? dateStr.slice(8);
  } catch { return dateStr.slice(8); }
}

function fmtDate(dateStr: string): string {
  return `${weekdayLabel(dateStr)} ${dateStr.slice(8)}.${dateStr.slice(5, 7)}`;
}

function utilizationPct(station: StationDemand): number {
  const shiftMin = SHIFT_HOURS * 60;
  return Math.min(100, Math.round((station.effectiveMinutes / shiftMin) * 100));
}

function utilizationColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-400";
  if (pct >= 40) return "bg-emerald-400";
  return "bg-blue-300";
}

function utilizationTextColor(pct: number): string {
  if (pct >= 90) return "text-red-700";
  if (pct >= 70) return "text-amber-700";
  return "text-emerald-700";
}

// ── Station-Card ───────────────────────────────────────────────────────────

function StationCard({
  station,
  woDetails,
}: {
  station: StationDemand;
  woDetails: { woNumber: string; subRecipeName: string; kg: number }[];
}) {
  const [open, setOpen] = useState(false);
  const pct = utilizationPct(station);
  const barColor = utilizationColor(pct);
  const textColor = utilizationTextColor(pct);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden transition-all hover:shadow-md">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        {/* Auslastungs-Ring */}
        <div className="relative w-11 h-11 shrink-0">
          <svg className="w-11 h-11 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#E2E8F0" strokeWidth="3" />
            <circle
              cx="18" cy="18" r="15" fill="none"
              stroke={pct >= 90 ? "#EF4444" : pct >= 70 ? "#F59E0B" : "#10B981"}
              strokeWidth="3"
              strokeDasharray={`${pct * 0.94} 100`}
              strokeLinecap="round"
            />
          </svg>
          <span className={`absolute inset-0 flex items-center justify-center text-[10px] font-black ${textColor}`}>
            {pct}%
          </span>
        </div>

        {/* Stations-Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-black text-slate-800">{station.label}</span>
            {station.deviceCount > 1 && (
              <span className="text-[9px] font-bold bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">
                {station.deviceCount}× Geräte
              </span>
            )}
            {station.allergensPresent.length > 0 && (
              <span className="text-[9px] font-bold bg-red-100 text-red-700 rounded px-1.5 py-0.5">
                ⚠ Allergen
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-slate-500">
            <span><span className="font-bold text-blue-700">{station.totalBatches}</span> Bat</span>
            <span><span className="font-bold text-slate-700">{station.totalKg.toFixed(0)}</span> kg</span>
            <span>{(station.effectiveMinutes / 60).toFixed(1)}h</span>
            {station.wannen > 0 && <span>{station.wannen} Wannen</span>}
            {station.gnTrays.length > 0 && (
              <span>{station.gnTrays.map(t => `${t.count}× ${t.gnType}`).join(", ")}</span>
            )}
            {station.ovenLoads != null && <span>{station.ovenLoads} Rack-Lad.</span>}
          </div>
        </div>

        {/* Expand-Pfeil */}
        <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Auslastungs-Bar */}
      <div className="px-4 pb-2">
        <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Aufklappbare WO-Liste */}
      {open && woDetails.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-2 bg-slate-50/50 max-h-48 overflow-y-auto">
          <div className="space-y-1">
            {woDetails.map((wo) => (
              <div key={wo.woNumber} className="flex items-center justify-between text-[10px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold text-slate-600 shrink-0">WO {wo.woNumber}</span>
                  <span className="text-slate-400 truncate">{wo.subRecipeName}</span>
                </div>
                <span className="text-slate-500 font-semibold tabular-nums shrink-0 ml-2">{wo.kg.toFixed(1)} kg</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chiller-Dots ───────────────────────────────────────────────────────────

function ChillerDots({ chillerSlots }: { chillerSlots: RunDemand["chillerSlots"] }) {
  if (chillerSlots.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">Chiller:</span>
      {chillerSlots.map(c => {
        const cfg = CHILLER_CFG[c.key as ChillerKey];
        return (
          <div
            key={c.key}
            title={`${cfg.label} (${cfg.sub}): ${c.woNumbers.join(", ")}`}
            className="flex items-center gap-1 rounded-full px-2 py-0.5"
            style={{ background: cfg.cntBg, color: cfg.cntColor }}
          >
            <span className="text-[10px] font-black">{c.woCount}</span>
            <span className="text-[8px] font-bold">{cfg.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Hauptkomponente ────────────────────────────────────────────────────────

export function KetEquipmentPanel({
  rows,
  calcMap,
  runAssignments,
}: {
  rows: KetRow[];
  calcMap: Map<string, BatchCalc>;
  runAssignments: Map<string, RunInfo>;
}) {
  const summary = useMemo(
    () => computeFullResourceDemand(rows, calcMap, runAssignments),
    [rows, calcMap, runAssignments],
  );

  // Verfügbare Tage extrahieren
  const availableDays = useMemo(() => {
    const days = new Set<string>();
    for (const row of rows) days.add(parseDateShift(row.dateNeeded).date);
    return [...days].sort();
  }, [rows]);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<"all" | 1 | 2>("all");

  // Aktiver Tag (erster Tag wenn nichts gewählt)
  const activeDay = selectedDay ?? availableDays[0] ?? null;

  // Gefilterte RunDemands für den aktiven Tag
  const dayDemands = useMemo(() => {
    if (!activeDay) return [];
    return summary.byRunDayShift.filter(rd =>
      rd.date === activeDay && (runFilter === "all" || rd.run === runFilter),
    );
  }, [summary, activeDay, runFilter]);

  // WO-Details für die Station-Cards (welche WO gehört zu welcher Station)
  const woDetailsByStation = useMemo(() => {
    const map = new Map<string, { woNumber: string; subRecipeName: string; kg: number }[]>();
    if (!activeDay) return map;

    for (const row of rows) {
      const { date } = parseDateShift(row.dateNeeded);
      if (date !== activeDay) continue;
      if (runFilter !== "all") {
        const runInfo = runAssignments.get(row.key);
        if (runInfo && runInfo.run !== runFilter) continue;
      }
      const calc = calcMap.get(row.key);
      if (!calc) continue;

      const methods = calc.components.length > 0
        ? [...new Set(calc.components.flatMap(c => c.equipBatches.filter(eb => eb.batches > 0).map(eb => eb.equip)))]
        : calc.equipBatches.filter(eb => eb.batches > 0).map(eb => eb.equip);

      for (const station of methods) {
        if (!map.has(station)) map.set(station, []);
        const list = map.get(station)!;
        if (!list.some(wo => wo.woNumber === row.woNumber)) {
          list.push({
            woNumber: row.woNumber,
            subRecipeName: row.subRecipeName || row.recipeName,
            kg: calc.totalKg,
          });
        }
      }
    }
    return map;
  }, [rows, calcMap, runAssignments, activeDay, runFilter]);

  // Tages-Totals
  const dayTotals = useMemo(() => {
    const kg = dayDemands.reduce((s, rd) => s + rd.totalKg, 0);
    const bleche = dayDemands.reduce((s, rd) => s + rd.totalGnTrays, 0);
    const wannen = dayDemands.reduce((s, rd) => s + rd.totalWannen, 0);
    const wos = dayDemands.reduce((s, rd) => s + rd.totalWos, 0);
    const chillerSlots = dayDemands.flatMap(rd => rd.chillerSlots);
    // Merge chiller slots across runs
    const chillerMap = new Map<string, RunDemand["chillerSlots"][0]>();
    for (const c of chillerSlots) {
      const existing = chillerMap.get(c.key);
      if (existing) {
        existing.woCount += c.woCount;
        existing.woNumbers = [...new Set([...existing.woNumbers, ...c.woNumbers])];
      } else {
        chillerMap.set(c.key, { ...c, woNumbers: [...c.woNumbers] });
      }
    }
    return { kg, bleche, wannen, wos, chillerSlots: [...chillerMap.values()] };
  }, [dayDemands]);

  // Alle Stationen des Tages (merged über Runs wenn "alle")
  const dayStations = useMemo(() => {
    const stationMap = new Map<string, StationDemand>();
    for (const rd of dayDemands) {
      for (const st of rd.stations) {
        const existing = stationMap.get(st.station);
        if (existing) {
          existing.totalBatches += st.totalBatches;
          existing.totalKg = +(existing.totalKg + st.totalKg).toFixed(2);
          existing.estimatedMinutes += st.estimatedMinutes;
          existing.effectiveMinutes += st.effectiveMinutes;
          existing.wannen += st.wannen;
          // merge gnTrays
          for (const t of st.gnTrays) {
            const eg = existing.gnTrays.find(g => g.gnType === t.gnType);
            if (eg) eg.count += t.count;
            else existing.gnTrays.push({ ...t });
          }
          if (st.ovenLoads != null) {
            existing.ovenLoads = (existing.ovenLoads ?? 0) + st.ovenLoads;
          }
          for (const wo of st.woNumbers) {
            if (!existing.woNumbers.includes(wo)) existing.woNumbers.push(wo);
          }
          for (const a of st.allergensPresent) {
            if (!existing.allergensPresent.includes(a)) existing.allergensPresent.push(a);
          }
        } else {
          stationMap.set(st.station, { ...st, gnTrays: st.gnTrays.map(t => ({ ...t })), woNumbers: [...st.woNumbers], allergensPresent: [...st.allergensPresent], scoopsNeeded: [...st.scoopsNeeded] });
        }
      }
    }
    return [...stationMap.values()].sort((a, b) => b.totalBatches - a.totalBatches);
  }, [dayDemands]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Keine WO-Daten geladen.
      </div>
    );
  }

  const hasBottleneck = summary.bottlenecks.some(b => b.date === activeDay);

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-slate-50 to-white">
      {/* ── Tages-Tabs ── */}
      <div className="shrink-0 px-4 pt-4 pb-2 flex items-center gap-2 flex-wrap">
        {availableDays.map(day => (
          <button
            key={day}
            type="button"
            onClick={() => setSelectedDay(day)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
              day === activeDay
                ? "bg-[#1e3a5f] text-white shadow-md scale-105"
                : "bg-white text-slate-500 border border-slate-200 hover:border-blue-300 hover:text-blue-600"
            }`}
          >
            {fmtDate(day)}
          </button>
        ))}

        {/* Run-Filter */}
        <div className="ml-auto flex rounded-lg overflow-hidden border border-slate-200 text-[9px] font-bold">
          {(["all", 1, 2] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => setRunFilter(v)}
              className={`px-2.5 py-1 transition-colors ${
                runFilter === v ? "bg-[#1e3a5f] text-white" : "bg-white text-slate-400 hover:text-slate-600"
              }`}
            >
              {v === "all" ? "Alle" : `Run ${v}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tages-KPI ── */}
      {activeDay && (
        <div className="shrink-0 px-4 pb-3">
          <div className="flex items-center gap-4 text-[11px]">
            <span className="font-black text-slate-800">{dayTotals.wos} WOs</span>
            <span className="text-slate-400">·</span>
            <span className="font-bold text-slate-600">{dayTotals.kg.toFixed(0)} kg</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{dayTotals.bleche} Bleche</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{dayTotals.wannen} Wannen</span>
            <div className="ml-auto">
              <ChillerDots chillerSlots={dayTotals.chillerSlots} />
            </div>
          </div>

          {/* Engpass-Alert */}
          {hasBottleneck && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {summary.bottlenecks.filter(b => b.date === activeDay).map((b, i) => (
                <div key={i} className="text-[10px] font-bold text-red-700">
                  ⚠ {b.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Station-Cards ── */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-2.5">
          {dayStations.map(st => (
            <StationCard
              key={st.station}
              station={st}
              woDetails={woDetailsByStation.get(st.station) ?? []}
            />
          ))}
        </div>

        {dayStations.length === 0 && activeDay && (
          <div className="text-center text-slate-400 text-sm mt-12">
            Keine Station-Daten für diesen Tag.
          </div>
        )}
      </div>
    </div>
  );
}
