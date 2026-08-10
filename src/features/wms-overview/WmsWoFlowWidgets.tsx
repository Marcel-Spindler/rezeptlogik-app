// WMS Übersicht – WO-Stufenkette, Übergangstabelle, Plausibilitäts-/Bereitschafts-Anzeigen.
import React from "react";
import type { ReactNode } from "react";
import { fmtQty } from "./wmsFormat";
import { WO_FLOW_META } from "./wmsWoLogic";
import type { PlausibilityLevel, WoFlowStageKey, WoPlausibilityCheck, WoTransitionAgg } from "./wmsWoLogic";

export function WoStageChain({ stages }: { stages: WoFlowStageKey[] }) {
  if (stages.length === 0) return <span className="text-slate-300">–</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {stages.map((stage, index) => {
        const meta = WO_FLOW_META[stage];
        return (
          <React.Fragment key={stage}>
            {index > 0 && <span className="text-slate-300 text-[10px]">→</span>}
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${meta.className}`}>
              <span>{meta.icon}</span>
              <span>{meta.label}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function WoTransitionTable({ transitions, emptyLabel }: { transitions: WoTransitionAgg[]; emptyLabel: string }) {
  if (transitions.length === 0) return <div className="text-[11px] text-slate-400">{emptyLabel}</div>;
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="bg-slate-50 text-slate-500">
            <th className="px-2 py-1 text-left font-semibold">Von</th>
            <th className="px-2 py-1 text-left font-semibold">Nach</th>
            <th className="px-2 py-1 text-right font-semibold">Menge</th>
            <th className="px-2 py-1 text-right font-semibold">Beweg.</th>
            <th className="px-2 py-1 text-left font-semibold">Items</th>
            <th className="px-2 py-1 text-left font-semibold">Lose</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-2 py-1 font-mono text-slate-700">{row.from || "–"}</td>
              <td className="px-2 py-1 font-mono text-slate-700">{row.to || "–"}</td>
              <td className="px-2 py-1 text-right font-mono font-semibold">{fmtQty(row.totalQty)}</td>
              <td className="px-2 py-1 text-right font-mono text-slate-500">{row.count}</td>
              <td className="px-2 py-1 text-slate-600">{row.items.slice(0, 3).join(", ") || "–"}{row.items.length > 3 ? ` +${row.items.length - 3}` : ""}</td>
              <td className="px-2 py-1 text-slate-600">{row.lots.slice(0, 2).join(", ") || "–"}{row.lots.length > 2 ? ` +${row.lots.length - 2}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export function PlausibilityBadge({ level, children }: { level: PlausibilityLevel; children: ReactNode }) {
  const cls = level === "ok"
    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : level === "warn"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : level === "err"
        ? "bg-rose-100 text-rose-700 border-rose-200"
        : "bg-slate-100 text-slate-500 border-slate-200";
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${cls}`}>{children}</span>;
}

export function WoPlausibilityPanel({ checks }: { checks: WoPlausibilityCheck[] }) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {checks.map((check) => (
        <div key={check.key} className="rounded-lg border border-slate-200 bg-white p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase text-slate-500">{check.label}</div>
            <PlausibilityBadge level={check.level}>{check.level.toUpperCase()}</PlausibilityBadge>
          </div>
          <div className="space-y-1 text-[10px] text-slate-600">
            <div className="flex justify-between gap-2"><span>Plan</span><span className="font-mono">{fmtQty(check.planned)}</span></div>
            <div className="flex justify-between gap-2"><span>Ist</span><span className="font-mono">{fmtQty(check.actual)}</span></div>
            <div className="flex justify-between gap-2"><span>Delta</span><span className={`font-mono ${check.level === "err" ? "text-rose-600" : check.level === "warn" ? "text-amber-600" : "text-slate-700"}`}>{fmtQty(check.delta)}</span></div>
            <div className="flex justify-between gap-2"><span>Abw.</span><span className="font-mono">{check.pct == null ? "–" : `${check.pct.toFixed(1)}%`}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function WoFlowGraph({ transitions }: { transitions: WoTransitionAgg[] }) {
  if (transitions.length === 0) return <div className="text-[11px] text-slate-400">Keine gerichteten Flüsse verfügbar</div>;
  const maxQty = Math.max(1, ...transitions.map((row) => row.totalQty));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      {transitions.map((row, index) => {
        const fromMeta = WO_FLOW_META[row.fromStage];
        const toMeta = WO_FLOW_META[row.toStage];
        const width = Math.max(8, Math.round((row.totalQty / maxQty) * 100));
        const prevQty = index > 0 ? transitions[index - 1].totalQty : null;
        const deltaPct = prevQty && prevQty > 0 ? ((row.totalQty - prevQty) / prevQty) * 100 : null;
        const absDeltaPct = Math.abs(deltaPct ?? 0);
        const breakLevel: PlausibilityLevel = deltaPct == null
          ? "offen"
          : absDeltaPct <= 10
            ? "ok"
            : absDeltaPct <= 25
              ? "warn"
              : "err";
        const trackCls = breakLevel === "err"
          ? "bg-rose-500"
          : breakLevel === "warn"
            ? "bg-amber-500"
            : breakLevel === "ok"
              ? "bg-emerald-500"
              : "bg-violet-500";
        const rowCls = breakLevel === "err"
          ? "border-rose-200 bg-rose-50/40"
          : breakLevel === "warn"
            ? "border-amber-200 bg-amber-50/40"
            : "border-transparent bg-transparent";
        return (
          <div key={row.key} className={`grid gap-2 rounded-lg border p-2 md:grid-cols-[180px_1fr_180px] md:items-center ${rowCls}`}>
            <div className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold ${fromMeta.className}`}>
              <span>{fromMeta.icon}</span><span className="truncate">{row.from || fromMeta.label}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden">
                <div className={`h-full rounded-full ${trackCls}`} style={{ width: `${width}%` }} />
              </div>
              <div className="flex flex-col items-end text-[10px] font-mono text-slate-600 whitespace-nowrap">
                <span>{fmtQty(row.totalQty)} · {row.count}x</span>
                {deltaPct != null && (
                  <span className={breakLevel === "err" ? "text-rose-600" : breakLevel === "warn" ? "text-amber-600" : "text-slate-400"}>
                    Bruch {deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-1">
              {deltaPct != null && breakLevel !== "offen" && <PlausibilityBadge level={breakLevel}>{breakLevel.toUpperCase()}</PlausibilityBadge>}
              <div className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold ${toMeta.className}`}>
                <span>{toMeta.icon}</span><span className="truncate">{row.to || toMeta.label}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


export function ReadinessBadge({ available, inSleeving, total, pct }: { available: number; inSleeving?: number; total: number; pct: number }) {
  if (total === 0) return <span className="text-slate-300 text-xs">–</span>;
  const cls = pct >= 100 ? "bg-emerald-100 text-emerald-700 border-emerald-200"
             : pct >= 60  ? "bg-amber-100 text-amber-700 border-amber-200"
             :               "bg-rose-100 text-rose-700 border-rose-200";
  const icon = pct >= 100 ? "✓" : pct >= 60 ? "△" : "✗";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cls}`}>
      <span>{icon}</span>
      <span className="font-mono">{available}{inSleeving ? `+${inSleeving}🔄` : ""}/{total}</span>
      <span className="opacity-60">{pct}%</span>
    </span>
  );
}

