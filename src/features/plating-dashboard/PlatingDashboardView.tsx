// Plating Dashboard — teilbares Dashboard für das Plating-Team.
// Kombiniert Fortschritt je Meal + Was kann ich plaiten + Stillstand-Vermeidung.
// Läuft als eigene Surface (?surface=plating) oder als View im Hauptmenü.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import {
  usePostblastMonitor, usePreblastMonitor, useRtiMonitor, useEtMonitor,
  useProductionPlanWeeks, useProductionPlanMonitor, useVolumeOverviewMonitor,
} from "../gsheet-monitor/useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed, type MealProgress } from "../gsheet-monitor/postblastMatch";
import { platedForMeal } from "../gsheet-monitor/plateableNet";
import { mealReadiness } from "../gsheet-monitor/mealProgress";
import { MinimumNeedsPanel, VolumeSummary, volumeStats } from "../gsheet-monitor/MinimumNeedsPanel";
import { estimatePlannedKg } from "../gsheet-monitor/PostblastLiveView";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { fetchWmsWorkorderCache, filterRowsToWeekWindow, wmsWorkorderRowToEntry } from "../../lib/wmsCache";
import type { KetRow } from "../ket-plan/ketTypes";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { useCombinedPlaited } from "../gsheet-monitor/useCombinedPlaited";
import { PlatingActionBoard } from "./PlatingActionBoard";
import { MealProgressCard } from "./MealProgressCard";

const KET_CSV_STORAGE_KEY = "ket-csv-rows-v1";

