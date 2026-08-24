import type { AggSleevingRow, AggStoredRow, AggWorkorderMeal } from "./wmsTypes";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { fmtQty, skuKey } from "./wmsFormat";
import { useState } from "react";

export type PortionHU = {
  huId: string;
  location: string;
  qty: number;
  portions: number;
  station: string;
};

export type SubmealTrace = {
  sku: string;
  name: string;
  cookMethod: string;
  required: number;
  gramsPerPortion: number;
  requiredPortions: number;
  inPlatingHolding: number;
  inPostBlast: number;
  inDebox: number;
  inStaging: number;
  inSleeving: number;
  total: number;
  totalPortions: number;
  gap: number;
  gapPortions: number;
  yieldPct: number | null;
  hus: PortionHU[];
  status: "ready" | "partial" | "missing";
};

export type MealOperation = {
  sku: string;
  name: string;
  required: number;
  finished: number;
  rackWip: number;
  rackCount: number;
  rackLocations: string[];
  inPlatingHolding: number;
  inPostBlast: number;
  inDebox: number;
  inStaging: number;
  inTransit: number;
  workorders: string[];
  open: number;
  submeals: SubmealTrace[];
  readinessPct: number;
};

function sumBySku(rows: AggStoredRow[], sku: string) {
  return rows.filter(row => row.sku === sku).reduce((sum, row) => sum + row.totalQty, 0);
}

