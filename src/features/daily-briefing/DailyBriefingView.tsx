import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import type { DataBundle } from "../../core/types";
import { useAppState } from "../../app/AppContext";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useCombinedPlaited } from "../gsheet-monitor/useCombinedPlaited";
import { useSharedKetCsvRows, useKetRowsData } from "../ket-plan/useKetRowsData";
import {
  useTransparencyWeighing, useTransparencyFlow, useTransparencyPlanningCheck, useTransparencyRtem,
} from "../gsheet-monitor/useTransparencyMonitor";
import { useStaffingPlanMonitor } from "../gsheet-monitor/useGSheetMonitor";
import { computeTransparencyProducibility } from "../gsheet-monitor/transparencyProducibility";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek } from "../wms-overview/wmsWeeks";
import { fmtNum } from "../../lib/helpers";
import {
  buildDailyBriefing,
  SHIFT_LABEL_SHORT,
  type DailyBriefing,
  type WoLocation,
  type KetDayGroup,
  type MealPlatingStatus,
  type BackfillWatchItem,
  type CriticalItem,
  type PlatingTodoItem,
  type AtRiskWo,
  type TomorrowPriorityWo,
  type StaffingEstimate,
} from "./dailyBriefingLogic";
import type { BackfillAlert } from "../backfills/backfillTypes";
import { escHtml } from "../ket-plan/ketLogic";

// ── helpers ─────────────────────────────────────────────────────────────────

function pctColor(pct: number) { return pct >= 95 ? "text-emerald-600" : pct >= 70 ? "text-amber-600" : "text-rose-600"; }
function pctBg(pct: number) { return pct >= 95 ? "bg-emerald-400" : pct >= 70 ? "bg-amber-400" : "bg-rose-400"; }
function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }

const LOC_STYLE: Record<WoLocation, { bg: string; text: string }> = {
  Warte:       { bg: "bg-slate-100",   text: "text-slate-600" },
  Staging:     { bg: "bg-violet-100",  text: "text-violet-700" },
  Kitchen:     { bg: "bg-amber-100",   text: "text-amber-700" },
  "Post-Blast": { bg: "bg-sky-100",    text: "text-sky-700" },
  Fertig:      { bg: "bg-emerald-100", text: "text-emerald-700" },
  unbekannt:   { bg: "bg-slate-100",   text: "text-slate-400" },
};
const PROD_STYLE: Record<string, { bg: string; text: string }> = {
  ready:   { bg: "bg-emerald-100", text: "text-emerald-700" },
  partial: { bg: "bg-amber-100",   text: "text-amber-700" },
  blocked: { bg: "bg-rose-100",    text: "text-rose-700" },
  unknown: { bg: "bg-slate-100",   text: "text-slate-500" },
};

