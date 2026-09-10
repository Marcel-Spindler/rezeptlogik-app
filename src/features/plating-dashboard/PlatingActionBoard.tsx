// Plating Action Board — Stillstand-vermeiden-Dashboard für das Plating-Team.
// Kategorisiert Meals nach Plating-Bereitschaft und gibt konkrete Handlungsempfehlungen.
import { useMemo, useState } from "react";
import type { MealProgress, WoMatchedStatus, BackfillNeed } from "../gsheet-monitor/postblastMatch";
import type { RecipeWeightLookup } from "../gsheet-monitor/parsers/parseExportRecipes";
import { recipeWeightKey } from "../gsheet-monitor/parsers/parseExportRecipes";
import { estimateMealEta, type MealEta } from "../gsheet-monitor/productionEta";
import type { RedzoneState } from "../redzone-live/RedzoneContext";
import { fmt } from "../whatif/whatIfFormat";

// ─── Typen ───────────────────────────────────────────────────────────────────

interface ReadyMeal {
  meal: MealProgress;
  maxMeals: number;
  exact: boolean;
  bottleneckSubRecipe: string | null;
  holdingKg: number;
}

interface ChillerMeal {
  meal: MealProgress;
  kgInChiller: number;
  eta: MealEta;
  chillerWos: WoMatchedStatus[];
}

interface BlockedMeal {
  meal: MealProgress;
  missingWos: WoMatchedStatus[];
  actions: string[];
}

interface ActionItem {
  priority: "critical" | "warning" | "info";
  text: string;
  mealCode?: string;
}

export interface PlatingActionBoardProps {
  meals: MealProgress[];
  allMatched: WoMatchedStatus[];
  backfill: BackfillNeed[];
  recipeWeights: RecipeWeightLookup | null;
  redzone?: RedzoneState | null;
}

// ─── Platierbare Meals berechnen (gleiche Logik wie PostblastLiveView) ───────

export function computeMealPlatable(
  meal: MealProgress,
  recipeWeights: RecipeWeightLookup | null,
): { meals: number; exact: boolean; bottleneckSubRecipe: string | null } | null {
  if (recipeWeights) {
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
    let bottleneckSub: string | null = null;
    let found = 0;
    for (const [subRecipe, { actualKg, recipeCode, hasBlockingZero }] of bySubRecipe) {
      const grams = recipeWeights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
      if (!grams || grams <= 0) {
        if (hasBlockingZero) { minMeals = 0; bottleneckSub = subRecipe; found++; }
        continue;
      }
      if (actualKg === 0 && !hasBlockingZero) continue;
      const maxFromThis = hasBlockingZero ? 0 : Math.floor(actualKg / (grams / 1000));
      found++;
      if (maxFromThis < minMeals) { minMeals = maxFromThis; bottleneckSub = subRecipe; }
    }
    if (found === 0) return null;
    const meals = minMeals === Infinity ? 0 : minMeals;
    return { meals, exact: true, bottleneckSubRecipe: meals < (meal.plannedMeals || Infinity) ? bottleneckSub : null };
  }

  if (meal.plannedMeals <= 0) return null;
  const bySubRecipe = new Map<string, { actualKg: number; plannedKgSum: number; plannedWOCount: number; totalWOCount: number; hasBlockingZero: boolean; subRecipe: string }>();
  for (const wo of meal.workOrders) {
    const key = wo.subRecipe;
    if (!bySubRecipe.has(key)) bySubRecipe.set(key, { actualKg: 0, plannedKgSum: 0, plannedWOCount: 0, totalWOCount: 0, hasBlockingZero: false, subRecipe: wo.subRecipe });
    const entry = bySubRecipe.get(key)!;
    entry.actualKg += wo.actualKg;
    entry.totalWOCount++;
    if (wo.hasPlan && wo.plannedKg > 0) { entry.plannedKgSum += wo.plannedKg; entry.plannedWOCount++; }
    if (wo.hasPlan && wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) entry.hasBlockingZero = true;
  }
  for (const entry of bySubRecipe.values()) {
    if (entry.actualKg > 0) entry.hasBlockingZero = false;
  }

  let minMeals = Infinity;
  let bottleneckSub: string | null = null;
  let anyComputable = false;
  for (const entry of bySubRecipe.values()) {
    if (entry.plannedWOCount === 0) continue;
    if (entry.hasBlockingZero) return { meals: 0, exact: false, bottleneckSubRecipe: entry.subRecipe };
    const estimatedTotalPlanned = (entry.plannedKgSum / entry.plannedWOCount) * entry.totalWOCount;
    const m = estimatedTotalPlanned > 0 ? Math.floor((entry.actualKg / estimatedTotalPlanned) * meal.plannedMeals) : 0;
    anyComputable = true;
    if (m < minMeals) { minMeals = m; bottleneckSub = entry.subRecipe; }
  }
  if (!anyComputable || minMeals === Infinity) return null;
  return { meals: minMeals, exact: false, bottleneckSubRecipe: minMeals < meal.plannedMeals ? bottleneckSub : null };
}