export function buildMealOperations(
  meals: AggWorkorderMeal[],
  plating: AggStoredRow[],
  platingHolding: AggStoredRow[],
  postblast: AggStoredRow[],
  debox: AggStoredRow[],
  staging: AggStoredRow[],
  sleeving: AggSleevingRow[],
  skuInfoIndex: Map<string, WmsSkuInfo>,
): MealOperation[] {
  return meals.map(meal => {
    const sku = skuKey(meal.mealSku);
    const info = skuInfoIndex.get(sku);
    const finished = sumBySku(plating, sku);
    const postblastQty = sumBySku(postblast, sku);
    const postblastRows = postblast.filter(row => row.sku === sku);
    const racks = new Set(postblastRows.flatMap(row => row.hus));
    const rackLocations = [...new Set(postblastRows.map(row => row.location).filter(Boolean))];
    const plhQty = sumBySku(platingHolding, sku);
    const deboxQty = sumBySku(debox, sku);
    const stagingQty = sumBySku(staging, sku);
    const sleevingRow = sleeving.find(row => row.sku === sku);
    const inTransit = Math.max(0, sleevingRow?.net ?? 0);
    const required = info?.plannedQty || meal.totalQty;

    // Submeal-Level Trace mit Portionsberechnung aus dem Rezeptkatalog
    // skuInfoIndex.plannedQty = Gesamtmenge laut Rezeptplan (ingredients * portions)
    // Daraus: gramsPerPortion = plannedQty / totalPortions (aus weekRecipes.verdenVolume)
    const uniqueSubmeals = new Map<string, { name: string; qty: number; gramsPerPortion: number }>();
    for (const sub of meal.submeals) {
      const subSku = skuKey(sub.submealItemNumber);
      if (!subSku) continue;
      const subInfo = skuInfoIndex.get(subSku);
      // Prefer recipe-katalog gramsPerPortion; fallback to WO targetPerPlate
      const gpp = subInfo && subInfo.plannedQty > 0 && sub.plates && sub.plates > 0
        ? Math.round(subInfo.plannedQty / sub.plates)
        : sub.targetPerPlate ?? 0;
      const existing = uniqueSubmeals.get(subSku);
      if (existing) { existing.qty += sub.quantity ?? 0; if (gpp > 0 && existing.gramsPerPortion === 0) existing.gramsPerPortion = gpp; }
      else { uniqueSubmeals.set(subSku, { name: subInfo?.name || sub.submealItemDescription, qty: sub.quantity ?? 0, gramsPerPortion: gpp }); }
    }
    const submeals: SubmealTrace[] = [...uniqueSubmeals.entries()].map(([subSku, { name, qty, gramsPerPortion }]) => {
      const subPlh = sumBySku(platingHolding, subSku);
      const subPb = sumBySku(postblast, subSku);
      const subDeb = sumBySku(debox, subSku);
      const subStg = sumBySku(staging, subSku);
      const subSlv = Math.max(0, sleeving.find(r => r.sku === subSku)?.net ?? 0);
      const total = subPlh + subPb + subDeb + subStg + subSlv;
      const gap = Math.max(0, qty - total);
      const requiredPortions = gramsPerPortion > 0 ? Math.round(qty / gramsPerPortion) : 0;
      const totalPortions = gramsPerPortion > 0 ? Math.round(total / gramsPerPortion) : 0;
      const gapPortions = gramsPerPortion > 0 ? Math.round(gap / gramsPerPortion) : 0;

      // Yield: PreBlast (qty from WO) vs PostBlast (actual stock)
      const preBlastQty = meal.submeals
        .filter(s => skuKey(s.submealItemNumber) === subSku)
        .reduce((s, r) => s + (r.preBlastQuantity ?? 0), 0);
      const yieldPct = preBlastQty > 0 && subPb > 0 ? Math.round((subPb / preBlastQty) * 100) : null;

      // Individual HUs with portion counts
      const hus: PortionHU[] = [];
      const collectHus = (rows: AggStoredRow[], station: string) => {
        for (const agg of rows.filter(r => r.sku === subSku)) {
          for (const raw of agg.rawRows) {
            if ((raw.actualQty ?? 0) <= 0) continue;
            hus.push({
              huId: raw.huId || raw.lotNumber || "–",
              location: raw.locationId,
              qty: raw.actualQty ?? 0,
              portions: gramsPerPortion > 0 ? Math.round((raw.actualQty ?? 0) / gramsPerPortion) : 0,
              station,
            });
          }
        }
      };
      collectHus(platingHolding, "PLH");
      collectHus(postblast, "PostBlast");
      collectHus(debox, "Debox");
      collectHus(staging, "Staging");
      hus.sort((a, b) => b.portions - a.portions);

      // Cook method from recipe catalog
      const cookMethod = skuInfoIndex.get(subSku)?.category ?? "";

      return {
        sku: subSku, name, cookMethod, required: qty, gramsPerPortion, requiredPortions,
        inPlatingHolding: subPlh, inPostBlast: subPb, inDebox: subDeb, inStaging: subStg, inSleeving: subSlv,
        total, totalPortions, gap, gapPortions, yieldPct, hus,
        status: (total >= qty ? "ready" : total > 0 ? "partial" : "missing") as SubmealTrace["status"],
      };
    }).sort((a, b) => b.gapPortions - a.gapPortions || b.gap - a.gap);

    const readyCount = submeals.filter(s => s.status === "ready").length;
    const readinessPct = submeals.length > 0 ? Math.round((readyCount / submeals.length) * 100) : 0;

    return {
      sku, name: info?.name || meal.mealName, required, finished,
      rackWip: postblastQty, rackCount: racks.size, rackLocations,
      inPlatingHolding: plhQty, inPostBlast: postblastQty, inDebox: deboxQty, inStaging: stagingQty,
      inTransit,
      workorders: [...new Set(meal.submeals.map(submeal => submeal.woNumber).filter(Boolean))],
      open: Math.max(0, required - finished),
      submeals, readinessPct,
    };
  }).sort((a, b) => b.open - a.open || b.required - a.required);
}

// ─── PLH-Bereitschaft: eigenständiger Live-Check "liegt gerade alles im Plating Holding?" ──
// Getrennt von readinessPct oben, weil das dort über ALLE Stationen (PLH+PostBlast+Debox+
// Staging+Sleeving) summiert — für die Live-Entscheidung "plaiten wir dieses Meal jetzt"
// zählt aber nur, was in diesem Moment tatsächlich im PLH-Puffer steht.