function Badge({ label, bg, text }: { label: string; bg: string; text: string }) {
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${bg} ${text}`}>{label}</span>;
}

// Manche Kritisch-/Backfill-Meldungen (aus combineBackfills.ts) sind lange,
// mehrteilige Sätze — auf der Karte reicht der erste Teil, der komplette Text
// bleibt per Hover (title) erreichbar statt den Screen vollzuschreiben.
function truncate(s: string, max = 150): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}
function TruncatedText({ text, className }: { text: string; className?: string }) {
  return <p className={className} title={text}>{truncate(text)}</p>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "green" | "amber" | "rose" | "blue" | "slate" }) {
  const t = tone ?? "slate";
  const border = { green: "border-emerald-200 bg-emerald-50", amber: "border-amber-200 bg-amber-50", rose: "border-rose-200 bg-rose-50", blue: "border-blue-200 bg-blue-50", slate: "border-slate-200 bg-white" }[t];
  const valColor = { green: "text-emerald-800", amber: "text-amber-800", rose: "text-rose-800", blue: "text-blue-800", slate: "text-slate-800" }[t];
  const subColor = { green: "text-emerald-500", amber: "text-amber-500", rose: "text-rose-500", blue: "text-blue-500", slate: "text-slate-400" }[t];
  return (
    <div className={`rounded-lg border px-4 py-3 ${border}`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${subColor}`}>{label}</div>
      <div className={`font-mono text-lg font-bold ${valColor}`}>{value}</div>
      {sub && <div className={`text-[10px] mt-0.5 ${subColor}`}>{sub}</div>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
        {title}
        {count != null && <span className="bg-slate-100 text-slate-500 text-[10px] font-mono px-1.5 py-0.5 rounded-full">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function SourceDot({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${on ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-slate-300"}`} />{label}
    </span>
  );
}

// ── Kritisch — was ist JETZT faul ───────────────────────────────────────────
// Steht bewusst ganz oben, noch vor den KPI-Kacheln: das ist die Frage, die um
// 15:30 als Erstes beantwortet werden muss. Unterscheidet explizit "nichts
// Kritisches, weil geprüft und gut" (grün) von "nichts zu sehen, weil noch
// keine Quelle verbunden" (grau) — sonst sieht eine leere Liste in beiden
// Fällen gleich aus, und genau das war die Beschwerde am alten Stand.
function CriticalSection({ items, dataConnected }: { items: CriticalItem[]; dataConnected: boolean }) {
  if (!dataConnected) {
    return (
      <div className="card p-4 border-slate-200 bg-slate-50">
        <p className="text-sm font-bold text-slate-500">Noch keine Live-Daten verbunden.</p>
        <p className="text-xs text-slate-400 mt-0.5">Postblast / RTI / LinePlaiting / KET-Plan warten auf Verbindung — siehe Punkte oben rechts.</p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="card p-4 border-emerald-200 bg-emerald-50">
        <p className="text-sm font-bold text-emerald-700">Keine kritischen Meldungen.</p>
      </div>
    );
  }
  return (
    <section className="card p-4 border-rose-200">
      <h3 className="text-sm font-bold text-rose-700 mb-3 flex items-center gap-2">
        Kritisch — was ist faul
        <span className="bg-rose-100 text-rose-600 text-[10px] font-mono px-1.5 py-0.5 rounded-full">{items.length}</span>
      </h3>
      <div className="space-y-1.5">
        {items.map((c, i) => (
          <div key={`${c.recipeCode}-${c.source}-${i}`} className={`flex items-start gap-2 text-xs rounded px-2 py-1.5 border ${c.severity === "critical" ? "bg-rose-50 border-rose-200" : "bg-amber-50 border-amber-200"}`}>
            <Badge label={c.sourceLabel} bg={c.severity === "critical" ? "bg-rose-600" : "bg-amber-500"} text="text-white" />
            {c.dayScope === "morgen" && <Badge label="morgen" bg="bg-violet-100" text="text-violet-700" />}
            <div className="flex-1 min-w-0">
              <span className="font-mono text-slate-400 mr-1">{c.recipeCode}</span>
              <span className={`font-bold ${c.severity === "critical" ? "text-rose-700" : "text-amber-700"}`}>{c.recipeName}</span>
              <span className="text-slate-600" title={c.message}> — {truncate(c.message, 120)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Gefährdete WOs — EIN Eintrag pro Meal, alle betroffenen WOs gebündelt ───
// (vorher: ein Eintrag pro WO, derselbe lange Grund-Absatz mehrfach identisch
// untereinander bei Meals mit mehreren offenen Sub-Rezept-WOs — siehe AtRiskWo
// oben in dailyBriefingLogic.ts).

function AtRiskWosSection({ items, onWoClick }: { items: AtRiskWo[]; onWoClick: () => void }) {
  if (items.length === 0) return <p className="text-sm text-emerald-600">Keine gefährdeten WOs erkannt.</p>;
  return (
    <div className="space-y-1.5">
      {items.map(w => (
        <div key={w.recipeCode} className={`rounded-lg border p-2.5 ${w.isToday ? "border-rose-200 bg-rose-50" : "border-violet-200 bg-violet-50"}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge label={w.dayLabel} bg={w.isToday ? "bg-rose-600" : "bg-violet-600"} text="text-white" />
            <span className="font-mono text-[10px] text-slate-400">{w.recipeCode}</span>
            <span className="text-sm font-medium">{w.recipeName}</span>
            <span onClick={onWoClick} className="text-xs font-mono text-blue-600 hover:underline cursor-pointer" title={w.woNumbers.join(", ")}>
              {w.woNumbers.length} WO{w.woNumbers.length !== 1 ? "s" : ""} ({w.woNumbers.slice(0, 3).join(", ")}{w.woNumbers.length > 3 ? " …" : ""})
            </span>
            <span className="ml-auto text-[10px] font-mono text-slate-500">{fmtNum(w.cookedPortions)}/{fmtNum(w.targetPortions)} Port.</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {w.reasons.map((r, i) => <TruncatedText key={i} text={r} className="text-xs text-slate-600" />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Was soll geplaitet werden ────────────────────────────────────────────────

function PlatingTodoSection({ items }: { items: PlatingTodoItem[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">Nichts wartet aufs Plaitieren.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
          <th className="text-left py-1.5 pr-2">Meal</th><th className="text-left py-1.5 pr-1">Tag</th>
          <th className="text-right py-1.5 pr-2">Jetzt plaitierbar</th>
          <th className="text-right py-1.5 pr-2">Schon plaitiert</th>
          <th className="text-right py-1.5">Brutto produziert</th>
        </tr></thead>
        <tbody>{items.map(p => {
          const ds = DAY_SCOPE_STYLE[p.dayScope];
          return (
            <tr key={p.recipeCode} className="border-b border-slate-50">
              <td className="py-1.5 pr-2"><span className="font-mono text-[10px] text-slate-400 mr-1">{p.recipeCode}</span><span className="text-xs">{p.recipeName}</span></td>
              <td className="py-1.5 pr-1"><Badge label={ds.label} bg={ds.bg} text={ds.text} /></td>
              <td className="py-1.5 pr-2 text-right font-mono text-sm font-bold text-emerald-700">{fmtNum(p.netMeals)}</td>
              <td className="py-1.5 pr-2 text-right font-mono text-xs text-slate-500">{fmtNum(p.platedMeals)}</td>
              <td className="py-1.5 text-right font-mono text-xs text-slate-500">{fmtNum(p.grossMeals)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

// ── Morgen zuerst anfassen ───────────────────────────────────────────────────

function TomorrowPrioritySection({ items, onWoClick }: { items: TomorrowPriorityWo[]; onWoClick: () => void }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">Für morgen liegt nichts vor.</p>;
  return (
    <ol className="space-y-1.5">
      {items.map((p, i) => (
        <li key={p.woNumber} className="flex items-start gap-2 text-xs rounded px-2 py-1.5 border border-slate-100">
          <span className="font-mono font-bold text-slate-400 w-5 shrink-0">{i + 1}.</span>
          <div className="flex-1 min-w-0">
            <span onClick={onWoClick} className="font-mono font-bold text-blue-600 hover:underline cursor-pointer mr-1">WO {p.woNumber}</span>
            <span className="font-mono text-[10px] text-slate-400 mr-1">{p.recipeCode}</span>
            <span className="font-bold">{p.recipeName}</span>
            <span className="text-slate-400"> ({p.subRecipeName})</span>
            <p className="text-slate-600 mt-0.5">{p.reason}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ── Besetzungs-Schätzung ─────────────────────────────────────────────────────
// Grobe Faustregel (Marcel): Sub-Rezepte, die gerade in Arbeit sind, + 1
// Lead/Springer — je Seite der Halle. Kein Schichtplan, deshalb explizit als
// Schätzung markiert.
function StaffingNote({ staffing }: { staffing: StaffingEstimate }) {
  if (staffing.kitchen === 0 && staffing.plating === 0) return null;
  const kitchenLabel = staffing.kitchenSource === "plan"
    ? "MA Küche (lt. Staffing-Plan-Sheet)"
    : `MA Küche (Schätzung: ${staffing.kitchenComponents} Sub-Rezepte + 1)`;
  return (
    <div className="card px-4 py-2.5 flex items-center gap-4 flex-wrap text-sm">
      <span className="text-[10px] font-bold uppercase text-slate-400">Besetzung</span>
      <span><span className="font-mono font-bold text-slate-700">{staffing.kitchen || "–"}</span> <span className="text-slate-400 text-xs">{kitchenLabel}</span></span>
      <span><span className="font-mono font-bold text-slate-700">{staffing.plating || "–"}</span> <span className="text-slate-400 text-xs">MA Plating (Schätzung: {staffing.platingComponents} Sub-Rezepte + 1)</span></span>
    </div>
  );
}

// ── KET Day Groups (clickable WOs) ──────────────────────────────────────────

function KetDaySection({ days, onWoClick }: { days: KetDayGroup[]; onWoClick: () => void }) {
  const [showFertig, setShowFertig] = useState(false);
  if (days.length === 0) return <p className="text-sm text-slate-400">Keine KET-Daten geladen.</p>;
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => setShowFertig(!showFertig)}
        className={`text-[11px] px-2 py-1 rounded font-medium ${showFertig ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
        {showFertig ? "Fertige ausblenden" : "Fertige einblenden"}
      </button>
      {days.map(day => {
        const visible = showFertig ? day.rows : day.rows.filter(r => r.location !== "Fertig");
        const fertig = day.rows.filter(r => r.location === "Fertig").length;
        const offen = day.rows.length - fertig;
        return (
          <div key={`${day.date}-${day.shift}`}>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-200">
              <span className={`text-sm font-bold ${day.isToday ? "text-blue-700" : day.isTomorrow ? "text-violet-700" : "text-slate-600"}`}>{day.dateLabel}</span>
              <span className="text-[10px] text-emerald-600 font-mono">{fertig} fertig</span>
              {offen > 0 && <span className="text-[10px] text-amber-600 font-mono">{offen} offen</span>}
              <span className={`text-[10px] font-mono font-bold ml-auto ${pctColor(day.cookedPct)}`}>{day.cookedPct}% ({fmtNum(day.totalCooked)}/{fmtNum(day.totalTarget)} Port.)</span>
            </div>
            {visible.length > 0 ? (
              <table className="w-full text-sm mb-1">
                <thead><tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                  <th className="text-left py-0.5 pr-1">Standort</th>
                  <th className="text-left py-0.5 pr-2">WO</th>
                  <th className="text-left py-0.5 pr-2">Rezept</th>
                  <th className="text-left py-0.5 pr-2">Sub</th>
                  <th className="text-right py-0.5 pr-2">Ziel</th>
                  <th className="text-right py-0.5 pr-2">Gekocht</th>
                  <th className="text-right py-0.5 pr-1">%</th>
                  <th className="w-14"></th>
                </tr></thead>
                <tbody>{visible.map((wo, i) => {
                  const ls = LOC_STYLE[wo.location];
                  return (
                    <tr key={`${wo.woNumber}-${wo.subRecipeName}-${i}`} className="border-b border-slate-50 hover:bg-blue-50/40 cursor-pointer" onClick={onWoClick} title="KET Plan / WO oeffnen">
                      <td className="py-0.5 pr-1"><Badge label={wo.location} bg={ls.bg} text={ls.text} /></td>
                      <td className="py-0.5 pr-2 font-mono text-xs font-bold text-blue-600 hover:underline">{wo.woNumber}</td>
                      <td className="py-0.5 pr-2 text-xs truncate max-w-[100px]" title={wo.recipeName}>
                        <span className="text-slate-400 font-mono text-[10px] mr-0.5">{wo.recipeCode}</span>{wo.recipeName}
                      </td>
                      <td className="py-0.5 pr-2 text-xs text-slate-500 truncate max-w-[90px]" title={wo.subRecipeName}>{wo.subRecipeName}</td>
                      <td className="py-0.5 pr-2 text-right font-mono text-xs">{fmtNum(wo.targetPortions)}</td>
                      <td className={`py-0.5 pr-2 text-right font-mono text-xs font-bold ${wo.cookedPortions > 0 ? pctColor(wo.cookedPct) : "text-slate-400"}`}>
                        {wo.cookedPortions > 0 ? fmtNum(wo.cookedPortions) : "-"}
                      </td>
                      <td className={`py-0.5 pr-1 text-right font-mono text-xs font-bold ${pctColor(wo.cookedPct)}`}>{wo.cookedPct.toFixed(0)}%</td>
                      <td className="py-0.5"><div className="h-2 w-full rounded bg-slate-100"><div className={`h-full rounded ${pctBg(wo.cookedPct)}`} style={{ width: `${Math.min(100, wo.cookedPct)}%` }} /></div></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            ) : (
              <p className="text-[10px] text-emerald-600 mb-2">Alle {fertig} WOs fertig</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Meal Plating ────────────────────────────────────────────────────────────

const DAY_SCOPE_STYLE: Record<MealPlatingStatus["dayScope"], { label: string; bg: string; text: string }> = {
  heute: { label: "Heute", bg: "bg-blue-100", text: "text-blue-700" },
  morgen: { label: "Morgen", bg: "bg-violet-100", text: "text-violet-700" },
  beide: { label: "Heute+Morgen", bg: "bg-blue-100", text: "text-blue-700" },
  plating: { label: "Plaitieren", bg: "bg-emerald-100", text: "text-emerald-700" },
  unbekannt: { label: "KET n/v", bg: "bg-slate-100", text: "text-slate-400" },
};

function MealPlatingTable({ meals }: { meals: MealPlatingStatus[] }) {
  if (meals.length === 0) return <p className="text-sm text-slate-400">Keine Meals für heute/morgen.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
          <th className="text-left py-1.5 pr-2">Meal</th><th className="text-left py-1.5 pr-1">Tag</th><th className="text-left py-1.5 pr-1">Ziel</th>
          <th className="text-right py-1.5 pr-2">Geplant</th><th className="text-right py-1.5 pr-2">Geplaitet</th>
          <th className="text-right py-1.5 pr-1">Plating %</th><th className="w-14"></th>
          <th className="text-right py-1.5 pr-2">Prod %</th><th className="text-right py-1.5 pr-2">WOs</th>
          <th className="text-left py-1.5">Engpass</th>
        </tr></thead>
        <tbody>{meals.map(m => {
          const ps = PROD_STYLE[m.producibility] ?? PROD_STYLE.unknown;
          const ds = DAY_SCOPE_STYLE[m.dayScope];
          return (
            <tr key={m.recipeCode} className="border-b border-slate-50">
              <td className="py-1.5 pr-2"><span className="font-mono text-[10px] text-slate-400 mr-1">{m.recipeCode}</span><span className="text-xs truncate max-w-[100px]" title={m.recipeName}>{m.recipeName}</span></td>
              <td className="py-1.5 pr-1"><Badge label={ds.label} bg={ds.bg} text={ds.text} /></td>
              <td className="py-1.5 pr-1"><Badge label={m.producibility} bg={ps.bg} text={ps.text} /></td>
              <td className="py-1.5 pr-2 text-right font-mono text-xs">{fmtNum(m.plannedMeals)}</td>
              <td className={`py-1.5 pr-2 text-right font-mono text-xs font-bold ${m.platedPortions > 0 ? pctColor(m.platingPct) : "text-slate-400"}`}>{m.platedPortions > 0 ? fmtNum(m.platedPortions) : "-"}</td>
              <td className={`py-1.5 pr-1 text-right font-mono text-xs font-bold ${pctColor(m.platingPct)}`}>{m.platingPct.toFixed(0)}%</td>
              <td className="py-1.5"><div className="h-2 w-full rounded bg-slate-100"><div className={`h-full rounded ${pctBg(m.platingPct)}`} style={{ width: `${Math.min(100, m.platingPct)}%` }} /></div></td>
              <td className={`py-1.5 pr-2 text-right font-mono text-xs ${pctColor(m.productionPct)}`}>{m.productionPct.toFixed(0)}%</td>
              <td className="py-1.5 pr-2 text-right font-mono text-xs">{m.completedWOs}/{m.totalWOs}</td>
              <td className="py-1.5 text-xs text-slate-500 truncate max-w-[80px]" title={m.bottleneckSub ?? ""}>{m.bottleneckSub ?? "-"}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

// ── Backfill Watcher ────────────────────────────────────────────────────────

function BackfillSection({ items, alerts }: { items: BackfillWatchItem[]; alerts: BackfillAlert[] }) {
  if (items.length === 0 && alerts.length === 0) return <p className="text-sm text-emerald-600">Kein offener Backfill-Bedarf.</p>;
  return (
    <div className="space-y-2">
      {alerts.slice(0, 5).map((a, i) => (
        <div key={`${a.id}-${i}`} className={`text-xs rounded px-2 py-1.5 ${a.severity === "critical" ? "bg-rose-50 text-rose-700 border border-rose-200" : "bg-amber-50 text-amber-700 border border-amber-200"}`}>
          <span className="font-bold">{a.recipeName}:</span> {a.title}
        </div>
      ))}
      {items.slice(0, 8).map(item => (
        <div key={item.mealCode} className="border border-slate-100 rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium"><span className="font-mono text-xs text-slate-400 mr-1">{item.mealCode}</span>{item.mealName}</span>
            <span className="font-mono text-xs font-bold text-rose-600">-{fmtNum(item.gap)}</span>
          </div>
          {item.openSubs.map((sub, i) => (
            <div key={`${sub.subRecipeName}-${i}`} className="flex items-center gap-2 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
              <span className="truncate flex-1 text-slate-600">{sub.subRecipeName}</span>
              <span className="font-mono text-rose-600 font-bold">min {fmtNum(sub.minimumNeed)}</span>
              <span className="font-mono text-slate-400">empf. {fmtNum(sub.bufferedNeed)}</span>
            </div>
          ))}
        </div>
      ))}
      {items.length > 8 && <p className="text-xs text-slate-400">+ {items.length - 8} weitere</p>}
    </div>
  );
}

// ── PDF-Download ─────────────────────────────────────────────────────────────
// Nutzt denselben Server-Endpunkt wie der KET-Plan-Export (buildPdf in
// ketPdf.ts → POST /api/local-db/generate-pdf, siehe local-db-server.mjs):
// HTML rein, fertige PDF-Datei als Blob zurück. "Kopieren"/"Drucken" gab es
// schon — das hier ist die echte Datei für die 15:30-Runde, bevor es später
// direkt nach Slack geht.
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function buildBriefingHtml(briefing: DailyBriefing, week: string): string {
  const s = briefing.summary;
  const staffing = briefing.staffing;
  const time = fmtTime(briefing.generatedAt);
  const th = 'style="text-align:left;font-size:8px;color:#94a3b8;padding:2px 8px;"';
  const thr = 'style="text-align:right;font-size:8px;color:#94a3b8;padding:2px 8px;"';
  const td = 'style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;"';

  const critRows = briefing.criticalItems.map(c => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;font-weight:800;color:${c.severity === "critical" ? "#be123c" : "#b45309"};white-space:nowrap;">${c.severity === "critical" ? "KRITISCH" : "WARNUNG"}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;color:#64748b;white-space:nowrap;">${escHtml(c.sourceLabel)}${c.dayScope === "morgen" ? " (morgen)" : ""}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;font-weight:700;white-space:nowrap;">${escHtml(c.recipeCode)} ${escHtml(c.recipeName)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;color:#475569;">${escHtml(c.message)}</td>
    </tr>`).join("");

  const atRiskRows = briefing.atRiskWos.map(w => `
    <tr>
      <td ${td} font-weight:700;>${escHtml(w.dayLabel)}</td>
      <td ${td}>${escHtml(w.recipeCode)} ${escHtml(w.recipeName)}</td>
      <td ${td} font-weight:700;color:#2563eb;>${w.woNumbers.length} WO${w.woNumbers.length !== 1 ? "s" : ""} <span style="font-weight:400;color:#94a3b8;">(${escHtml(w.woNumbers.join(", "))})</span></td>
      <td ${td} text-align:right;>${fmtNum(w.cookedPortions)}/${fmtNum(w.targetPortions)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;color:#475569;">${w.reasons.map(escHtml).join("<br>")}</td>
    </tr>`).join("");

  const dayRows = briefing.ketDays.map(d => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;font-weight:700;">${escHtml(d.dateLabel)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;text-align:right;">${d.rows.length}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;text-align:right;">${d.rows.filter(r => r.location === "Fertig").length}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;text-align:right;font-weight:700;">${d.cookedPct}%</td>
    </tr>`).join("");

  // "Was heute noch produziert werden muss" — WO-Level, nur offene (nicht
  // Fertig). Zweischicht-Modell: beide heutigen Schicht-Gruppen einsammeln
  // (nicht nur die erste per find()) und wieder nach Standort sortieren, damit
  // der Standort-Dedup unten (nur bei Wechsel anzeigen statt jede Zeile) über
  // beide Schichten hinweg sauber bleibt.
  const LOC_ORDER_PDF: Record<string, number> = { Warte: 0, Staging: 1, Kitchen: 2, "Post-Blast": 3, Fertig: 4, unbekannt: 5 };
  const todayRowsAll = briefing.ketDays.filter(d => d.isToday).flatMap(d => d.rows);
  const openTodayRows = todayRowsAll
    .filter(r => r.location !== "Fertig")
    .sort((a, b) => (LOC_ORDER_PDF[a.location] ?? 5) - (LOC_ORDER_PDF[b.location] ?? 5) || (a.shift || "").localeCompare(b.shift || "") || a.woNumber.localeCompare(b.woNumber));
  const tdCompact = 'style="padding:2px 6px;border-bottom:1px solid #f1f5f9;font-size:8px;"';
  let lastLoc = "";
  const openTodayHtml = openTodayRows.map(r => {
    const showLoc = r.location !== lastLoc;
    lastLoc = r.location;
    const shiftTxt = SHIFT_LABEL_SHORT[r.shift] ?? (r.shift || "–");
    return `
    <tr>
      <td ${tdCompact} font-weight:700;color:#64748b;>${showLoc ? escHtml(r.location) : ""}</td>
      <td ${tdCompact} color:#94a3b8;>${escHtml(shiftTxt)}</td>
      <td ${tdCompact} font-weight:700;color:#2563eb;white-space:nowrap;>${escHtml(r.woNumber)}</td>
      <td ${tdCompact}>${escHtml(r.recipeCode)} ${escHtml(r.recipeName)} <span style="color:#94a3b8;">(${escHtml(r.subRecipeName)})</span></td>
      <td ${tdCompact} text-align:right;white-space:nowrap;>${fmtNum(r.cookedPortions)}/${fmtNum(r.targetPortions)}</td>
      <td ${tdCompact} text-align:right;font-weight:700;>${r.cookedPct.toFixed(0)}%</td>
    </tr>`;
  }).join("");

  const platingRows = briefing.platingTodo.map(p => `
    <tr>
      <td ${td} font-weight:700;>${escHtml(p.recipeCode)} ${escHtml(p.recipeName)}</td>
      <td ${td} text-align:right;font-weight:800;color:#047857;>${fmtNum(p.netMeals)}</td>
      <td ${td} text-align:right;color:#64748b;>${fmtNum(p.platedMeals)}</td>
      <td ${td} text-align:right;color:#64748b;>${fmtNum(p.grossMeals)}</td>
    </tr>`).join("");

  const priorityRows = briefing.tomorrowPriority.map((p, i) => `
    <tr>
      <td ${td} font-weight:800;color:#94a3b8;>${i + 1}.</td>
      <td ${td} font-weight:700;color:#2563eb;>WO ${escHtml(p.woNumber)}</td>
      <td ${td}>${escHtml(p.recipeCode)} ${escHtml(p.recipeName)} <span style="color:#94a3b8;">(${escHtml(p.subRecipeName)})</span></td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;color:#475569;">${escHtml(p.reason)}</td>
    </tr>`).join("");

  const backfillRows = briefing.backfillWatch.map(b => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;font-weight:700;">${escHtml(b.mealCode)} ${escHtml(b.mealName)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;color:#475569;">${b.openSubs.map(sub => `${escHtml(sub.subRecipeName)} (min ${fmtNum(sub.minimumNeed)})`).join(", ")}</td>
    </tr>`).join("");

  const section = (title: string, bodyHtml: string, emptyText: string) => `
    <h2 style="font-size:12px;margin:16px 0 6px 0;">${title}</h2>
    ${bodyHtml || `<p style="font-size:10px;color:#94a3b8;margin:0;">${emptyText}</p>`}`;

  return `
  <div style="font-family:Arial,sans-serif;color:#1e293b;padding:20px;max-width:760px;">
    <h1 style="font-size:16px;margin:0 0 2px 0;">Tagesbriefing &middot; ${escHtml(week)}</h1>
    <p style="font-size:10px;color:#64748b;margin:0 0 16px 0;">Stand ${time} &middot; Fokus: Heute + Morgen &middot; ${briefing.ketDays.reduce((n, d) => n + d.rows.length, 0)} KET-Zeilen</p>

    <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      ${[
        ["Kritisch", String(s.criticalCount)],
        ["Heute", `${s.todayCookedPct}%`],
        ["Plating", `${s.platingPct}%`],
        ["Planungsziel", `${s.mealsReady}/${s.totalMeals}`],
        ["Produktion", `${s.productionPct}%`],
        ["Backfill", String(s.backfillMeals)],
      ].map(([label, val]) => `
        <div style="border:1px solid #e2e8f0;border-radius:6px;padding:6px 10px;min-width:80px;">
          <div style="font-size:8px;font-weight:800;text-transform:uppercase;color:#94a3b8;">${label}</div>
          <div style="font-size:14px;font-weight:800;">${val}</div>
        </div>`).join("")}
    </div>
    ${staffing.kitchen > 0 || staffing.plating > 0 ? `
    <p style="font-size:9px;color:#64748b;margin:0 0 8px 0;">Besetzung: Küche ${staffing.kitchen} MA (${staffing.kitchenSource === "plan" ? "lt. Staffing-Plan-Sheet" : `Schätzung: ${staffing.kitchenComponents} Sub-Rezepte + 1`}) &middot; Plating ~${staffing.plating} MA (Schätzung: ${staffing.platingComponents} Sub-Rezepte + 1)</p>` : ""}

    ${section(`Kritisch (${briefing.criticalItems.length})`,
      critRows ? `<table style="width:100%;border-collapse:collapse;"><tbody>${critRows}</tbody></table>` : "",
      "Keine kritischen Meldungen.")}

    ${section(`Gefährdete WOs (${briefing.atRiskWos.length})`,
      atRiskRows ? `<table style="width:100%;border-collapse:collapse;"><tbody>${atRiskRows}</tbody></table>` : "",
      "Keine gefährdeten WOs erkannt.")}

    <h2 style="font-size:12px;margin:16px 0 6px 0;">WOs nach Tag</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th ${th}>Tag</th><th ${thr}>WOs</th><th ${thr}>Fertig</th><th ${thr}>%</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table>

    ${section(`Heute noch offen (${openTodayRows.length}/${todayRowsAll.length} WOs)`,
      openTodayHtml ? `<table style="width:100%;border-collapse:collapse;"><thead><tr><th ${th}>Standort</th><th ${th}>Schicht</th><th ${th}>WO</th><th ${th}>Rezept</th><th ${thr}>Gekocht/Ziel</th><th ${thr}>%</th></tr></thead><tbody>${openTodayHtml}</tbody></table>` : "",
      "Alle WOs von heute sind fertig.")}

    ${section(`Was soll geplaitet werden (${briefing.platingTodo.length})`,
      platingRows ? `<table style="width:100%;border-collapse:collapse;"><thead><tr><th ${th}>Meal</th><th ${thr}>Jetzt plaitierbar</th><th ${thr}>Schon plaitiert</th><th ${thr}>Brutto</th></tr></thead><tbody>${platingRows}</tbody></table>` : "",
      "Nichts wartet aufs Plaitieren.")}

    ${section("Morgen zuerst anfassen",
      priorityRows ? `<table style="width:100%;border-collapse:collapse;"><tbody>${priorityRows}</tbody></table>` : "",
      "Für morgen liegt nichts vor.")}

    ${backfillRows ? section("Backfill-Details", `<table style="width:100%;border-collapse:collapse;"><tbody>${backfillRows}</tbody></table>`, "") : ""}
  </div>`;
}

// ── Excel/CSV-Download ───────────────────────────────────────────────────────
// "Excel für Auswertungen — gerne alles" (Marcel): anders als das PDF (fürs
// Lesen in der Runde) ist das hier für Pivot/Filter in Excel gedacht — jede
// Sektion als eigenes, flaches Tabellenblatt. Läuft komplett im Browser (kein
// Server-Roundtrip nötig wie bei der PDF), SheetJS ist schon Projekt-Dependency.
function buildBriefingWorkbook(briefing: DailyBriefing): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const addSheet = (name: string, rows: (string | number)[][]) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31)); // Excel-Limit: 31 Zeichen
  };

  addSheet("Kritisch", [
    ["Schwere", "Quelle", "Tag", "RecipeCode", "Meal", "Meldung"],
    ...briefing.criticalItems.map(c => [c.severity, c.sourceLabel, c.dayScope, c.recipeCode, c.recipeName, c.message]),
  ]);

  addSheet("Gefaehrdete WOs", [
    ["Tag", "RecipeCode", "Meal", "Anzahl WOs", "WOs", "Gekocht", "Ziel", "Gruende"],
    ...briefing.atRiskWos.map(w => [w.dayLabel, w.recipeCode, w.recipeName, w.woNumbers.length, w.woNumbers.join(", "), w.cookedPortions, w.targetPortions, w.reasons.join(" | ")]),
  ]);

  const woRows: (string | number)[][] = [["Tag", "WO", "RecipeCode", "Meal", "Sub-Rezept", "Schicht", "Standort", "Ziel", "Gekocht", "%"]];
  for (const day of briefing.ketDays) {
    const dayLabel = day.isToday ? "Heute" : "Morgen";
    for (const r of day.rows) woRows.push([dayLabel, r.woNumber, r.recipeCode, r.recipeName, r.subRecipeName, r.shift, r.location, r.targetPortions, r.cookedPortions, Math.round(r.cookedPct)]);
  }
  addSheet("WOs", woRows);

  addSheet("Meals", [
    ["RecipeCode", "Meal", "Tag", "Producibility", "Geplant", "Geplaitet", "Plating %", "Produktion %", "WOs fertig", "WOs gesamt", "Engpass"],
    ...briefing.mealPlating.map(m => [m.recipeCode, m.recipeName, m.dayScope, m.producibility, m.plannedMeals, m.platedPortions, Math.round(m.platingPct), Math.round(m.productionPct), m.completedWOs, m.totalWOs, m.bottleneckSub ?? ""]),
  ]);

  addSheet("Zu plaitieren", [
    ["RecipeCode", "Meal", "Tag", "Jetzt plaitierbar", "Schon plaitiert", "Brutto produziert"],
    ...briefing.platingTodo.map(p => [p.recipeCode, p.recipeName, p.dayScope, p.netMeals, p.platedMeals, p.grossMeals]),
  ]);

  addSheet("Morgen zuerst", [
    ["WO", "RecipeCode", "Meal", "Sub-Rezept", "Ziel", "Grund"],
    ...briefing.tomorrowPriority.map(p => [p.woNumber, p.recipeCode, p.recipeName, p.subRecipeName, p.targetPortions, p.reason]),
  ]);

  const backfillRows: (string | number)[][] = [["MealCode", "Meal", "Sub-Rezept", "Min. Bedarf", "Empfohlen (Puffer)"]];
  for (const b of briefing.backfillWatch) for (const sub of b.openSubs) backfillRows.push([b.mealCode, b.mealName, sub.subRecipeName, sub.minimumNeed, sub.bufferedNeed]);
  addSheet("Backfill", backfillRows);

  return wb;
}

// ── Main view ───────────────────────────────────────────────────────────────

export function DailyBriefingView({ data }: { data: DataBundle }) {
  const { setView } = useAppState();
  const backfillsCtx = useBackfillsOptional();
  const woRecon = useWoReconciliation();
  const recipeWeights = woRecon?.recipeWeights ?? null;
  const week = currentHfWeek();
  const weekNum = weekNumFromHfWeek(week);
  const { plaitedByCode } = useCombinedPlaited(weekNum);
  const csvRows = useSharedKetCsvRows();
  const { ketRows } = useKetRowsData(data, week, csvRows);

  const weighing = useTransparencyWeighing();
  const flow = useTransparencyFlow();
  const planCheck = useTransparencyPlanningCheck();
  const rtem = useTransparencyRtem();
  const producibility = useMemo(() => {
    if (!flow.data || !weighing.data) return null;
    return computeTransparencyProducibility(flow.data, weighing.data, rtem.data, planCheck.data, weekNum);
  }, [flow.data, weighing.data, rtem.data, planCheck.data, weekNum]);
  const staffingPlan = useStaffingPlanMonitor(week);

  const [copied, setCopied] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const briefing = useMemo<DailyBriefing>(() => buildDailyBriefing({
    data,
    meals: backfillsCtx?.meals ?? [],
    rtiMeals: backfillsCtx?.rtiMeals ?? [],
    alerts: backfillsCtx?.alerts ?? [],
    ketRows,
    plaitedByCode,
    producibility,
    week,
    combined: backfillsCtx?.combined ?? [],
    feasibilityByMeal: backfillsCtx?.feasibilityByMeal,
    recipeWeights,
    kitchenHeadcountFromPlan: staffingPlan.data?.kitchenHeadcount,
  }), [data, backfillsCtx?.meals, backfillsCtx?.rtiMeals, backfillsCtx?.alerts, backfillsCtx?.combined, backfillsCtx?.feasibilityByMeal, recipeWeights, staffingPlan.data, ketRows, plaitedByCode, producibility, week]);

  const s = briefing.summary;
  const handleCopy = () => { navigator.clipboard.writeText(briefing.copyText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  const goToWo = () => setView("wo");

  const postblastOn = backfillsCtx?.postblastConnected ?? false;
  const rtiOn = backfillsCtx?.rtiConnected ?? false;
  const lpOn = backfillsCtx?.linePlaitingConnected ?? false;
  // feasibilityByMeal (Rohware-Check je Backfill) bleibt eine leere Map, solange
  // kein lokaler WMS-Server den Vollbestand liefert (siehe backfillFeasibility.ts)
  // — als eigener Punkt sichtbar, sonst wirkt ein fehlender "Rohware"-Kritisch-
  // Eintrag wie "alles verfügbar" statt "ungeprüft".
  const invOn = backfillsCtx?.fullInventoryConnected ?? false;
  // Die 4 mealPlating-KPIs (Plating/Planungsziel/Produktion) hängen komplett an
  // backfillsCtx.meals, das ohne Postblast-Verbindung leer bleibt (siehe
  // matchPostblastToWorkOrders in postblastMatch.ts). Backfill hängt an RTI. Ohne
  // diese Unterscheidung zeigten die Kacheln irreführend "0%"/"0/0" statt ehrlich
  // "nicht verbunden" — das war der gemeldete "leere Pillen"-Eindruck.
  const platingDataOn = postblastOn;
  const backfillDataOn = rtiOn;
  const ketDataOn = ketRows.length > 0;
  const anyDataOn = platingDataOn || backfillDataOn || lpOn || ketDataOn || !!flow.data;

  const handleDownloadPdf = async () => {
    setPdfBusy(true);
    setPdfError(null);
    let url: string | null = null;
    try {
      const html = buildBriefingHtml(briefing, week);
      const filename = `${sanitizeFilename(`Tagesbriefing_${week}_${new Date().toISOString().slice(0, 10)}`)}.pdf`;
      const resp = await fetch("/api/local-db/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, filename }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` })) as { error?: string };
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      console.error("[DailyBriefing] PDF-Download fehlgeschlagen:", error);
      setPdfError(error instanceof Error ? error.message : String(error));
    } finally {
      if (url) URL.revokeObjectURL(url);
      setPdfBusy(false);
    }
  };

  const filenameBase = () => sanitizeFilename(`Tagesbriefing_${week}_${new Date().toISOString().slice(0, 10)}`);
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const handleDownloadExcel = () => {
    XLSX.writeFile(buildBriefingWorkbook(briefing), `${filenameBase()}.xlsx`);
  };
  const handleDownloadCsv = () => {
    // "Der CSV" (Marcel) — die eine flache WO-Tabelle (heute+morgen), am
    // brauchbarsten für Pivots; die anderen Sektionen gibt's vollständig im Excel.
    const ws = buildBriefingWorkbook(briefing).Sheets["WOs"];
    downloadBlob(new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv;charset=utf-8;" }), `${filenameBase()}_WOs.csv`);
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Tagesbriefing &middot; 15:30</h2>
            <p className="text-xs text-slate-400 mt-0.5">{week} &middot; Stand {fmtTime(briefing.generatedAt)} &middot; Fokus: Heute + Morgen &middot; {ketRows.length} KET-Zeilen</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <SourceDot label="Postblast" on={postblastOn} />
            <SourceDot label="RTI" on={rtiOn} />
            <SourceDot label="LinePlaiting" on={lpOn} />
            <SourceDot label="Transparency" on={!!flow.data} />
            <SourceDot label="Lager" on={invOn} />
            <SourceDot label="Staffing-Plan" on={staffingPlan.data?.kitchenHeadcount != null} />
            <button type="button" onClick={handleCopy} className={`text-xs px-2 py-1 rounded border ml-1 ${copied ? "border-emerald-300 text-emerald-600 bg-emerald-50" : "border-slate-200 text-slate-400 hover:text-slate-600"}`}>{copied ? "Kopiert!" : "Kopieren"}</button>
            <button type="button" onClick={() => window.print()} className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded border border-slate-200">Drucken</button>
            <button type="button" onClick={handleDownloadPdf} disabled={pdfBusy} className="text-xs px-2 py-1 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-40 font-medium">{pdfBusy ? "Erzeuge PDF …" : "PDF-Download"}</button>
            <button type="button" onClick={handleDownloadExcel} className="text-xs px-2 py-1 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 font-medium">Excel</button>
            <button type="button" onClick={handleDownloadCsv} className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 font-medium">CSV</button>
          </div>
        </div>
        {pdfError && <p className="text-xs text-rose-600 mt-2">PDF fehlgeschlagen: {pdfError}</p>}
      </div>

      <CriticalSection items={briefing.criticalItems} dataConnected={anyDataOn} />
      <StaffingNote staffing={briefing.staffing} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        <Kpi label="Kritisch" value={anyDataOn ? s.criticalCount : "–"} sub={!anyDataOn ? "keine Daten" : s.criticalCount > 0 ? "siehe oben" : "alles ok"} tone={!anyDataOn ? "slate" : s.criticalCount > 0 ? "rose" : "green"} />
        <Kpi label="Küche heute" value={ketDataOn ? `${s.todayCookedPct}%` : "–"} sub={ketDataOn ? `${s.todayWos} WOs lt. KET-Plan` : "kein KET-Plan"} tone={!ketDataOn ? "slate" : s.todayCookedPct >= 80 ? "green" : s.todayCookedPct >= 40 ? "amber" : "rose"} />
        <Kpi label="Plating" value={platingDataOn ? `${s.platingPct}%` : "–"} sub={platingDataOn ? `${fmtNum(s.totalPlated)}/${fmtNum(s.totalPlannedPortions)} Port. verpackt` : "Postblast offline"} tone={!platingDataOn ? "slate" : s.platingPct >= 90 ? "green" : s.platingPct >= 50 ? "amber" : "rose"} />
        <Kpi label="Planungsziel" value={platingDataOn ? `${s.mealsReady}/${s.totalMeals}` : "–"} sub={platingDataOn ? (s.mealsBlocked > 0 ? `${s.mealsBlocked} blocked` : "Meals ready") : "Postblast offline"} tone={!platingDataOn ? "slate" : s.mealsBlocked > 0 ? "rose" : "green"} />
        <Kpi label="Produktion (Küche)" value={platingDataOn ? `${s.productionPct}%` : "–"} sub={platingDataOn ? "Ø je Meal, schwächste Zutat" : "Postblast offline"} tone={!platingDataOn ? "slate" : s.productionPct >= 80 ? "green" : s.productionPct >= 40 ? "amber" : "rose"} />
        <Kpi label="Backfill" value={backfillDataOn ? `${fmtNum(s.totalBackfillPortions)} Port.` : "–"} sub={backfillDataOn ? `${s.backfillMeals} Meal${s.backfillMeals !== 1 ? "s" : ""} offen` : "RTI offline"} tone={!backfillDataOn ? "slate" : s.backfillMeals > 0 ? "rose" : "green"} />
        <Kpi label="Morgen" value={ketDataOn ? s.tomorrowWos : "–"} sub={ketDataOn ? "WOs geplant" : "kein KET-Plan"} tone="slate" />
      </div>

      <Section title="Gefährdete WOs — heute & morgen" count={briefing.atRiskWos.length}>
        <AtRiskWosSection items={briefing.atRiskWos} onWoClick={goToWo} />
      </Section>

      <Section title="WOs nach Tag — Standort & Status" count={ketRows.length}>
        <KetDaySection days={briefing.ketDays} onWoClick={goToWo} />
      </Section>

      <Section title="Was soll geplaitet werden" count={briefing.platingTodo.length}>
        <PlatingTodoSection items={briefing.platingTodo} />
      </Section>

      <Section title="Meals — Geplant vs. Geplaitet (Heute + Morgen)" count={s.totalMeals}>
        <MealPlatingTable meals={briefing.mealPlating} />
      </Section>

      <Section title="Morgen zuerst anfassen" count={briefing.tomorrowPriority.length}>
        <TomorrowPrioritySection items={briefing.tomorrowPriority} onWoClick={goToWo} />
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section title="Backfill-Waechter" count={briefing.backfillWatch.length}>
          <BackfillSection items={briefing.backfillWatch} alerts={briefing.backfillAlerts} />
        </Section>
        {(briefing.deadlines.length > 0 || briefing.deadlinesTomorrow.length > 0) && (
          <Section title="Deadlines" count={briefing.deadlines.length + briefing.deadlinesTomorrow.length}>
            <div className="space-y-3">
              {briefing.deadlines.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Heute</p>
                  <div className="space-y-1">{briefing.deadlines.map((d, i) => (
                    <div key={`t-${d.activity}-${i}`} className="flex items-center gap-3 text-sm py-1 border-b border-slate-50">
                      <span className="font-mono text-xs font-bold text-blue-600 w-12 shrink-0">{d.time}</span>
                      <span className="flex-1">{d.activity}</span>
                      {d.owner && <span className="text-slate-400 text-xs">{d.owner}</span>}
                    </div>
                  ))}</div>
                </div>
              )}
              {briefing.deadlinesTomorrow.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Morgen</p>
                  <div className="space-y-1">{briefing.deadlinesTomorrow.map((d, i) => (
                    <div key={`m-${d.activity}-${i}`} className="flex items-center gap-3 text-sm py-1 border-b border-slate-50">
                      <span className="font-mono text-xs font-bold text-violet-600 w-12 shrink-0">{d.time}</span>
                      <span className="flex-1">{d.activity}</span>
                      {d.owner && <span className="text-slate-400 text-xs">{d.owner}</span>}
                    </div>
                  ))}</div>
                </div>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
