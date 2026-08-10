// WMS Übersicht – kleine wiederverwendete UI-Bausteine (Badges, Tabellenzellen, Karten-Hülle).
import { useState } from "react";
import type { ReactNode } from "react";
import { STATION_META, STATION_ORDER } from "./wmsTypes";
import type { StationKey } from "./wmsTypes";
import { skuKey } from "./wmsFormat";
import type { LotStationMap, SkuStationMap } from "./wmsIndex";
import { getSkuDisplayLabel, type WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

// ─── UI Primitives ────────────────────────────────────────────────────────────

export function StationBadges({ sku, stationMap, currentStation, onTrace }: {
  sku: string; stationMap: SkuStationMap; currentStation: StationKey; onTrace: (sku: string) => void;
}) {
  const stations = stationMap.get(skuKey(sku));
  if (!stations || stations.size <= 1) return null;
  const others = STATION_ORDER.filter(s => s !== currentStation && stations.has(s));
  if (others.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-0.5 ml-1">
      {others.map(s => {
        const m = STATION_META[s];
        return (
          <button key={s} type="button"
            title={`Trace: ${sku} → ${m.label}`}
            className={`text-[9px] px-1 py-0.5 rounded font-semibold ${m.bgColor} ${m.textColor} border ${m.borderColor} hover:brightness-90 cursor-pointer`}
            onClick={e => { e.stopPropagation(); onTrace(sku); }}
          >
            {m.icon}
          </button>
        );
      })}
    </span>
  );
}

export function LotCrossStations({ lots, lotMap, currentStation }: {
  lots: string[]; lotMap: LotStationMap; currentStation: StationKey;
}) {
  const cross = new Set<StationKey>();
  for (const lot of lots) {
    const stns = lotMap.get(lot);
    if (stns) for (const s of stns) if (s !== currentStation) cross.add(s);
  }
  if (cross.size === 0) return null;
  return (
    <span className="inline-flex gap-0.5">
      {STATION_ORDER.filter(s => cross.has(s)).map(s => {
        const m = STATION_META[s];
        return (
          <span key={s} title={`Los auch in: ${m.label}`} className={`text-[9px] px-1 py-0.5 rounded ${m.bgColor} ${m.textColor} border ${m.borderColor}`}>
            {m.icon}
          </span>
        );
      })}
    </span>
  );
}

export function SkuLabel({ sku, skuInfoIndex }: { sku: string; skuInfoIndex: Map<string, WmsSkuInfo> }) {
  const label = getSkuDisplayLabel(sku, skuInfoIndex);
  const isFallback = label === skuKey(sku) || label === "–";
  return (
    <div className="leading-tight">
      <div className={`font-medium ${isFallback ? "text-slate-700" : "text-slate-800"}`}>{label}</div>
      {sku && sku !== label && (
        <div className={`text-[10px] font-mono ${isFallback ? "text-slate-400" : "text-slate-500"}`}>{sku}</div>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    ["AVAILABLE","RECEIVED","ACTIVE"].includes(status) ? "bg-emerald-100 text-emerald-700" :
    status === "CLOSED"  ? "bg-slate-100 text-slate-500"  :
    status === "HOLD"    ? "bg-amber-100 text-amber-700"  :
    status === "DAMAGED" ? "bg-rose-100 text-rose-700"    :
    "bg-slate-100 text-slate-600";
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{status || "–"}</span>;
}

export function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return (
    <th className={`px-2 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap bg-slate-50 sticky top-0 ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

export function Td({ children, right, mono, cls, title }: { children?: ReactNode; right?: boolean; mono?: boolean; cls?: string; title?: string }) {
  return (
    <td title={title} className={`px-2 py-1.5 text-xs whitespace-nowrap ${right ? "text-right" : ""} ${mono ? "font-mono" : ""} ${cls ?? "text-slate-700"}`}>
      {children}
    </td>
  );
}

export function SectionCard({ stationKey, totalCount, filteredCount, children, defaultOpen = true }: {
  stationKey: StationKey; totalCount: number; filteredCount?: number; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const m = STATION_META[stationKey];
  const isFiltered = filteredCount !== undefined && filteredCount !== totalCount;

  return (
    <div className={`rounded-xl border ${m.borderColor} overflow-hidden shadow-sm`}>
      <button
        type="button"
        className={`w-full flex items-center justify-between px-4 py-3 ${m.bgColor} hover:brightness-95 transition-all`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">{m.icon}</span>
          <span className={`font-bold text-sm ${m.textColor}`}>{m.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {isFiltered ? (
            <span className="text-xs font-mono font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
              {filteredCount} / {totalCount.toLocaleString("de-DE")} SKUs
            </span>
          ) : (
            <span className={`text-xs font-mono font-semibold ${m.textColor} bg-white/60 px-2 py-0.5 rounded-full`}>
              {totalCount.toLocaleString("de-DE")} SKUs
            </span>
          )}
          <span className={`text-xs ${m.textColor}`}>{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && <div className="bg-white">{children}</div>}
    </div>
  );
}

export function ShowMoreBar({ total, shown, expanded, onExpand, onCollapse }: {
  total: number; shown: number; expanded: boolean; onExpand: () => void; onCollapse: () => void;
}) {
  if (total <= shown && !expanded) return null;
  return (
    <div className="px-4 py-2 border-t border-slate-100 text-center">
      {expanded
        ? <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={onCollapse}>▲ Weniger anzeigen</button>
        : <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={onExpand}>▼ Alle {total.toLocaleString("de-DE")} anzeigen</button>
      }
    </div>
  );
}

