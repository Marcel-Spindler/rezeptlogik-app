// Postblast Live View — Echtzeit-Dashboard: GSheet-Wiegungen vs. geplante Work Orders.
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import type { PostblastData } from "./gsheetTypes";
import {
  useEtMonitor, usePostblastMonitor, usePreblastMonitor,
  useRtiMonitor, useShortsTrackerMonitor, useVolumeOverviewMonitor,
} from "./useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed, type MealProgress, type WoMatchedStatus } from "./postblastMatch";
import { netPlateable, platedForMeal } from "./plateableNet";
import { useCombinedPlaited } from "./useCombinedPlaited";
import { MinimumNeedsPanel, VolumeSummary } from "./MinimumNeedsPanel";
import { mealReadiness } from "./mealProgress";
import { findEquipmentForSubRecipe } from "./backfillGenerator";
import { correlateShortages, describeShortageImpact } from "./shortageAlerts";
import { fmt, fmtMass } from "../whatif/whatIfFormat";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { fetchWmsWorkorderCache, filterRowsToWeekWindow, wmsWorkorderRowToEntry } from "../../lib/wmsCache";
import { parseKetCsv } from "../ket-plan/ketLogic";
import type { KetRow } from "../ket-plan/ketTypes";
import { recipeWeightKey, type RecipeWeightLookup } from "./parsers/parseExportRecipes";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useRedzoneOptional, type RedzoneState } from "../redzone-live/RedzoneContext";

// ─── Typen ───────────────────────────────────────────────────────────────────

interface WoSnapshot { ts: string; actual: Record<string, number>; }

// ─── localStorage-Verlauf ────────────────────────────────────────────────────

function useWoHistory(matched: WoMatchedStatus[], week: string) {
  const key = `pb_hist_${week}`;
  const [snaps, setSnaps] = useState<WoSnapshot[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
  });
  const lastRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (matched.length === 0) return;
    const cur: Record<string, number> = {};
    let changed = Object.keys(lastRef.current).length === 0;
    for (const m of matched) {
      cur[m.workOrder] = m.actualKg;
      if (!changed && Math.abs((lastRef.current[m.workOrder] ?? -1) - m.actualKg) > 0.05) changed = true;
    }
    if (!changed) return;
    lastRef.current = cur;
    const snap: WoSnapshot = { ts: new Date().toISOString(), actual: cur };
    setSnaps(prev => {
      const next = [...prev.slice(-199), snap];
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [matched, key]);

  const firstSeen = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of snaps) {
      for (const [wo, kg] of Object.entries(s.actual)) {
        if (kg > 0 && !map.has(wo)) map.set(wo, s.ts);
      }
    }
    return map;
  }, [snaps]);

  // Tägliche Rücksetzung: "seit Schichtstart" meint den heutigen Schichtstart,
  // nicht den ersten Snapshot der ganzen Woche (der Verlauf selbst bleibt
  // wochenweise erhalten, siehe firstSeen oben, das ist bewusst nicht
  // tagesgebunden). Ohne diesen Filter würde "+X kg seit Schichtstart" ab
  // Dienstag die kumulierte Menge seit Montag zeigen statt seit heute früh.
  const shiftStartActual = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return snaps.find(s => s.ts.slice(0, 10) === todayStr)?.actual ?? {};
  }, [snaps]);

  const clear = () => { localStorage.removeItem(key); setSnaps([]); };

  return { firstSeen, shiftStartActual, snapCount: snaps.length, clear };
}

// ─── Primitive Komponenten ───────────────────────────────────────────────────

