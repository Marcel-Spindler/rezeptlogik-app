// Aufklappbare Meal-Fortschrittskarte — zeigt Fortschritt je Meal mit
// expandierbarer WO-Tabelle inkl. Wiegungsdetails.
import { type ReactElement } from "react";
import type { MealProgress, WoMatchedStatus, BackfillNeed } from "../gsheet-monitor/postblastMatch";
import type { RecipeWeightLookup } from "../gsheet-monitor/parsers/parseExportRecipes";
import { recipeWeightKey } from "../gsheet-monitor/parsers/parseExportRecipes";
import { fmt, fmtMass } from "../whatif/whatIfFormat";

// ─── Helpers ────────────────────────────────────────────────────────────────

function ProgressBar({ pct, size = "sm" }: { pct: number; size?: "xs" | "sm" }) {
  const h = size === "xs" ? "h-1.5" : "h-2";
  const auto = pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`w-full ${h} rounded-full bg-slate-200 overflow-hidden`}>
      <div className={`${h} rounded-full ${auto} transition-all duration-700`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function StatusBadge({ wo }: { wo: WoMatchedStatus }) {
  if (!wo.hasPlan)
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 ring-1 ring-slate-300 font-bold">○ OHNE PLAN</span>;
  const estSuffix = wo.isEstimated ? " ≈" : "";
  if (wo.isComplete)
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold">✓ FERTIG{estSuffix}</span>;
  if (wo.awaitingPostBlast)
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 font-bold">⏳ IM CHILLER{estSuffix}</span>;
  if (wo.isCritical)
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 ring-1 ring-red-200 font-bold">⚠ KRITISCH{estSuffix}</span>;
  return <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 ring-1 ring-sky-200 font-bold">LÄUFT{estSuffix}</span>;
}

function WoDots({ wos }: { wos: WoMatchedStatus[] }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
      {wos.map(wo => (
        <div
          key={wo.workOrder}
          title={`${wo.workOrder}: ${wo.subRecipe} (${Math.round(wo.progressPct)}%)`}
          className={`w-3 h-3 rounded-full border-2 border-white shadow-sm ${
            !wo.hasPlan ? "bg-white ring-1 ring-slate-300" :
            wo.isComplete ? "bg-emerald-400" :
            wo.awaitingPostBlast ? "bg-cyan-400 animate-pulse" :
            wo.isCritical ? "bg-red-500 animate-pulse" :
            wo.progressPct >= 60 ? "bg-sky-400" :
            wo.progressPct >= 20 ? "bg-amber-400" : "bg-slate-300"
          }`}
        />
      ))}
    </div>
  );
}

function computeMaxPlateable(
  meal: MealProgress,
  recipeWeights: RecipeWeightLookup | null,
): { meals: number; exact: boolean } | null {
  if (!recipeWeights) return null;
  const bySubRecipe = new Map<string, { actualKg: number; recipeCode: string; hasBlockingZero: boolean }>();
  for (const wo of meal.workOrders) {
    const key = wo.subRecipe;
    if (!bySubRecipe.has(key)) bySubRecipe.set(key, { actualKg: 0, recipeCode: wo.recipeCode, hasBlockingZero: false });
    const entry = bySubRecipe.get(key)!;
    entry.actualKg += wo.actualKg;
    if (wo.hasPlan && wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) entry.hasBlockingZero = true;
  }
  for (const entry of bySubRecipe.values()) {
    if (entry.actualKg > 0) entry.hasBlockingZero = false;
  }
  let minMeals = Infinity;
  let found = 0;
  for (const [subRecipe, { actualKg, recipeCode, hasBlockingZero }] of bySubRecipe) {
    const grams = recipeWeights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
    if (!grams || grams <= 0) { if (hasBlockingZero) { minMeals = 0; found++; } continue; }
    if (actualKg === 0 && !hasBlockingZero) continue;
    const maxFromThis = hasBlockingZero ? 0 : Math.floor(actualKg / (grams / 1000));
    found++;
    if (maxFromThis < minMeals) minMeals = maxFromThis;
  }
  if (found === 0) return null;
  return { meals: minMeals === Infinity ? 0 : minMeals, exact: true };
}

// ─── Hauptkomponente ────────────────────────────────────────────────────────

export interface MealProgressCardProps {
  meal: MealProgress;
  expanded: boolean;
  onToggle: () => void;
  backfillNeeds: BackfillNeed[];
  recipeWeights: RecipeWeightLookup | null;
  isPlatable?: boolean;
  plateableMeals?: number | null;
}