export type PlhSubmealCheck = {
  sku: string;
  name: string;
  required: number;
  inPlatingHolding: number;
  present: boolean;
  sufficient: boolean;
};

export type PlhReadiness = {
  sku: string;
  name: string;
  workorders: string[];
  submeals: PlhSubmealCheck[];
  allPresent: boolean;
  allSufficient: boolean;
  missing: PlhSubmealCheck[];
};

export function buildPlhReadiness(meals: MealOperation[]): PlhReadiness[] {
  return meals
    .filter(meal => meal.submeals.length > 0)
    .map(meal => {
      const submeals: PlhSubmealCheck[] = meal.submeals.map(s => ({
        sku: s.sku,
        name: s.name,
        required: s.required,
        inPlatingHolding: s.inPlatingHolding,
        present: s.inPlatingHolding > 0,
        sufficient: s.required > 0 ? s.inPlatingHolding >= s.required : s.inPlatingHolding > 0,
      }));
      const missing = submeals.filter(s => !s.present);
      return {
        sku: meal.sku,
        name: meal.name,
        workorders: meal.workorders,
        submeals,
        allPresent: missing.length === 0,
        allSufficient: submeals.every(s => s.sufficient),
        missing,
      };
    })
    .sort((a, b) => a.missing.length - b.missing.length);
}

