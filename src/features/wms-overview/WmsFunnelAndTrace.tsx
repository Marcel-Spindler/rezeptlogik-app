// WMS Übersicht – SKU-Funnel-Übersicht und Such-/Trace-Panel.
import { useState } from "react";
import { STATION_META, STATION_ORDER } from "./wmsTypes";
import type { StationKey } from "./wmsTypes";
import { fmtQty } from "./wmsFormat";
import type { FunnelRow, SkuStationMap } from "./wmsIndex";
import { SkuLabel, ShowMoreBar, Td, Th } from "./WmsPrimitives";
import { getSkuDisplayLabel, type WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

export function SkuFunnelSection({ funnel, skuMap, skuInfoIndex, onTrace }: {
  funnel: FunnelRow[]; skuMap: SkuStationMap; skuInfoIndex: Map<string, WmsSkuInfo>; onTrace: (sku: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? funnel : funnel.slice(0, 30);
  if (funnel.length === 0) return null;

  const cell = (v: number | null) =>
    v == null
      ? <span className="text-slate-300">–</span>
      : <span className="font-mono text-slate-700">{fmtQty(v)}</span>;

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800 text-white">
        <div className="flex items-center gap-2">
          <span>🔍</span>
          <span className="font-bold text-sm">SKU-Querschnitt durch alle Stationen</span>
          <span className="text-xs text-slate-400">— Zeile anklicken zum Trace</span>
        </div>
        <span className="text-xs font-mono bg-white/20 px-2 py-0.5 rounded-full">{funnel.length} SKUs in ≥2 Stationen</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <Th>SKU</Th>
              <Th right>📦 Inbound</Th>
              <Th right>📋 WO</Th>
              <Th right>🗄️ Staging</Th>
              <Th right>📂 Debox</Th>
              <Th right>❄️ Post-Blast</Th>
              <Th right>🍽️ Plating</Th>
              <Th right>🔄 Sleeving</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const stations = skuMap.get(row.sku);
              return (
                <tr key={row.sku} className="hover:bg-amber-50/60 cursor-pointer" onClick={() => onTrace(row.sku)}>
                  <Td cls="max-w-[260px] whitespace-normal"><SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} /></Td>
                  <Td right>{cell(row.inboundQty)}</Td>
                  <Td right>{cell(row.woQty)}</Td>
                  <Td right>{cell(row.stagingQty)}</Td>
                  <Td right>{cell(row.deboxQty)}</Td>
                  <Td right>{cell(row.postblastQty)}</Td>
                  <Td right>{cell(row.platingQty)}</Td>
                  <Td right>{cell(row.sleevingNet)}</Td>
                  <Td>
                    <span className="inline-flex gap-0.5">
                      {STATION_ORDER.filter(s => stations?.has(s)).map(s => (
                        <span key={s} title={STATION_META[s].label} className={`text-[10px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                          {STATION_META[s].icon}
                        </span>
                      ))}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={funnel.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </div>
  );
}

// ─── Trace Panel ──────────────────────────────────────────────────────────────

export function TracePanel({ sku, funnel, skuInfoIndex, onClear }: { sku: string; funnel: FunnelRow[]; skuInfoIndex: Map<string, WmsSkuInfo>; onClear: () => void }) {
  const row = funnel.find(f => f.sku === sku.toUpperCase().trim());

  const cell = (label: string, v: number | null, sk: StationKey) => {
    const m = STATION_META[sk];
    return (
      <div className={`flex flex-col items-center px-3 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[80px]`}>
        <span className="text-base leading-none">{m.icon}</span>
        <span className={`text-[10px] font-semibold ${m.textColor} mt-0.5 whitespace-nowrap`}>{label}</span>
        <span className="font-mono font-bold text-slate-800 text-sm mt-1">
          {v == null ? <span className="text-slate-300 font-normal">–</span> : fmtQty(v)}
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 shadow-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔎</span>
          <span className="font-bold text-amber-800">Trace:</span>
          <div className="rounded-lg border border-amber-300 bg-amber-100 px-2 py-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">SKU</div>
            <div className="font-mono text-amber-900 font-semibold">{sku}</div>
          </div>
          <div className="max-w-[260px] rounded-lg border border-amber-300 bg-white/70 px-2 py-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Name</div>
            <div className="text-sm text-amber-900 font-medium">{getSkuDisplayLabel(sku, skuInfoIndex)}</div>
          </div>
          <span className="text-xs text-amber-600">— Mengenfluss durch alle Stationen</span>
        </div>
        <button type="button"
          className="text-xs text-amber-700 hover:text-amber-900 font-semibold px-2 py-1 rounded hover:bg-amber-100 border border-amber-300"
          onClick={onClear}
        >
          ✕ Trace beenden
        </button>
      </div>
      {row ? (
        <div className="flex flex-wrap gap-2 items-center">
          {cell("Inbound", row.inboundQty, "inbound")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("WO", row.woQty, "workorders")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Staging", row.stagingQty, "staging")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Debox", row.deboxQty, "debox")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Post-Blast", row.postblastQty, "postblast")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Plating", row.platingQty, "plating")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Sleeving Net", row.sleevingNet, "sleeving")}
        </div>
      ) : (
        <div className="text-sm text-amber-700 italic">SKU in weniger als 2 Stationen vorhanden — kein Funnel-Eintrag</div>
      )}
    </div>
  );
}

