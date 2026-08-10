// WMS Übersicht – Detail-Panel für eine einzelne SKU über alle Stationen.
import React from "react";
import { STATION_META, STATION_ORDER } from "./wmsTypes";
import type { AllData, InboundRow, StationKey, StoredRow } from "./wmsTypes";
import { fmtDate, fmtQty, mhdClass, skuKey } from "./wmsFormat";
import { sleevingSignal } from "./wmsAggregate";
import { woMatchesSelectedWeek } from "./wmsWeeks";
import type { FunnelRow } from "./wmsIndex";
import { StatusBadge } from "./WmsPrimitives";
import { getSkuDisplayLabel, type WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

// ─── SKU Detail Panel ─────────────────────────────────────────────────────────

export function SkuDetailPanel({ sku, allData, funnel, selectedWeek, weekNum, skuInfoIndex, onClose, onTrace }: {
  sku: string; allData: AllData; funnel: FunnelRow[]; selectedWeek: string; weekNum: number | null; skuInfoIndex: Map<string, WmsSkuInfo>;
  onClose: () => void; onTrace: (sku: string) => void;
}) {
  const k = skuKey(sku);
  const woRows  = allData.workorders.rows.filter(r => woMatchesSelectedWeek(r.week, selectedWeek) && (skuKey(r.mealItemNumber) === k || skuKey(r.submealItemNumber) === k));
  const inbRows = allData.inbound.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === k);
  const stagRows = allData.staging.rows.filter(r => skuKey(r.itemNumber) === k);
  const debRows  = allData.debox.rows.filter(r => skuKey(r.itemNumber) === k);
  const pbRows   = allData.postblast.rows.filter(r => skuKey(r.itemNumber) === k);
  const slvRows  = allData.sleeving.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === k);
  const pltRows  = allData.plating.rows.filter(r => skuKey(r.itemNumber) === k);
  const fRow = funnel.find(f => f.sku === k);
  const allLots = [...new Set([...inbRows, ...stagRows, ...debRows, ...pbRows, ...pltRows].map(r => (r as InboundRow & StoredRow).lotNumber).filter(Boolean))];

  const SectionHead = ({ icon, label, count, cls }: { icon: string; label: string; count: number; cls: string }) => (
    <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${cls}`}>{icon} {label} <span className="font-mono normal-case opacity-60">({count})</span></h3>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-slate-900 text-white px-5 py-3 flex items-center justify-between z-10 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono font-bold text-lg text-amber-400">{sku}</span>
            <span className="text-slate-300 text-sm truncate">{getSkuDisplayLabel(sku, skuInfoIndex)}</span>
            <span className="text-slate-400 text-sm">— vollständiger Eintrag</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onTrace(sku)} className="text-xs bg-amber-500 hover:bg-amber-400 text-white px-3 py-1 rounded font-semibold">🔍 Trace</button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl font-bold px-2 leading-none">✕</button>
          </div>
        </div>

        <div className="p-5 space-y-6 flex-1">
          {fRow && (
            <section>
              <SectionHead icon="📊" label="Mengenstrom" count={0} cls="text-slate-500" />
              <div className="flex flex-wrap gap-1.5 items-center">
                {([ ["inbound","Inbound",fRow.inboundQty], ["workorders","WO",fRow.woQty], ["staging","Staging",fRow.stagingQty], ["debox","Debox",fRow.deboxQty], ["postblast","Post-Blast",fRow.postblastQty], ["plating","Plating",fRow.platingQty], ["sleeving","Sleeving Net",fRow.sleevingNet] ] as [StationKey,string,number|null][]).map(([sk, lbl, qty], i) => {
                  const m = STATION_META[sk];
                  return (
                    <React.Fragment key={sk}>
                      {i > 0 && <span className="text-slate-300 text-lg">→</span>}
                      <div className={`flex flex-col items-center px-2.5 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[64px]`}>
                        <span>{m.icon}</span>
                        <span className={`text-[9px] font-semibold ${m.textColor} whitespace-nowrap`}>{lbl}</span>
                        <span className="font-mono font-bold text-sm text-slate-800 mt-0.5">{qty == null ? <span className="text-slate-300 font-normal text-xs">–</span> : fmtQty(qty)}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </section>
          )}

          {woRows.length > 0 && (
            <section>
              <SectionHead icon="📋" label="Work Orders" count={woRows.length} cls="text-violet-700" />
              <div className="overflow-x-auto rounded-lg border border-violet-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-violet-100 bg-violet-50/60 text-slate-500 text-[10px]">
                    {["WO-Nr","Meal","Submeal","Menge","Platten","Status","MHD"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {woRows.map((r, i) => (
                      <tr key={i} className="hover:bg-violet-50/30">
                        <td className="px-2 py-1 font-mono">{r.woNumber}</td>
                        <td className="px-2 font-mono text-violet-600">{r.mealItemNumber}</td>
                        <td className="px-2 font-mono text-slate-600">{r.submealItemNumber}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.quantity)}</td>
                        <td className="px-2 font-mono text-right">{fmtQty(r.plates)}</td>
                        <td className="px-2"><StatusBadge status={r.status} /></td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {inbRows.length > 0 && (
            <section>
              <SectionHead icon="📦" label="Wareneingang" count={inbRows.length} cls="text-emerald-700" />
              <div className="overflow-x-auto rounded-lg border border-emerald-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-emerald-100 bg-emerald-50/60 text-slate-500 text-[10px]">
                    {["PO-Nr","Los-Nr","HU","Erhalten","Defekt","Lieferant","MHD","Eingang"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {inbRows.map((r, i) => (
                      <tr key={i} className="hover:bg-emerald-50/30">
                        <td className="px-2 py-1 font-mono">{r.poNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.lotNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.huId||"–"}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.qtyReceived)}</td>
                        <td className={`px-2 font-mono text-right ${(r.qtyDamaged??0)>0?"text-rose-600 font-semibold":"text-slate-300"}`}>{fmtQty(r.qtyDamaged)}</td>
                        <td className="px-2">{r.vendorCode||"–"}</td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                        <td className="px-2">{fmtDate(r.receiptDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {([ ["staging","🗄️ Staging",stagRows], ["debox","📂 Debox",debRows], ["postblast","❄️ Post-Blast",pbRows], ["plating","🍽️ Plating",pltRows] ] as [StationKey, string, StoredRow[]][]).map(([sk, lbl, rws]) => rws.length > 0 && (
            <section key={sk}>
              <SectionHead icon="" label={lbl} count={rws.length} cls={STATION_META[sk].textColor} />
              <div className={`overflow-x-auto rounded-lg border ${STATION_META[sk].borderColor}`}>
                <table className="text-xs border-collapse w-full">
                  <thead><tr className={`border-b ${STATION_META[sk].borderColor} ${STATION_META[sk].bgColor} text-slate-500 text-[10px]`}>
                    {["Ort","Menge","Los-Nr","HU","Status","FIFO","MHD"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rws.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-2 py-1 font-mono">{r.locationId||"–"}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.actualQty)}</td>
                        <td className="px-2 font-mono">{r.lotNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.huId||"–"}</td>
                        <td className="px-2">{r.status||"–"}</td>
                        <td className="px-2">{fmtDate(r.fifoDate)}</td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {slvRows.length > 0 && (
            <section>
              <SectionHead icon="🔄" label="Sleeving-Verlauf" count={slvRows.length} cls="text-sky-700" />
              <div className="overflow-x-auto rounded-lg border border-sky-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-sky-100 bg-sky-50/60 text-slate-500 text-[10px]">
                    {["Signal","Von","Nach","Menge","Art","Start","Ende","MA"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {slvRows.map((r, i) => {
                      const sig = sleevingSignal(r);
                      const sigCls = sig==="eingang"?"text-emerald-600 font-semibold":sig==="ausgang"?"text-orange-600 font-semibold":sig==="lost"?"text-rose-600 font-semibold":sig==="hold"?"text-amber-600 font-semibold":sig==="cycle"?"text-purple-600 font-semibold":"text-slate-400";
                      return (
                        <tr key={i} className="hover:bg-sky-50/30">
                          <td className={`px-2 py-1 ${sigCls}`}>{sig}</td>
                          <td className="px-2 font-mono">{r.von||"–"}</td>
                          <td className="px-2 font-mono">{r.nach||"–"}</td>
                          <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.tranQty)}</td>
                          <td className="px-2">{r.tranType||"–"}</td>
                          <td className="px-2">{fmtDate(r.startTranDate)}</td>
                          <td className="px-2">{fmtDate(r.endTranDate)}</td>
                          <td className="px-2 font-mono">{r.employeeId||"–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {allLots.length > 0 && (
            <section>
              <SectionHead icon="🗺️" label="Los-Journey" count={allLots.length} cls="text-slate-600" />
              <div className="flex flex-wrap gap-2">
                {allLots.map(lot => {
                  const stations: StationKey[] = [];
                  if (inbRows.some(r => r.lotNumber === lot)) stations.push("inbound");
                  if (stagRows.some(r => r.lotNumber === lot)) stations.push("staging");
                  if (debRows.some(r => r.lotNumber === lot)) stations.push("debox");
                  if (pbRows.some(r => r.lotNumber === lot)) stations.push("postblast");
                  if (pltRows.some(r => r.lotNumber === lot)) stations.push("plating");
                  return (
                    <div key={lot} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
                      <span className="font-mono text-[11px] font-semibold text-slate-700">{lot}</span>
                      <span className="text-slate-300">→</span>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => stations.includes(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>{STATION_META[s].icon}</span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {woRows.length===0 && inbRows.length===0 && stagRows.length===0 && debRows.length===0 && pbRows.length===0 && slvRows.length===0 && pltRows.length===0 && (
            <div className="text-slate-400 text-sm text-center py-10">Keine Daten für {sku} in dieser KW.</div>
          )}
        </div>
      </div>
    </div>
  );
}

