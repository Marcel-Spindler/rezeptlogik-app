// WMS Übersicht – Timeline-Panel: Auto-Snapshots über Zeit, Meal-Grid mit
// Katalog-Matching (FV/FE-Codes, Namen, Readiness), Gap-Feed.
import { useMemo, useState } from "react";
import { fmtQty } from "./wmsFormat";
import type { TimelineMealState, TimelineSnapshot } from "./wmsSnapshots";
import type { MealOperation } from "./WmsMealOperations";
import type { DataBundle } from "../../core/types";

type ViewMode = "grid" | "flow" | "gaps";

export function WmsTimelinePanel({ timeline, currentMeals, data, onTrace }: {
  timeline: TimelineSnapshot[];
  currentMeals: MealOperation[];
  data: DataBundle;
  onTrace: (sku: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selectedSnapIdx, setSelectedSnapIdx] = useState<number | null>(null);

  const viewingSnap = selectedSnapIdx != null ? timeline[selectedSnapIdx] : null;
  const viewingMeals: TimelineMealState[] = viewingSnap?.meals ?? currentMeals.map(m => ({
    mealSku: m.sku,
    mealName: m.name,
    recipeCode: m.name.match(/\b(F[VE]\d{3,4}[A-Z]?)\b/)?.[1] ?? "",
    required: m.required,
    finished: m.finished,
    readinessPct: m.readinessPct,
    submeals: m.submeals.map(s => ({
      sku: s.sku, name: s.name, required: s.required,
      gramsPerPortion: s.gramsPerPortion, requiredPortions: s.requiredPortions,
      total: s.total, totalPortions: s.totalPortions, gap: s.gap, gapPortions: s.gapPortions,
      status: s.status,
      platingHolding: s.inPlatingHolding, postBlast: s.inPostBlast, debox: s.inDebox, staging: s.inStaging, sleeving: s.inSleeving,
    })),
  }));

  // Gap-Events: Diffs between consecutive snapshots
  const gapEvents = useMemo(() => {
    const events: { time: string; mealName: string; recipeCode: string; sku: string; subName: string; from: string; to: string; gap: number }[] = [];
    for (let i = 0; i < timeline.length - 1; i++) {
      const newer = timeline[i];
      const older = timeline[i + 1];
      for (const meal of newer.meals) {
        const oldMeal = older.meals.find(m => m.mealSku === meal.mealSku);
        if (!oldMeal) continue;
        for (const sub of meal.submeals) {
          const oldSub = oldMeal.submeals.find(s => s.sku === sub.sku);
          if (!oldSub) continue;
          if (oldSub.status !== sub.status) {
            events.push({
              time: newer.timestamp,
              mealName: meal.mealName,
              recipeCode: meal.recipeCode,
              sku: sub.sku,
              subName: sub.name,
              from: oldSub.status,
              to: sub.status,
              gap: sub.gap,
            });
          }
        }
      }
    }
    return events;
  }, [timeline]);

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  const recipeInfo = (code: string) => {
    if (!code) return null;
    const recipe = data.recipes[code];
    if (!recipe) return null;
    return { name: recipe.baseName, photo: recipe.catalog?.photoUrl };
  };

  return (
    <div className="space-y-3">
      {/* Timeline Scrubber */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-base">🕐</span>
            <span className="text-xs font-bold text-slate-700 uppercase">Timeline</span>
            <span className="text-[10px] text-slate-400 font-mono">{timeline.length} Snapshots (48h)</span>
          </div>
          <div className="flex gap-1">
            {(["grid", "flow", "gaps"] as ViewMode[]).map(mode => (
              <button key={mode} type="button" onClick={() => setViewMode(mode)}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold ${viewMode === mode ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {mode === "grid" ? "🎯 Meal-Grid" : mode === "flow" ? "📊 SKU-Flow" : "🚨 Gap-Feed"}
              </button>
            ))}
          </div>
        </div>
        {timeline.length > 0 ? (
          <div className="flex items-center gap-0.5 overflow-x-auto py-1">
            <button type="button" onClick={() => setSelectedSnapIdx(null)}
              className={`shrink-0 px-2 py-1 rounded text-[9px] font-semibold ${selectedSnapIdx == null ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>
              JETZT
            </button>
            {timeline.map((snap, i) => {
              const avgReadiness = snap.meals.length > 0 ? Math.round(snap.meals.reduce((s, m) => s + m.readinessPct, 0) / snap.meals.length) : 0;
              const dotColor = avgReadiness >= 80 ? "bg-emerald-500" : avgReadiness >= 50 ? "bg-amber-500" : "bg-rose-500";
              return (
                <button key={snap.id} type="button" onClick={() => setSelectedSnapIdx(i)}
                  title={`${fmtTime(snap.timestamp)} — ${avgReadiness}% bereit`}
                  className={`shrink-0 flex flex-col items-center gap-0.5 px-1.5 py-1 rounded ${selectedSnapIdx === i ? "bg-slate-800 text-white" : "hover:bg-slate-100"}`}>
                  <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
                  <span className="text-[8px] font-mono text-slate-500">{fmtTime(snap.timestamp)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-slate-400 text-center py-3">Noch keine Timeline-Snapshots. Live-Mode starten um automatisch zu erfassen.</div>
        )}
        {viewingSnap && (
          <div className="mt-1 text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 font-semibold">
            Zeige Zustand von {fmtTime(viewingSnap.timestamp)} — {new Date(viewingSnap.timestamp).toLocaleDateString("de-DE")}
          </div>
        )}
      </div>

      {/* ── View: Meal-Grid ── */}
      {viewMode === "grid" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {viewingMeals.map(meal => {
            const info = recipeInfo(meal.recipeCode);
            const missingCount = meal.submeals.filter(s => s.status === "missing").length;
            const partialCount = meal.submeals.filter(s => s.status === "partial").length;
            return (
              <div key={meal.mealSku} className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                {info?.photo && (
                  <div className="h-24 overflow-hidden bg-slate-100">
                    <img src={info.photo} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {meal.recipeCode && (
                        <div className="text-[10px] font-bold text-violet-600 font-mono">{meal.recipeCode}</div>
                      )}
                      <div className="text-sm font-semibold text-slate-800 truncate" title={info?.name || meal.mealName}>
                        {info?.name || meal.mealName}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 mt-0.5">{meal.mealSku}</div>
                    </div>
                    {/* Readiness Ring */}
                    <div className="relative w-10 h-10 shrink-0">
                      <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="15" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                        <circle cx="18" cy="18" r="15" fill="none"
                          stroke={meal.readinessPct >= 100 ? "#10b981" : meal.readinessPct >= 60 ? "#f59e0b" : "#ef4444"}
                          strokeWidth="3" strokeDasharray={`${meal.readinessPct * 0.94} 94`} strokeLinecap="round" />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-slate-700">
                        {meal.readinessPct}%
                      </span>
                    </div>
                  </div>
                  {/* Stats */}
                  <div className="flex gap-2 mt-2 text-[10px]">
                    <span className="font-mono text-slate-600">Soll: {fmtQty(meal.required)}</span>
                    <span className="font-mono text-emerald-700">Fertig: {fmtQty(meal.finished)}</span>
                  </div>
                  {/* Submeal Status Dots */}
                  <div className="flex flex-wrap gap-0.5 mt-2">
                    {meal.submeals.map(s => (
                      <span key={s.sku} title={`${s.name}: ${s.status} (${fmtQty(s.total)}/${fmtQty(s.required)})`}
                        className={`w-2 h-2 rounded-full ${s.status === "ready" ? "bg-emerald-500" : s.status === "partial" ? "bg-amber-500" : "bg-rose-500"}`} />
                    ))}
                  </div>
                  {(missingCount > 0 || partialCount > 0) && (
                    <div className="mt-2 text-[10px] space-y-0.5">
                      {meal.submeals.filter(s => s.status !== "ready").slice(0, 3).map(s => (
                        <div key={s.sku} className={`flex justify-between ${s.status === "missing" ? "text-rose-700" : "text-amber-700"}`}>
                          <span className="truncate max-w-[140px]">{s.name}</span>
                          <span className="font-mono shrink-0">−{fmtQty(s.gap)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── View: SKU-Flow ── */}
      {viewMode === "flow" && (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500">Meal</th>
                  <th className="px-2 py-2 text-left text-[10px] font-semibold text-slate-500">Submeal</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-500">Soll</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-indigo-500">🧊 PLH</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-rose-500">❄️ Post-B</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-orange-500">📂 Debox</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-amber-500">🗄️ Staging</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-sky-500">🔄 Sleev</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-slate-700">Total</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-emerald-700">Portionen</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-rose-700">Fehlt (Port.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {viewingMeals.flatMap(meal =>
                  meal.submeals.filter(s => s.status !== "ready").map(s => (
                    <tr key={`${meal.mealSku}-${s.sku}`} className="hover:bg-slate-50">
                      <td className="px-2 py-1.5">
                        <div className="text-[9px] font-mono text-violet-600">{meal.recipeCode}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => onTrace(s.sku)} className="text-slate-700 hover:underline truncate max-w-[160px] block">{s.name}</button>
                        <div className="text-[9px] font-mono text-slate-400">{s.sku}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-slate-600">{fmtQty(s.required)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-indigo-700">{s.platingHolding > 0 ? fmtQty(s.platingHolding) : "–"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-rose-600">{s.postBlast > 0 ? fmtQty(s.postBlast) : "–"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-orange-600">{s.debox > 0 ? fmtQty(s.debox) : "–"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-600">{s.staging > 0 ? fmtQty(s.staging) : "–"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-sky-600">{s.sleeving > 0 ? fmtQty(s.sleeving) : "–"}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtQty(s.total)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold text-emerald-700">
                        {s.totalPortions > 0 ? `${s.totalPortions.toLocaleString("de-DE")} Port.` : "–"}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono font-bold text-rose-700">
                        {s.gapPortions > 0 ? `−${s.gapPortions.toLocaleString("de-DE")} Port.` : s.gap > 0 ? `−${fmtQty(s.gap)}` : "✓"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── View: Gap-Feed ── */}
      {viewMode === "gaps" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          {gapEvents.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-6">Keine Status-Änderungen in der Timeline erfasst. Live-Mode laufen lassen um Events zu sammeln.</div>
          ) : (
            gapEvents.slice(0, 50).map((ev, i) => {
              const isAlert = ev.to === "missing";
              const isRecovery = ev.from === "missing" && ev.to !== "missing";
              return (
                <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${isAlert ? "border-rose-200 bg-rose-50" : isRecovery ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0 w-10">{fmtTime(ev.time)}</span>
                  <span className={`shrink-0 ${isAlert ? "text-rose-600" : isRecovery ? "text-emerald-600" : "text-amber-600"}`}>
                    {isAlert ? "🚨" : isRecovery ? "✅" : "⚠️"}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800">
                      <span className="font-mono text-violet-600">{ev.recipeCode}</span>
                      {" — "}
                      <button type="button" onClick={() => onTrace(ev.sku)} className="hover:underline">{ev.subName}</button>
                    </div>
                    <div className="text-slate-500">
                      {isAlert ? `Fehlt jetzt komplett (−${fmtQty(ev.gap)})` : isRecovery ? "Wieder verfügbar" : `${ev.from} → ${ev.to}`}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