export function PlatingDashboardView({ data }: { data: DataBundle }) {
  const monitor = usePostblastMonitor();
  const preblastMonitor = usePreblastMonitor();
  const rtiMonitor = useRtiMonitor();
  const etMonitor = useEtMonitor();
  const { weeks: planWeekOptions } = useProductionPlanWeeks();
  const redzone = useRedzoneOptional();
  const woRecon = useWoReconciliation();
  const recipeWeights = woRecon?.recipeWeights ?? null;

  // WMS Cache
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchWms = () => {
      fetchWmsWorkorderCache().then(res => {
        if (cancelled || !res?.rows.length) return;
        const { kept } = filterRowsToWeekWindow(res.rows, currentHfWeek());
        const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
          try { acc.push(wmsWorkorderRowToEntry(row)); } catch { /* skip */ }
          return acc;
        }, []);
        if (!cancelled && mapped.length) setLiveWmsRows(mapped);
      }).catch(() => {});
    };
    fetchWms();
    const interval = setInterval(fetchWms, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // KET CSV aus localStorage
  const [ketCsvRows] = useState<KetRow[] | null>(() => {
    try { const raw = localStorage.getItem(KET_CSV_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  });

  // Wochen-Auswahl (vereinfacht, automatisch auf aktuelle KW)
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
    const refYear = currentHfWeek().match(/^(\d{4})/)?.[1];
    for (const n of woCountByWeekNum.keys()) {
      if (!allowedWeekNums.has(n)) continue;
      if ([...labels].some(w => weekNumFromHfWeek(w) === n)) continue;
      if (refYear) labels.add(`${refYear}-W${String(n).padStart(2, "0")}`);
    }
    return [...labels].sort();
  }, [data.weeks, woCountByWeekNum, allowedWeekNums]);

  const rtiWeekNum = useMemo(
    () => (rtiMonitor.data ? weekNumFromHfWeek(rtiMonitor.data.week) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rtiMonitor.data?.week],
  );

  const userPickedWeekRef = useRef(false);
  const [selectedWeek, setSelectedWeek] = useState("");
  useEffect(() => {
    if (weekOptions.length === 0) return;
    const hf = currentHfWeek();
    const hfWeekNum = weekNumFromHfWeek(hf);
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

  const selectedWeekNum = selectedWeek ? weekNumFromHfWeek(selectedWeek) : null;

  // „Schon plaitiert" je Meal — LinePlaiting-Actuals ⊕ Redzone (siehe useCombinedPlaited.ts).
  const { plaitedByCode, holdingMealsByCode } = useCombinedPlaited(selectedWeekNum);
  // Minimum Needs / Gesamtvolumen aus dem „Volume Overview"-Tab.
  const volumeOverview = useVolumeOverviewMonitor();

  const planGid = useMemo(
    () => (selectedWeekNum != null ? planWeekOptions.find(w => w.week === selectedWeekNum)?.gid ?? "" : ""),
    [planWeekOptions, selectedWeekNum],
  );
  useProductionPlanMonitor(planGid);

  // Produktionsplan: Firestore + KET + WMS + ET zusammenführen
  const { filteredProductionPlan, unplannedWorkOrders, estimatedWorkOrders } = useMemo(() => {
    const allRows = data.productionPlan?.rows ?? [];
    const baseRows = selectedWeekNum == null
      ? allRows
      : allRows.filter(r => weekPrefixFromWoNumber(r.workOrder) === selectedWeekNum);

    const known = new Set(baseRows.map(r => r.workOrder));
    const gapRows: WorkOrderEntry[] = [];
    const unplanned = new Set<string>();
    const estimated = new Set<string>();

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
          run: 1, kitchenDay: r.dateNeeded, workOrder: r.woNumber, recipeId: r.recipeId,
          recipeCode: r.recipeCode, recipeName: r.recipeName, subRecipe: r.subRecipeName,
          plannedMeals: r.targetPortions, targetPortions: r.targetPortions,
          stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0,
          cookMethods: r.cookMethods.join(", "), stagingStatus: r.stagingStatus, kitchenStatus: r.kitchenStatus,
        }, r.targetPortions);
      }
      for (const r of liveWmsRows ?? []) {
        addGapRow(r, r.targetPortions ?? r.plannedMeals);
      }
      for (const e of etMonitor.data?.entries ?? []) {
        addGapRow({
          run: 1, kitchenDay: e.cookingDay, workOrder: e.workOrder,
          recipeCode: e.recipeCode, recipeName: e.recipeName, subRecipe: e.subRecipeName,
          plannedMeals: 0, stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0,
        }, null);
      }
    }

    const plan = (baseRows.length === 0 && gapRows.length === 0)
      ? data.productionPlan
      : { week: selectedWeek || (data.productionPlan?.week ?? ""), generatedAt: data.productionPlan?.generatedAt ?? "", rows: [...baseRows, ...gapRows] };
    return { filteredProductionPlan: plan, unplannedWorkOrders: unplanned, estimatedWorkOrders: estimated };
  }, [data.productionPlan, etMonitor.data, liveWmsRows, ketCsvRows, recipeWeights, selectedWeek, selectedWeekNum]);

  // Matching
  const { matched, meals, backfill } = useMemo(
    () => matchPostblastToWorkOrders(monitor.data, preblastMonitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders),
    [monitor.data, preblastMonitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders],
  );

  // Meal-Filter + Expand-State
  const [expandedMeals, setExpandedMeals] = useState<Set<string>>(new Set());
  const [mealFilter, setMealFilter] = useState<"offen" | "all" | "critical" | "running" | "done">("offen");

  const backfillByWo = useMemo(() => new Map(backfill.map(b => [b.workOrder, b])), [backfill]);

  // Netto platierbar / beendet / ehrliche % je Meal — gemeinsame Logik mit dem
  // Postblast Live Monitor (siehe mealProgress.ts).
  const mealMeta = useMemo(() => {
    const m = new Map<string, ReturnType<typeof mealReadiness>>();
    for (const meal of meals) m.set(meal.recipeCode, mealReadiness(meal, recipeWeights, plaitedByCode));
    return m;
  }, [meals, recipeWeights, plaitedByCode]);

  // „Platierbar"-Highlight: nur wenn wirklich netto etwas übrig ist.
  const platableMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const meal of meals) {
      const net = mealMeta.get(meal.recipeCode)!.net?.netMeals ?? 0;
      if (net > 0) map.set(meal.recipeCode, net);
    }
    return map;
  }, [meals, mealMeta]);

  const mealDone = meals.filter(m => mealMeta.get(m.recipeCode)?.finished).length;
  const mealCritical = meals.filter(m => m.criticalWOs.length > 0 && !mealMeta.get(m.recipeCode)?.finished).length;
  const mealRunning = meals.length - mealCritical - mealDone;

  const filteredMeals = useMemo(() => {
    const pass = (m: MealProgress) => {
      const meta = mealMeta.get(m.recipeCode)!;
      if (mealFilter === "offen") return !meta.finished;
      if (mealFilter === "critical") return m.criticalWOs.length > 0;
      if (mealFilter === "running") return m.completedWOs < m.totalWOs && m.criticalWOs.length === 0 && !meta.finished;
      if (mealFilter === "done") return meta.finished;
      return true;
    };
    // Chronologisch: was jetzt am meisten platierbar ist zuerst, runter bis 0 %.
    return meals.filter(pass).sort((a, b) => {
      const ma = mealMeta.get(a.recipeCode)!, mb = mealMeta.get(b.recipeCode)!;
      return (mb.net?.netMeals ?? 0) - (ma.net?.netMeals ?? 0) || b.progressPct - a.progressPct;
    });
  }, [meals, mealFilter, mealMeta]);

  function toggleMeal(code: string) {
    setExpandedMeals(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  // Teilbare URL
  const shareUrl = `${window.location.origin}${window.location.pathname}?surface=plating`;
  const [linkCopied, setLinkCopied] = useState(false);

  // Verbindungsstatus
  const isConnected = monitor.isPolling;
  const lastUpdate = monitor.lastUpdate ? new Date(monitor.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  // KPI — dieselbe Quelle wie Gesamtvolumen / Minimum Needs, damit die Zahlen
  // im Header und in den Karten darunter zusammenpassen.
  const vol = useMemo(() => volumeStats(volumeOverview.data), [volumeOverview.data]);

  // Loading
  if (!monitor.data && !monitor.error) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-slate-200 border-t-purple-600 rounded-full animate-spin" />
          <div className="text-sm text-slate-500 mt-3">Lade Plating-Daten …</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-5 shadow-lg text-white">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h1 className="text-xl font-black tracking-tight">Plating Dashboard</h1>
            <div className="text-xs text-slate-400 mt-0.5">
              {selectedWeek || "—"} · {lastUpdate}
              {isConnected && <span className="ml-2 text-emerald-400 font-medium">● Live</span>}
              {monitor.error && <span className="ml-2 text-red-400 font-medium">● Fehler</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {weekOptions.length > 1 && (
              <select
                value={selectedWeek}
                onChange={e => { userPickedWeekRef.current = true; setSelectedWeek(e.target.value); }}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/10 ring-1 ring-white/20 text-white"
              >
                {weekOptions.map(w => (
                  <option key={w} value={w} className="text-slate-900">{w}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => { monitor.forceRefresh(); preblastMonitor.forceRefresh(); rtiMonitor.forceRefresh(); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition ring-1 ring-white/20"
            >
              Aktualisieren
            </button>
          </div>
        </div>

        {/* KPI Tiles — aus dem Volume Overview, damit sie zu den Karten unten passen */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="bg-white/10 backdrop-blur rounded-xl p-3 ring-1 ring-white/10">
            <div className="text-[10px] text-slate-400 uppercase font-bold">Wochenvolumen</div>
            <div className="text-2xl font-black font-mono mt-0.5">{vol ? Math.round(vol.pct) : "—"}%</div>
            <div className="text-[10px] text-slate-400">
              {vol ? `${vol.production.toLocaleString("de-DE")} / ${vol.forecast.toLocaleString("de-DE")} Portionen` : "lädt …"}
            </div>
          </div>
          <div className="bg-emerald-500/20 backdrop-blur rounded-xl p-3 ring-1 ring-emerald-400/30">
            <div className="text-[10px] text-emerald-300 uppercase font-bold">Nachfrage gedeckt</div>
            <div className="text-2xl font-black font-mono mt-0.5 text-emerald-300">{vol?.complete ?? "—"}</div>
            <div className="text-[10px] text-emerald-400/70">von {vol?.total ?? meals.length} Meals (bis Sa)</div>
          </div>
          <div className="bg-red-500/20 backdrop-blur rounded-xl p-3 ring-1 ring-red-400/30">
            <div className="text-[10px] text-red-300 uppercase font-bold">Fehlt bis Samstag</div>
            <div className="text-2xl font-black font-mono mt-0.5 text-red-300">
              {vol ? `−${Math.round(vol.missByDay.sat).toLocaleString("de-DE")}` : "—"}
            </div>
            <div className="text-[10px] text-red-400/70">{vol?.open ?? "—"} Meals offen</div>
          </div>
        </div>

        {/* Teilbare URL */}
        <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-1.5 ring-1 ring-white/10">
          <span className="text-[10px] text-slate-500 shrink-0">Link:</span>
          <code className="text-[10px] text-slate-400 font-mono truncate flex-1">{shareUrl}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(shareUrl); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }}
            className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition shrink-0 ${
              linkCopied ? "bg-emerald-500/30 text-emerald-300" : "bg-white/10 text-slate-300 hover:bg-white/20"
            }`}
          >
            {linkCopied ? "Kopiert!" : "Kopieren"}
          </button>
        </div>
      </div>

      {/* ── Fortschritt je Meal ── */}
      <div className="card p-5 border-0 shadow-md">
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
              Alle aufklappen
            </button>
            <button
              onClick={() => setExpandedMeals(new Set())}
              className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
            >
              Alle zuklappen
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          {filteredMeals.map(meal => (
            <MealProgressCard
              key={meal.recipeCode}
              meal={meal}
              expanded={expandedMeals.has(meal.recipeCode)}
              onToggle={() => toggleMeal(meal.recipeCode)}
              backfillNeeds={meal.workOrders.map(wo => backfillByWo.get(wo.workOrder)).filter((b): b is BackfillNeed => b != null)}
              recipeWeights={recipeWeights}
              isPlatable={platableMap.has(meal.recipeCode)}
              plateableMeals={platableMap.get(meal.recipeCode) ?? null}
              platedMeals={platedForMeal(plaitedByCode, meal.recipeCode)}
            />
          ))}
          {filteredMeals.length === 0 && (
            <div className="text-center py-8 text-sm text-slate-400">
              {meals.length === 0 ? "Noch keine Produktionsdaten — warte auf erste Wiegung." : "Kein Meal in dieser Kategorie."}
            </div>
          )}
        </div>
      </div>

      {/* ── Gesamtvolumen ── */}
      <VolumeSummary volumeOverview={volumeOverview.data} />

      {/* ── Minimum Needs (Do → Fr → Sa je Meal) ── */}
      <MinimumNeedsPanel volumeOverview={volumeOverview.data} redzone={redzone} holdingMealsByCode={holdingMealsByCode} />

      {/* ── Plating Action Board (UNTEN) ── */}
      <div className="card p-5 border-0 shadow-md">
        <PlatingActionBoard
          meals={meals}
          allMatched={matched}
          backfill={backfill}
          recipeWeights={recipeWeights}
          redzone={redzone}
          platedByMealCode={plaitedByCode}
        />
      </div>
    </div>
  );
}
