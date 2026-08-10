// WMS Übersicht – Bilanz-Tab: Rechen-Aufschlüsselung je SKU, Stationsbilanz-Tabelle, Snapshot-Verwaltung.
import React, { useState } from "react";
import { fmtQty } from "./wmsFormat";
import { detectKettenbruch, type SkuBilanzEntry } from "./wmsAggregate";
import { MAX_SNAPSHOTS, type WmsSnapshot } from "./wmsSnapshots";
import { SkuLabel, Td, Th } from "./WmsPrimitives";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

// ─── Bilanz-Rechnung (expandable detail per SKU) ──────────────────────────────

export function BilanzRechnung({ e, snapEntry }: { e: SkuBilanzEntry; snapEntry: SkuBilanzEntry | null }) {
  const kb = detectKettenbruch(e);
  const R = ({ label, value, cls, sub }: { label: string; value: number; cls?: string; sub?: boolean }) => (
    <div className={`flex justify-between py-0.5 ${sub ? "pl-3 text-[11px]" : "text-xs"}`}>
      <span className={sub ? "text-slate-500" : "text-slate-700"}>{label}</span>
      <span className={`font-mono font-semibold ${cls ?? "text-slate-700"}`}>{fmtQty(value)}</span>
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Differenzrechnung</div>
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 space-y-0.5">
          <R label="WO Bedarf (geplant)" value={e.woRequired} cls="font-bold text-slate-800" />
          <R label="Inbound erhalten" value={e.inboundQty}
            cls={e.inboundQty === 0 ? "text-slate-300" : e.inboundQty < e.woRequired ? "text-amber-600" : "text-emerald-700"} />
          <div className="border-t border-slate-100 my-1" />
          <R label="\u2211 Lager (alle Stationen)" value={e.totalStock} cls="font-bold text-slate-800" />
          {e.stagingQty   > 0 && <R label="davon Staging"    value={e.stagingQty}   cls="text-amber-700"  sub />}
          {e.deboxQty     > 0 && <R label="davon Debox"      value={e.deboxQty}     cls="text-orange-700" sub />}
          {e.postblastQty > 0 && <R label="davon Post-Blast" value={e.postblastQty} cls="text-rose-700"   sub />}
          {e.platingQty   > 0 && <R label="davon Plating"    value={e.platingQty}   cls="text-blue-700"   sub />}
          <div className="border-t border-slate-100 my-1" />
          <R label="Sleeving Verlust (dok.)" value={e.sleevingLost}
            cls={e.sleevingLost > 0 ? "text-rose-600" : "text-slate-300"} />
          {e.inboundQty > 0 && (
            <div className={`flex justify-between text-xs py-0.5 border-t border-dashed mt-1 pt-1 ${e.unresolvedGap > 0 ? "border-rose-300" : "border-slate-200"}`}>
              <span className={e.unresolvedGap > 0 ? "text-rose-700 font-semibold" : "text-slate-500"}>Unerklärter Schwund (Inb. − Lager − Verlust)</span>
              <span className={`font-mono font-bold ${e.unresolvedGap > 0 ? "text-rose-700" : "text-emerald-600"}`}>
                {e.unresolvedGap > 0 ? fmtQty(e.unresolvedGap) : "0"}
              </span>
            </div>
          )}
          <div className={`flex justify-between text-sm font-bold py-1 border-t mt-1 ${e.gap < 0 ? "border-rose-300 text-rose-700" : "border-emerald-200 text-emerald-700"}`}>
            <span>\u0394 Lager vs. WO</span>
            <span className="font-mono">{e.gap >= 0 ? `+${fmtQty(e.gap)}` : fmtQty(e.gap)}</span>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {e.unresolvedGap > 0 && (
          <div className="rounded-lg border-2 border-rose-500 bg-rose-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-rose-400 mb-1">🚨 Unerklärte Fehlmenge</div>
            <div className="text-sm font-bold text-rose-800">{fmtQty(e.unresolvedGap)} Einheiten ohne Buchungsbeleg</div>
            <div className="text-[11px] text-rose-500 mt-0.5 font-mono">
              {fmtQty(e.inboundQty)} − {fmtQty(e.totalStock)} − {fmtQty(e.sleevingLost)} = {fmtQty(e.unresolvedGap)}
            </div>
          </div>
        )}
        {kb && (
        <div className={`rounded-lg border px-3 py-2 ${kb.severity === "stuck" ? "border-amber-300 bg-amber-50" : kb.severity === "yield_loss" ? "border-rose-300 bg-rose-50" : "border-rose-200 bg-rose-50"}`}>
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">{kb.severity === "yield_loss" ? "🗑️ Yield-Verlust" : "⚡ Engpass erkannt"}</div>
          <div className={`text-sm font-semibold ${kb.severity === "stuck" ? "text-amber-800" : "text-rose-700"}`}>{kb.label}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {kb.severity === "stuck" ? "Ware liegt hier — kein Weitertransport erkennbar" : kb.severity === "yield_loss" ? "Massiver Verlust zwischen Inbound und aktuellem Bestand" : "Mengendifferenz zwischen zwei Stationen"}
            </div>
          </div>
        )}
        {e.sleevingLost > 0 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">🗑️ Dokumentierter Verlust</div>
            <div className="text-sm font-semibold text-rose-700">{fmtQty(e.sleevingLost)} als Sleeving-Verlust gebucht</div>
          </div>
        )}
        {snapEntry && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">📸 Snapshot-\u0394</div>
            <div className="space-y-0.5 text-xs">
              <div className="flex justify-between"><span className="text-slate-500">Lager damals</span><span className="font-mono">{fmtQty(snapEntry.totalStock)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Lager jetzt</span><span className="font-mono">{fmtQty(e.totalStock)}</span></div>
              <div className={`flex justify-between font-bold ${e.totalStock >= snapEntry.totalStock ? "text-emerald-700" : "text-rose-700"}`}>
                <span>Netto-\u0394</span>
                <span className="font-mono">{e.totalStock >= snapEntry.totalStock ? "+" : ""}{fmtQty(e.totalStock - snapEntry.totalStock)}</span>
              </div>
            </div>
          </div>
        )}
        {!kb && e.sleevingLost === 0 && e.unresolvedGap === 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 font-semibold">
            \u2713 Keine Auffälligkeiten \u00b7 Deckung: {e.coverage.toFixed(1)}%
          </div>
        )}
      </div>
    </div>
  );
}