export function PlhReadyToPlateBoard({ rows, onTrace, onWoDetail }: {
  rows: PlhReadiness[];
  onTrace: (sku: string) => void;
  onWoDetail: (wo: string) => void;
}) {
  const ready = rows.filter(row => row.allPresent);
  const almost = rows.filter(row => !row.allPresent && row.missing.length <= 2);
  const partial = rows.filter(row => !row.allPresent && row.missing.length > 2 && row.submeals.some(s => s.present));
  const all = [...ready, ...almost, ...partial];
  if (all.length === 0) return null;

  return (
    <section className="card overflow-hidden border-emerald-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-200 bg-emerald-950 px-4 py-3 text-white">
        <div>
          <div className="text-sm font-bold">🧊 PLH-Bereitschaft — jetzt plaiten?</div>
          <div className="mt-0.5 text-[11px] text-emerald-200">Meals, bei denen aktuell alle Submeals im Plating Holding liegen</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {ready.length > 0 && <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 font-bold">{ready.length} bereit</span>}
          {almost.length > 0 && <span className="rounded-full bg-amber-600 px-2.5 py-0.5 font-bold">{almost.length} fast</span>}
          {partial.length > 0 && <span className="rounded-full bg-slate-600 px-2.5 py-0.5">{partial.length} teilw.</span>}
        </div>
      </div>

      {ready.length === 0 && almost.length === 0 && (
        <div className="px-4 py-3 text-sm text-slate-400">Aktuell kein Meal komplett im PLH.</div>
      )}

      <div className="divide-y divide-slate-100">
        {all.map(row => (
          <PlhMealCard key={row.sku} row={row} onTrace={onTrace} onWoDetail={onWoDetail} />
        ))}
      </div>
    </section>
  );
}

function PlhMealCard({ row, onTrace, onWoDetail }: {
  row: PlhReadiness;
  onTrace: (sku: string) => void;
  onWoDetail: (wo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentCount = row.submeals.filter(s => s.present).length;
  const totalCount = row.submeals.length;
  const pct = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
  const isReady = row.allPresent;
  const isAlmost = !row.allPresent && row.missing.length <= 2;

  const ringSize = 44;
  const strokeWidth = 5;
  const radius = (ringSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <div className={`transition-colors ${isReady ? "bg-emerald-50/30" : isAlmost ? "bg-amber-50/20" : "bg-white"}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50/60 transition-colors"
      >
        {/* Ring-Diagramm */}
        <div className="relative flex-shrink-0" style={{ width: ringSize, height: ringSize }}>
          <svg width={ringSize} height={ringSize} className="rotate-[-90deg]">
            <circle cx={ringSize / 2} cy={ringSize / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-slate-200" />
            <circle
              cx={ringSize / 2} cy={ringSize / 2} r={radius} fill="none"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              className={isReady ? "text-emerald-500" : isAlmost ? "text-amber-500" : "text-slate-400"}
              stroke="currentColor"
            />
          </svg>
          <span className={`absolute inset-0 flex items-center justify-center text-[10px] font-bold ${isReady ? "text-emerald-700" : isAlmost ? "text-amber-700" : "text-slate-600"}`}>
            {presentCount}/{totalCount}
          </span>
        </div>

        {/* Meal-Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-slate-800">{row.sku}</span>
            {isReady && <span className="rounded bg-emerald-100 border border-emerald-300 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800 uppercase tracking-wide">Bereit</span>}
            {isAlmost && <span className="rounded bg-amber-100 border border-amber-300 px-1.5 py-0.5 text-[9px] font-bold text-amber-800 uppercase tracking-wide">Fast bereit</span>}
          </div>
          <div className="text-xs text-slate-600 truncate mt-0.5">{row.name}</div>
          {!isReady && row.missing.length > 0 && (
            <div className="text-[10px] text-rose-600 mt-0.5 truncate">
              fehlt: {row.missing.map(m => m.name || m.sku).join(" · ")}
            </div>
          )}
        </div>

        {/* WO-Buttons */}
        <div className="flex-shrink-0 flex flex-wrap gap-1 max-w-[120px] justify-end">
          {row.workorders.slice(0, 2).map(wo => (
            <span key={wo} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[9px] text-slate-600">{wo}</span>
          ))}
        </div>

        {/* Expand-Arrow */}
        <svg className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded Submeal Detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1">
          {/* Segmentleiste */}
          <div className="flex gap-px rounded overflow-hidden h-2 mb-3">
            {row.submeals.map((s, i) => (
              <div
                key={i}
                className={`flex-1 transition-colors ${
                  s.present
                    ? s.sufficient ? "bg-emerald-500" : "bg-amber-400"
                    : "bg-rose-300"
                }`}
              />
            ))}
          </div>

          {/* Submeal-Tabelle */}
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                <th className="py-1.5 text-left font-medium">Submeal</th>
                <th className="py-1.5 text-right font-medium">Benötigt</th>
                <th className="py-1.5 text-right font-medium">Im PLH</th>
                <th className="py-1.5 text-right font-medium">Deckung</th>
                <th className="py-1.5 text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {row.submeals.map((s, i) => {
                const coverage = s.required > 0 ? Math.round((s.inPlatingHolding / s.required) * 100) : (s.inPlatingHolding > 0 ? 100 : 0);
                return (
                  <tr
                    key={i}
                    className={`group cursor-pointer transition-colors ${!s.present ? "bg-rose-50/40" : "hover:bg-slate-50"}`}
                    onClick={(e) => { e.stopPropagation(); onTrace(s.sku); }}
                  >
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.present ? (s.sufficient ? "bg-emerald-500" : "bg-amber-500") : "bg-rose-400"}`} />
                        <span className="font-mono text-[10px] text-slate-500 group-hover:text-violet-700">{s.sku}</span>
                        <span className="text-slate-700 truncate max-w-[180px]">{s.name}</span>
                      </div>
                    </td>
                    <td className="py-1.5 text-right font-mono text-slate-600">{fmtQty(s.required)}</td>
                    <td className={`py-1.5 text-right font-mono font-semibold ${s.present ? (s.sufficient ? "text-emerald-700" : "text-amber-700") : "text-rose-600"}`}>
                      {s.inPlatingHolding > 0 ? fmtQty(s.inPlatingHolding) : "—"}
                    </td>
                    <td className="py-1.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <div className="w-10 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${coverage >= 100 ? "bg-emerald-500" : coverage > 50 ? "bg-amber-400" : "bg-rose-400"}`}
                            style={{ width: `${Math.min(100, coverage)}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-400 w-7 text-right">{coverage}%</span>
                      </div>
                    </td>
                    <td className="py-1.5 text-center">
                      {s.present ? (
                        s.sufficient
                          ? <span className="inline-block w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] leading-4 font-bold">✓</span>
                          : <span className="inline-block w-4 h-4 rounded-full bg-amber-100 text-amber-700 text-[10px] leading-4 font-bold">△</span>
                      ) : (
                        <span className="inline-block w-4 h-4 rounded-full bg-rose-100 text-rose-700 text-[10px] leading-4 font-bold">✗</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Action-Buttons */}
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTrace(row.sku); }}
              className="text-[10px] font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded px-2.5 py-1 transition-colors"
            >
              🔍 Meal tracen
            </button>
            {row.workorders.map(wo => (
              <button
                key={wo}
                type="button"
                onClick={(e) => { e.stopPropagation(); onWoDetail(wo); }}
                className="text-[10px] font-mono text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded px-2 py-1 transition-colors"
              >
                WO {wo}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function MealOperationsBoard({ rows, onTrace, onWoDetail }: {
  rows: MealOperation[];
  onTrace: (sku: string) => void;
  onWoDetail: (wo: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-950 px-4 py-3 text-white">
        <div><div className="text-sm font-bold">Meal-Status</div><div className="mt-0.5 text-[11px] text-slate-400">Soll aus Wochenplan · fertig nur aus Plating · Rack/WIP aus Post-Blast · unterwegs aus Sleeving</div></div>
        <div className="text-xs text-slate-300"><strong className="text-white">{rows.filter(row => row.open > 0).length}</strong> offen</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Meal / WOs</th>
              <th className="px-3 py-2 text-right">Benötigt</th>
              <th className="px-3 py-2 text-right">Fertig</th>
              <th className="px-3 py-2 text-right">Noch offen</th>
              <th className="px-3 py-2 text-left">Rack / WIP</th>
              <th className="px-3 py-2 text-right">Unterwegs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(row => {
              const completion = row.required > 0 ? Math.min(100, Math.round(row.finished / row.required * 100)) : 0;
              return <tr key={row.sku} className="hover:bg-slate-50">
                <td className="px-3 py-2">
                  <button type="button" className="font-mono text-[11px] font-bold text-violet-700 hover:underline" onClick={() => onTrace(row.sku)}>{row.sku}</button>
                  <div className="max-w-[18rem] truncate text-slate-700" title={row.name}>{row.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">{row.workorders.slice(0, 3).map(wo => <button key={wo} type="button" onClick={() => onWoDetail(wo)} className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 font-mono text-[9px] text-violet-700 hover:bg-violet-100">{wo}</button>)}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">{fmtQty(row.required)}</td>
                <td className="px-3 py-2 text-right"><div className="font-mono font-bold text-emerald-700">{fmtQty(row.finished)}</div><div className="ml-auto mt-1 h-1.5 w-14 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${completion}%` }} /></div></td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${row.open > 0 ? "text-rose-700" : "text-emerald-700"}`}>{fmtQty(row.open)}</td>
                <td className="px-3 py-2"><div className={row.rackWip > 0 ? "font-mono font-semibold text-rose-700" : "text-slate-400"}>{row.rackWip > 0 ? `${fmtQty(row.rackWip)} · ${row.rackCount} HU` : "–"}</div>{row.rackLocations.length > 0 && <div className="mt-0.5 max-w-[12rem] truncate font-mono text-[9px] text-slate-500" title={row.rackLocations.join(", ")}>{row.rackLocations.join(", ")}</div>}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${row.inTransit > 0 ? "text-sky-700" : "text-slate-300"}`}>{row.inTransit > 0 ? fmtQty(row.inTransit) : "–"}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}