function ProgressBar({ pct, size = "md", color }: { pct: number; size?: "xs" | "sm" | "md" | "lg"; color?: string }) {
  const h = size === "lg" ? "h-4" : size === "sm" ? "h-2" : size === "xs" ? "h-1.5" : "h-3";
  const auto = pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`w-full ${h} rounded-full bg-slate-200 overflow-hidden`}>
      <div
        className={`${h} rounded-full ${color ?? auto} transition-all duration-700`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: BackfillNeed["priority"] }) {
  const cls =
    priority === "critical" ? "bg-red-100 text-red-700 ring-1 ring-red-300" :
    priority === "behind" ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" :
    "bg-emerald-100 text-emerald-700";
  const label = priority === "critical" ? "⚠ KRITISCH" : priority === "behind" ? "HINTER PLAN" : "OK";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${cls}`}>{label}</span>;
}

function StatusBadge({ wo }: { wo: WoMatchedStatus }) {
  if (!wo.hasPlan)
    return (
      <span
        title="Diese WO ist im System (ET/WMS/KET), hat aber noch kein Mengen-Soll — Fortschritt kann nicht bewertet werden"
        className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 ring-1 ring-slate-300 font-bold"
      >
        ○ OHNE PLAN
      </span>
    );
  const estTitle = wo.isEstimated ? " — Sollmenge GESCHÄTZT aus Portionen × Rezept-Gewicht, kein echtes Firestore-Soll" : "";
  const estSuffix = wo.isEstimated ? " ≈" : "";
  if (wo.isComplete)
    return <span title={`Fertig${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold">✓ FERTIG{estSuffix}</span>;
  if (wo.awaitingPostBlast)
    return (
      <span
        title={`Schon pre-blast gewogen (${wo.preBlastKg.toFixed(1)} kg) — Post-Blast-Wiegung steht noch aus${estTitle}`}
        className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 font-bold"
      >
        ⏳ IM CHILLER{estSuffix}
      </span>
    );
  if (wo.isCritical)
    return <span title={`Kritisch${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 ring-1 ring-red-200 font-bold">⚠ KRITISCH{estSuffix}</span>;
  return <span title={`Läuft${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 ring-1 ring-sky-200 font-bold">LÄUFT{estSuffix}</span>;
}

function WoDots({ wos }: { wos: WoMatchedStatus[] }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
      {wos.map(wo => (
        <div
          key={wo.workOrder}
          title={!wo.hasPlan ? `${wo.workOrder}: ${wo.subRecipe} (ohne Plan-Soll)` : wo.awaitingPostBlast ? `${wo.workOrder}: ${wo.subRecipe} (im Blast Chiller, ${wo.preBlastKg.toFixed(1)} kg pre-blast)` : `${wo.workOrder}: ${wo.subRecipe} (${Math.round(wo.progressPct)}%)`}
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

// Ziel-Portionen × Gramm/Portion (aus export-recipes.csv) = geschätzte Ziel-
// menge in kg. null, wenn für dieses Sub-Rezept kein Gewicht bekannt ist oder
// keine Portionenzahl vorliegt — dann bleibt die WO "OHNE PLAN" statt eine
// erfundene Zahl zu zeigen.
export function estimatePlannedKg(
  recipeWeights: RecipeWeightLookup | null,
  recipeCode: string,
  subRecipe: string,
  targetPortions: number | undefined | null
): number | null {
  if (!recipeWeights || !targetPortions || targetPortions <= 0) return null;
  const grams = recipeWeights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
  if (grams == null) return null;
  return (grams * targetPortions) / 1000;
}

// ─── Plating-Warteschlange ──────────────────────────────────────────────────

// Exakte Berechnung der max. platierbaren Meals aus Post-Blast-Wiegungen.
// Primär: Gramm/Portion aus export-recipes.csv (exakt, unabhängig vom Planwert).
// Fallback: Planverhältnis mit N/M-Skalierung für OHNE-PLAN-WOs (Schätzung).
// Gibt null zurück wenn zu wenig Daten vorhanden sind.
function computeMaxPlateable(
  meal: MealProgress,
  recipeWeights: RecipeWeightLookup | null
): { meals: number; exact: boolean; bottleneckSubRecipe: string | null } | null {

  // ── Primär: Gramm/Portion (export-recipes.csv) ────────────────────────
  if (recipeWeights) {
    // Aggregiert pro Sub-Rezept über alle Batches (mehrere WOs = mehrere Chargen)
    const bySubRecipe = new Map<string, { actualKg: number; recipeCode: string; hasBlockingZero: boolean; anyInChiller: boolean }>();
    for (const wo of meal.workOrders) {
      const key = wo.subRecipe;
      if (!bySubRecipe.has(key)) bySubRecipe.set(key, { actualKg: 0, recipeCode: wo.recipeCode, hasBlockingZero: false, anyInChiller: false });
      const entry = bySubRecipe.get(key)!;
      entry.actualKg += wo.actualKg;
      if (wo.awaitingPostBlast) entry.anyInChiller = true;
      if (wo.hasPlan && wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) entry.hasBlockingZero = true;
    }
    // Erst nach vollständiger Akkumulierung prüfen: wenn bereits kg vorhanden sind, ist kein Blocker
    for (const entry of bySubRecipe.values()) {
      if (entry.actualKg > 0) entry.hasBlockingZero = false;
    }

    let minMeals = Infinity;
    let bottleneckSub: string | null = null;
    let found = 0;

    for (const [subRecipe, { actualKg, recipeCode, hasBlockingZero }] of bySubRecipe) {
      const grams = recipeWeights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
      if (!grams || grams <= 0) {
        // Kein Gewichtseintrag → KET-Plan vermutlich veraltet.
        // Wenn dieses Sub-Rezept trotzdem als Blocker gilt (0 kg, hat Plan), als 0 werten.
        if (hasBlockingZero) { minMeals = 0; bottleneckSub = subRecipe; found++; }
        continue;
      }
      // OHNE PLAN / Chiller-WOs mit 0 kg sind kein Blocker — nicht in das Minimum einrechnen
      if (actualKg === 0 && !hasBlockingZero) continue;
      const maxFromThis = hasBlockingZero ? 0 : Math.floor(actualKg / (grams / 1000));
      found++;
      if (maxFromThis < minMeals) { minMeals = maxFromThis; bottleneckSub = subRecipe; }
    }

    if (found === 0) return null;
    const meals = minMeals === Infinity ? 0 : minMeals;
    return { meals, exact: true, bottleneckSubRecipe: meals < (meal.plannedMeals || Infinity) ? bottleneckSub : null };
  }

  // ── Fallback: Planverhältnis mit N/M-Skalierung ───────────────────────
  if (meal.plannedMeals <= 0) return null;

  const bySubRecipe = new Map<string, {
    actualKg: number; plannedKgSum: number;
    plannedWOCount: number; totalWOCount: number;
    hasBlockingZero: boolean; subRecipe: string;
  }>();

  for (const wo of meal.workOrders) {
    const key = wo.subRecipe;
    if (!bySubRecipe.has(key)) bySubRecipe.set(key, { actualKg: 0, plannedKgSum: 0, plannedWOCount: 0, totalWOCount: 0, hasBlockingZero: false, subRecipe: wo.subRecipe });
    const entry = bySubRecipe.get(key)!;
    entry.actualKg += wo.actualKg;
    entry.totalWOCount++;
    if (wo.hasPlan && wo.plannedKg > 0) { entry.plannedKgSum += wo.plannedKg; entry.plannedWOCount++; }
    if (wo.hasPlan && wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) entry.hasBlockingZero = true;
  }
  // Erst nach vollständiger Akkumulierung: wenn bereits kg vorhanden → kein Blocker
  for (const entry of bySubRecipe.values()) {
    if (entry.actualKg > 0) entry.hasBlockingZero = false;
  }

  let minMeals = Infinity;
  let bottleneckSub: string | null = null;
  let anyComputable = false;

  for (const entry of bySubRecipe.values()) {
    if (entry.plannedWOCount === 0) continue; // kein Planwert → überspringen
    if (entry.hasBlockingZero) {
      return { meals: 0, exact: false, bottleneckSubRecipe: entry.subRecipe };
    }
    // N/M-Skalierung: Ø Planmenge pro WO × Gesamt-WO-Zahl = geschätzte Gesamt-Planmenge
    const estimatedTotalPlanned = (entry.plannedKgSum / entry.plannedWOCount) * entry.totalWOCount;
    const meals = estimatedTotalPlanned > 0 ? Math.floor((entry.actualKg / estimatedTotalPlanned) * meal.plannedMeals) : 0;
    anyComputable = true;
    if (meals < minMeals) { minMeals = meals; bottleneckSub = entry.subRecipe; }
  }

  if (!anyComputable || minMeals === Infinity) return null;
  return { meals: minMeals, exact: false, bottleneckSubRecipe: minMeals < meal.plannedMeals ? bottleneckSub : null };
}

// Hilfsfunktion: Engpass-WO und maximal platierbare Meals für ein Meal berechnen.
// Alle WOs mit Plan müssen Gewicht haben — das Minimum setzt die Grenze.
// Eine WO mit 0 kg (die nicht im Chiller ist) blockiert das Meal komplett.
function mealPlatingCapacity(meal: MealProgress): {
  maxMeals: number;
  bottleneckPct: number;
  bottleneckSubRecipe: string | null;
  hasBlockingZeroWo: boolean;
} {
  const withPlan = meal.workOrders.filter(w => w.hasPlan && w.plannedKg > 0);
  if (withPlan.length === 0) return { maxMeals: 0, bottleneckPct: 0, bottleneckSubRecipe: null, hasBlockingZeroWo: false };

  // Per Sub-Rezept aggregieren (inkl. WOs ohne Planmenge, z.B. R0-Chicken mit plannedKg=0)
  const bySubRecipe = new Map<string, { totalActual: number; totalPlanned: number; anyInChiller: boolean }>();
  for (const wo of meal.workOrders) {
    if (!bySubRecipe.has(wo.subRecipe)) bySubRecipe.set(wo.subRecipe, { totalActual: 0, totalPlanned: 0, anyInChiller: false });
    const e = bySubRecipe.get(wo.subRecipe)!;
    e.totalActual += wo.actualKg;
    if (wo.hasPlan && wo.plannedKg > 0) e.totalPlanned += wo.plannedKg;
    if (wo.awaitingPostBlast) e.anyInChiller = true;
  }

  // Blocker: Sub-Rezept hat Planmenge, aber null kg produziert und nicht im Chiller
  let hasBlockingZeroWo = false;
  for (const e of bySubRecipe.values()) {
    if (e.totalPlanned > 0 && e.totalActual === 0 && !e.anyInChiller) { hasBlockingZeroWo = true; break; }
  }

  // Fortschritt und Bottleneck per Sub-Rezept (nicht per einzelnem WO)
  let minPct = Infinity;
  let bottleneckSub: string | null = null;
  for (const [sub, e] of bySubRecipe) {
    if (e.totalPlanned <= 0) continue;
    const pct = Math.min(100, (e.totalActual / e.totalPlanned) * 100);
    if (pct < minPct) { minPct = pct; bottleneckSub = sub; }
  }

  const bottleneckPct = minPct === Infinity ? 0 : minPct;
  const maxMeals = meal.plannedMeals > 0 ? Math.floor(bottleneckPct / 100 * meal.plannedMeals) : 0;

  return {
    maxMeals,
    bottleneckPct,
    bottleneckSubRecipe: bottleneckPct < 99 ? bottleneckSub : null,
    hasBlockingZeroWo,
  };
}

function PlatingNowPanel({
  meals,
  recipeWeights,
  wmsRows,
  redzone,
  plaitedByCode,
}: {
  meals: MealProgress[];
  recipeWeights: RecipeWeightLookup | null;
  wmsRows?: WorkOrderEntry[] | null;
  redzone?: RedzoneState | null;
  // Schon plaitierte Portionen je 4-Ziffer-Meal-Identität (LinePlaiting ⊕
  // Redzone). Wird von der Brutto-Menge abgezogen — sonst zeigt "bereit" Runs
  // an, die längst raus sind (siehe plateableNet.ts / useCombinedPlaited.ts).
  plaitedByCode?: Map<string, number>;
}) {
  const [showAllReady, setShowAllReady] = useState(false);
  const [showAllChiller, setShowAllChiller] = useState(false);
  const [showAllCritical, setShowAllCritical] = useState(false);
  const [showAllProd, setShowAllProd] = useState(false);
  const refReady = useRef<HTMLDivElement>(null);
  const refChiller = useRef<HTMLDivElement>(null);
  const refBlocked = useRef<HTMLDivElement>(null);
  const refProd = useRef<HTMLDivElement>(null);

  if (meals.length === 0) return null;

  const dayName = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });

  type ReadyEntry = { meal: MealProgress; maxMeals: number; platedMeals: number; exact: boolean; bottleneckPct: number; bottleneckSubRecipe: string | null };
  type ChillerEntry = { meal: MealProgress; kgInChiller: number; maxAfterChiller: number };
  type PlatedOutEntry = { meal: MealProgress; platedMeals: number };

  const readyList: ReadyEntry[] = [];
  const chillerList: ChillerEntry[] = [];
  const runningMeals: MealProgress[] = [];
  const criticalMeals: MealProgress[] = [];
  const platedOutList: PlatedOutEntry[] = [];

  for (const meal of meals) {
    if (meal.totalWOs === 0) continue;
    const wos = meal.workOrders;
    const cap = mealPlatingCapacity(meal);
    const hasHolding = wos.some(w => w.platingHoldingKg > 0);
    const hasChillerWo = wos.some(w => w.awaitingPostBlast);

    // Brutto-platierbar (exakt aus Gramm/Portion, sonst Planverhältnis) minus
    // die schon platierten Portionen aus Redzone — nur der Rest ist wirklich
    // "bereit".
    const grossExact = computeMaxPlateable(meal, recipeWeights);
    const grossMeals = grossExact?.meals ?? cap.maxMeals;
    const net = netPlateable(meal, grossMeals, platedForMeal(plaitedByCode, meal.recipeCode));

    if (!cap.hasBlockingZeroWo && (net.netMeals > 0 || hasHolding)) {
      readyList.push({
        meal,
        maxMeals: net.netMeals,
        platedMeals: net.platedMeals,
        exact: grossExact?.exact ?? false,
        bottleneckPct: cap.bottleneckPct,
        bottleneckSubRecipe: grossExact?.bottleneckSubRecipe ?? cap.bottleneckSubRecipe,
      });
    } else if (hasChillerWo) {
      const kgInChiller = wos.filter(w => w.awaitingPostBlast).reduce((s, w) => s + w.preBlastKg, 0);
      chillerList.push({ meal, kgInChiller, maxAfterChiller: net.netMeals });
    } else if (net.fullyPlated) {
      platedOutList.push({ meal, platedMeals: net.platedMeals });
    } else if (cap.hasBlockingZeroWo || wos.some(w => w.isCritical && w.hasPlan)) {
      criticalMeals.push(meal);
    } else {
      runningMeals.push(meal);
    }
  }

  readyList.sort((a, b) => b.maxMeals - a.maxMeals);
  platedOutList.sort((a, b) => b.platedMeals - a.platedMeals);
  chillerList.sort((a, b) => b.meal.progressPct - a.meal.progressPct);
  runningMeals.sort((a, b) => a.progressPct - b.progressPct);

  // WMS-WOs die noch gar nicht im Postblast aufgetaucht sind → "Noch in Produktion"
  const matchedWoNums = new Set(meals.flatMap(m => m.workOrders.map(w => w.workOrder)));
  type WmsGroup = { recipeCode: string; recipeName: string; subRecipes: Array<{ name: string; portions: number }>; maxPortions: number };
  const wmsGroupMap = new Map<string, WmsGroup>();
  if (wmsRows) {
    for (const row of wmsRows) {
      if (matchedWoNums.has(row.workOrder)) continue;
      if (!wmsGroupMap.has(row.recipeCode)) {
        wmsGroupMap.set(row.recipeCode, { recipeCode: row.recipeCode, recipeName: row.recipeName, subRecipes: [], maxPortions: 0 });
      }
      const g = wmsGroupMap.get(row.recipeCode)!;
      const portions = row.targetPortions ?? row.plannedMeals ?? 0;
      if (!g.subRecipes.find(s => s.name === row.subRecipe)) g.subRecipes.push({ name: row.subRecipe, portions });
      if (portions > g.maxPortions) g.maxPortions = portions;
    }
  }
  const wmsInProdList = [...wmsGroupMap.values()].sort((a, b) => b.maxPortions - a.maxPortions);
  const totalInProd = runningMeals.length + wmsInProdList.length;

  const MAX = 5;

  return (
    <div className="card p-5 shadow-md border-0">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="font-bold text-slate-900 text-sm">Was kann ich plaiten?</div>
          <div className="text-[10px] text-slate-400">{dayName}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {readyList.length > 0 && (
            <button
              onClick={() => refReady.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
              className="text-[11px] px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 font-bold ring-1 ring-emerald-300 hover:bg-emerald-200 active:scale-95 transition-all cursor-pointer select-none"
            >
              ✅ {readyList.length} bereit
            </button>
          )}
          {chillerList.length > 0 && (
            <button
              onClick={() => refChiller.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
              className="text-[11px] px-3 py-1.5 rounded-full bg-cyan-100 text-cyan-800 font-bold ring-1 ring-cyan-300 hover:bg-cyan-200 active:scale-95 transition-all cursor-pointer select-none"
            >
              ⏳ {chillerList.length} im Chiller
            </button>
          )}
          {criticalMeals.length > 0 && (
            <button
              onClick={() => refBlocked.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
              className="text-[11px] px-3 py-1.5 rounded-full bg-red-100 text-red-800 font-bold ring-1 ring-red-300 hover:bg-red-200 active:scale-95 transition-all cursor-pointer select-none"
            >
              ⛔ {criticalMeals.length} blockiert
            </button>
          )}
          {totalInProd > 0 && (
            <button
              onClick={() => refProd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
              className="text-[11px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-700 font-semibold ring-1 ring-slate-300 hover:bg-slate-200 active:scale-95 transition-all cursor-pointer select-none"
            >
              🔵 {totalInProd} in Produktion
            </button>
          )}
          {platedOutList.length > 0 && (
            <span
              title="Ganze Wochenmenge dieses Meals ist ist schon komplett plaitiert — kein Rest mehr"
              className="text-[11px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-500 font-semibold ring-1 ring-slate-200 select-none"
            >
              ✓ {platedOutList.length} komplett platiert
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* ── Jetzt plaiten ── */}
        <div ref={refReady}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 mb-2">
            ✅ Jetzt plaiten{readyList.length > 0 ? ` (${readyList.length})` : ""}
          </div>
          {readyList.length === 0 ? (
            <div className="text-[10px] text-slate-300 italic">Noch kein Meal vollständig produziert</div>
          ) : (
            <div className="space-y-1.5">
              {(showAllReady ? readyList : readyList.slice(0, MAX)).map(({ meal: m, bottleneckPct, maxMeals, platedMeals, exact, bottleneckSubRecipe }) => {
                const holdKg = m.workOrders.reduce((s, w) => s + w.platingHoldingKg, 0);
                return (
                  <div key={m.recipeCode} className={`rounded-xl px-3 py-2.5 ring-1 ${redzone?.isPlatingNow(m.recipeCode) ? "bg-red-50 ring-red-200" : "bg-emerald-50 ring-emerald-200"}`}>
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                      {maxMeals > 0 ? (
                        <span className="text-[11px] font-bold font-mono text-emerald-700">
                          {exact ? "" : "~"}{maxMeals.toLocaleString("de-DE")} Meals
                        </span>
                      ) : (
                        <span className="text-[11px] font-bold font-mono text-slate-500">{Math.round(bottleneckPct)}%</span>
                      )}
                    </div>
                    {redzone?.isPlatingNow(m.recipeCode) && (
                      <div className="flex items-center gap-1 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block shrink-0" />
                        <span className="text-[10px] font-bold text-red-600 uppercase tracking-wide">wird platiert</span>
                      </div>
                    )}
                    <div className="text-[10px] text-slate-500 mb-1.5 truncate">{m.recipeName}</div>
                    <ProgressBar pct={bottleneckPct} size="xs" color="bg-emerald-500" />
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1">
                      <span>{m.totalActualKg.toFixed(0)} / {m.totalPlannedKg > 0 ? m.totalPlannedKg.toFixed(0) : "—"} kg</span>
                      <span>{m.completedWOs}/{m.totalWOs} WOs</span>
                    </div>
                    {platedMeals > 0 && (
                      <div className="text-[9px] text-slate-500 font-medium mt-0.5">
                        {platedMeals.toLocaleString("de-DE")} schon plaitiert abgezogen
                      </div>
                    )}
                    {bottleneckSubRecipe && (
                      <div className="text-[9px] text-amber-600 font-medium mt-0.5 truncate">
                        ⚡ Engpass: {bottleneckSubRecipe}
                      </div>
                    )}
                    {!exact && maxMeals > 0 && (
                      <div className="text-[9px] text-amber-600 mt-0.5">≈ Schätzung — KET-Plan mit aktuellen WOs neu exportieren</div>
                    )}
                    {holdKg > 0 && (
                      <div className="text-[9px] text-emerald-600 font-medium mt-0.5">+{holdKg.toFixed(0)} kg Puffer (RTI)</div>
                    )}
                  </div>
                );
              })}
              {readyList.length > MAX && (
                <button
                  onClick={() => setShowAllReady(v => !v)}
                  className="w-full text-[10px] text-emerald-600 hover:text-emerald-800 text-center py-1.5 hover:bg-emerald-50 rounded-lg transition-colors font-medium"
                >
                  {showAllReady ? "▲ Weniger anzeigen" : `▼ +${readyList.length - MAX} weitere anzeigen`}
                </button>
              )}
            </div>
          )}
          {platedOutList.length > 0 && (
            <div className="mt-3 pt-2 border-t border-slate-100">
              <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                ✓ Komplett platiert ({platedOutList.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {platedOutList.map(({ meal: m, platedMeals }) => (
                  <span
                    key={m.recipeCode}
                    title={`${m.recipeName} — ${platedMeals.toLocaleString("de-DE")} Portionen plaitiert — gesamte produzierte Menge raus`}
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500"
                  >
                    {m.recipeCode}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Im Chiller + Kritisch/Blockiert ── */}
        <div ref={refChiller}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-cyan-700 mb-2">
            ⏳ Im Chiller{chillerList.length > 0 ? ` (${chillerList.length})` : ""}
          </div>
          {chillerList.length === 0 ? (
            <div className="text-[10px] text-slate-300 italic">Kein Meal im Chiller</div>
          ) : (
            <div className="space-y-1.5">
              {(showAllChiller ? chillerList : chillerList.slice(0, MAX)).map(({ meal: m, kgInChiller }) => {
                const chillerWos = m.workOrders.filter(w => w.awaitingPostBlast);
                return (
                  <div key={m.recipeCode} className="rounded-xl px-3 py-2.5 bg-cyan-50 ring-1 ring-cyan-200">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                      <span className="text-[11px] font-bold font-mono text-slate-600">{Math.round(m.progressPct)}%</span>
                    </div>
                    <div className="text-[10px] text-slate-500 mb-1.5 truncate">{m.recipeName}</div>
                    <ProgressBar pct={m.progressPct} size="xs" color="bg-cyan-400" />
                    <div className="flex items-center justify-between text-[9px] text-slate-400 mt-1">
                      <span>{m.totalActualKg.toFixed(0)} / {m.totalPlannedKg > 0 ? m.totalPlannedKg.toFixed(0) : "—"} kg</span>
                      <span>{m.completedWOs}/{m.totalWOs} WOs</span>
                    </div>
                    {chillerWos.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-cyan-200 space-y-0.5">
                        {chillerWos.map(w => (
                          <div key={w.workOrder} className="flex items-center justify-between text-[9px]">
                            <span className="text-cyan-700 font-medium truncate flex-1 mr-2">⏳ {w.subRecipe}</span>
                            <span className="text-cyan-600 font-mono shrink-0">{w.preBlastKg.toFixed(0)} kg</span>
                          </div>
                        ))}
                        {chillerWos.length > 1 && (
                          <div className="text-[9px] text-cyan-500 font-medium pt-0.5 border-t border-cyan-100">
                            Gesamt {kgInChiller.toFixed(0)} kg → Post-Blast ausstehend
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {chillerList.length > MAX && (
                <button
                  onClick={() => setShowAllChiller(v => !v)}
                  className="w-full text-[10px] text-cyan-600 hover:text-cyan-800 text-center py-1.5 hover:bg-cyan-50 rounded-lg transition-colors font-medium"
                >
                  {showAllChiller ? "▲ Weniger anzeigen" : `▼ +${chillerList.length - MAX} weitere anzeigen`}
                </button>
              )}
            </div>
          )}
          {criticalMeals.length > 0 && (
            <>
              <div ref={refBlocked} className="text-[10px] font-bold uppercase tracking-wide text-red-600 mt-4 mb-2">
                ⛔ Blockiert — Sub-Meal fehlt ({criticalMeals.length})
              </div>
              <div className="space-y-1.5">
                {(showAllCritical ? criticalMeals : criticalMeals.slice(0, 4)).map(m => {
                  const missingWos = m.workOrders.filter(w => w.hasPlan && w.plannedKg > 0 && w.actualKg === 0 && !w.awaitingPostBlast);
                  return (
                    <div key={m.recipeCode} className="rounded-xl px-3 py-2.5 bg-red-50 ring-1 ring-red-200">
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="font-mono text-[11px] font-bold text-slate-900">{m.recipeCode}</span>
                        <span className="text-[10px] font-bold text-red-600">0 Meals</span>
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">{m.recipeName}</div>
                      {missingWos.slice(0, 2).map(w => (
                        <div key={w.workOrder} className="text-[9px] text-red-600 mt-0.5 truncate">
                          ✕ {w.subRecipe} (0 / {w.plannedKg.toFixed(0)} kg)
                        </div>
                      ))}
                    </div>
                  );
                })}
                {criticalMeals.length > 4 && (
                  <button
                    onClick={() => setShowAllCritical(v => !v)}
                    className="w-full text-[10px] text-red-500 hover:text-red-700 text-center py-1.5 hover:bg-red-50 rounded-lg transition-colors font-medium"
                  >
                    {showAllCritical ? "▲ Weniger" : `▼ +${criticalMeals.length - 4} weitere`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Noch in Produktion (WMS) ── */}
        <div ref={refProd}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-2">
            🔵 Noch in Produktion ({totalInProd})
          </div>
          {totalInProd === 0 ? (
            <div className="text-[10px] text-slate-300 italic">
              {wmsRows ? "Alle WMS-WOs verbucht oder im Postblast" : "WMS-Daten werden geladen…"}
            </div>
          ) : (
            <div className="space-y-1.5">
              {/* Postblast-basierte "laufende" Meals (teilweise gebucht, aber noch nicht vollständig) */}
              {runningMeals.map(m => (
                <div key={m.recipeCode} className="rounded-xl px-3 py-2.5 bg-white ring-1 ring-slate-200">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-slate-800">{m.recipeCode}</span>
                    <span className="text-[11px] font-bold font-mono text-slate-500">{Math.round(m.progressPct)}%</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mb-1.5 truncate">{m.recipeName}</div>
                  <ProgressBar pct={m.progressPct} size="xs" />
                  <div className="text-[9px] text-slate-400 mt-1">
                    {m.totalActualKg.toFixed(0)} / {m.totalPlannedKg > 0 ? m.totalPlannedKg.toFixed(0) : "—"} kg · {m.totalWOs} WOs
                  </div>
                </div>
              ))}
              {/* WMS-WOs die noch keine Postblast-Wiegung haben */}
              {(showAllProd ? wmsInProdList : wmsInProdList.slice(0, Math.max(0, MAX - runningMeals.length))).map(g => (
                <div key={g.recipeCode} className="rounded-xl px-3 py-2.5 bg-slate-50 ring-1 ring-slate-200">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-slate-800">{g.recipeCode}</span>
                    {g.maxPortions > 0 && (
                      <span className="text-[10px] font-mono text-slate-500">{g.maxPortions.toLocaleString("de-DE")} Stk</span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 mb-1 truncate">{g.recipeName}</div>
                  {g.subRecipes.slice(0, 3).map(s => (
                    <div key={s.name} className="text-[9px] text-slate-400 truncate">
                      · {s.name}{s.portions > 0 ? ` (${s.portions.toLocaleString("de-DE")} Stk)` : ""}
                    </div>
                  ))}
                  {g.subRecipes.length > 3 && (
                    <div className="text-[9px] text-slate-300">+{g.subRecipes.length - 3} Sub-Rezepte</div>
                  )}
                  <div className="text-[9px] text-blue-500 font-medium mt-1">● WMS · noch keine Wiegung</div>
                </div>
              ))}
              {wmsInProdList.length > Math.max(0, MAX - runningMeals.length) && (
                <button
                  onClick={() => setShowAllProd(v => !v)}
                  className="w-full text-[10px] text-slate-400 hover:text-slate-600 text-center py-1.5 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  {showAllProd
                    ? "▲ Weniger anzeigen"
                    : `▼ +${wmsInProdList.length - Math.max(0, MAX - runningMeals.length)} weitere (WMS)`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Redzone-Monitor-Panel ───────────────────────────────────────────────────

function RedzoneMonitorPanel({ redzone }: { redzone: RedzoneState | null }) {
  const [expanded, setExpanded] = useState(true);

  // Hooks müssen vor jedem frühen return laufen (rules-of-hooks) — daher
  // platingDone hier defensiv aus dem evtl. null-Wert ziehen.
  const platingDone = redzone?.platingDone;

  // Abgeschlossene Runs nach mealCode gruppieren (letzte 24h)
  const doneTotals = useMemo(() => {
    const map = new Map<string, { mealCode: string; name: string; total: number }>();
    for (const run of platingDone ?? []) {
      if (!run.mealCode) continue;
      const existing = map.get(run.mealCode);
      if (existing) existing.total += run.outCount ?? 0;
      else map.set(run.mealCode, { mealCode: run.mealCode, name: run.productTypeName, total: run.outCount ?? 0 });
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [platingDone]);

  if (!redzone) return null;

  const { activeLineCount, platingNow, cookingNow, totalPlated, loading, error, lastUpdate, secondsUntilRefresh } = redzone;

  // platingNow trägt jeden aktiven Run unter ZWEI Keys (mealCode + SKU) auf
  // demselben Objekt — über Set dedupen, sonst zählt/zeigt sich ein Run doppelt.
  const activeRuns = [...new Set(platingNow.values())];

  // Kompakte Zeitdarstellung: "seit X min" / "seit Xh Ym"
  function sinceMin(start: string | null): string {
    if (!start) return "—";
    const mins = Math.round((Date.now() - new Date(start).getTime()) / 60_000);
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  const lastUpdateStr = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "—";

  const hasAnyActivity = activeRuns.length > 0 || cookingNow.length > 0 || doneTotals.length > 0;
  const maxDone = doneTotals.reduce((m, d) => Math.max(m, d.total), 0);
  const doneSum = doneTotals.reduce((s, d) => s + d.total, 0);
  const active = activeLineCount > 0;

  return (
    <div className={`card border-0 overflow-hidden transition-all ${active ? "shadow-lg ring-1 ring-rose-200" : "shadow-md ring-1 ring-slate-200"}`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className={`w-full px-5 py-4 flex items-center justify-between gap-3 text-left transition-colors ${
          active ? "bg-gradient-to-r from-rose-600 to-red-600 text-white" : "bg-slate-50"
        }`}
      >
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className={`w-2.5 h-2.5 rounded-full ${
              loading ? "bg-white/50" :
              error ? "bg-amber-300" :
              active ? "bg-white animate-pulse" : "bg-emerald-500"
            }`} />
            <span className={`text-xs font-black uppercase tracking-wider ${active ? "text-white" : "text-slate-800"}`}>Redzone Live · Plating</span>
          </div>
          {active && (
            <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-white/25 text-white ring-1 ring-white/30 font-bold shrink-0">
              {activeLineCount} {activeLineCount === 1 ? "Linie" : "Linien"} platieren gerade
            </span>
          )}
          {cookingNow.length > 0 && (
            <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-bold shrink-0 ${active ? "bg-white/20 text-white ring-1 ring-white/30" : "bg-orange-100 text-orange-700 ring-1 ring-orange-200"}`}>
              🔥 {cookingNow.length} Ofen/Braiser
            </span>
          )}
          {totalPlated > 0 && (
            <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-semibold shrink-0 ${active ? "bg-white/15 text-white/90" : "bg-slate-100 text-slate-600"}`}>
              {totalPlated.toLocaleString("de-DE")} Portionen fertig (24 h)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!loading && !error && (
            <span className={`text-[10px] ${active ? "text-white/70" : "text-slate-400"}`}>Stand {lastUpdateStr} · ⟳ {secondsUntilRefresh}s</span>
          )}
          {error && <span className="text-[10px] text-amber-600 font-medium truncate max-w-40">{error}</span>}
          <span className={`text-[10px] ${active ? "text-white/70" : "text-slate-400"}`}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {expanded && (
        <div className="p-5 space-y-5 bg-white">
          {!hasAnyActivity && !loading && (
            <div className="text-[11px] text-slate-400 italic text-center py-6">
              Keine aktiven Plating- oder Kochvorgänge in den letzten 24 Stunden
            </div>
          )}

          {/* Aktive Plating-Linien */}
          {activeRuns.length > 0 && (
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-rose-600 mb-2.5 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" /> Aktiv platieren ({activeRuns.length})
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {activeRuns.map(run => (
                  <div key={run.locationName + run.runName} className="rounded-2xl overflow-hidden ring-1 ring-rose-200 bg-rose-50/70 flex">
                    <div className="w-1 bg-rose-400 shrink-0" />
                    <div className="flex-1 min-w-0 px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-slate-800 truncate">{run.locationName}</span>
                        {run.mealCode && (
                          <span className="font-mono text-xs font-black text-rose-700 shrink-0">{run.mealCode}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate mt-0.5">{run.productTypeName}</div>
                      <div className="flex items-center justify-between mt-2 text-[10px]">
                        <span className="text-slate-400">läuft seit {sinceMin(run.startTime)}</span>
                        {run.outCount != null && run.outCount > 0 && (
                          <span className="font-mono font-black text-rose-600 text-[11px]">
                            {run.outCount.toLocaleString("de-DE")} <span className="font-normal text-[9px]">Stk</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Aktive Kocher (Ofen / Braiser) */}
          {cookingNow.length > 0 && (
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-orange-600 mb-2.5">🔥 Ofen / Braiser aktiv ({cookingNow.length})</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {cookingNow.map(run => (
                  <div key={run.locationName + run.runName} className="rounded-2xl px-3.5 py-2.5 bg-orange-50/70 ring-1 ring-orange-200">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-slate-800 truncate">{run.locationName}</span>
                      <span className="text-[10px] text-orange-600 font-medium shrink-0">{run.areaName}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 truncate mt-0.5">{run.productTypeName}</div>
                    <div className="text-[9px] text-slate-400 mt-1.5">seit {sinceMin(run.startTime)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Heute fertig (abgeschlossene Runs, gruppiert nach Meal) */}
          {doneTotals.length > 0 && (
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2.5">
                ✓ Fertig platiert heute · {doneTotals.length} Rezepte erkannt · {doneSum.toLocaleString("de-DE")} Portionen
                {totalPlated > doneSum && <span className="font-normal text-slate-400"> (24 h gesamt {totalPlated.toLocaleString("de-DE")})</span>}
              </div>
              <div className="space-y-1">
                {doneTotals.slice(0, 10).map(entry => (
                  <div key={entry.mealCode} className="flex items-center gap-2 text-[10px]">
                    <span className="font-mono font-bold text-slate-700 w-16 shrink-0">{entry.mealCode}</span>
                    <span className="text-slate-500 truncate flex-1 min-w-0">{entry.name}</span>
                    <div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden shrink-0">
                      <div className="h-full rounded-full bg-emerald-400" style={{ width: `${maxDone > 0 ? (entry.total / maxDone) * 100 : 0}%` }} />
                    </div>
                    <span className="font-mono font-bold text-slate-600 w-14 text-right shrink-0">{entry.total.toLocaleString("de-DE")}</span>
                  </div>
                ))}
                {doneTotals.length > 10 && (
                  <div className="text-[9px] text-slate-400 pt-0.5">+{doneTotals.length - 10} weitere Rezepte</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

export function PostblastLiveView({ data }: { data: DataBundle }): JSX.Element {
  const monitor = usePostblastMonitor();
  const preblastMonitor = usePreblastMonitor();
  const rtiMonitor = useRtiMonitor();
  const etMonitor = useEtMonitor();
  // Rohstoff-Engpässe (Shorts-Tracker-Sheet) — separat von den Postblast/
  // Preblast-Wiegungen, weil die schon VOR dem Kochen auftreten. Siehe
  // shortageAlerts.ts für die Verknüpfung mit den aktuellen WOs.
  const shortsTrackerMonitor = useShortsTrackerMonitor();
  const redzone = useRedzoneOptional();

  // Live-WMS-Cache (wmsCache/workorders, siehe scripts/sync-wms-cache.ts) — der
  // gleiche Fallback, den KetBreakdownView schon nutzt, wenn der Firestore-Plan
  // für die aktuelle Woche leer ist. Liefert echte Portionen/Sub-Rezept-Namen
  // direkt aus dem WMS (Snowflake-Pull), nur eben (noch) ohne kg-Ziel — siehe
  // wmsWorkorderRowToEntry. Wird alle 60 s neu abgefragt damit neue WOs live erscheinen.
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWms = () => {
      fetchWmsWorkorderCache().then(res => {
        if (cancelled || !res?.rows.length) return;
        const { kept } = filterRowsToWeekWindow(res.rows, currentHfWeek());
        const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
          try { acc.push(wmsWorkorderRowToEntry(row)); }
          catch (error) { console.warn("[PostblastLive] Skipping malformed WMS row:", error); }
          return acc;
        }, []);
        if (!cancelled && mapped.length) setLiveWmsRows(mapped);
      }).catch(error => {
        if (!cancelled) console.error("[PostblastLive] Failed to fetch WMS workorder cache:", error);
      });
    };
    fetchWms();
    const interval = setInterval(fetchWms, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // ── Manuelle Datei-Uploads: schließen die kg-Lücke, die weder ET noch der
  // Live-WMS-Cache füllen können (beide liefern keine Zielmenge).
  // KET-CSV (dieselbe, die "KET Plan / WO" nutzt) liefert echte Ziel-Portionen je WO.
  // Rezept-Gewichte (export-recipes.csv) kommen global aus WoReconciliationContext.
  const KET_CSV_STORAGE_KEY = "ket-csv-rows-v1";

  const [ketCsvRows, setKetCsvRows] = useState<KetRow[] | null>(() => {
    try { const raw = localStorage.getItem(KET_CSV_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  });
  const [ketCsvFileName, setKetCsvFileName] = useState("");
  const ketFileInputRef = useRef<HTMLInputElement>(null);

  const woRecon = useWoReconciliation();
  const recipeWeights = woRecon?.recipeWeights ?? null;

  function handleKetCsvFile(file: File) {
    setKetCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = typeof e.target?.result === "string" ? e.target.result : "";
      if (!text) { alert("Fehler beim Lesen der Datei."); return; }
      try {
        const { rows } = parseKetCsv(text);
        if (!rows.length) { alert("Die CSV-Datei ist leer oder konnte nicht gelesen werden."); return; }
        setKetCsvRows(rows);
        try { localStorage.setItem(KET_CSV_STORAGE_KEY, JSON.stringify(rows)); } catch { /* quota */ }
      } catch (error) {
        alert(`Fehler beim Verarbeiten der KET-CSV: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    reader.onerror = () => alert("Fehler beim Lesen der Datei.");
    reader.readAsText(file, "utf-8");
  }

  // ── Wochen-Auswahl ──
  // productionPlan.rows bündelt Work Orders aus ALLEN in Firestore vorhandenen
  // Wochen-Docs (siehe dataSource.ts) — kann aber hinterherhinken, wenn für die
  // aktuelle KW noch kein Plan-Doc importiert wurde. Tab "ET" (GSheet) und der
  // Live-WMS-Cache sind die vom WMS live gepflegten Master-WO-Listen über
  // mehrere Wochen hinweg und schließen genau diese Lücke. Alle drei Quellen
  // zusammen ergeben die tatsächlich im System vorhandenen Wochen. Die WO-
  // Nummer selbst trägt serverseitig immer die KW als Präfix ("35-222" =
  // KW35, siehe weekPrefixFromWoNumber) — zuverlässiger als jedes freie
  // "week"-Feld.
  const woCountByWeekNum = useMemo(() => {
    const byWeek = new Map<number, Set<string>>();
    const add = (wo: string) => {
      const n = weekPrefixFromWoNumber(wo);
      if (n == null) return;
      if (!byWeek.has(n)) byWeek.set(n, new Set());
      byWeek.get(n)!.add(wo);
    };
    for (const r of data.productionPlan?.rows ?? []) add(r.workOrder);
    for (const e of etMonitor.data?.entries ?? []) add(e.workOrder);
    for (const r of liveWmsRows ?? []) add(r.workOrder);
    for (const r of ketCsvRows ?? []) add(r.woNumber);
    const counts = new Map<number, number>();
    for (const [wk, set] of byWeek) counts.set(wk, set.size);
    return counts;
  }, [data.productionPlan, etMonitor.data, liveWmsRows, ketCsvRows]);

  // "Tote Karteileichen" (uralte WO-Reste, die irgendwo im Sheet hängen bleiben)
  // sollen die Wochenauswahl nicht zumüllen — nur ein plausibles Fenster um die
  // reale Kalenderwoche herum zulassen (2 Monate zurück, 3 Monate voraus).
  const allowedWeekNums = useMemo(() => {
    const center = weekNumFromHfWeek(currentHfWeek()) ?? 1;
    const set = new Set<number>();
    for (let d = -8; d <= 12; d++) set.add(((center - 1 + d) % 52 + 52) % 52 + 1);
    return set;
  }, []);

  const weekOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const w of data.weeks) {
      const n = weekNumFromHfWeek(w);
      if (n != null && woCountByWeekNum.has(n) && allowedWeekNums.has(n)) labels.add(w);
    }
    // Wochen, die ET/Plan schon kennen, die aber noch nicht im "weeks"-Katalog
    // stehen (z.B. eine ganz frische KW) — Label mit dem Jahr der aktuellen
    // HF-Woche synthetisieren, damit sie trotzdem wählbar ist.
    const refYear = currentHfWeek().match(/^(\d{4})/)?.[1];
    for (const n of woCountByWeekNum.keys()) {
      if (!allowedWeekNums.has(n)) continue;
      if ([...labels].some(w => weekNumFromHfWeek(w) === n)) continue;
      if (refYear) labels.add(`${refYear}-W${String(n).padStart(2, "0")}`);
    }
    return [...labels].sort();
  }, [data.weeks, woCountByWeekNum, allowedWeekNums]);

  // Das RTI-Sheet trägt seine eigene, live vom Menschen im Sheet gepflegte KW
  // ("KW 34" in Spalte A) — das ist die verlässlichste Quelle dafür, welche
  // Woche gerade WIRKLICH auf der Schicht läuft, unabhängig davon, welcher
  // Firestore-Plan-Doc zufällig "der neueste" ist.
  const rtiWeekNum = useMemo(
    () => (rtiMonitor.data ? weekNumFromHfWeek(rtiMonitor.data.week) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur der week-Wert ist relevant, nicht die Objektidentität
    [rtiMonitor.data?.week]
  );

  // ET/RTI treffen erst nach ihrem ersten Poll ein (~1-2s nach dem Laden), der
  // Firestore-Plan dagegen sofort — ein Default, der beim allerersten Tick fix
  // "einrastet", würde also auf der (u.U. veralteten) Plan-Woche hängen bleiben,
  // sobald ET/RTI kurz danach eine bessere Woche liefern. Deshalb bleibt die
  // Auswahl im "Auto"-Modus (folgt RTI/aktueller KW), bis der Mensch selbst am
  // Dropdown dreht — erst dann "rastet" die Auswahl endgültig ein.
  const userPickedWeekRef = useRef(false);
  const [selectedWeek, setSelectedWeek] = useState("");
  useEffect(() => {
    if (weekOptions.length === 0) return;
    const hf = currentHfWeek();
    const hfWeekNum = weekNumFromHfWeek(hf);
    // RTI darf die Auswahl nur nach VORNE ziehen (Schicht läuft schon in einer
    // Woche, die der Firestore-Plan noch nicht kennt), nie nach HINTEN — die
    // KW-Zelle im RTI-Sheet wird von Hand gepflegt und bleibt oft tagelang auf
    // der letzten Woche stehen, bis jemand daran denkt sie zu ändern. Ohne
    // diese Sperre würde ein stehen gelassenes "KW 35" die App auch dann noch
    // in KW35 starten lassen, wenn die reale Kalenderwoche längst KW36 ist.
    const rtiIsStale = rtiWeekNum != null && hfWeekNum != null
      && (((rtiWeekNum - hfWeekNum + 26) % 52 + 52) % 52) - 26 < 0;
    setSelectedWeek(prev => {
      if (userPickedWeekRef.current && prev && weekOptions.includes(prev)) return prev;
      if (rtiWeekNum != null && !rtiIsStale) {
        const rtiMatch = weekOptions.find(w => weekNumFromHfWeek(w) === rtiWeekNum);
        if (rtiMatch) return rtiMatch;
      }
      if (weekOptions.includes(hf)) return hf;
      const planWeek = data.productionPlan?.week;
      if (planWeek && weekOptions.includes(planWeek)) return planWeek;
      if (prev && weekOptions.includes(prev)) return prev;
      return weekOptions[weekOptions.length - 1];
    });
  }, [weekOptions, rtiWeekNum, data.productionPlan?.week]);

  function handleSelectWeek(w: string) {
    userPickedWeekRef.current = true;
    setSelectedWeek(w);
  }

  const selectedWeekNum = selectedWeek ? weekNumFromHfWeek(selectedWeek) : null;

  // „Schon plaitiert / steht rum" je Meal — LinePlaiting-Actuals ⊕ Redzone
  // (24 h + 72 h) für „Fortschritt je Meal" / „Was kann ich plaiten?", plus der
  // Holding-Puffer je Meal für den Minimum-Needs-Prüfhinweis. Siehe
  // useCombinedPlaited.ts.
  const { plaitedByCode, holdingMealsByCode } = useCombinedPlaited(selectedWeekNum);

  // Minimum Needs kommen aus dem „Volume Overview"-Tab der Transparency Plan
  // (alle Märkte zusammengerechnet).
  const volumeOverview = useVolumeOverviewMonitor();

  // Effektiver Plan für die gewählte Woche, gestaffelt nach Vertrauenswürdigkeit
  // — genau die Kette, die KetBreakdownView für dasselbe Problem schon nutzt,
  // plus eine kg-Schätzung on top:
  // 1) Firestore-Plan-Zeilen (einzige Quelle mit echtem kg-Soll)
  // 2) Hochgeladene KET-CSV (echte Ziel-Portionen je WO, manuell aktuell gehalten)
  // 3) Live-WMS-Cache (echte Portionen/Sub-Rezept-Namen direkt aus dem WMS)
  // 4) ET-Master-Liste (nur Recipe/Sub-Rezept-Identität, keine Portionen)
  // Jede Stufe ergänzt nur WOs, die die vorherige noch nicht kennt, damit eine
  // schwächere Quelle eine stärkere nie überschreibt. Für Stufe 2+3 (mit
  // Portionen) wird — falls Rezept-Gewichte hochgeladen sind — eine kg-Schätzung
  // berechnet (Portionen × Gramm/Portion) und als "isEstimated" markiert; ohne
  // Portionen (Stufe 4) oder ohne Rezept-Gewichte bleibt die WO "OHNE PLAN".
  const { filteredProductionPlan, unplannedWorkOrders, estimatedWorkOrders } = useMemo(() => {
    const allRows = data.productionPlan?.rows ?? [];
    const baseRows = selectedWeekNum == null
      ? allRows
      : allRows.filter(r => weekPrefixFromWoNumber(r.workOrder) === selectedWeekNum);

    const known = new Set(baseRows.map(r => r.workOrder));
    const gapRows: WorkOrderEntry[] = [];
    const unplanned = new Set<string>();
    const estimated = new Set<string>();

    // Index over ALL plan rows (not just week-filtered) for kg-value fallback
    const allRowsByWo = new Map<string, WorkOrderEntry>();
    for (const r of allRows) { if (r.workOrder) allRowsByWo.set(r.workOrder, r); }

    function addGapRow(row: WorkOrderEntry, targetPortions: number | undefined | null) {
      if (known.has(row.workOrder) || weekPrefixFromWoNumber(row.workOrder) !== selectedWeekNum) return;
      known.add(row.workOrder);
      const kgEstimate = estimatePlannedKg(recipeWeights, row.recipeCode, row.subRecipe, targetPortions);
      if (kgEstimate != null) {
        estimated.add(row.workOrder);
        gapRows.push({ ...row, postKg: kgEstimate });
      } else {
        // Fallback: if the full production plan has kg values for this WO, use them
        const planRow = allRowsByWo.get(row.workOrder);
        const fallbackKg = planRow ? (planRow.postKg || planRow.kitchenKg || planRow.stagingKg || 0) : 0;
        if (fallbackKg > 0) {
          gapRows.push({ ...row, postKg: planRow!.postKg, kitchenKg: planRow!.kitchenKg, stagingKg: planRow!.stagingKg });
        } else {
          unplanned.add(row.workOrder);
          gapRows.push(row);
        }
      }
    }

    if (selectedWeekNum != null) {
      for (const r of ketCsvRows ?? []) {
        addGapRow({
          run: 1,
          kitchenDay: r.dateNeeded,
          workOrder: r.woNumber,
          recipeId: r.recipeId,
          recipeCode: r.recipeCode,
          recipeName: r.recipeName,
          subRecipe: r.subRecipeName,
          plannedMeals: r.targetPortions,
          targetPortions: r.targetPortions,
          stagingKg: 0,
          kitchenKg: 0,
          postKg: 0,
          yieldPct: 0,
          cookMethods: r.cookMethods.join(", "),
          stagingStatus: r.stagingStatus,
          kitchenStatus: r.kitchenStatus,
        }, r.targetPortions);
      }
      for (const r of liveWmsRows ?? []) {
        addGapRow(r, r.targetPortions ?? r.plannedMeals);
      }
      for (const e of etMonitor.data?.entries ?? []) {
        addGapRow({
          run: 1,
          kitchenDay: e.cookingDay,
          workOrder: e.workOrder,
          recipeCode: e.recipeCode,
          recipeName: e.recipeName,
          subRecipe: e.subRecipeName,
          plannedMeals: 0,
          stagingKg: 0,
          kitchenKg: 0,
          postKg: 0,
          yieldPct: 0,
        }, null);
      }
    }

    const plan = (baseRows.length === 0 && gapRows.length === 0)
      ? data.productionPlan
      : {
        week: selectedWeek || (data.productionPlan?.week ?? ""),
        generatedAt: data.productionPlan?.generatedAt ?? "",
        rows: [...baseRows, ...gapRows],
      };
    return { filteredProductionPlan: plan, unplannedWorkOrders: unplanned, estimatedWorkOrders: estimated };
  }, [data.productionPlan, etMonitor.data, liveWmsRows, ketCsvRows, recipeWeights, selectedWeek, selectedWeekNum]);

  const week = filteredProductionPlan?.week ?? "—";

  // Wiegungen, deren WO-Nummer auf eine ANDERE KW als die ausgewählte zeigt —
  // z.B. Nachzügler vom Vortag/Vorwoche im selben Sheet-Tab. Diese tauchen in
  // dieser Ansicht bewusst nicht als Fortschritt auf; wir zeigen aber, dass es
  // sie gibt, damit nichts "unsichtbar verschwindet".
  // Zählt Wiegungen aus ANDEREN KWs in Post- UND Pre-Blast — die Sheets kumulieren alle
  // Wochen, diese Zahl zeigt wie viele Einträge aus dem Live Feed herausgefiltert wurden.
  const offWeekWeighingCount = useMemo(() => {
    if (selectedWeekNum == null) return 0;
    let n = 0;
    for (const e of monitor.data?.entries ?? []) {
      const wn = weekPrefixFromWoNumber(e.workOrder);
      if (wn != null && wn !== selectedWeekNum) n++;
    }
    for (const e of preblastMonitor.data?.entries ?? []) {
      const wn = weekPrefixFromWoNumber(e.workOrder);
      if (wn != null && wn !== selectedWeekNum) n++;
    }
    return n;
  }, [monitor.data, preblastMonitor.data, selectedWeekNum]);

  const rtiWeekMismatch = rtiWeekNum != null && selectedWeekNum != null && rtiWeekNum !== selectedWeekNum;

  // ── State ──
  const [expandedMeals, setExpandedMeals] = useState<Set<string>>(new Set());
  const [liveFeedSearch, setLiveFeedSearch] = useState("");
  const [liveFeedToday, setLiveFeedToday] = useState(true);
  const [liveFeedStage, setLiveFeedStage] = useState<"post" | "pre">("post");
  const [backfillFilter, setBackfillFilter] = useState<"all" | "critical" | "behind">("all");
  const [mealFilter, setMealFilter] = useState<"offen" | "all" | "critical" | "running" | "done">("offen");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [shortagesExpanded, setShortagesExpanded] = useState(false);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Daten ──
  const { matched, meals, backfill } = useMemo(
    () => matchPostblastToWorkOrders(monitor.data, preblastMonitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders),
    [monitor.data, preblastMonitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders]
  );
  // Wöchentliche Rücksetzung: die Rohdaten aus dem Sheet wachsen über ALLE
  // Kalenderwochen hinweg unbegrenzt weiter — für Tempo/Anomalie/Schicht-
  // Kennzahlen (KI-Agent) nur die Wiegungen der aktuell gewählten Woche
  // zählen, sonst würden liegen gebliebene Wiegungen aus einer anderen KW die
  // "Gewogen heute"-Bilanz verfälschen. Die WO-Zuordnung in matched/meals
  // braucht das nicht extra (die schaut ohnehin nur exakte WO-Nummern der
  // gewählten Woche nach) — nur die "heute"-Zähler im Live Feed arbeiten
  // direkt auf den rohen Einträgen.
  const weekScopedPostblast = useMemo((): PostblastData | null => {
    if (!monitor.data || selectedWeekNum == null) return monitor.data;
    const entries = monitor.data.entries.filter(e => weekPrefixFromWoNumber(e.workOrder) === selectedWeekNum);
    if (entries.length === monitor.data.entries.length) return monitor.data;
    const byWorkOrder = new Map<string, typeof entries>();
    const bySubRecipe = new Map<string, typeof entries>();
    for (const e of entries) {
      if (e.workOrder) { if (!byWorkOrder.has(e.workOrder)) byWorkOrder.set(e.workOrder, []); byWorkOrder.get(e.workOrder)!.push(e); }
      if (e.subRecipeName) { if (!bySubRecipe.has(e.subRecipeName)) bySubRecipe.set(e.subRecipeName, []); bySubRecipe.get(e.subRecipeName)!.push(e); }
    }
    return {
      entries, byWorkOrder, bySubRecipe,
      totalWeightKg: entries.reduce((s, e) => s + e.weightKg, 0),
      lastEntry: entries.length > 0 ? entries[entries.length - 1] : null,
      lastUpdated: monitor.data.lastUpdated,
    };
  }, [monitor.data, selectedWeekNum]);
  const todayEntries = useMemo(
    () => (weekScopedPostblast?.entries ?? []).filter(e => e.date === todayStr),
    [weekScopedPostblast, todayStr]
  );
  const todayPreCount = useMemo(
    () => (preblastMonitor.data?.entries ?? []).filter(e => e.date === todayStr).length,
    [preblastMonitor.data, todayStr]
  );
  const liveEntries = useMemo(() => {
    const all = (liveFeedStage === "post" ? monitor.data?.entries : preblastMonitor.data?.entries) ?? [];
    // KW-Filter zuerst — die Sheets kumulieren alle Wochen, nur die ausgewählte KW zeigen.
    // WO-Prefix ist der einzige zuverlässige KW-Indikator (Datum-Spalte in den Sheets meist leer).
    let list = selectedWeekNum != null
      ? all.filter(e => weekPrefixFromWoNumber(e.workOrder) === selectedWeekNum)
      : [...all];
    if (liveFeedToday) list = list.filter(e => e.date === todayStr);
    if (liveFeedSearch.trim()) {
      const s = liveFeedSearch.toLowerCase();
      list = list.filter(e => e.workOrder.toLowerCase().includes(s) || e.subRecipeName.toLowerCase().includes(s));
    }
    return [...list].reverse().slice(0, 60);
  }, [monitor.data, preblastMonitor.data, liveFeedStage, liveFeedToday, liveFeedSearch, todayStr, selectedWeekNum]);

  const filteredBackfill = useMemo(() => {
    if (backfillFilter === "critical") return backfill.filter(b => b.priority === "critical");
    if (backfillFilter === "behind") return backfill.filter(b => b.priority === "behind");
    return backfill;
  }, [backfill, backfillFilter]);

  // ── Verlauf ──
  const { firstSeen, shiftStartActual, snapCount, clear: clearHistory } = useWoHistory(matched, week);

  // ── Bündelungs-Gruppen: gleiche Sub-Rezepte fehlen in mehreren Meals ──
  const bundleGroups = useMemo(() => {
    const map = new Map<string, typeof backfill>();
    for (const b of backfill) {
      if (!map.has(b.subRecipe)) map.set(b.subRecipe, []);
      map.get(b.subRecipe)!.push(b);
    }
    return [...map.entries()]
      .filter(([, items]) => items.length > 1)
      .sort((a, b) => b[1].reduce((s, x) => s + x.missingKg, 0) - a[1].reduce((s, x) => s + x.missingKg, 0));
  }, [backfill]);

  // ── Chargen-Map: grobe Batch-Schätzung je bestehender WO (rein informativ) ──
  const batchMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matched) {
      if (m.plannedKg <= 0) continue;
      const woEntry = filteredProductionPlan?.rows.find(r => r.workOrder === m.workOrder);
      const { capacityKg } = findEquipmentForSubRecipe(m.subRecipe, woEntry?.cookMethods, data.equipmentBible);
      map.set(m.workOrder, Math.max(1, Math.ceil(m.plannedKg / (capacityKg > 0 ? capacityKg : 100))));
    }
    return map;
  }, [matched, filteredProductionPlan, data.equipmentBible]);

  // ── Rohstoff-Engpässe (Shorts Tracker) ──
  const shortageImpacts = useMemo(
    () => correlateShortages(shortsTrackerMonitor.data?.entries ?? [], matched),
    [shortsTrackerMonitor.data, matched]
  );

  // ── Sets & Filter ──
  const backfillByWo = useMemo(() => new Map(backfill.map(b => [b.workOrder, b])), [backfill]);

  // Je Meal: netto platierbar, "beendet" (nichts mehr zu tun) + ehrliche % —
  // gemeinsame Logik mit dem Plating Dashboard (siehe mealProgress.ts).
  const mealMeta = useMemo(() => {
    const m = new Map<string, ReturnType<typeof mealReadiness>>();
    for (const meal of meals) m.set(meal.recipeCode, mealReadiness(meal, recipeWeights, plaitedByCode));
    return m;
  }, [meals, recipeWeights, plaitedByCode]);

  const filteredMeals = useMemo(() => {
    const pass = (m: MealProgress) => {
      const meta = mealMeta.get(m.recipeCode)!;
      if (mealFilter === "offen") return !meta.finished;
      if (mealFilter === "critical") return m.criticalWOs.length > 0;
      if (mealFilter === "running") return m.completedWOs < m.totalWOs && m.criticalWOs.length === 0 && !meta.finished;
      if (mealFilter === "done") return meta.finished;
      return true;
    };
    // Chronologisch nach Plating-Bereitschaft: was jetzt platierbar ist zuerst
    // (höchste Netto-Menge), runter bis zu Meals ohne Produktion (0 %).
    return meals.filter(pass).sort((a, b) => {
      const ma = mealMeta.get(a.recipeCode)!, mb = mealMeta.get(b.recipeCode)!;
      return (mb.net?.netMeals ?? 0) - (ma.net?.netMeals ?? 0) || b.progressPct - a.progressPct;
    });
  }, [meals, mealFilter, mealMeta]);

  // ── Summary ──
  const totalPlanned = meals.reduce((s, m) => s + m.totalPlannedKg, 0);
  const totalActual = meals.reduce((s, m) => s + m.totalActualKg, 0);
  const overallPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
  const mealDone = meals.filter(m => mealMeta.get(m.recipeCode)?.finished).length;
  const mealCritical = meals.filter(m => m.criticalWOs.length > 0 && !mealMeta.get(m.recipeCode)?.finished).length;
  const mealRunning = meals.length - mealCritical - mealDone;
  const shiftDeltaKg = totalActual - Object.values(shiftStartActual).reduce((s, v) => s + v, 0);
  const unplannedCount = matched.filter(m => !m.hasPlan).length;
  const estimatedCount = matched.filter(m => m.isEstimated).length;

  const lastUpdate = monitor.lastUpdate
    ? new Date(monitor.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // ── Handler ──
  function toggleMeal(code: string) {
    setExpandedMeals(prev => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await monitor.forceRefresh();
    setTimeout(() => setIsRefreshing(false), 1000);
  }

  function scrollToMeal(recipeCode: string) {
    setExpandedMeals(prev => new Set([...prev, recipeCode]));
    setMealFilter("all");
    setTimeout(() => {
      document.getElementById(`meal-${recipeCode}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-8">

      {/* ══ ROHSTOFF-ENGPÄSSE (Shorts Tracker) ═════════════════════════════ */}
      {shortageImpacts.length > 0 && (
        <div className={`card shadow-sm transition-all ${shortagesExpanded ? "p-4 bg-red-50 ring-1 ring-red-300" : "px-4 py-3 bg-red-50/70 ring-1 ring-red-200"}`}>
          <button
            onClick={() => setShortagesExpanded(e => !e)}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-xs font-bold text-red-700 uppercase tracking-wide shrink-0">
                ⚠ {shortageImpacts.length} Rohstoff-Engpass{shortageImpacts.length > 1 ? "e" : ""}
                {shortageImpacts.some(i => i.isNew) && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-red-200 text-red-800 font-bold">NEU</span>
                )}
              </span>
              {!shortagesExpanded && (
                <div className="flex flex-wrap gap-1 min-w-0">
                  {shortageImpacts.slice(0, 5).map(impact => {
                    const ing = impact.shortage.ingredient ?? "";
                    const shortName = ing.includes("/")
                      ? (ing.split("/")[1]?.split(",")[0]?.trim() ?? ing)
                      : (ing.split(",")[0]?.trim() ?? ing);
                    const kg = Math.abs(impact.shortage.shortKg ?? 0);
                    return (
                      <span
                        key={impact.shortage.rowIndex}
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                          impact.isNew ? "bg-red-200 text-red-800" : "bg-red-100 text-red-700"
                        }`}
                      >
                        {impact.isNew ? "🆕 " : ""}{shortName} −{kg.toFixed(0)} kg
                      </span>
                    );
                  })}
                  {shortageImpacts.length > 5 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-500">
                      +{shortageImpacts.length - 5} weitere
                    </span>
                  )}
                </div>
              )}
            </div>
            <span className="text-[10px] text-red-400 shrink-0">{shortagesExpanded ? "▲ Zuklappen" : "▼ Details"}</span>
          </button>
          {shortagesExpanded && (
            <ul className="mt-3 space-y-1.5 text-xs text-red-900">
              {shortageImpacts.map(impact => (
                <li key={impact.shortage.rowIndex} className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5">{impact.isNew ? "🆕" : "⚠"}</span>
                  <span>{describeShortageImpact(impact)}</span>
                </li>
              ))}
            </ul>
          )}
          {shortsTrackerMonitor.error && (
            <div className="text-[10px] text-red-500 mt-1">{shortsTrackerMonitor.error}</div>
          )}
        </div>
      )}

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <div className="card p-6 bg-gradient-to-br from-teal-600 to-cyan-700 text-white border-0 shadow-lg">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2.5 h-2.5 rounded-full ${monitor.isPolling ? "bg-emerald-300 animate-pulse" : "bg-slate-400"}`} />
              <span className="text-sm font-medium text-teal-100">{monitor.isPolling ? `Live · ${lastUpdate}` : "Offline"}</span>
              {snapCount > 0 && <span className="text-xs text-teal-200/70">· {snapCount} Snapshots</span>}
              <span
                title={rtiMonitor.data ? "RTI-Sheet verbunden — Status & vorbereitete Backfill-WOs werden abgeglichen" : "RTI-Sheet noch nicht geladen — Backfill-Logik nutzt nur Gewichts-Schätzung"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  rtiMonitor.data ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {rtiMonitor.data ? "● RTI abgeglichen" : "○ RTI wartet"}
              </span>
              <span
                title={etMonitor.data ? "ET-Master-WO-Liste verbunden — liefert die live im WMS angelegten WOs über mehrere Wochen hinweg, auch wenn der Produktionsplan für eine Woche noch fehlt" : "ET-Sheet noch nicht geladen — Wochenauswahl nutzt bislang nur den Produktionsplan"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  etMonitor.data ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {etMonitor.data ? "● ET abgeglichen" : "○ ET wartet"}
              </span>
              <span
                title={liveWmsRows ? "Live-WMS-Cache verbunden — ergänzt echte Portionen/Sub-Rezept-Namen für WOs, die im Produktionsplan noch fehlen" : "Live-WMS-Cache noch nicht geladen oder leer"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  liveWmsRows ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {liveWmsRows ? "● WMS abgeglichen" : "○ WMS wartet"}
              </span>
              <span
                title={preblastMonitor.data ? "Pre-Blast-Sheet verbunden — zeigt Chargen, die schon gekocht sind, aber noch nicht post-blast gewogen wurden" : "Pre-Blast-Sheet noch nicht geladen"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  preblastMonitor.data ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {preblastMonitor.data ? "● Pre-Blast abgeglichen" : "○ Pre-Blast wartet"}
              </span>
              <span
                title={
                  redzone && !redzone.error
                    ? `Redzone Live verbunden — ${redzone.activeLineCount} Plating-${redzone.activeLineCount === 1 ? "Linie" : "Linien"} aktiv, ${redzone.totalPlated.toLocaleString("de-DE")} Portionen fertig (letzte 24h)`
                    : redzone?.error
                    ? `Redzone Fehler: ${redzone.error}`
                    : "Redzone wird geladen"
                }
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  redzone && !redzone.error
                    ? redzone.activeLineCount > 0
                      ? "bg-red-400/30 text-red-100 ring-red-300/60 animate-pulse"
                      : "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40"
                    : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {redzone && !redzone.error
                  ? redzone.activeLineCount > 0
                    ? `● Redzone · ${redzone.activeLineCount} ${redzone.activeLineCount === 1 ? "Linie" : "Linien"}`
                    : "● Redzone verbunden"
                  : "○ Redzone wartet"}
              </span>
              {rtiWeekMismatch && (
                <button
                  onClick={() => {
                    const match = weekOptions.find(w => weekNumFromHfWeek(w) === rtiWeekNum);
                    if (match) setSelectedWeek(match);
                  }}
                  title="Das RTI-Sheet meldet aktuell eine andere Kalenderwoche als hier ausgewählt — anklicken zum Wechseln"
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 bg-red-400/25 text-red-100 ring-red-300/50 hover:bg-red-400/40 transition"
                >
                  ⚠ RTI meldet KW{rtiWeekNum} — wechseln
                </button>
              )}
              {offWeekWeighingCount > 0 && (
                <span
                  title="Wiegungen mit einer WO-Nummer aus einer anderen Kalenderwoche als der ausgewählten — werden hier bewusst nicht mitgezählt"
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 bg-amber-400/20 text-amber-100 ring-amber-400/40"
                >
                  ⚠ {offWeekWeighingCount} Wiegung{offWeekWeighingCount === 1 ? "" : "en"} andere KW ausgeblendet
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold">Postblast Live Monitor</h1>
            <p className="mt-1 text-sm text-teal-100/80">
              {week} · {meals.length} Meals · {matched.length} WOs · Echtzeit-Wiegungen vs. Produktionsplan
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                className="px-3 py-1.5 rounded-full text-xs bg-white/20 hover:bg-white/30 text-white ring-1 ring-white/30 transition disabled:opacity-50 font-medium"
              >
                {isRefreshing ? "⟳ Lädt…" : "⟳ Refresh"}
              </button>
              {weekOptions.length > 0 && (
                <select
                  value={selectedWeek}
                  onChange={e => handleSelectWeek(e.target.value)}
                  title="Angezeigte Woche — Produktionsplan enthält WOs aus mehreren Wochen, hier filtern"
                  className="text-xs px-2 py-1.5 rounded-full bg-white/20 text-white ring-1 ring-white/30 border-0 font-medium"
                >
                  {weekOptions.map(w => {
                    const n = weekNumFromHfWeek(w);
                    const count = n != null ? woCountByWeekNum.get(n) ?? 0 : 0;
                    return <option key={w} value={w} className="text-slate-900">{w} · {count} WOs</option>;
                  })}
                </select>
              )}
            </div>
            {monitor.error && (
              <div className="px-3 py-1 rounded-full bg-red-400/30 ring-1 ring-red-300 text-red-100 text-xs">{monitor.error}</div>
            )}
          </div>
        </div>

        {/* Gesamtfortschritt */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-bold text-white">Gesamtfortschritt</span>
            <div className="flex items-center gap-3 text-teal-100">
              {shiftDeltaKg > 0.5 && snapCount > 1 && (
                <span className="text-emerald-300 font-medium text-xs">+{fmt(shiftDeltaKg, 1)} kg seit Schichtstart</span>
              )}
              <span className="font-mono font-bold text-white">
                {totalPlanned > 0 ? `${fmt(overallPct, 1)}%` : "— kein Soll"}
              </span>
              <span className="text-xs text-teal-200/70">{fmtMass(totalActual * 1000)} / {fmtMass(totalPlanned * 1000)}</span>
            </div>
          </div>
          <div className="w-full h-4 rounded-full bg-white/20 overflow-hidden">
            <div
              className={`h-4 rounded-full transition-all duration-700 ${
                overallPct >= 95 ? "bg-emerald-400" : overallPct >= 60 ? "bg-sky-300" : overallPct >= 30 ? "bg-amber-400" : "bg-red-400"
              }`}
              style={{ width: `${Math.min(overallPct, 100)}%` }}
            />
          </div>
        </div>

        {/* Stat-Tiles */}
        <div className="mt-4 grid grid-cols-4 md:grid-cols-9 gap-2">
          {([
            { label: "Meals", value: meals.length, sub: "gesamt", color: "text-white", bg: "bg-white/15", onClick: undefined as (() => void) | undefined },
            { label: "WOs", value: matched.length, sub: "gesamt", color: "text-white", bg: "bg-white/15", onClick: undefined as (() => void) | undefined },
            { label: "WO Fertig", value: matched.filter(m => m.isComplete).length, sub: `von ${matched.length}`, color: "text-emerald-300", bg: "bg-emerald-500/20", onClick: (() => setMealFilter("done")) as (() => void) | undefined },
            { label: "Kritisch", value: backfill.filter(b => b.priority === "critical").length, sub: "WOs", color: "text-red-300", bg: "bg-red-500/20", onClick: (() => setMealFilter("critical")) as (() => void) | undefined },
            { label: "Im Chiller", value: matched.filter(m => m.awaitingPostBlast).length, sub: "wartet auf Post-Blast", color: "text-cyan-300", bg: "bg-cyan-500/20", onClick: undefined as (() => void) | undefined },
            { label: "Meals kritisch", value: mealCritical, sub: "Meals", color: "text-orange-300", bg: "bg-orange-500/20", onClick: (() => setMealFilter("critical")) as (() => void) | undefined },
            { label: "Meals fertig", value: mealDone, sub: `von ${meals.length}`, color: "text-emerald-300", bg: "bg-emerald-500/20", onClick: (() => setMealFilter("done")) as (() => void) | undefined },
            { label: "≈ Geschätzt", value: estimatedCount, sub: "Soll aus Portionen", color: "text-amber-300", bg: "bg-amber-500/20", onClick: undefined as (() => void) | undefined },
            { label: "Ohne Plan", value: unplannedCount, sub: "kein Soll bekannt", color: "text-slate-300", bg: "bg-white/10", onClick: undefined as (() => void) | undefined },
          ]).map(s => (
            <button
              key={s.label}
              onClick={s.onClick}
              disabled={!s.onClick}
              className={`${s.bg} rounded-xl p-2.5 text-center ${s.onClick ? "hover:bg-white/25 transition cursor-pointer" : "cursor-default"}`}
            >
              <div className="text-[10px] text-white/60 uppercase font-bold tracking-wide">{s.label}</div>
              <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-white/40">{s.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ══ MEAL-FORTSCHRITT ════════════════════════════════════════════════ */}
      {meals.length > 0 && (
        <div className="card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Fortschritt je Meal</h3>
              <p className="text-xs text-slate-500 mt-0.5">{filteredMeals.length} von {meals.length} Meals · klicken zum Aufklappen</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([
                { key: "offen", label: `Offen · ${mealCritical + mealRunning}`, active: "bg-slate-700 text-white", inactive: "bg-white ring-1 ring-slate-200 text-slate-600" },
                { key: "critical", label: `⚠ Kritisch · ${mealCritical}`, active: "bg-red-600 text-white", inactive: "bg-white ring-1 ring-red-200 text-red-600" },
                { key: "running", label: `◌ Laufend · ${mealRunning}`, active: "bg-sky-600 text-white", inactive: "bg-white ring-1 ring-sky-200 text-sky-600" },
                { key: "done", label: `✓ Plaitiert · ${mealDone}`, active: "bg-emerald-600 text-white", inactive: "bg-white ring-1 ring-emerald-200 text-emerald-700" },
                { key: "all", label: `Alle · ${meals.length}`, active: "bg-slate-700 text-white", inactive: "bg-white ring-1 ring-slate-200 text-slate-600" },
              ] as const).map(f => (
                <button
                  key={f.key}
                  onClick={() => setMealFilter(f.key as typeof mealFilter)}
                  className={`text-[10px] px-3 py-1.5 rounded-full font-bold transition shadow-sm ${mealFilter === f.key ? f.active : f.inactive}`}
                >
                  {f.label}
                </button>
              ))}
              <div className="w-px bg-slate-200 mx-1" />
              <button
                onClick={() => setExpandedMeals(new Set(meals.map(m => m.recipeCode)))}
                className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle ▼
              </button>
              <button
                onClick={() => setExpandedMeals(new Set())}
                className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle ▲
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {filteredMeals.map(meal => {
              const expanded = expandedMeals.has(meal.recipeCode);
              const mealBackfillNeeds = meal.workOrders.map(wo => backfillByWo.get(wo.workOrder)).filter((b): b is BackfillNeed => b != null);
              const mealBackfillPortions = mealBackfillNeeds.reduce((s, b) => s + b.estimatedPortions, 0);
              const isDone = meal.completedWOs === meal.totalWOs;
              const isCritical = meal.criticalWOs.length > 0;
              const awaitingWOs = meal.workOrders.filter(wo => wo.awaitingPostBlast);
              const awaitingKg = awaitingWOs.reduce((s, wo) => s + wo.preBlastKg, 0);
              // Ehrlicher Fortschritt = das schwächste Sub-Rezept (siehe
              // mealProgress.ts) — sonst steht 100 %, obwohl eine Komponente fehlt.
              const truePct = mealMeta.get(meal.recipeCode)?.displayPct ?? meal.progressPct;

              // Runs gruppieren
              const byRun = new Map<number, WoMatchedStatus[]>();
              for (const wo of meal.workOrders) {
                const r = wo.run ?? 1;
                if (!byRun.has(r)) byRun.set(r, []);
                byRun.get(r)!.push(wo);
              }
              const runEntries = [...byRun.entries()].sort(([a], [b]) => a - b);
              const hasRuns = runEntries.length > 1;

              const borderColor = isCritical ? "border-red-300" : isDone ? "border-emerald-300" : "border-slate-200";
              const bgColor = isCritical ? "bg-red-50/40" : isDone ? "bg-emerald-50/20" : "";

              return (
                <div
                  id={`meal-${meal.recipeCode}`}
                  key={meal.recipeCode}
                  className={`rounded-2xl border-2 overflow-hidden transition-shadow ${borderColor} ${bgColor} ${expanded ? "shadow-md" : "hover:shadow-sm"}`}
                >
                  {/* Füllstand-Leiste — läuft langsam voll, solange die Wiegungen reinkommen */}
                  <div className="h-2 bg-slate-100">
                    <div
                      className={`h-full transition-all duration-700 ${
                        isCritical ? "bg-red-400" :
                        truePct >= 95 ? "bg-emerald-400" :
                        truePct >= 60 ? "bg-sky-400" :
                        truePct >= 30 ? "bg-amber-400" : "bg-slate-300"
                      }`}
                      style={{ width: `${Math.min(truePct, 100)}%` }}
                    />
                  </div>
                  {/* Linke Statuslinie */}
                  <div className="flex">
                    <div className={`w-1.5 rounded-l-2xl shrink-0 ${isCritical ? "bg-red-400" : isDone ? "bg-emerald-400" : "bg-sky-300"}`} />
                    <div className="flex-1 min-w-0">
                      {/* Meal-Header */}
                      <div
                        className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 cursor-pointer select-none"
                        onClick={() => toggleMeal(meal.recipeCode)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-slate-400 text-xs">{expanded ? "▼" : "▶"}</span>
                            <span className="font-bold text-sm text-slate-900">{meal.recipeCode}</span>
                            <span className="text-slate-500 text-sm truncate">{meal.recipeName}</span>
                            {isDone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold shrink-0">✓ FERTIG</span>}
                            {mealBackfillNeeds.length > 0 && (
                              <span
                                title="Reguläre WOs durch, Plan nicht erreicht — Backfill im WMS anlegen"
                                className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 font-bold shrink-0"
                              >
                                Backfill: −{fmt(mealBackfillPortions)} Stk
                              </span>
                            )}
                            {hasRuns && runEntries.map(([r, wos]) => {
                              const rDone = wos.every(w => w.isComplete);
                              const rStarted = wos.some(w => w.actualKg > 0);
                              const rCrit = wos.some(w => w.isCritical);
                              return (
                                <span
                                  key={r}
                                  title={`Run ${r}: ${wos.filter(w => w.isComplete).length}/${wos.length} Sub-WOs fertig`}
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ring-1 ${
                                    rDone ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
                                    : rCrit ? "bg-red-100 text-red-700 ring-red-200"
                                    : rStarted ? "bg-indigo-100 text-indigo-700 ring-indigo-200"
                                    : "bg-slate-100 text-slate-400 ring-slate-200"
                                  }`}
                                >
                                  Run {r} {rDone ? "✓" : rStarted ? `${wos.filter(w => w.isComplete).length}/${wos.length}` : "wartet"}
                                </span>
                              );
                            })}
                            {awaitingWOs.length > 0 && (
                              <span
                                title={`${awaitingWOs.length} WO(s) schon pre-blast gewogen, Post-Blast-Wiegung steht noch aus`}
                                className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 font-bold shrink-0"
                              >
                                ⏳ {awaitingWOs.length} im Chiller · {fmt(awaitingKg, 1)} kg
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-slate-500 ml-5 mt-0.5">
                            <span>{meal.completedWOs}/{meal.totalWOs} WOs fertig</span>
                            <span>·</span>
                            <span>{fmt(meal.plannedMeals)} Meals</span>
                            {(() => {
                              const cap = computeMaxPlateable(meal, recipeWeights);
                              if (!cap) {
                                // recipeWeights geladen aber kein Eintrag → KET-Plan veraltet
                                if (recipeWeights) return (
                                  <span className="text-amber-500 font-medium">· KET-Plan aktualisieren</span>
                                );
                                return null; // kein File geladen → kein Hinweis im Header
                              }
                              // Brutto (ganze Woche) minus die laut Redzone schon platierten
                              // Portionen — sonst zeigt die Karte Runs an, die längst raus sind.
                              const net = netPlateable(meal, cap.meals, platedForMeal(plaitedByCode, meal.recipeCode));
                              if (net.fullyPlated) return (
                                <span
                                  className="text-slate-400 font-medium"
                                  title={`Gesamte produzierte Menge (${net.grossMeals.toLocaleString("de-DE")}) ist schon plaitiert (LinePlaiting + Redzone)`}
                                >
                                  · ✓ komplett platiert
                                </span>
                              );
                              if (net.netMeals === 0) return (
                                <span className="text-red-600 font-bold">· 0 platierbar ⛔</span>
                              );
                              return (
                                <span className={cap.exact ? "text-emerald-600 font-bold" : "text-amber-600 font-medium"}>
                                  · {cap.exact ? "" : "~"}{net.netMeals.toLocaleString("de-DE")} platierbar
                                  {net.partiallyPlated && (
                                    <span
                                      className="text-slate-400 font-normal"
                                      title={`Brutto ${net.grossMeals.toLocaleString("de-DE")} − ${net.platedMeals.toLocaleString("de-DE")} schon plaitiert (LinePlaiting + Redzone)`}
                                    > (−{net.platedMeals.toLocaleString("de-DE")} platiert)</span>
                                  )}
                                  {!cap.exact && <span className="text-amber-400 font-normal" title="KET-Plan mit aktuellen WOs exportieren → export-recipes.csv hochladen"> ≈</span>}
                                </span>
                              );
                            })()}
                          </div>
                          {!expanded && <WoDots wos={meal.workOrders} />}
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className={`text-2xl font-bold font-mono ${isCritical ? "text-red-600" : truePct >= 99.5 ? "text-emerald-600" : "text-slate-800"}`}
                            title={Math.round(truePct) !== Math.round(meal.progressPct)
                              ? `Schwächstes Sub-Rezept ${fmt(truePct, 0)}% · kg-Summe wäre ${fmt(meal.progressPct, 0)}% (einzelne Subs überproduziert)`
                              : undefined}
                          >
                            {fmt(truePct, 0)}%
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {fmtMass(meal.totalActualKg * 1000)} / {fmtMass(meal.totalPlannedKg * 1000)}
                          </div>
                        </div>
                      </div>

                      {/* Fortschrittsbalken */}
                      <div className="px-4 pb-3">
                        <ProgressBar pct={truePct} size="sm" />
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
                                  <th className="px-3 py-2 text-right">Chargen</th>
                                  <th className="px-3 py-2 text-center">Status</th>
                                  <th className="px-3 py-2 text-left">Verlauf</th>
                                  <th className="px-3 py-2 text-left">Letzte Wiegung</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 bg-white">
                                {runEntries.flatMap(([runNum, runWos]) => {
                                  const runDone = runWos.filter(w => w.isComplete).length;
                                  const runHasCritical = runWos.some(w => w.isCritical);
                                  const runAllDone = runDone === runWos.length;

                                  const rows: ReactElement[] = [];

                                  // Run-Trennzeile (nur wenn mehrere Runs)
                                  if (hasRuns) {
                                    rows.push(
                                      <tr key={`sep-${runNum}`} className="bg-gradient-to-r from-indigo-50 to-slate-50">
                                        <td colSpan={10} className="px-3 py-2">
                                          <div className="flex items-center gap-3">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 ${
                                              runAllDone ? "bg-emerald-500" : runHasCritical ? "bg-red-500" : "bg-indigo-500"
                                            }`}>
                                              {runNum}
                                            </span>
                                            <span className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider">Run {runNum}</span>
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                              runAllDone ? "bg-emerald-100 text-emerald-700" :
                                              runHasCritical ? "bg-red-100 text-red-700" :
                                              "bg-indigo-100 text-indigo-700"
                                            }`}>
                                              {runDone}/{runWos.length} fertig
                                              {runAllDone && " ✓"}
                                              {runHasCritical && " ⚠"}
                                            </span>
                                            <span className="text-[10px] text-slate-400">
                                              {fmtMass(runWos.reduce((s, w) => s + w.actualKg, 0) * 1000)} / {fmtMass(runWos.reduce((s, w) => s + w.plannedKg, 0) * 1000)}
                                            </span>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  }

                                  // WO-Zeilen
                                  runWos.forEach(wo => {
                                    const fsTs = firstSeen.get(wo.workOrder);
                                    const fsTime = fsTs ? new Date(fsTs).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
                                    const startKg = shiftStartActual[wo.workOrder] ?? 0;
                                    const delta = wo.actualKg - startKg;
                                    const backfillNeed = backfillByWo.get(wo.workOrder);
                                    const batchCount = batchMap.get(wo.workOrder);

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
                                            <span
                                              title="Reguläre WOs sind durch, Plan wird trotzdem nicht erreicht — Backfill im WMS anlegen"
                                              className="text-[9px] px-1.5 py-0.5 rounded-full font-bold ring-1 bg-amber-100 text-amber-700 ring-amber-200"
                                            >
                                              BACKFILL · −{fmt(backfillNeed.estimatedPortions)} Stk
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-500">
                                          {wo.isEstimated && (
                                            <span title="Geschätzt aus Portionen × Rezept-Gewicht — kein echtes Firestore-Soll" className="text-amber-500 mr-0.5">≈</span>
                                          )}
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
                                            <div className="text-[9px] text-slate-400 font-mono whitespace-nowrap">
                                              Schwund {fmt(wo.shrinkPct, 0)}%
                                            </div>
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          <div className="flex items-center justify-end gap-1.5">
                                            <div className="w-10">
                                              <ProgressBar pct={wo.progressPct} size="xs" />
                                            </div>
                                            <span className="font-mono font-bold text-slate-700 w-8 text-right">{fmt(wo.progressPct, 0)}%</span>
                                          </div>
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {batchCount != null ? (
                                            <span className={`font-mono font-bold ${batchCount >= 5 ? "text-amber-600" : "text-slate-600"}`}>
                                              {batchCount}×
                                            </span>
                                          ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-3 py-2 text-center"><StatusBadge wo={wo} /></td>
                                        <td className="px-3 py-2 text-[10px] whitespace-nowrap">
                                          {fsTime ? (
                                            <span className={wo.isComplete ? "text-emerald-600 font-medium" : "text-teal-600"}>
                                              {wo.isComplete ? `✓ ${fsTime}` : `⏱ ab ${fsTime}`}
                                              {delta > 0.1 && <span className="ml-1 text-slate-400">+{fmt(delta, 1)} kg</span>}
                                            </span>
                                          ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap">{wo.lastWeighing ?? "—"}</td>
                                      </tr>
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
            })}

            {filteredMeals.length === 0 && (
              <div className="py-10 text-center text-sm text-slate-400">
                Keine Meals in dieser Kategorie.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ PLATING-QUEUE ════════════════════════════════════════════════ */}
      <PlatingNowPanel meals={meals} recipeWeights={recipeWeights} wmsRows={liveWmsRows} redzone={redzone} plaitedByCode={plaitedByCode} />

      {/* ══ GESAMTVOLUMEN ════════════════════════════════════════════════ */}
      <VolumeSummary volumeOverview={volumeOverview.data} />

      {/* ══ MINIMUM NEEDS ════════════════════════════════════════════════ */}
      <MinimumNeedsPanel
        volumeOverview={volumeOverview.data}
        redzone={redzone}
        holdingMealsByCode={holdingMealsByCode}
      />

      {/* ══ BACKFILL-MELDUNGEN ══════════════════════════════════════════════ */}
      {backfill.length > 0 && (
        <div className="card overflow-hidden shadow-sm border-0">
          <div className="px-5 py-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-lg font-bold">Backfill-Meldungen</h3>
                <p className="text-sm text-amber-100 mt-0.5">
                  Reguläre WOs sind komplett durch, Plan wird trotzdem nicht erreicht — Stückzahl zum Anlegen des Backfills im WMS
                </p>
              </div>
              <div className="flex gap-1.5">
                {(["all", "critical", "behind"] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setBackfillFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                      backfillFilter === f
                        ? "bg-white text-amber-700 shadow-sm"
                        : "bg-white/20 text-white hover:bg-white/30 ring-1 ring-white/30"
                    }`}
                  >
                    {f === "all" ? `Alle · ${backfill.length}` :
                     f === "critical" ? `⚠ Kritisch · ${backfill.filter(b => b.priority === "critical").length}` :
                     `Hinter Plan · ${backfill.filter(b => b.priority === "behind").length}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary-Tiles im Header — Stückzahl zuerst, kg nur als Zusatzinfo */}
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { label: "Fehlende Stück", val: fmt(backfill.reduce((s, b) => s + b.estimatedPortions, 0)) },
                { label: "Gesamt fehlt (kg)", val: fmtMass(backfill.reduce((s, b) => s + b.missingKg, 0) * 1000) },
                { label: "Kritisch", val: String(backfill.filter(b => b.priority === "critical").length) },
                { label: "Hinter Plan", val: String(backfill.filter(b => b.priority === "behind").length) },
              ].map(s => (
                <div key={s.label} className="bg-white/20 rounded-xl p-2.5 text-center backdrop-blur-sm">
                  <div className="text-[10px] text-amber-100 uppercase font-bold tracking-wide">{s.label}</div>
                  <div className="text-lg font-bold font-mono text-white">{s.val}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden">
            <div className="max-h-[400px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-amber-50 text-[10px] uppercase tracking-wide text-amber-800 border-b border-amber-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Meal</th>
                    <th className="px-4 py-2.5 text-left">Sub-Rezept</th>
                    <th className="px-4 py-2.5 text-right">Fehlende Stück</th>
                    <th className="px-4 py-2.5 text-right">Fehlt (kg)</th>
                    <th className="px-4 py-2.5 text-right">%</th>
                    <th className="px-4 py-2.5 text-center">Status</th>
                    <th className="px-4 py-2.5 text-center">Meal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-50 bg-white">
                  {filteredBackfill.map(b => (
                    <tr key={b.workOrder} className={`hover:bg-amber-50/50 transition-colors ${b.priority === "critical" ? "border-l-4 border-l-red-400" : b.priority === "behind" ? "border-l-4 border-l-amber-400" : "border-l-4 border-l-emerald-300"}`}>
                      <td className="px-4 py-2.5 font-medium text-slate-600">{b.recipeCode}</td>
                      <td className="px-4 py-2.5 truncate max-w-[200px]" title={b.subRecipe}>
                        {b.subRecipe}
                        {b.rtiConfirmed && (
                          <span className="ml-1.5 text-[9px] text-emerald-600 font-medium" title="Status 'done' direkt aus dem RTI-Sheet übernommen">✓ RTI-bestätigt</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="font-mono font-bold text-lg text-red-700">{fmt(b.estimatedPortions)}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="font-mono text-slate-500">{fmt(b.missingKg, 1)} kg</div>
                        {b.platingHoldingKg > 0 && (
                          <div className="text-[9px] text-sky-600" title="Bereits als Fertigware im Holding vorhanden laut RTI-Sheet">+{fmt(b.platingHoldingKg, 1)} kg in Holding</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmt(b.missingPct, 0)}%</td>
                      <td className="px-4 py-2.5 text-center"><PriorityBadge priority={b.priority} /></td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => scrollToMeal(b.recipeCode)}
                          className="text-[10px] px-2.5 py-1 rounded-full bg-teal-50 text-teal-700 ring-1 ring-teal-200 hover:bg-teal-100 transition font-medium"
                        >
                          ↑ zeigen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ BÜNDELUNGS-VORSCHLÄGE ═══════════════════════════════════════════ */}
      {bundleGroups.length > 0 && (
        <div className="card overflow-hidden shadow-sm border-0">
          <div className="px-5 py-4 bg-gradient-to-r from-violet-600 to-purple-600 text-white">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔗</span>
              <div>
                <h3 className="text-lg font-bold">Bündelungs-Hinweis</h3>
                <p className="text-sm text-violet-100 mt-0.5">
                  {bundleGroups.length} Sub-Rezept{bundleGroups.length > 1 ? "e" : ""} fehlen in mehreren Meals — als einen gemeinsamen Backfill anlegen statt einzeln
                </p>
              </div>
              <div className="ml-auto text-right">
                <div className="text-3xl font-bold font-mono">{bundleGroups.length}</div>
                <div className="text-xs text-violet-200">Gruppen</div>
              </div>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Erklärungskasten */}
            <div className="flex gap-3 p-3 rounded-xl bg-violet-50 border border-violet-100 text-sm text-violet-800">
              <span className="text-violet-400 text-base shrink-0 mt-0.5">ℹ</span>
              <div>
                <span className="font-semibold">Was bedeutet das?</span> Dasselbe Sub-Rezept fehlt bei mehreren Meals gleichzeitig.
                Ein Backfill deckt dann mehrere Meals ab — beim Anlegen im WMS die Stückzahlen einfach zusammenzählen.
              </div>
            </div>

            {/* Gruppen */}
            <div className="grid gap-3 md:grid-cols-2">
              {bundleGroups.map(([subRecipe, items]) => {
                const totalKg = items.reduce((s, b) => s + b.missingKg, 0);
                const totalPortions = items.reduce((s, b) => s + b.estimatedPortions, 0);
                const hasCritical = items.some(b => b.priority === "critical");
                return (
                  <div
                    key={subRecipe}
                    className={`rounded-xl border p-4 ${hasCritical ? "border-red-200 bg-red-50/40" : "border-violet-200 bg-white"}`}
                  >
                    {/* Sub-Rezept Header */}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <div className="font-bold text-sm text-slate-900 leading-tight">{subRecipe}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          fehlt bei {items.length} Meals
                        </div>
                      </div>
                      {hasCritical && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 ring-1 ring-red-300 font-bold shrink-0">⚠ KRITISCH</span>
                      )}
                    </div>

                    {/* Meal-Liste */}
                    <div className="space-y-1.5 mb-3">
                      {items.map((b, i) => (
                        <div key={b.workOrder} className="flex items-center gap-2 text-xs">
                          <span className="text-slate-300 font-mono text-[10px] w-3 shrink-0">{i === items.length - 1 ? "└" : "├"}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${b.priority === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                            {b.recipeCode}
                          </span>
                          <span className="font-mono font-bold text-red-700 shrink-0">−{fmt(b.estimatedPortions)} Stk</span>
                          <span className="text-slate-400 shrink-0">({b.missingKg.toFixed(1)} kg)</span>
                        </div>
                      ))}
                    </div>

                    {/* Zusammenfassung */}
                    <div className="pt-2.5 border-t border-slate-100">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] text-slate-500">
                          Zusammen: <span className="font-mono font-bold text-red-700">{fmt(totalPortions)} Stk</span>
                          {" · "}
                          <span className="font-mono font-bold text-slate-700">{totalKg.toFixed(1)} kg</span>
                        </div>
                        <div className="text-[10px] font-semibold text-violet-700 bg-violet-100 px-2 py-0.5 rounded-full">
                          {items.length} Meals → 1 Backfill ✓
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ REDZONE LIVE ═════════════════════════════════════════════════ */}
      <RedzoneMonitorPanel redzone={redzone} />

      {/* ══ ZUSATZDATEN FÜR KG-SCHÄTZUNG ═══════════════════════════════════ */}
      <div className="card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">Zusatzdaten für Schätzung</span>

          <input
            ref={ketFileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleKetCsvFile(f); e.target.value = ""; }}
          />
          <button
            onClick={() => ketFileInputRef.current?.click()}
            className={`px-3 py-1.5 rounded-full font-medium transition ${ketCsvRows ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {ketCsvRows ? `✓ KET-CSV · ${ketCsvRows.length} Zeilen` : "KET-CSV hochladen"}
          </button>
          {ketCsvFileName && <span className="text-slate-400 text-[10px]">{ketCsvFileName}</span>}
          {ketCsvRows && (
            <button
              onClick={() => { setKetCsvRows(null); try { localStorage.removeItem(KET_CSV_STORAGE_KEY); } catch { /* quota */ } }}
              className="text-slate-300 hover:text-slate-500"
              title="KET-CSV entfernen"
            >
              ✕
            </button>
          )}

          <div className="w-px h-4 bg-slate-200 mx-1" />
          {recipeWeights
            ? <span className="text-[10px] px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 font-medium">✓ {recipeWeights.recipeCount} Rezept-Gewichte</span>
            : <span className="text-[10px] text-slate-400">Rezept-Gewichte: über Nav-Leiste hochladen</span>
          }
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          KET-CSV liefert Ziel-Portionen je WO. Rezept-Gewichte (export-recipes.csv) können global über die linke Nav-Leiste hochgeladen werden und gelten app-weit.
        </p>
      </div>

      {/* ══ LIVE FEED ═══════════════════════════════════════════════════════ */}
      {((monitor.data?.entries.length ?? 0) > 0 || (preblastMonitor.data?.entries.length ?? 0) > 0) && (
        <div className="card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              <h3 className="text-lg font-bold text-slate-800">
                Letzte Wiegungen
                {liveFeedToday && (liveFeedStage === "post" ? todayEntries.length : todayPreCount) > 0 && (
                  <span className="ml-2 text-sm font-normal text-slate-500">({liveFeedStage === "post" ? todayEntries.length : todayPreCount} heute)</span>
                )}
              </h3>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex rounded-full ring-1 ring-slate-200 overflow-hidden">
                <button
                  onClick={() => setLiveFeedStage("post")}
                  title="Ist-Gewicht nach dem Blast Chiller — das entscheidende Gewicht"
                  className={`text-xs px-3 py-1.5 font-medium transition ${liveFeedStage === "post" ? "bg-teal-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  Post-Blast
                </button>
                <button
                  onClick={() => setLiveFeedStage("pre")}
                  title="Gewicht vor dem Blast Chiller — früher Zwischenstatus"
                  className={`text-xs px-3 py-1.5 font-medium transition ${liveFeedStage === "pre" ? "bg-cyan-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  Pre-Blast
                </button>
              </div>
              <button
                onClick={() => setLiveFeedToday(t => !t)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition shadow-sm ${
                  liveFeedToday ? "bg-teal-600 text-white" : "bg-white ring-1 ring-slate-200 text-slate-500"
                }`}
              >
                {liveFeedToday ? "Nur heute ✓" : "Nur heute"}
              </button>
              <input
                type="text"
                value={liveFeedSearch}
                onChange={e => setLiveFeedSearch(e.target.value)}
                placeholder="WO / Sub-Rezept suchen…"
                className="text-xs px-3 py-1.5 rounded-full border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-400 w-44"
              />
              {liveFeedSearch && (
                <button onClick={() => setLiveFeedSearch("")} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
              )}
              {snapCount > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition"
                  title="Schichtverlauf aus localStorage löschen"
                >
                  Verlauf löschen ({snapCount})
                </button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <div className="max-h-72 overflow-auto">
              {liveEntries.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  {liveFeedToday ? "Heute noch keine Wiegungen." : "Keine Einträge gefunden."}
                </div>
              ) : (
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Zeitpunkt</th>
                      <th className="px-3 py-2 text-left">WO</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-right">Gewicht</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {liveEntries.map((e, idx) => (
                      <tr key={idx} className={`transition-colors ${idx === 0 ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
                        <td className="px-3 py-2 font-mono text-slate-500">
                          {idx === 0 && <span className="mr-1 text-emerald-500 animate-pulse">●</span>}
                          {e.timestamp || "—"}
                        </td>
                        <td className="px-3 py-2 font-mono font-bold">{e.workOrder}</td>
                        <td className="px-3 py-2 font-medium">{e.subRecipeName}</td>
                        <td className={`px-3 py-2 text-right font-mono font-bold ${liveFeedStage === "post" ? "text-indigo-700" : "text-cyan-700"}`}>{fmt(e.weightKg, 2)} kg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ EMPTY STATES ════════════════════════════════════════════════════ */}
      {!monitor.data && !monitor.error && (
        <div className="card p-10 text-center text-slate-500 shadow-sm">
          <div className="text-4xl mb-3">⏳</div>
          <div className="font-bold text-lg">Lade Postblast-Daten…</div>
          <div className="text-sm mt-2 text-slate-400">Polling startet automatisch (alle 30 Sekunden)</div>
        </div>
      )}

      {!data.productionPlan && monitor.data && (
        <div className="card p-4 bg-amber-50 border-2 border-amber-300 text-amber-900 shadow-sm">
          <strong>Kein Produktionsplan geladen.</strong> Work-Order-Matching nicht möglich.
        </div>
      )}
    </div>
  );
}