export function StationsBilanz({ bilanz, compareSnap, week, onTrace, onWoDetail, skuInfoIndex }: {
  bilanz: SkuBilanzEntry[];
  compareSnap: WmsSnapshot | null;
  week: string;
  onTrace: (sku: string) => void;
  onWoDetail: (wo: string) => void;
  skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [filter, setFilter] = useState<"all" | "deficit" | "surplus" | "ok" | "unresolved">("all");
  const [showAll, setShowAll] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const deficitCount    = bilanz.filter(e => e.gap < -10).length;
  const surplusCount    = bilanz.filter(e => e.gap > 100).length;
  const okCount         = bilanz.filter(e => e.gap >= -10 && e.gap <= 100).length;
  const unresolvedCount = bilanz.filter(e => e.unresolvedGap > 0).length;

  const filtered = bilanz.filter(e => {
    if (filter === "deficit")    return e.gap < -10;
    if (filter === "surplus")    return e.gap > 100;
    if (filter === "ok")         return e.gap >= -10 && e.gap <= 100;
    if (filter === "unresolved") return e.unresolvedGap > 0;
    return true;
  });

  const shown = showAll ? filtered : filtered.slice(0, 40);
  const snapMap = compareSnap ? new Map(compareSnap.bilanz.map(e => [e.sku, e])) : null;

  const coverageCls = (cov: number) =>
    cov >= 100 ? "text-emerald-700 font-bold" :
    cov >= 75  ? "text-amber-600 font-semibold" :
    cov >= 50  ? "text-orange-600 font-semibold" :
                 "text-rose-700 font-bold";

  const gapCls = (gap: number) =>
    gap >= 0   ? "text-emerald-700" :
    gap >= -50 ? "text-amber-600"   :
                 "text-rose-700 font-bold";

  if (bilanz.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-slate-900 text-white">
        <div className="flex items-center gap-2">
          <span>🎛️</span>
          <span className="font-bold text-sm">Stationsbilanz</span>
          <span className="text-xs text-slate-400">Fehlbestand & Überproduktion · {week}</span>
          {compareSnap && (
            <span className="text-[10px] font-semibold bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">∆ vs {compareSnap.label}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "deficit", "surplus", "ok", "unresolved"] as const).map(f => {
            const count = f === "all" ? bilanz.length : f === "deficit" ? deficitCount : f === "surplus" ? surplusCount : f === "ok" ? okCount : unresolvedCount;
            const labels = { all: `Alle (${count})`, deficit: `⚠️ Fehlbestand (${count})`, surplus: `📈 Überschuss (${count})`, ok: `✓ OK (${count})`, unresolved: `🚨 Unerklärt (${count})` };
            const activeCls = f === "deficit" ? "bg-rose-600 text-white" : f === "surplus" ? "bg-amber-600 text-white" : f === "ok" ? "bg-emerald-600 text-white" : f === "unresolved" ? "bg-rose-900 text-white" : "bg-slate-600 text-white";
            return (
              <button key={f} type="button"
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-opacity ${filter === f ? activeCls : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                onClick={() => setFilter(f)}>
                {labels[f]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200">
              <Th>SKU</Th>
              <Th right>Inbound</Th>
              <Th right>WO Bedarf</Th>
              <Th right>🗄️ Staging</Th>
              <Th right>📂 Debox</Th>
              <Th right>❄️ Post-Blast</Th>
              <Th right>🍽️ Plating</Th>
              <Th right>🔄 Sleeving</Th>
              <Th right>Gesamt Lager</Th>
              <Th right>Deckung</Th>
              <Th right>Delta</Th>
              {snapMap && <Th right>Δ Snapshot</Th>}
              <Th right>🗑️ Schwund</Th>
              <Th>⚡ Engpass</Th>
              <Th>WOs</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(e => {
              const snapEntry = snapMap?.get(e.sku);
              const snapDelta = snapEntry != null ? e.totalStock - snapEntry.totalStock : null;
              const rowCls = e.gap < -10 ? "bg-rose-50/50" : e.gap > 100 ? "bg-emerald-50/30" : "";
              const isExpanded = expandedSku === e.sku;
              const kb = detectKettenbruch(e);
              return (
                <React.Fragment key={e.sku}>
                  <tr className={`${rowCls} hover:bg-slate-50/80`}>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="inline-flex items-center gap-1">
                        <button type="button"
                          onClick={() => setExpandedSku(s => s === e.sku ? null : e.sku)}
                          className="text-slate-400 hover:text-slate-700 text-[10px] w-3 shrink-0 text-center">
                          {isExpanded ? "▼" : "▶"}
                        </button>
                        <span className="cursor-pointer hover:underline" onClick={() => onTrace(e.sku)}><SkuLabel sku={e.sku} skuInfoIndex={skuInfoIndex} /></span>
                        {e.unresolvedGap > 0 && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block shrink-0" title="Unerklärte Fehlmenge" />}
                      </span>
                    </Td>
                    <Td right mono cls={e.inboundQty === 0 ? "text-slate-300" : "text-emerald-700"}>{e.inboundQty > 0 ? fmtQty(e.inboundQty) : "–"}</Td>
                    <Td right mono cls="font-bold text-slate-700">{fmtQty(e.woRequired)}</Td>
                    <Td right mono cls={e.stagingQty === 0 ? "text-slate-300" : "text-amber-700"}>{e.stagingQty > 0 ? fmtQty(e.stagingQty) : "–"}</Td>
                    <Td right mono cls={e.deboxQty === 0 ? "text-slate-300" : "text-orange-700"}>{e.deboxQty > 0 ? fmtQty(e.deboxQty) : "–"}</Td>
                    <Td right mono cls={e.postblastQty === 0 ? "text-slate-300" : "text-rose-700"}>{e.postblastQty > 0 ? fmtQty(e.postblastQty) : "–"}</Td>
                    <Td right mono cls={e.platingQty === 0 ? "text-slate-300" : "text-blue-700"}>{e.platingQty > 0 ? fmtQty(e.platingQty) : "–"}</Td>
                    <Td right mono cls={e.sleevingNet === 0 ? "text-slate-300" : e.sleevingNet > 0 ? "text-sky-700" : "text-rose-600"}>{e.sleevingNet !== 0 ? fmtQty(e.sleevingNet) : "–"}</Td>
                    <Td right mono cls="font-bold text-slate-800">{fmtQty(e.totalStock)}</Td>
                    <Td right>
                      <div className="flex items-center gap-1 justify-end">
                        <span className={`font-mono font-bold ${coverageCls(e.coverage)}`}>{e.coverage.toFixed(0)}%</span>
                        <span className="w-10 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <span className={`block h-full rounded-full ${e.coverage >= 100 ? "bg-emerald-500" : e.coverage >= 75 ? "bg-amber-500" : "bg-rose-500"}`}
                            style={{ width: `${Math.min(100, e.coverage).toFixed(0)}%` }} />
                        </span>
                      </div>
                    </Td>
                    <Td right mono cls={gapCls(e.gap)}>
                      {e.gap >= 0 ? `+${fmtQty(e.gap)}` : fmtQty(e.gap)}
                    </Td>
                    {snapMap && (
                      <Td right mono cls={snapDelta == null ? "text-slate-300" : snapDelta > 0 ? "text-emerald-600 font-semibold" : snapDelta < 0 ? "text-rose-600 font-semibold" : "text-slate-400"}>
                        {snapDelta == null ? "–" : snapDelta > 0 ? `+${fmtQty(snapDelta)}` : fmtQty(snapDelta)}
                      </Td>
                    )}
                    <Td right mono cls={e.sleevingLost > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}>
                      {e.sleevingLost > 0 ? fmtQty(e.sleevingLost) : "–"}
                    </Td>
                    <Td>
                      {kb && (
                        <span className={`inline-block px-1.5 py-0.5 rounded border text-[9px] font-semibold ${kb.severity === "stuck" ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-rose-100 text-rose-700 border-rose-200"}`}>
                          {kb.label}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-0.5">
                        {e.woNumbers.slice(0, 2).map(wo => (
                          <button key={wo} type="button" onClick={ev => { ev.stopPropagation(); onWoDetail(wo); }}
                            className="px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-mono font-semibold hover:bg-violet-100">
                            {wo}
                          </button>
                        ))}
                        {e.woNumbers.length > 2 && <span className="text-[9px] text-slate-400">+{e.woNumbers.length - 2}</span>}
                      </div>
                    </Td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={snapMap ? 14 : 13} className="px-5 py-4 bg-slate-50 border-t border-b border-slate-200">
                        <BilanzRechnung e={e} snapEntry={snapEntry ?? null} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > 40 && (
        <div className="px-4 py-2 border-t border-slate-100 text-center">
          {showAll
            ? <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={() => setShowAll(false)}>▲ Weniger</button>
            : <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={() => setShowAll(true)}>▼ Alle {filtered.length} anzeigen</button>
          }
        </div>
      )}
    </div>
  );
}

// ─── Snapshot Panel ───────────────────────────────────────────────────────────

export function SnapshotPanel({ snapshots, currentWeek, onCompare, compareId, onDelete, onSave }: {
  snapshots: WmsSnapshot[];
  currentWeek: string;
  onCompare: (id: string | null) => void;
  compareId: string | null;
  onDelete: (id: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <button type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-100 hover:bg-slate-200 transition-colors"
        onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-2">
          <span>💾</span>
          <span className="font-semibold text-sm text-slate-700">Snapshots & Verlauf</span>
          {snapshots.length > 0 && (
            <span className="text-[10px] font-mono bg-slate-300 text-slate-700 px-1.5 py-0.5 rounded-full">{snapshots.length}</span>
          )}
          {compareId && <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Vergleich aktiv</span>}
        </div>
        <span className="text-xs text-slate-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="bg-white p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
              onClick={onSave}>
              💾 Aktuellen Stand speichern ({currentWeek})
            </button>
            {compareId && (
              <button type="button" onClick={() => onCompare(null)}
                className="px-3 py-1.5 rounded-lg bg-amber-100 text-amber-700 border border-amber-300 text-xs font-semibold hover:bg-amber-200">
                ✕ Vergleich beenden
              </button>
            )}
            <span className="text-[10px] text-slate-400">Bis zu {MAX_SNAPSHOTS} Snapshots · wird im Browser gespeichert</span>
          </div>
          {snapshots.length === 0 ? (
            <div className="text-xs text-slate-400 text-center py-4">Noch keine Snapshots. Stand speichern um Verläufe zu vergleichen.</div>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {snapshots.map(snap => {
                const isComparing = compareId === snap.id;
                const defCount = snap.bilanz.filter(e => e.gap < -10).length;
                const surpCount = snap.bilanz.filter(e => e.gap > 100).length;
                return (
                  <div key={snap.id} className={`flex items-center gap-2 p-2 rounded-lg border text-xs ${isComparing ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-slate-50 hover:bg-slate-100"}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-700 truncate">{snap.label}</div>
                      <div className="flex gap-2 text-[10px] text-slate-400 mt-0.5 flex-wrap">
                        <span>{new Date(snap.timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                        <span className="font-mono">{snap.bilanz.length} SKUs</span>
                        {defCount > 0 && <span className="text-rose-500 font-semibold">{defCount} Fehlbestände</span>}
                        {surpCount > 0 && <span className="text-emerald-600 font-semibold">{surpCount} Überschüsse</span>}
                      </div>
                    </div>
                    <button type="button"
                      className={`px-2 py-1 rounded text-[10px] font-semibold shrink-0 ${isComparing ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-600 hover:bg-amber-100 hover:text-amber-700"}`}
                      onClick={() => onCompare(isComparing ? null : snap.id)}>
                      {isComparing ? "✓ Aktiv" : "Vergleichen"}
                    </button>
                    <button type="button" className="text-slate-300 hover:text-rose-500 text-xs px-1 shrink-0"
                      onClick={() => onDelete(snap.id)}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