// ─── Kategorisierung und Aktionsableitung ────────────────────────────────────

function categorize(
  meals: MealProgress[],
  allMatched: WoMatchedStatus[],
  backfill: BackfillNeed[],
  recipeWeights: RecipeWeightLookup | null,
) {
  const backfillByWo = new Map(backfill.map(b => [b.workOrder, b]));

  const ready: ReadyMeal[] = [];
  const chiller: ChillerMeal[] = [];
  const blocked: BlockedMeal[] = [];
  const actions: ActionItem[] = [];

  for (const meal of meals) {
    if (meal.totalWOs === 0) continue;
    const wos = meal.workOrders;
    const holdingKg = wos.reduce((s, w) => s + w.platingHoldingKg, 0);
    const hasChillerWo = wos.some(w => w.awaitingPostBlast);
    const cap = computeMealPlatable(meal, recipeWeights);

    // Blockiert: Sub-Meals mit 0 kg, nicht im Chiller
    const missingWos = wos.filter(w => w.hasPlan && w.plannedKg > 0 && w.actualKg === 0 && !w.awaitingPostBlast);
    const hasBlockingZero = missingWos.length > 0 && !wos.some(w => w.subRecipe === missingWos[0].subRecipe && w.actualKg > 0);

    if (!hasBlockingZero && (cap && cap.meals > 0 || holdingKg > 0)) {
      ready.push({
        meal,
        maxMeals: cap?.meals ?? 0,
        exact: cap?.exact ?? false,
        bottleneckSubRecipe: cap?.bottleneckSubRecipe ?? null,
        holdingKg,
      });
    } else if (hasChillerWo && !hasBlockingZero) {
      const chillerWos = wos.filter(w => w.awaitingPostBlast);
      const kgInChiller = chillerWos.reduce((s, w) => s + w.preBlastKg, 0);
      const eta = estimateMealEta(meal, allMatched);
      chiller.push({ meal, kgInChiller, eta, chillerWos });
    } else if (hasBlockingZero) {
      const mealActions: string[] = [];
      for (const w of missingWos) {
        const bf = backfillByWo.get(w.workOrder);
        if (bf) {
          mealActions.push(`Backfill für "${w.subRecipe}" einplanen (−${fmt(bf.missingKg, 0)} kg)`);
        } else {
          mealActions.push(`"${w.subRecipe}" (WO ${w.workOrder}) — Küche nach Status fragen`);
        }
      }
      blocked.push({ meal, missingWos, actions: mealActions });

      actions.push({
        priority: "critical",
        text: `${meal.recipeCode} blockiert — ${missingWos.map(w => `"${w.subRecipe}"`).join(", ")} fehlt komplett`,
        mealCode: meal.recipeCode,
      });
    }
  }

  ready.sort((a, b) => b.maxMeals - a.maxMeals);
  chiller.sort((a, b) => {
    if (a.eta.etaHours != null && b.eta.etaHours != null) return a.eta.etaHours - b.eta.etaHours;
    if (a.eta.etaHours != null) return -1;
    if (b.eta.etaHours != null) return 1;
    return b.meal.progressPct - a.meal.progressPct;
  });

  // Aktionen aus Chiller-Meals
  for (const c of chiller) {
    if (c.eta.etaTime) {
      const clock = c.eta.etaTime.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      actions.push({
        priority: "info",
        text: `${c.meal.recipeCode} — voraussichtlich bereit ca. ${clock} Uhr (${c.kgInChiller.toFixed(0)} kg im Chiller)`,
        mealCode: c.meal.recipeCode,
      });
    }
  }

  // Backfill-Warnungen
  for (const bf of backfill) {
    if (bf.priority === "critical") {
      actions.push({
        priority: "warning",
        text: `Backfill für ${bf.recipeCode} "${bf.subRecipe}" — ${fmt(bf.missingKg, 0)} kg (${fmt(bf.estimatedPortions)} Portionen) fehlen`,
        mealCode: bf.recipeCode,
      });
    }
  }

  // Changeover-Hinweise: gleiche Sub-Rezepte in ready-Liste hintereinander platten
  if (ready.length >= 2) {
    const subRecipeSets = ready.map(r => new Set(r.meal.workOrders.map(w => w.subRecipe)));
    for (let i = 0; i < ready.length - 1; i++) {
      for (let j = i + 1; j < ready.length; j++) {
        const overlap = [...subRecipeSets[i]].filter(s => subRecipeSets[j].has(s));
        if (overlap.length > 0) {
          actions.push({
            priority: "info",
            text: `${ready[i].meal.recipeCode} und ${ready[j].meal.recipeCode} teilen sich "${overlap[0]}" — hintereinander platten spart Changeover`,
          });
          break;
        }
      }
      if (actions.some(a => a.priority === "info" && a.text.includes("Changeover"))) break;
    }
  }

  actions.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.priority] - order[b.priority];
  });

  return { ready, chiller, blocked, actions };
}