export function MealProgressCard({ meal, expanded, onToggle, backfillNeeds, recipeWeights, isPlatable, plateableMeals }: MealProgressCardProps) {
  const isDone = meal.completedWOs === meal.totalWOs;
  const isCritical = meal.criticalWOs.length > 0;
  const awaitingWOs = meal.workOrders.filter(wo => wo.awaitingPostBlast);
  const awaitingKg = awaitingWOs.reduce((s, wo) => s + wo.preBlastKg, 0);
  const mealBackfillPortions = backfillNeeds.reduce((s, b) => s + b.estimatedPortions, 0);

  const byRun = new Map<number, WoMatchedStatus[]>();
  for (const wo of meal.workOrders) {
    const r = wo.run ?? 1;
    if (!byRun.has(r)) byRun.set(r, []);
    byRun.get(r)!.push(wo);
  }
  const runEntries = [...byRun.entries()].sort(([a], [b]) => a - b);
  const hasRuns = runEntries.length > 1;

  const borderColor = isPlatable ? "border-emerald-400" : isCritical ? "border-red-300" : isDone ? "border-emerald-300" : "border-slate-200";
  const bgColor = isPlatable ? "bg-emerald-50" : isCritical ? "bg-red-50/40" : isDone ? "bg-emerald-50/20" : "";

  const cap = computeMaxPlateable(meal, recipeWeights);

  return (
    <div className={`rounded-2xl border-2 overflow-hidden transition-shadow ${borderColor} ${bgColor} ${expanded ? "shadow-md" : "hover:shadow-sm"}`}>
      {/* Platierbar-Banner */}
      {isPlatable && (
        <div className="bg-emerald-500 px-4 py-1.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-white font-black text-sm tracking-wide">PLATIERBAR</span>
          </div>
          {plateableMeals != null && plateableMeals > 0 && (
            <span className="text-white font-bold font-mono text-sm">{plateableMeals.toLocaleString("de-DE")} Meals</span>
          )}
        </div>
      )}
      {/* Füllstand-Leiste */}
      <div className="h-2 bg-slate-100">
        <div
          className={`h-full transition-all duration-700 ${
            isCritical ? "bg-red-400" :
            meal.progressPct >= 95 ? "bg-emerald-400" :
            meal.progressPct >= 60 ? "bg-sky-400" :
            meal.progressPct >= 30 ? "bg-amber-400" : "bg-slate-300"
          }`}
          style={{ width: `${Math.min(meal.progressPct, 100)}%` }}
        />
      </div>
      <div className="flex">
        <div className={`w-1.5 rounded-l-2xl shrink-0 ${isCritical ? "bg-red-400" : isDone ? "bg-emerald-400" : "bg-sky-300"}`} />
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 cursor-pointer select-none" onClick={onToggle}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-400 text-xs">{expanded ? "▼" : "▶"}</span>
                <span className="font-bold text-sm text-slate-900">{meal.recipeCode}</span>
                <span className="text-slate-500 text-sm truncate">{meal.recipeName}</span>
                {isDone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold shrink-0">✓ FERTIG</span>}
                {backfillNeeds.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 font-bold shrink-0">
                    Backfill: −{fmt(mealBackfillPortions)} Stk
                  </span>
                )}
                {hasRuns && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200 font-bold shrink-0">
                    {runEntries.length} Runs
                  </span>
                )}
                {awaitingWOs.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 font-bold shrink-0">
                    ⏳ {awaitingWOs.length} im Chiller · {fmt(awaitingKg, 1)} kg
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-500 ml-5 mt-0.5">
                <span>{meal.completedWOs}/{meal.totalWOs} WOs fertig</span>
                <span>·</span>
                <span>{fmt(meal.plannedMeals)} Meals</span>
                {cap && (
                  <span className={cap.meals === 0 ? "text-red-600 font-bold" : "text-emerald-600 font-bold"}>
                    · {cap.meals === 0 ? "0 platierbar ⛔" : `${cap.meals.toLocaleString("de-DE")} platierbar`}
                  </span>
                )}
              </div>
              {!expanded && <WoDots wos={meal.workOrders} />}
            </div>
            <div className="shrink-0 text-right">
              <div className={`text-2xl font-bold font-mono ${isCritical ? "text-red-600" : isDone ? "text-emerald-600" : "text-slate-800"}`}>
                {fmt(meal.progressPct, 0)}%
              </div>
              <div className="text-[10px] text-slate-400">
                {fmtMass(meal.totalActualKg * 1000)} / {fmtMass(meal.totalPlannedKg * 1000)}
              </div>
            </div>
          </div>

          {/* Fortschrittsbalken */}
          <div className="px-4 pb-3">
            <ProgressBar pct={meal.progressPct} />
          </div>

          {/* Kritisch-Hinweis (collapsed) */}
          {isCritical && !expanded && (
            <div className="px-4 pb-3 text-[11px] text-red-700 font-medium">
              ⚠ Kritisch: {meal.criticalWOs.map(w => w.subRecipe).join(" · ")}
            </div>
          )}

          {/* Aufgeklappte WO-Tabelle */}
          {expanded && (
            <div className="mx-4 mb-4 overflow-hidden rounded-xl ring-1 ring-slate-200 shadow-sm">
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">WO</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-right">Geplant</th>
                      <th className="px-3 py-2 text-right">Preblast</th>
                      <th className="px-3 py-2 text-right">Postblast</th>
                      <th className="px-3 py-2 text-right">%</th>
                      <th className="px-3 py-2 text-center">Status</th>
                      <th className="px-3 py-2 text-left">Letzte Wiegung</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {runEntries.flatMap(([runNum, runWos]) => {
                      const runDone = runWos.filter(w => w.isComplete).length;
                      const runHasCritical = runWos.some(w => w.isCritical);
                      const runAllDone = runDone === runWos.length;
                      const rows: ReactElement[] = [];

                      if (hasRuns) {
                        rows.push(
                          <tr key={`sep-${runNum}`} className="bg-gradient-to-r from-indigo-50 to-slate-50">
                            <td colSpan={8} className="px-3 py-2">
                              <div className="flex items-center gap-3">
                                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 ${
                                  runAllDone ? "bg-emerald-500" : runHasCritical ? "bg-red-500" : "bg-indigo-500"
                                }`}>{runNum}</span>
                                <span className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider">Run {runNum}</span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                  runAllDone ? "bg-emerald-100 text-emerald-700" :
                                  runHasCritical ? "bg-red-100 text-red-700" :
                                  "bg-indigo-100 text-indigo-700"
                                }`}>
                                  {runDone}/{runWos.length} fertig
                                </span>
                              </div>
                            </td>
                          </tr>,
                        );
                      }

                      runWos.forEach(wo => {
                        const backfillNeed = backfillNeeds.find(b => b.workOrder === wo.workOrder);
                        rows.push(
                          <tr
                            key={wo.workOrder}
                            className={`transition-colors ${
                              wo.isCritical ? "bg-red-50/60 hover:bg-red-50" :
                              wo.isComplete ? "bg-emerald-50/30 hover:bg-emerald-50/50" :
                              "hover:bg-slate-50/80"
                            }`}
                          >
                            <td className="px-3 py-2 font-mono font-bold text-slate-700 whitespace-nowrap">{wo.workOrder}</td>
                            <td className="px-3 py-2 max-w-[180px]">
                              <div className="font-medium truncate" title={wo.subRecipe}>{wo.subRecipe}</div>
                              {backfillNeed && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold ring-1 bg-amber-100 text-amber-700 ring-amber-200">
                                  BACKFILL · −{fmt(backfillNeed.estimatedPortions)} Stk
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-slate-500">
                              {wo.isEstimated && <span className="text-amber-500 mr-0.5">≈</span>}
                              {fmt(wo.plannedKg, 1)} kg
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-slate-500">
                              {wo.preBlastKg > 0
                                ? <span className="font-bold text-cyan-700">{fmt(wo.preBlastKg, 1)} kg</span>
                                : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="font-mono font-bold">{fmt(wo.actualKg, 1)} kg</div>
                              {wo.shrinkKg > 0 && (
                                <div className="text-[9px] text-slate-400 font-mono whitespace-nowrap">Schwund {fmt(wo.shrinkPct, 0)}%</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <div className="w-10"><ProgressBar pct={wo.progressPct} size="xs" /></div>
                                <span className="font-mono font-bold text-slate-700 w-8 text-right">{fmt(wo.progressPct, 0)}%</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-center"><StatusBadge wo={wo} /></td>
                            <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap">{wo.lastWeighing ?? "—"}</td>
                          </tr>,
                        );
                      });

                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
