// WMS Übersicht – kleine Leitwarte-Tab-Widgets: Dashboard-KPIs, Planungskalender, Gewichts-Tracking.
import { useState } from "react";
import type { DataBundle, WeightGoalRow } from "../../core/types";
import type { AggInboundRow, AggSleevingRow, AggStoredRow } from "./wmsTypes";
import { daysUntil, fmtQty } from "./wmsFormat";
import type { SkuStationMap } from "./wmsIndex";

// ─── Dashboard KPI ────────────────────────────────────────────────────────────

export function DashboardKpi({ aggInbound, aggStaging, aggDebox, aggPostblast, aggPlating, aggSleeving, skuMap }: {
  aggInbound: AggInboundRow[]; aggStaging: AggStoredRow[]; aggDebox: AggStoredRow[];
  aggPostblast: AggStoredRow[]; aggPlating: AggStoredRow[]; aggSleeving: AggSleevingRow[]; skuMap: SkuStationMap;
}) {
  const totalInbound = aggInbound.reduce((s, r) => s + r.totalReceived, 0);
  const allStored = [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating];
  const stockSkus  = new Set(allStored.map(r => r.sku)).size;
  const stockTotal = allStored.reduce((s, r) => s + r.totalQty, 0);

  const mhdAlarm = allStored.filter(r => { if (!r.firstExpiry) return false; const d = daysUntil(r.firstExpiry); return d >= 0 && d < 3; }).length;
  const mhdWarn  = allStored.filter(r => { if (!r.firstExpiry) return false; const d = daysUntil(r.firstExpiry); return d >= 3 && d < 7; }).length;
  const sleevNet = aggSleeving.reduce((s, r) => s + r.net, 0);
  const sleevLost = aggSleeving.reduce((s, r) => s + r.lost, 0);
  const crossCount = [...skuMap.values()].filter(s => s.size >= 2).length;
  const lossRate = totalInbound > 0 ? sleevLost / totalInbound : 0;

  const tiles = [
    { label: "Wareneingang",  value: fmtQty(totalInbound), sub: `${aggInbound.length} SKUs`,   icon: "📦", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
    { label: "Lagerbestand",  value: fmtQty(stockTotal),   sub: `${stockSkus} SKUs`,           icon: "🗄️", cls: "border-amber-200 bg-amber-50 text-amber-800" },
    { label: "MHD Kritisch",  value: String(mhdAlarm),     sub: "0–2 Tage",                    icon: "🚨", cls: mhdAlarm > 0 ? "border-rose-300 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "MHD Warnung",   value: String(mhdWarn),      sub: "3–6 Tage",                    icon: "⚠️", cls: mhdWarn  > 0 ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "Sleeving Net",  value: fmtQty(sleevNet),     sub: `${aggSleeving.length} SKUs`,  icon: "🔄", cls: sleevNet >= 0 ? "border-sky-200 bg-sky-50 text-sky-800" : "border-rose-200 bg-rose-50 text-rose-700" },
    { label: "Schwund",       value: fmtQty(sleevLost),    sub: lossRate > 0 ? `${(lossRate * 100).toFixed(1)}% v. Inbound` : "0%", icon: "🗑️", cls: sleevLost > 0 ? (lossRate > 0.05 ? "border-rose-300 bg-rose-50 text-rose-800" : "border-amber-300 bg-amber-50 text-amber-800") : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "Cross-Station", value: String(crossCount),   sub: "SKUs in ≥2 Stationen",        icon: "🔍", cls: "border-slate-600 bg-slate-800 text-white" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {tiles.map(t => (
        <div key={t.label} className={`rounded-xl border px-3 py-3 ${t.cls}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-base leading-none">{t.icon}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t.label}</span>
          </div>
          <div className="font-mono font-bold text-xl leading-none">{t.value}</div>
          <div className="text-[10px] opacity-55 mt-1">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}


// ─── Planning Calendar (Deadlines & Eskalation) ────────────────────────────────

export function PlanningCalendarCard({ calendar }: { calendar: DataBundle["planningCalendar"] }) {
  const [open, setOpen] = useState(false);
  if (!calendar || (calendar.deadlines.length === 0 && calendar.rules.length === 0)) return null;

  const todayAbbr = new Date().toLocaleDateString("en-US", { weekday: "short" });
  const isToday = (days: string) => days.toLowerCase().split(",").map(d => d.trim()).includes(todayAbbr.toLowerCase());

  const priorityCls: Record<string, string> = {
    must: "bg-rose-100 text-rose-700",
    can: "bg-sky-100 text-sky-700",
    optimal: "bg-emerald-100 text-emerald-700",
    info: "bg-slate-100 text-slate-500",
  };

  return (
    <div className="card p-4">
      <button type="button" className="w-full flex items-center justify-between" onClick={() => setOpen(o => !o)}>
        <div className="text-xs font-bold uppercase text-slate-500">🗓️ Planning Calendar — Deadlines &amp; Eskalation</div>
        <span className="text-xs text-slate-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {calendar.deadlines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="py-1 pr-3 font-semibold">Aktivität</th>
                    <th className="py-1 pr-3 font-semibold">Deadline</th>
                    <th className="py-1 pr-3 font-semibold">Tage</th>
                    <th className="py-1 pr-3 font-semibold">L1</th>
                    <th className="py-1 pr-3 font-semibold">L2 (+1h)</th>
                    <th className="py-1 font-semibold">L3 (+2h)</th>
                  </tr>
                </thead>
                <tbody>
                  {calendar.deadlines.map((d, i) => (
                    <tr key={i} className={`border-b border-slate-50 ${isToday(d.days) ? "bg-amber-50" : ""}`}>
                      <td className="py-1 pr-3 font-medium text-slate-800">{d.activity}</td>
                      <td className="py-1 pr-3 font-mono text-slate-700">{d.time || "–"}</td>
                      <td className="py-1 pr-3 text-slate-600">{d.days || "–"}</td>
                      <td className="py-1 pr-3 text-slate-600">{d.owner ?? "–"}</td>
                      <td className="py-1 pr-3 text-slate-600">{d.escalation1 ?? "–"}</td>
                      <td className="py-1 text-slate-600">{d.escalation2 ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {calendar.rules.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase text-slate-400 mb-1.5">Planungsregeln</div>
              <ul className="space-y-1">
                {calendar.rules.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                    {r.priority && (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${priorityCls[r.priority] ?? "bg-slate-100 text-slate-500"}`}>
                        {r.priority}
                      </span>
                    )}
                    <span>{r.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Weight Tracking (Kitchen): Ziel vs. Ist ───────────────────────────────────

export function WeightGoalsCard({ goals }: { goals: DataBundle["weightGoals"] }) {
  if (!goals?.length) return null;

  // Nur Zeilen mit tatsaechlicher Untermenge (Shortage < 0) sind Handlungsbedarf —
  // Zeilen ohne Shortage-Wert heissen "im Ziel", nicht "kein Ziel gesetzt".
  const shortages = goals
    .filter(g => (g.shortageKg ?? 0) < 0)
    .sort((a, b) => (a.shortageKg ?? 0) - (b.shortageKg ?? 0));

  if (shortages.length === 0) {
    return (
      <div className="card p-4 border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold text-center">
        ✓ Gewichts-Tracking: keine Untermengen gegenüber Ziel erkannt
      </div>
    );
  }

  const stageLabel: Record<WeightGoalRow["stage"], string> = { raw: "Raw", preBlast: "Pre-Blast" };
  const stageCls: Record<WeightGoalRow["stage"], string> = {
    raw: "bg-amber-100 text-amber-700",
    preBlast: "bg-sky-100 text-sky-700",
  };

  return (
    <div className="card p-4">
      <div className="text-xs font-bold uppercase text-slate-500 mb-2">⚖️ Gewichts-Tracking: Untermengen ggü. Ziel ({shortages.length})</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-100">
              <th className="py-1 pr-3 font-semibold">Stufe</th>
              <th className="py-1 pr-3 font-semibold">WO</th>
              <th className="py-1 pr-3 font-semibold">Sub-Rezept</th>
              <th className="py-1 pr-3 font-semibold text-right">Ziel (kg)</th>
              <th className="py-1 pr-3 font-semibold text-right">Ist (kg)</th>
              <th className="py-1 font-semibold text-right">Shortage (kg)</th>
            </tr>
          </thead>
          <tbody>
            {shortages.slice(0, 15).map((g, i) => (
              <tr key={i} className="border-b border-slate-50">
                <td className="py-1 pr-3">
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${stageCls[g.stage]}`}>{stageLabel[g.stage]}</span>
                </td>
                <td className="py-1 pr-3 font-mono text-slate-700">{g.workOrder}</td>
                <td className="py-1 pr-3 text-slate-800 font-medium truncate max-w-[220px]">{g.subRecipeName}</td>
                <td className="py-1 pr-3 text-right font-mono text-slate-600">{g.goalKg.toFixed(1)}</td>
                <td className="py-1 pr-3 text-right font-mono text-slate-600">{g.trackedKg.toFixed(1)}</td>
                <td className="py-1 text-right font-mono font-semibold text-rose-700">{g.shortageKg?.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shortages.length > 15 && (
        <div className="text-[10px] text-slate-400 mt-2">+ {shortages.length - 15} weitere</div>
      )}
    </div>
  );
}