// ─── Komponente ──────────────────────────────────────────────────────────────

function ProgressBarSmall({ pct, color }: { pct: number; color?: string }) {
  const auto = pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-full rounded-full ${color ?? auto} transition-all duration-700`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

export function PlatingActionBoard({ meals, allMatched, backfill, recipeWeights, redzone }: PlatingActionBoardProps) {
  const { ready, chiller, blocked } = useMemo(
    () => categorize(meals, allMatched, backfill, recipeWeights),
    [meals, allMatched, backfill, recipeWeights],
  );

  const [showAllReady, setShowAllReady] = useState(false);
  const [showAllChiller, setShowAllChiller] = useState(false);

  if (meals.length === 0) return null;

  const MAX = 6;

  return (
    <div>
      {/* ── Drei Spalten ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

        {/* ── JETZT PLAITEN ── */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 mb-2">
            ✅ Jetzt plaiten{ready.length > 0 ? ` (${ready.length})` : ""}
          </div>
          {ready.length === 0 ? (
            <div className="text-[10px] text-slate-300 italic">Noch kein Meal vollständig produziert</div>
          ) : (
            <div className="space-y-1.5">
              {(showAllReady ? ready : ready.slice(0, MAX)).map(({ meal: m, maxMeals, exact, bottleneckSubRecipe, holdingKg }) => (
                <div
                  key={m.recipeCode}
                  className={`rounded-xl px-3 py-2.5 ring-1 ${
                    redzone?.isPlatingNow(m.recipeCode) ? "bg-red-50 ring-red-200" : "bg-emerald-50 ring-emerald-200"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                    <span className="text-[11px] font-bold font-mono text-emerald-700">
                      {exact ? "" : "~"}{maxMeals.toLocaleString("de-DE")} Meals
                    </span>
                  </div>
                  {redzone?.isPlatingNow(m.recipeCode) && (
                    <div className="flex items-center gap-1 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block shrink-0" />
                      <span className="text-[10px] font-bold text-red-600 uppercase tracking-wide">wird platiert</span>
                    </div>
                  )}
                  <div className="text-[10px] text-slate-500 mb-1.5 truncate">{m.recipeName}</div>
                  <ProgressBarSmall pct={m.progressPct} color="bg-emerald-500" />
                  <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1">
                    <span>{m.totalActualKg.toFixed(0)} / {m.totalPlannedKg > 0 ? m.totalPlannedKg.toFixed(0) : "—"} kg</span>
                    <span>{m.completedWOs}/{m.totalWOs} WOs</span>
                  </div>
                  {bottleneckSubRecipe && (
                    <div className="text-[9px] text-amber-600 font-medium mt-0.5 truncate">Engpass: {bottleneckSubRecipe}</div>
                  )}
                  {holdingKg > 0 && (
                    <div className="text-[9px] text-emerald-600 font-medium mt-0.5">+{holdingKg.toFixed(0)} kg Puffer (RTI)</div>
                  )}
                </div>
              ))}
              {ready.length > MAX && (
                <button
                  onClick={() => setShowAllReady(v => !v)}
                  className="w-full text-[10px] text-emerald-600 hover:text-emerald-800 text-center py-1.5 hover:bg-emerald-50 rounded-lg transition-colors font-medium"
                >
                  {showAllReady ? "Weniger anzeigen" : `+${ready.length - MAX} weitere anzeigen`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── BALD BEREIT (Im Chiller) ── */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-cyan-700 mb-2">
            ⏳ Bald bereit{chiller.length > 0 ? ` (${chiller.length})` : ""}
          </div>
          {chiller.length === 0 ? (
            <div className="text-[10px] text-slate-300 italic">Kein Meal im Chiller</div>
          ) : (
            <div className="space-y-1.5">
              {(showAllChiller ? chiller : chiller.slice(0, MAX)).map(({ meal: m, kgInChiller, eta, chillerWos }) => {
                const etaClock = eta.etaTime?.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
                return (
                  <div key={m.recipeCode} className="rounded-xl px-3 py-2.5 bg-cyan-50 ring-1 ring-cyan-200">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                      {etaClock && (
                        <span className="text-[11px] font-bold font-mono text-cyan-700">ca. {etaClock}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 mb-1.5 truncate">{m.recipeName}</div>
                    <ProgressBarSmall pct={m.progressPct} color="bg-cyan-400" />
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1">
                      <span>{m.totalActualKg.toFixed(0)} / {m.totalPlannedKg > 0 ? m.totalPlannedKg.toFixed(0) : "—"} kg</span>
                      <span>{kgInChiller.toFixed(0)} kg im Chiller</span>
                    </div>
                    {chillerWos.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-cyan-200 space-y-0.5">
                        {chillerWos.slice(0, 3).map(w => (
                          <div key={w.workOrder} className="flex items-center justify-between text-[9px]">
                            <span className="text-cyan-700 font-medium truncate flex-1 mr-2">{w.subRecipe}</span>
                            <span className="text-cyan-600 font-mono shrink-0">{w.preBlastKg.toFixed(0)} kg</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {eta.limitingWo && (
                      <div className="text-[9px] text-cyan-600 mt-1">
                        Limitiert durch: {eta.limitingWo.subRecipe}
                      </div>
                    )}
                  </div>
                );
              })}
              {chiller.length > MAX && (
                <button
                  onClick={() => setShowAllChiller(v => !v)}
                  className="w-full text-[10px] text-cyan-600 hover:text-cyan-800 text-center py-1.5 hover:bg-cyan-50 rounded-lg transition-colors font-medium"
                >
                  {showAllChiller ? "Weniger anzeigen" : `+${chiller.length - MAX} weitere anzeigen`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── BLOCKIERT + AKTION ── */}
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-red-600 mb-2">
            ⛔ Blockiert — Aktion nötig{blocked.length > 0 ? ` (${blocked.length})` : ""}
          </div>
          {blocked.length === 0 ? (
            <div className="text-[10px] text-slate-300 italic">Keine Meals blockiert</div>
          ) : (
            <div className="space-y-1.5">
              {blocked.map(({ meal: m, missingWos, actions: mealActions }) => (
                <div key={m.recipeCode} className="rounded-xl px-3 py-2.5 bg-red-50 ring-1 ring-red-200">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                    <span className="text-[10px] font-bold text-red-600">0 Meals</span>
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">{m.recipeName}</div>
                  {missingWos.slice(0, 3).map(w => (
                    <div key={w.workOrder} className="text-[9px] text-red-600 mt-0.5 truncate">
                      ✕ {w.subRecipe} (WO {w.workOrder} · 0 / {w.plannedKg.toFixed(0)} kg)
                    </div>
                  ))}
                  {mealActions.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-red-200">
                      {mealActions.slice(0, 2).map((a, i) => (
                        <div key={i} className="text-[9px] text-purple-700 font-medium mt-0.5">
                          → {a}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
