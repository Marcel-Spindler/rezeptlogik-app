// WMS Übersicht – Stationstabellen für Inbound, Staging/Debox/Post-Blast/Plating, Sleeving.
import React, { useMemo, useState } from "react";
import { STATION_META, STATION_ORDER } from "./wmsTypes";
import type { AggInboundRow, AggSleevingRow, AggStoredRow, StationKey } from "./wmsTypes";
import { fmtDate, fmtQty, maxDate, mhdClass, minDate } from "./wmsFormat";
import { sleevingSignal } from "./wmsAggregate";
import type { LotStationMap, SkuStationMap } from "./wmsIndex";
import { LotCrossStations, ShowMoreBar, SkuLabel, StationBadges, StatusBadge, Td, Th } from "./WmsPrimitives";
import { RawDetailRow, WoBadge } from "./WmsAlertBanners";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

// ─── Station: Inbound ─────────────────────────────────────────────────────────

export function InboundAggTable({ rows, skuMap, lotMap, search, onTrace, onDetail, skuInfoIndex }: {
  rows: AggInboundRow[]; skuMap: SkuStationMap; lotMap: LotStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const needle = search.trim().toUpperCase();

  const filtered = needle
    ? rows.filter(r =>
        r.sku.includes(needle) ||
        r.vendors.some(v => v.toUpperCase().includes(needle)) ||
        r.rawRows.some(raw =>
          [raw.poNumber, raw.lotNumber, raw.huId, raw.shipmentNumber].some(f => String(f ?? "").toUpperCase().includes(needle))
        )
      )
    : rows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (sku: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(sku)) s.delete(sku);
      else s.add(sku);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Kein Wareneingang für diese KW</div>;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th right>Erhalten</Th>
              <Th right>Defekt</Th>
              <Th>POs</Th>
              <Th>Lose</Th>
              <Th>HUs</Th>
              <Th>Lieferant</Th>
              <Th>Status</Th>
              <Th>MHD (nächste)</Th>
              <Th>Letzter Eingang</Th>
              <Th>Los auch in…</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.sku);
              const isMatch = needle && row.sku.includes(needle);
              const allLots = [...new Set(row.rawRows.map(r => r.lotNumber).filter(Boolean))];
              return (
                <React.Fragment key={row.sku}>
                  <tr className={`hover:bg-emerald-50/30 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.sku)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      {skuMap.get(row.sku)?.has("workorders") && (
                        <span title="Zutat in Work Order dieser KW" className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200 font-semibold">WO</span>
                      )}
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation="inbound" onTrace={onTrace} />
                    </Td>
                    <Td right mono cls="font-bold text-slate-800">{fmtQty(row.totalReceived)}</Td>
                    <Td right mono cls={row.totalDamaged > 0 ? "text-rose-700 font-bold" : "text-slate-300"}>{fmtQty(row.totalDamaged)}</Td>
                    <Td mono cls="text-slate-500">{row.poCount}x</Td>
                    <Td mono cls="text-slate-500">{row.lotCount}x</Td>
                    <Td mono cls="text-slate-500">{row.huCount}x</Td>
                    <Td cls="text-slate-600 text-[11px]">{row.vendors.join(", ") || "–"}</Td>
                    <Td><div className="flex flex-wrap gap-0.5">{row.statuses.map(s => <StatusBadge key={s} status={s} />)}</div></Td>
                    <Td cls={mhdClass(row.nextExpiry)}>{fmtDate(row.nextExpiry)}</Td>
                    <Td>{fmtDate(row.lastReceipt)}</Td>
                    <Td><LotCrossStations lots={allLots} lotMap={lotMap} currentStation="inbound" /></Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== "inbound" && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["PO-Nr", "Los-Nr", "HU", "Erhalten", "Defekt", "Status", "MHD", "Eingang", "Lieferant", "Sendung"].map(h => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${["Erhalten","Defekt"].includes(h) ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => (
                              <tr key={i} className="hover:bg-white">
                                <td className="pr-4 font-mono py-0.5">{r.poNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.lotNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.huId || "–"}</td>
                                <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.qtyReceived)}</td>
                                <td className={`pr-4 text-right font-mono ${(r.qtyDamaged ?? 0) > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}`}>{fmtQty(r.qtyDamaged)}</td>
                                <td className="pr-4">{r.status}</td>
                                <td className={`pr-4 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                                <td className="pr-4">{fmtDate(r.receiptDate)}</td>
                                <td className="pr-4 font-mono">{r.vendorCode || "–"}</td>
                                <td className="font-mono">{r.shipmentNumber || "–"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </RawDetailRow>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={filtered.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </>
  );
}


// ─── Station: Stored (Staging / Debox / Post-Blast / Plating) ─────────────────

export function StoredAggTable({ rows, stationKey, skuMap, lotMap, search, onTrace, onDetail, itemToWoMap, onWoDetail, skuInfoIndex }: {
  rows: AggStoredRow[]; stationKey: StationKey; skuMap: SkuStationMap; lotMap: LotStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void;
  itemToWoMap?: Map<string, Set<string>>; onWoDetail?: (wo: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<"location" | "sku">("location");
  const needle = search.trim().toUpperCase();

  // Merge rows by SKU when groupMode === "sku"
  const displayRows = useMemo<AggStoredRow[]>(() => {
    if (groupMode === "location") return rows;
    const map = new Map<string, AggStoredRow>();
    for (const r of rows) {
      let agg = map.get(r.sku);
      if (!agg) {
        agg = { key: r.sku, sku: r.sku, location: "", totalQty: 0, lots: [], hus: [], statuses: [], firstFifo: null, firstExpiry: null, lastChange: null, rawRows: [] };
        map.set(r.sku, agg);
      }
      agg.totalQty   += r.totalQty;
      agg.firstFifo   = minDate(agg.firstFifo,  r.firstFifo);
      agg.firstExpiry = minDate(agg.firstExpiry, r.firstExpiry);
      agg.lastChange  = maxDate(agg.lastChange,  r.lastChange);
      if (r.location) agg.location = agg.location ? `${agg.location}, ${r.location}` : r.location;
      for (const l of r.lots)     if (!agg.lots.includes(l))     agg.lots.push(l);
      for (const h of r.hus)      if (!agg.hus.includes(h))      agg.hus.push(h);
      for (const s of r.statuses) if (!agg.statuses.includes(s)) agg.statuses.push(s);
      agg.rawRows.push(...r.rawRows);
    }
    return [...map.values()].sort((a, b) => b.totalQty - a.totalQty);
  }, [rows, groupMode]);

  const filtered = needle
    ? displayRows.filter(r =>
        r.sku.includes(needle) ||
        r.location.toUpperCase().includes(needle) ||
        r.lots.some(l => l.toUpperCase().includes(needle))
      )
    : displayRows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (key: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Daten für diese KW</div>;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-100">
        <span className="text-[10px] font-semibold text-slate-500">Ansicht:</span>
        <button type="button" onClick={() => setGroupMode("location")}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${groupMode === "location" ? "bg-slate-700 text-white" : "text-slate-500 hover:bg-slate-200"}`}>
          Nach Stellplatz
        </button>
        <button type="button" onClick={() => setGroupMode("sku")}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${groupMode === "sku" ? "bg-slate-700 text-white" : "text-slate-500 hover:bg-slate-200"}`}>
          Nach SKU (zusammengefasst)
        </button>
        {groupMode === "sku" && (
          <span className="text-[10px] text-slate-400 ml-1">{displayRows.length} SKUs über alle Stellplätze</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th>{groupMode === "sku" ? "Stellplätze" : "Ort / Location"}</Th>
              <Th right>Menge</Th>
              <Th>Lose</Th>
              <Th>HUs</Th>
              <Th>Status</Th>
              <Th>FIFO</Th>
              <Th>MHD</Th>
              <Th>Letzte Änd.</Th>
              <Th>Los auch in…</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.key);
              const isMatch = needle && (row.sku.includes(needle) || row.location.toUpperCase().includes(needle) || row.lots.some(l => l.toUpperCase().includes(needle)));
              return (
                <React.Fragment key={row.key}>
                  <tr className={`hover:bg-slate-50/60 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.key)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      {itemToWoMap && onWoDetail && <WoBadge itemNumber={row.sku} itemToWoMap={itemToWoMap} onWoDetail={onWoDetail} />}
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation={stationKey} onTrace={onTrace} />
                    </Td>
                    <Td mono cls="text-slate-600 font-medium">{row.location || "–"}</Td>
                    <Td right mono cls={`font-bold ${row.rawRows.some(r => (r.actualQty ?? 0) < 0) ? "text-rose-600" : "text-slate-800"}`}>
                      {fmtQty(row.totalQty)}
                      {row.rawRows.some(r => (r.actualQty ?? 0) < 0) && <span className="ml-1 text-[9px] bg-rose-100 text-rose-600 border border-rose-200 px-1 rounded">neg</span>}
                    </Td>
                    <Td cls="text-slate-500 text-[10px] max-w-[120px] truncate" title={row.lots.join(", ")}>
                      {row.lots.length > 0
                        ? row.lots.slice(0, 2).join(", ") + (row.lots.length > 2 ? ` +${row.lots.length - 2}` : "")
                        : "–"}
                    </Td>
                    <Td mono cls="text-slate-500">{row.hus.length}x</Td>
                    <Td><div className="flex flex-wrap gap-0.5">{row.statuses.map(s => <StatusBadge key={s} status={s} />)}</div></Td>
                    <Td>{fmtDate(row.firstFifo)}</Td>
                    <Td cls={mhdClass(row.firstExpiry)}>{fmtDate(row.firstExpiry)}</Td>
                    <Td>{fmtDate(row.lastChange)}</Td>
                    <Td><LotCrossStations lots={row.lots} lotMap={lotMap} currentStation={stationKey} /></Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== stationKey && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["Los-Nr", "HU", "Menge", "Status", "FIFO", "MHD", "Letzte Änd."].map((h, i) => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${i === 2 ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => (
                              <tr key={i} className="hover:bg-white">
                                <td className="pr-4 font-mono py-0.5">{r.lotNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.huId || "–"}</td>
                                <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.actualQty)}</td>
                                <td className="pr-4">{r.status || "–"}</td>
                                <td className="pr-4">{fmtDate(r.fifoDate)}</td>
                                <td className={`pr-4 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                                <td>{fmtDate(r.dbChangeCommitTime)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </RawDetailRow>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={filtered.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </>
  );
}

// ─── Station: Sleeving ────────────────────────────────────────────────────────

export function SleevingAggTable({ rows, skuMap, search, onTrace, onDetail, skuInfoIndex, itemToWoMap, onWoDetail }: {
  rows: AggSleevingRow[]; skuMap: SkuStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
  itemToWoMap?: Map<string, Set<string>>; onWoDetail?: (wo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const needle = search.trim().toUpperCase();

  const filtered = needle
    ? rows.filter(r =>
        r.sku.includes(needle) ||
        r.description.toUpperCase().includes(needle) ||
        r.employees.some(e => e.toUpperCase().includes(needle))
      )
    : rows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (sku: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(sku)) s.delete(sku);
      else s.add(sku);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Sleeving-Daten für diese KW</div>;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th>Bezeichnung</Th>
              <Th right>Eingang ↓</Th>
              <Th right>Ausgang ↑</Th>
              <Th right>Net</Th>
              <Th right>Lost</Th>
              <Th right>Hold</Th>
              <Th right>Transakt.</Th>
              <Th>Mitarbeiter</Th>
              <Th>Letzte Änd.</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.sku);
              const isMatch = needle && row.sku.includes(needle);
              return (
                <React.Fragment key={row.sku}>
                  <tr className={`hover:bg-sky-50/30 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.sku)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation="sleeving" onTrace={onTrace} />
                      {itemToWoMap && onWoDetail && <WoBadge itemNumber={row.sku} itemToWoMap={itemToWoMap} onWoDetail={onWoDetail} />}
                    </Td>
                    <Td cls="max-w-[150px] truncate text-slate-600" title={row.description}>{row.description}</Td>
                    <Td right mono cls="text-emerald-700 font-semibold">{fmtQty(row.eingang)}</Td>
                    <Td right mono cls="text-orange-600 font-semibold">{fmtQty(row.ausgang)}</Td>
                    <Td right mono cls={row.net >= 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold"}>{fmtQty(row.net)}</Td>
                    <Td right mono cls={row.lost > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}>{row.lost > 0 ? fmtQty(row.lost) : "–"}</Td>
                    <Td right mono cls={row.hold > 0 ? "text-amber-600 font-semibold" : "text-slate-300"}>{row.hold > 0 ? fmtQty(row.hold) : "–"}</Td>
                    <Td right mono cls="text-slate-500">{row.transCount}</Td>
                    <Td cls="text-slate-500 text-[10px]">
                      {row.employees.length > 0
                        ? row.employees.slice(0, 3).join(", ") + (row.employees.length > 3 ? ` +${row.employees.length - 3}` : "")
                        : "–"}
                    </Td>
                    <Td>{fmtDate(row.lastChange)}</Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== "sleeving" && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["Signal", "Von", "Nach", "Menge", "Art", "Start", "Ende", "MA"].map((h, i) => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${i === 3 ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => {
                              const sig = sleevingSignal(r);
                              const sigCls =
                                sig === "eingang" ? "text-emerald-600 font-semibold" :
                                sig === "ausgang" ? "text-orange-600 font-semibold" :
                                sig === "lost"    ? "text-rose-600 font-semibold"   :
                                sig === "hold"    ? "text-amber-600 font-semibold"  :
                                sig === "cycle"   ? "text-purple-600 font-semibold" :
                                "text-slate-400";
                              return (
                                <tr key={i} className="hover:bg-white">
                                  <td className={`pr-4 py-0.5 ${sigCls}`}>{sig}</td>
                                  <td className="pr-4 font-mono">{r.von  || "–"}</td>
                                  <td className="pr-4 font-mono">{r.nach || "–"}</td>
                                  <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.tranQty)}</td>
                                  <td className="pr-4">{r.tranType || "–"}</td>
                                  <td className="pr-4">{fmtDate(r.startTranDate)}</td>
                                  <td className="pr-4">{fmtDate(r.endTranDate)}</td>
                                  <td className="font-mono">{r.employeeId || "–"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </RawDetailRow>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={filtered.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </>
  );
}

