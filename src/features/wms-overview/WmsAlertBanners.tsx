// WMS Übersicht – WO-Badge (Stationstabellen) sowie MHD-/Yield-Warnbanner.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AggSleevingRow, AggStoredRow } from "./wmsTypes";
import { daysUntil, fmtDate, fmtQty } from "./wmsFormat";
import type { SkuBilanzEntry } from "./wmsAggregate";

// ─── WO Badge (for station tables) ──────────────────────────────────────────

export function WoBadge({ itemNumber, itemToWoMap, onWoDetail }: {
  itemNumber: string; itemToWoMap: Map<string, Set<string>>; onWoDetail: (wo: string) => void;
}) {
  const wos = itemToWoMap.get(itemNumber.toUpperCase());
  if (!wos || wos.size === 0) return null;
  const woList = [...wos];
  return (
    <span className="inline-flex flex-wrap gap-0.5 ml-1">
      {woList.slice(0, 3).map(wo => (
        <button key={wo} type="button" onClick={e => { e.stopPropagation(); onWoDetail(wo); }}
          className="px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-mono font-semibold hover:bg-violet-100 cursor-pointer">
          {wo}
        </button>
      ))}
      {woList.length > 3 && <span className="text-[9px] text-slate-400">+{woList.length - 3}</span>}
    </span>
  );
}

// ─── MHD Alert Banner ─────────────────────────────────────────────────────────

export function MhdAlertBanner({ allStored }: { allStored: AggStoredRow[] }) {
  const [dismissed, setDismissed] = useState(false);

  const withDays = allStored
    .filter(r => r.firstExpiry)
    .map(r => ({ ...r, days: daysUntil(r.firstExpiry!) }));

  const critical = withDays.filter(r => r.days >= 0 && r.days < 3).sort((a, b) => a.days - b.days);
  const warning  = withDays.filter(r => r.days >= 3 && r.days < 7).sort((a, b) => a.days - b.days);
  const total    = critical.length + warning.length;

  if (total === 0 || dismissed) return null;

  const Item = ({ r, cls, borderCls }: { r: typeof critical[0]; cls: string; borderCls: string }) => (
    <div className={`flex items-center gap-1.5 bg-white border ${borderCls} rounded-lg px-2 py-1`}>
      <span className={`font-mono text-xs font-semibold ${cls}`}>{r.sku}</span>
      <span className="text-[10px] text-slate-400">{r.location}</span>
      <span className={`text-[10px] font-bold ${cls}`}>{fmtDate(r.firstExpiry)}</span>
      <span className={`text-[9px] font-mono ${cls}`}>{r.days === 0 ? "heute" : `${r.days}T`}</span>
    </div>
  );

  return (
    <div className="rounded-xl border-2 border-rose-400 bg-rose-50 px-4 py-3 shadow-md space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚨</span>
          <span className="font-bold text-rose-800 text-sm">
            MHD-Alarm: {critical.length > 0 && <span className="text-rose-700">{critical.length} kritisch (0–2 Tage)</span>}
            {critical.length > 0 && warning.length > 0 && <span className="text-rose-400 mx-1">·</span>}
            {warning.length > 0 && <span className="text-amber-700">{warning.length} Warnung (3–6 Tage)</span>}
          </span>
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="text-rose-400 hover:text-rose-700 font-bold text-lg leading-none px-2">✕</button>
      </div>
      {critical.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {critical.slice(0, 15).map(r => <Item key={r.key} r={r} cls="text-rose-800" borderCls="border-rose-300" />)}
          {critical.length > 15 && <span className="text-xs text-rose-600 self-center">+{critical.length - 15}</span>}
        </div>
      )}
      {warning.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {warning.slice(0, 10).map(r => <Item key={r.key} r={r} cls="text-amber-700" borderCls="border-amber-200" />)}
          {warning.length > 10 && <span className="text-xs text-amber-600 self-center">+{warning.length - 10}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Yield Alert Banner ──────────────────────────────────────────────────────

export function YieldAlertBanner({ aggSleeving, bilanz, itemToWoMap }: {
  aggSleeving: AggSleevingRow[];
  bilanz: SkuBilanzEntry[];
  itemToWoMap: Map<string, Set<string>>;
}) {
  const [dismissed, setDismissed] = useState(false);

  const yieldIssues = useMemo(() => {
    const issues: { sku: string; lost: number; rate: number; wos: string[]; type: "sleeving" | "unresolved" }[] = [];
    for (const r of aggSleeving) {
      if (r.lost > 0 && r.eingang > 0) {
        const rate = r.lost / r.eingang;
        if (rate > 0.15 || r.lost > 500) {
          const wos = [...(itemToWoMap.get(r.sku.toUpperCase()) ?? [])];
          issues.push({ sku: r.sku, lost: r.lost, rate, wos, type: "sleeving" });
        }
      }
    }
    for (const e of bilanz) {
      if (e.unresolvedGap > 500 || (e.inboundQty > 0 && e.unresolvedGap / e.inboundQty > 0.15)) {
        const wos = [...(itemToWoMap.get(e.sku.toUpperCase()) ?? [])];
        if (!issues.some(i => i.sku === e.sku)) {
          issues.push({ sku: e.sku, lost: e.unresolvedGap, rate: e.inboundQty > 0 ? e.unresolvedGap / e.inboundQty : 0, wos, type: "unresolved" });
        }
      }
    }
    return issues.sort((a, b) => b.lost - a.lost);
  }, [aggSleeving, bilanz, itemToWoMap]);

  if (yieldIssues.length === 0 || dismissed) return null;

  const totalLost = yieldIssues.reduce((s, i) => s + i.lost, 0);

  return (
    <div className="rounded-xl border-2 border-orange-400 bg-orange-50 px-4 py-3 shadow-md space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">⚠️</span>
          <span className="font-bold text-orange-800 text-sm">
            Yield-Alarm: {yieldIssues.length} SKU{yieldIssues.length > 1 ? "s" : ""} mit massivem Verlust ({fmtQty(totalLost)} Einheiten gesamt)
          </span>
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="text-orange-400 hover:text-orange-700 font-bold text-lg leading-none px-2">✕</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {yieldIssues.slice(0, 12).map(i => (
          <div key={i.sku} className={`flex items-center gap-1.5 bg-white border ${i.type === "sleeving" ? "border-orange-300" : "border-rose-300"} rounded-lg px-2 py-1`}>
            <span className="font-mono text-xs font-semibold text-slate-800">{i.sku}</span>
            <span className={`text-[10px] font-bold ${i.rate > 0.25 ? "text-rose-700" : "text-orange-700"}`}>−{fmtQty(i.lost)}</span>
            <span className="text-[9px] font-mono text-orange-600">({(i.rate * 100).toFixed(0)}%)</span>
            {i.type === "sleeving" && <span className="text-[9px] text-sky-600">Sleev</span>}
            {i.type === "unresolved" && <span className="text-[9px] text-rose-600">Schwund</span>}
            {i.wos.length > 0 && <span className="text-[9px] text-violet-600">WO:{i.wos.slice(0, 2).join(",")}</span>}
          </div>
        ))}
        {yieldIssues.length > 12 && <span className="text-xs text-orange-600 self-center">+{yieldIssues.length - 12}</span>}
      </div>
    </div>
  );
}

// ─── Raw Detail Row ───────────────────────────────────────────────────────────

export function RawDetailRow({ children }: { children: ReactNode }) {
  return (
    <tr className="bg-slate-50/80">
      <td colSpan={99} className="px-6 py-2 border-t border-slate-100">
        {children}
      </td>
    </tr>
  );
}

