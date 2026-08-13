import type { AggSleevingRow, AggStoredRow, AggWorkorderMeal } from "./wmsTypes";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { fmtQty, skuKey } from "./wmsFormat";

export type MealOperation = {
  sku: string;
  name: string;
  required: number;
  finished: number;
  rackWip: number;
  rackCount: number;
  rackLocations: string[];
  inTransit: number;
  workorders: string[];
  open: number;
};

function sumBySku(rows: AggStoredRow[], sku: string) {
  return rows.filter(row => row.sku === sku).reduce((sum, row) => sum + row.totalQty, 0);
}

export function buildMealOperations(
  meals: AggWorkorderMeal[],
  plating: AggStoredRow[],
  postblast: AggStoredRow[],
  sleeving: AggSleevingRow[],
  skuInfoIndex: Map<string, WmsSkuInfo>,
): MealOperation[] {
  return meals.map(meal => {
    const sku = skuKey(meal.mealSku);
    const info = skuInfoIndex.get(sku);
    const finished = sumBySku(plating, sku);
    const postblastRows = postblast.filter(row => row.sku === sku);
    const rackWip = postblastRows.reduce((sum, row) => sum + row.totalQty, 0);
    const racks = new Set(postblastRows.flatMap(row => row.hus));
    const rackLocations = [...new Set(postblastRows.map(row => row.location).filter(Boolean))];
    const sleevingRow = sleeving.find(row => row.sku === sku);
    const inTransit = Math.max(0, sleevingRow?.net ?? 0);
    const required = info?.plannedQty || meal.totalQty;
    return {
      sku,
      name: info?.name || meal.mealName,
      required,
      finished,
      rackWip,
      rackCount: racks.size,
      rackLocations,
      inTransit,
      workorders: [...new Set(meal.submeals.map(submeal => submeal.woNumber).filter(Boolean))],
      open: Math.max(0, required - finished),
    };
  }).sort((a, b) => b.open - a.open || b.required - a.required);
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