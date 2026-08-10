// Modal: Sub-Rezept-Info — Bruttomengen, Batches, Container-/Tray-Bedarf, Lead-Zeit-Erklärung.
import type { PlannerDay, PlannerShift } from "../../../../lib/planner";
import type { SubRecipeInfoView } from "../recipeInfoHints";

export type SubRecipeInfoRequest = {
  recipeCode: string;
  recipeName: string;
  subRecipeId: string;
  subRecipeName: string;
  day: PlannerDay;
  shift: PlannerShift;
  targetPortions: number;
  /** Lead-Zeit in Küchentagen vor dem Bedarfstag (Fulfillment-Start) */
  leadDays: number;
  /** Tag des Haupt-Rezepts (= Plating / Need-Day), damit klar ist warum der Sub hier liegt */
  mainDay?: PlannerDay;
  category: string;
};

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function leadDaysExplanation(leadDays: number): string {
  if (leadDays >= 3) return "Kategorie erfordert ≥ 3 Tage Vorlauf (Brine / Cure / Ferment / Lagerzeit ≥ 24 h)";
  if (leadDays === 2) return "Kategorie erfordert 2 Tage Vorlauf (Sauce / Marinade / Slow Cook / Lagerzeit ≥ 12 h)";
  return "Kategorie erfordert 1 Tag Vorlauf (Grill / Blast Chiller / Portion / Standardprozess)";
}

interface Props {
  request: SubRecipeInfoRequest;
  info: SubRecipeInfoView | null;
  onClose: () => void;
}

export function SubRecipeInfoModal({ request, info, onClose }: Props) {
  const { leadDays: ld, mainDay: mDay, category: cat } = request;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-xl bg-white shadow-2xl ring-1 ring-slate-300" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between rounded-t-xl bg-amber-600 px-4 py-2 text-white">
          <div className="text-sm font-semibold">Subrezept-Info · {request.subRecipeName}</div>
          <button className="text-lg leading-none" onClick={onClose}>×</button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="grid gap-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-700 md:grid-cols-4">
            <div><span className="font-semibold">Rezept:</span> {request.recipeCode}</div>
            <div><span className="font-semibold">Tag/Schicht:</span> {request.day} / {request.shift}</div>
            <div><span className="font-semibold">Menge:</span> {fmtNum(request.targetPortions)} Portionen</div>
            <div><span className="font-semibold">Yield:</span> {info ? `${fmtNum(info.yieldRatio * 100, 1)}%` : "-"}</div>
          </div>

          {info && (
            <div className="grid gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-900 md:grid-cols-4">
              <div>
                <span className="font-semibold">Equipment:</span>{" "}
                {info.equipment ?? <span className="italic text-orange-400">unbekannt</span>}
              </div>
              <div>
                <span className="font-semibold">Kapazität/Batch:</span>{" "}
                {info.capacityKg != null ? `${fmtNum(info.capacityKg, 1)} kg` : <span className="italic text-orange-400">unbekannt</span>}
                <span className="ml-1 text-[10px] font-normal text-orange-500">
                  ({info.capacitySource === "bible" ? "Bible" : info.capacitySource === "process-spec" ? "PFEI" : "–"})
                </span>
              </div>
              <div>
                <span className="font-semibold">Rohware gesamt:</span> {fmtNum(info.totalRawKg, 2)} kg
              </div>
              <div>
                <span className="font-semibold">Batches:</span>{" "}
                {info.batchCount != null ? <span className="font-bold text-orange-800">{info.batchCount}</span> : <span className="italic text-orange-400">–</span>}
              </div>
            </div>
          )}

          {(ld || mDay) && (
            <div className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              <span className="mt-0.5 shrink-0 rounded-full bg-sky-600 px-2 py-0.5 text-[11px] font-bold text-white">D-{ld}</span>
              <div className="space-y-1">
                <div className="font-semibold">Warum liegt dieses Sub hier?</div>
                <div>{leadDaysExplanation(ld)}</div>
                {cat && <div className="text-sky-700">Kategorie: <span className="font-semibold">{cat}</span></div>}
                {mDay && (
                  <div>
                    Bedarfstag (Fulfillment-Start): <span className="font-semibold">{mDay}</span>
                    {" → "} Sub fertig bis: <span className="font-semibold">{request.day}</span>
                    {" "}({ld} Küchentag{ld !== 1 ? "e" : ""} früher)
                  </div>
                )}
              </div>
            </div>
          )}

          {info && info.ingredientRows.length > 0 ? (
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-semibold">Artikel</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Menge (roh)</th>
                    <th className="px-2 py-1.5 text-right font-semibold">kg (roh)</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Yield</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Fertigware</th>
                    <th className="px-2 py-1.5 text-right font-semibold">kg/Batch</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Container</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Anz.</th>
                  </tr>
                </thead>
                <tbody>
                  {info.ingredientRows.map(row => (
                    <tr key={`${row.ingredientId}-${row.uom}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1.5 text-slate-800">{row.ingredientName}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtNum(row.rawTotal, 1)} {row.uom}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{row.rawKg != null ? `${fmtNum(row.rawKg, 2)} kg` : "–"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtNum(row.yieldRatio * 100, 1)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtNum(row.finishedTotal, 1)} {row.uom}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-sky-700 font-semibold">{row.proBatchKg != null ? `${fmtNum(row.proBatchKg, 2)} kg` : "–"}</td>
                      <td className="px-2 py-1.5 text-slate-600">{row.containerType}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-900">{row.containerCount > 0 ? fmtNum(row.containerCount) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-200 bg-amber-50 text-xs font-semibold text-amber-900">
                  <tr>
                    <td className="px-2 py-1.5">Gesamt</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(info.totalRawKg, 2)} kg</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(info.totalFinishedKg, 2)} kg</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5">
                      {info.batchCount != null && (
                        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px]">
                          {info.batchCount} Wanne{info.batchCount !== 1 ? "n" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{info.totalContainerCount > 0 ? `${fmtNum(info.totalContainerCount)} Tray${info.totalContainerCount !== 1 ? "s" : ""}` : "–"}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Für dieses Subrezept wurden keine passenden Artikel im Gross-Ingredients-Dump gefunden.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
