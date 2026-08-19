// Postblast Live View — Echtzeit-Dashboard: GSheet-Wiegungen vs. geplante Work Orders.
import { useMemo } from "react";
import type { DataBundle } from "../../core/types";
import { usePostblastMonitor } from "./useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed } from "./postblastMatch";
import { generateBackfillPlan, exportBackfillPlanExcel } from "./backfillGenerator";
import { analyzeProduction, type AlertSeverity } from "./productionAgent";
import { fmt, fmtMass } from "../whatif/whatIfFormat";

function ProgressBar({ pct, size = "md" }: { pct: number; size?: "sm" | "md" }) {
  const h = size === "sm" ? "h-2" : "h-3";
  const color = pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`w-full ${h} rounded-full bg-slate-200 overflow-hidden`}>
      <div className={`${h} rounded-full ${color} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: BackfillNeed["priority"] }) {
  const cls = priority === "critical" ? "bg-red-200 text-red-800" : priority === "behind" ? "bg-amber-200 text-amber-800" : "bg-emerald-100 text-emerald-700";
  const label = priority === "critical" ? "KRITISCH" : priority === "behind" ? "HINTER PLAN" : "OK";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>{label}</span>;
}

function AlertIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "critical") return <span className="text-red-600">●</span>;
  if (severity === "warning") return <span className="text-amber-500">●</span>;
  if (severity === "info") return <span className="text-sky-500">●</span>;
  return <span className="text-emerald-500">●</span>;
}

export function PostblastLiveView({ data }: { data: DataBundle }): JSX.Element {
  const postblastMonitor = usePostblastMonitor();

  const { matched, meals, backfill } = useMemo(
    () => matchPostblastToWorkOrders(postblastMonitor.data, data.productionPlan),
    [postblastMonitor.data, data.productionPlan]
  );

  const totalPlanned = meals.reduce((s, m) => s + m.totalPlannedKg, 0);
  const totalActual = meals.reduce((s, m) => s + m.totalActualKg, 0);
  const overallPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
  const criticalCount = backfill.filter(b => b.priority === "critical").length;
  const behindCount = backfill.filter(b => b.priority === "behind").length;

  // Production Intelligence Agent
  const intelligence = useMemo(() => {
    const plan = generateBackfillPlan(backfill, data);
    return analyzeProduction(postblastMonitor.data, meals, plan, data.productionPlan);
  }, [postblastMonitor.data, meals, backfill, data]);

  const lastUpdate = postblastMonitor.lastUpdate
    ? new Date(postblastMonitor.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="card p-5 bg-gradient-to-r from-teal-50 to-cyan-50 border-2 border-teal-200">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              Postblast Live Monitor
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Echtzeit-Wiegungen aus GSheet vs. geplante Work Orders
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-xs">
            <div className={`px-3 py-1 rounded-full ring-1 ${postblastMonitor.isPolling ? "bg-emerald-100 ring-emerald-300 text-emerald-800" : "bg-slate-100 ring-slate-300"}`}>
              {postblastMonitor.isPolling ? `Live · ${lastUpdate}` : "Offline"}
            </div>
            {postblastMonitor.error && (
              <div className="px-3 py-1 rounded-full bg-red-100 ring-1 ring-red-300 text-red-800">
                {postblastMonitor.error}
              </div>
            )}
          </div>
        </div>

        {/* GESAMT-FORTSCHRITT */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="font-bold text-slate-700">Gesamtfortschritt</span>
            <span className="font-mono font-bold">{fmt(overallPct, 1)}% · {fmtMass(totalActual * 1000)} / {fmtMass(totalPlanned * 1000)}</span>
          </div>
          <ProgressBar pct={overallPct} />
        </div>

        <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <div className="bg-white/70 rounded-lg p-2 text-center">
            <div className="text-slate-500 uppercase font-bold">Meals</div>
            <div className="text-lg font-bold">{meals.length}</div>
          </div>
          <div className="bg-white/70 rounded-lg p-2 text-center">
            <div className="text-slate-500 uppercase font-bold">Work Orders</div>
            <div className="text-lg font-bold">{matched.length}</div>
          </div>
          <div className="bg-white/70 rounded-lg p-2 text-center">
            <div className="text-slate-500 uppercase font-bold">Fertig</div>
            <div className="text-lg font-bold text-emerald-700">{matched.filter(m => m.isComplete).length}</div>
          </div>
          <div className="bg-white/70 rounded-lg p-2 text-center">
            <div className="text-slate-500 uppercase font-bold">Kritisch</div>
            <div className="text-lg font-bold text-red-700">{criticalCount}</div>
          </div>
          <div className="bg-white/70 rounded-lg p-2 text-center">
            <div className="text-slate-500 uppercase font-bold">Hinter Plan</div>
            <div className="text-lg font-bold text-amber-700">{behindCount}</div>
          </div>
        </div>
      </div>

      {/* PRODUCTION INTELLIGENCE AGENT */}
      {(intelligence.alerts.length > 0 || intelligence.recommendations.length > 0) && (
        <div className="card p-5 border-2 border-purple-200 bg-gradient-to-r from-purple-50/50 to-fuchsia-50/30">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-lg font-bold text-slate-800">KI Produktions-Agent</h3>
            {intelligence.shiftSummary && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                intelligence.shiftSummary.overallHealth === "good" ? "bg-emerald-200 text-emerald-800" :
                intelligence.shiftSummary.overallHealth === "warning" ? "bg-amber-200 text-amber-800" :
                "bg-red-200 text-red-800"
              }`}>
                {intelligence.shiftSummary.overallHealth === "good" ? "ON TRACK" :
                 intelligence.shiftSummary.overallHealth === "warning" ? "ACHTUNG" : "KRITISCH"}
              </span>
            )}
          </div>

          {/* Schicht-Zusammenfassung */}
          {intelligence.shiftSummary && (
            <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Gewogen heute</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.totalWeighed, 1)} kg</div>
              </div>
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Tempo</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.entriesPerHour, 1)} /h</div>
              </div>
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Prognose Schichtende</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.projectedEndOfShift, 0)} kg</div>
              </div>
              {intelligence.shiftSummary.shortfallAtEndOfShift > 0 && (
                <div className="bg-red-100/70 rounded-lg p-2">
                  <div className="text-red-700 uppercase font-bold">Fehlprognose</div>
                  <div className="text-sm font-bold font-mono text-red-700">-{fmt(intelligence.shiftSummary.shortfallAtEndOfShift, 0)} kg</div>
                </div>
              )}
            </div>
          )}

          {/* Alerts */}
          {intelligence.alerts.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {intelligence.alerts.slice(0, 8).map(alert => (
                <div key={alert.id} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                  alert.severity === "critical" ? "bg-red-100/70 ring-1 ring-red-200" :
                  alert.severity === "warning" ? "bg-amber-100/70 ring-1 ring-amber-200" :
                  "bg-white/70 ring-1 ring-slate-200"
                }`}>
                  <AlertIcon severity={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-800">{alert.title}</div>
                    <div className="text-slate-600 mt-0.5">{alert.message}</div>
                    {alert.suggestedAction && (
                      <div className="mt-1 text-purple-700 font-medium">→ {alert.suggestedAction}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empfehlungen */}
          {intelligence.recommendations.length > 0 && (
            <div className="bg-white/70 rounded-lg p-3 ring-1 ring-purple-200">
              <div className="text-[10px] uppercase font-bold text-purple-700 mb-1.5">Empfehlungen</div>
              <ul className="space-y-1 text-xs text-slate-700">
                {intelligence.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-purple-500 shrink-0">▸</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* MEAL PROGRESS */}
      {meals.length > 0 && (
        <div className="card p-5">
          <h3 className="text-lg font-bold text-slate-800 mb-3">Fortschritt je Meal</h3>
          <div className="space-y-3">
            {meals.map(meal => (
              <div key={meal.recipeCode} className={`rounded-xl border p-3 ${meal.criticalWOs.length > 0 ? "border-red-300 bg-red-50/30" : "border-slate-200"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-slate-800 truncate">{meal.recipeCode} · {meal.recipeName}</div>
                    <div className="text-[11px] text-slate-500">{meal.completedWOs}/{meal.totalWOs} WOs fertig · {fmt(meal.plannedMeals)} Meals geplant</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-mono font-bold">{fmt(meal.progressPct, 0)}%</div>
                    <div className="text-[10px] text-slate-500">{fmtMass(meal.totalActualKg * 1000)} / {fmtMass(meal.totalPlannedKg * 1000)}</div>
                  </div>
                </div>
                <div className="mt-2">
                  <ProgressBar pct={meal.progressPct} size="sm" />
                </div>
                {meal.criticalWOs.length > 0 && (
                  <div className="mt-2 text-[11px] text-red-700">
                    Kritisch: {meal.criticalWOs.map(w => w.subRecipe).join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* BACKFILL-RECHNER */}
      {backfill.length > 0 && (
        <div className="card p-5 border-2 border-amber-200 bg-amber-50/30">
          <h3 className="text-lg font-bold text-slate-800 mb-1">Backfill-Bedarf</h3>
          <p className="text-sm text-slate-600 mb-3">Work Orders die noch produziert werden müssen — sortiert nach fehlendem Gewicht</p>

          <div className="overflow-hidden rounded-xl ring-1 ring-amber-200">
            <div className="max-h-[500px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-amber-100 text-[10px] uppercase tracking-wide text-amber-800">
                  <tr>
                    <th className="px-3 py-2 text-left">WO</th>
                    <th className="px-3 py-2 text-left">Sub-Rezept</th>
                    <th className="px-3 py-2 text-left">Meal</th>
                    <th className="px-3 py-2 text-right">Fehlt (kg)</th>
                    <th className="px-3 py-2 text-right">Fehlt %</th>
                    <th className="px-3 py-2 text-right">~ Portionen</th>
                    <th className="px-3 py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100 bg-white">
                  {backfill.map(b => (
                    <tr key={b.workOrder} className={b.priority === "critical" ? "bg-red-50/50" : ""}>
                      <td className="px-3 py-2 font-mono font-bold">{b.workOrder}</td>
                      <td className="px-3 py-2 font-medium truncate max-w-[200px]">{b.subRecipe}</td>
                      <td className="px-3 py-2 text-slate-500 truncate max-w-[150px]">{b.recipeCode}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-red-700">{fmt(b.missingKg, 2)} kg</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(b.missingPct, 0)}%</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(b.estimatedPortions)}</td>
                      <td className="px-3 py-2 text-center"><PriorityBadge priority={b.priority} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="bg-white rounded-lg p-2 ring-1 ring-amber-200">
              <div className="text-amber-700 uppercase font-bold">Gesamt fehlt</div>
              <div className="text-lg font-bold font-mono">{fmtMass(backfill.reduce((s, b) => s + b.missingKg, 0) * 1000)}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-red-200">
              <div className="text-red-700 uppercase font-bold">Kritische WOs</div>
              <div className="text-lg font-bold font-mono text-red-700">{backfill.filter(b => b.priority === "critical").length}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-amber-200">
              <div className="text-amber-700 uppercase font-bold">Hinter Plan</div>
              <div className="text-lg font-bold font-mono text-amber-700">{backfill.filter(b => b.priority === "behind").length}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-slate-200">
              <div className="text-slate-600 uppercase font-bold">~ Portionen fehlen</div>
              <div className="text-lg font-bold font-mono">{fmt(backfill.reduce((s, b) => s + b.estimatedPortions, 0))}</div>
            </div>
          </div>
        </div>
      )}

      {/* BACKFILL WO GENERATOR */}
      {backfill.length > 0 && (() => {
        const plan = generateBackfillPlan(backfill, data);
        const weekLabel = data.productionPlan?.week ?? "KW??";
        return (
          <div className="card p-5 border-2 border-rose-200 bg-gradient-to-br from-rose-50/50 to-white">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Backfill Work Orders</h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  Automatisch generierte Nachproduktions-WOs mit Equipment-Zuordnung und Chargenberechnung
                </p>
              </div>
              <button
                onClick={() => void exportBackfillPlanExcel(plan, weekLabel)}
                className="btn btn-primary text-xs shrink-0"
              >
                Excel Export
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
              <div className="bg-white rounded-lg p-2 ring-1 ring-rose-200 text-center">
                <div className="text-rose-700 uppercase font-bold">WOs</div>
                <div className="text-lg font-bold">{plan.proposals.length}</div>
              </div>
              <div className="bg-white rounded-lg p-2 ring-1 ring-rose-200 text-center">
                <div className="text-rose-700 uppercase font-bold">Chargen</div>
                <div className="text-lg font-bold">{plan.totalBatches}</div>
              </div>
              <div className="bg-white rounded-lg p-2 ring-1 ring-rose-200 text-center">
                <div className="text-rose-700 uppercase font-bold">Gesamt kg</div>
                <div className="text-lg font-bold font-mono">{fmt(plan.totalKg, 1)}</div>
              </div>
              <div className="bg-white rounded-lg p-2 ring-1 ring-rose-200 text-center">
                <div className="text-rose-700 uppercase font-bold">Portionen</div>
                <div className="text-lg font-bold font-mono">{fmt(plan.totalPortions)}</div>
              </div>
              <div className="bg-white rounded-lg p-2 ring-1 ring-red-300 text-center">
                <div className="text-red-700 uppercase font-bold">Kritisch</div>
                <div className="text-lg font-bold text-red-700">{plan.criticalCount}</div>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-rose-200">
              <div className="max-h-[400px] overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-rose-100 text-[10px] uppercase tracking-wide text-rose-800">
                    <tr>
                      <th className="px-3 py-2 text-left">Backfill-WO</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-left">Equipment</th>
                      <th className="px-3 py-2 text-right">Kapazität</th>
                      <th className="px-3 py-2 text-right">Chargen</th>
                      <th className="px-3 py-2 text-right">Fehlt</th>
                      <th className="px-3 py-2 text-right">Produziert</th>
                      <th className="px-3 py-2 text-right">Überschuss</th>
                      <th className="px-3 py-2 text-center">Prio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rose-100 bg-white">
                    {plan.proposals.map(p => (
                      <tr key={p.backfillWoNumber} className={p.priority === "critical" ? "bg-red-50/50" : ""}>
                        <td className="px-3 py-2">
                          <div className="font-mono font-bold">{p.backfillWoNumber}</div>
                          <div className="text-[10px] text-slate-400">← {p.originalWo}</div>
                        </td>
                        <td className="px-3 py-2 font-medium truncate max-w-[180px]" title={p.subRecipe}>{p.subRecipe}</td>
                        <td className="px-3 py-2">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-bold text-[10px]">{p.equipment}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{fmt(p.capacityKg, 0)} kg</td>
                        <td className="px-3 py-2 text-right font-mono font-bold">{p.batchCount}×</td>
                        <td className="px-3 py-2 text-right font-mono text-red-700">{fmt(p.missingKg, 1)} kg</td>
                        <td className="px-3 py-2 text-right font-mono text-indigo-700">{fmt(p.totalProducedKg, 1)} kg</td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-700">+{fmt(p.excessKg, 1)} kg</td>
                        <td className="px-3 py-2 text-center"><PriorityBadge priority={p.priority} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* LETZTE WIEGUNGEN (Live Feed) */}
      {postblastMonitor.data && postblastMonitor.data.entries.length > 0 && (
        <div className="card p-5">
          <h3 className="text-lg font-bold text-slate-800 mb-3">Letzte Wiegungen (Live Feed)</h3>
          <div className="max-h-72 overflow-auto rounded-xl ring-1 ring-slate-200">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Zeitpunkt</th>
                  <th className="px-3 py-2 text-left">WO</th>
                  <th className="px-3 py-2 text-left">Sub-Rezept</th>
                  <th className="px-3 py-2 text-right">Gewicht (kg)</th>
                  <th className="px-3 py-2 text-left">Sub-Sub</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {postblastMonitor.data.entries.slice(-30).reverse().map((e, idx) => (
                  <tr key={idx} className={idx === 0 ? "bg-emerald-50" : ""}>
                    <td className="px-3 py-2 font-mono text-slate-500">{e.timestamp}</td>
                    <td className="px-3 py-2 font-mono font-bold">{e.workOrder}</td>
                    <td className="px-3 py-2 font-medium">{e.subRecipeName}</td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">{fmt(e.rawWeightKg, 2)} kg</td>
                    <td className="px-3 py-2 text-slate-500">{e.subSubRecipe || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* NO DATA STATE */}
      {!postblastMonitor.data && !postblastMonitor.error && (
        <div className="card p-8 text-center text-slate-500">
          <div className="text-2xl mb-2">⏳</div>
          <div className="font-bold">Lade Postblast-Daten...</div>
          <div className="text-sm mt-1">Polling startet automatisch (alle 30 Sekunden)</div>
        </div>
      )}

      {!data.productionPlan && postblastMonitor.data && (
        <div className="card p-4 bg-amber-50 border border-amber-300 text-amber-900">
          <strong>Kein Produktionsplan geladen.</strong> Work-Order-Matching nicht möglich.
          Bitte <code>npm run import:local</code> mit aktuellem Transparency-Sheet ausführen.
        </div>
      )}
    </div>
  );
}
