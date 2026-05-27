import { useMemo, useState } from "react";
import type { DataBundle, WeekRecipe } from "./types";
import { runSplitForRecipeLike, type RunCount } from "./runPlanning";
import { PLANNER_DAYS } from "./planner";
import type { PlannerDay, RecipeAssignment } from "./planner";

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoWeekToMondayUTC(isoWeek: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) return new Date();
  const year = parseInt(m[1]), week = parseInt(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(year, 0, 4 - jan4dow + (week - 1) * 7));
}

function nextIsoWeek(isoWeek: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) return isoWeek;
  const y = parseInt(m[1]), kw = parseInt(m[2]);
  if (kw >= 52) {
    const dec28 = new Date(Date.UTC(y, 11, 28));
    const maxKw = Math.ceil(((dec28.getTime() - Date.UTC(y, 0, 1)) / 86400000 + (dec28.getUTCDay() || 7)) / 7);
    if (kw < maxKw) return `${y}-W${String(kw + 1).padStart(2, "0")}`;
    return `${y + 1}-W01`;
  }
  return `${y}-W${String(kw + 1).padStart(2, "0")}`;
}

function dateToIsoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  const kw = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4dow + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(kw).padStart(2, "0")}`;
}

function weekdayShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { weekday: "short", timeZone: "UTC" });
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}

function dateToPlannerDay(dateStr: string): PlannerDay | null {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const map: PlannerDay[] = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  return map[d.getUTCDay()];
}

function addPlannerDays(day: PlannerDay, n: number): PlannerDay {
  const idx = PLANNER_DAYS.indexOf(day);
  return PLANNER_DAYS[(idx + n + PLANNER_DAYS.length * 4) % PLANNER_DAYS.length];
}

// Plating = last kitchen day (= final cook/assembly day from Sheet 6).
// If no kitchen days: Wednesday of delivery week as default.
function derivePlatingDate(kitchenDays: string[], deliveryWeekMonday: Date): string {
  if (kitchenDays.length > 0) return kitchenDays[kitchenDays.length - 1];
  const wed = new Date(deliveryWeekMonday);
  wed.setUTCDate(deliveryWeekMonday.getUTCDate() + 2);
  return wed.toISOString().slice(0, 10);
}

// Cook run dates = D-N before plating (kitchen is Mon–Fri, plating = final assembly day).
// 1 run → cook = D-1; 2 runs → D-2, D-1; 3 runs → D-3, D-2, D-1.
function computeRunDates(platingDate: string, runCount: RunCount): string[] {
  if (runCount === 1) return [addDays(platingDate, -1)];
  if (runCount === 2) return [addDays(platingDate, -2), addDays(platingDate, -1)];
  return [addDays(platingDate, -3), addDays(platingDate, -2), addDays(platingDate, -1)];
}

// ─── Types ────────────────────────────────────────────────────────────────────

const DE_WEEKDAY_TO_PLANNER: Record<string, PlannerDay> = {
  "montag": "Mo", "dienstag": "Di", "mittwoch": "Mi", "donnerstag": "Do",
  "freitag": "Fr", "samstag": "Sa", "sonntag": "So",
  "monday": "Mo", "tuesday": "Di", "wednesday": "Mi", "thursday": "Do",
  "friday": "Fr", "saturday": "Sa", "sunday": "So",
};

interface RecipePlanRow {
  wr: WeekRecipe;
  split: ReturnType<typeof runSplitForRecipeLike>;
  kitchenDays: string[];
  workOrders: string[];
  plannedMealsFromSheet: number;
  totalStagingKg: number;
  deboxDay?: string;
  hotKitchenWeekday?: string;
  woReady: boolean;
  priority: number | null;
  primaryStation?: string;
  batchSizeKg?: number;
  estimatedBatches: number | null;
  // Derived scheduling
  platingDate: string;
  runDates: string[];
}

type CalendarEventType = "plating" | "run1" | "run2" | "run3";

interface CalendarEvent {
  row: RecipePlanRow;
  type: CalendarEventType;
  portions: number;
}

const EVENT_STYLE: Record<CalendarEventType, { pill: string; label: string; dot: string }> = {
  plating: { pill: "bg-emerald-50 ring-1 ring-emerald-300 hover:ring-emerald-500", label: "text-emerald-800", dot: "bg-emerald-500" },
  run1:    { pill: "bg-indigo-50 ring-1 ring-indigo-200 hover:ring-indigo-400",   label: "text-indigo-700",  dot: "bg-indigo-400" },
  run2:    { pill: "bg-teal-50 ring-1 ring-teal-200 hover:ring-teal-400",         label: "text-teal-700",    dot: "bg-teal-400" },
  run3:    { pill: "bg-violet-50 ring-1 ring-violet-200 hover:ring-violet-400",   label: "text-violet-700",  dot: "bg-violet-400" },
};

const EVENT_LABEL: Record<CalendarEventType, string> = {
  plating: "Plating",
  run1:    "Run 1",
  run2:    "Run 2",
  run3:    "Run 3",
};

// ─── Snapshot ─────────────────────────────────────────────────────────────────

const SNAP_LS_KEY = (week: string) => `rezeptlogik-plan-snapshot-${week}`;
const SNAP_EVENT  = "rezeptlogik:plan-snapshot-saved";

function buildAndSaveSnapshot(
  planRows: RecipePlanRow[],
  mfgWeek: string,
  platingOverrides: Record<string, string>,
): number {
  const assignments: Record<string, RecipeAssignment> = {};
  let count = 0;

  for (const row of planRows) {
    if (row.split.upliftTotal === 0) continue;

    const effectivePlating = platingOverrides[row.wr.code] ?? row.platingDate;
    const runDates = computeRunDates(effectivePlating, row.split.runCount);

    const r1Day = dateToPlannerDay(runDates[0]) ?? "Mo";
    assignments[row.wr.code] = {
      recipeCode: row.wr.code,
      day: r1Day,
      shift: "S1",
      order: 1,
      targetPortions: row.split.firstRun.total,
      note: `Auto: R1=${row.split.firstRun.total} R2=${row.split.secondRun} R3=${row.split.thirdRun} Plating=${effectivePlating}`,
    };
    count++;

    if (row.split.secondRun > 0 && runDates.length >= 2) {
      const r2Day = dateToPlannerDay(runDates[1]) ?? addPlannerDays(r1Day, 1);
      assignments[`${row.wr.code}::run2`] = {
        recipeCode: row.wr.code,
        subRecipeId: "run2",
        subRecipeName: "Run 2",
        day: r2Day,
        shift: "S1",
        order: 2,
        targetPortions: row.split.secondRun,
        note: `Auto: Run 2`,
      };
      count++;
    }

    if (row.split.thirdRun > 0 && runDates.length >= 3) {
      const r3Day = dateToPlannerDay(runDates[2]) ?? addPlannerDays(r1Day, 2);
      assignments[`${row.wr.code}::run3`] = {
        recipeCode: row.wr.code,
        subRecipeId: "run3",
        subRecipeName: "Run 3",
        day: r3Day,
        shift: "S1",
        order: 3,
        targetPortions: row.split.thirdRun,
        note: `Auto: Run 3`,
      };
      count++;
    }

    // Plating day assignment (assembly step)
    const platDay = dateToPlannerDay(effectivePlating) ?? addPlannerDays(r1Day, row.split.runCount);
    assignments[`${row.wr.code}::plating`] = {
      recipeCode: row.wr.code,
      subRecipeId: "plating",
      subRecipeName: "Plating",
      day: platDay,
      shift: "S1",
      order: 0,
      targetPortions: row.split.upliftTotal,
      note: `Auto: Plating ${effectivePlating}`,
    };
    count++;
  }

  const now = new Date();
  const snapshot = {
    savedAtIso:   now.toISOString(),
    savedAtLabel: now.toLocaleString("de-DE"),
    week:         mfgWeek,
    scenarioId:   `mfg-auto-${Date.now()}`,
    scenarioName: `Küchen-Kalender ${mfgWeek}`,
    assignments,
    stats: { plannedCount: count, unplannedCount: 0 },
  };
  window.localStorage.setItem(SNAP_LS_KEY(mfgWeek), JSON.stringify(snapshot));
  window.dispatchEvent(new CustomEvent(SNAP_EVENT, { detail: { week: mfgWeek } }));
  return count;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  data: DataBundle;
  week: string;
  mfgWeek?: string;
  onSelectRecipe?: (code: string) => void;
  onRequestLinesSection?: () => void;
}

export function ManufacturingCalendarView({ data, week, mfgWeek: mfgWeekProp, onSelectRecipe, onRequestLinesSection }: Props) {
  const [snapStatus, setSnapStatus] = useState<"idle" | "saved" | "error">("idle");
  const [platingOverrides, setPlatingOverrides] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);

  const planWeek = data.productionPlan?.week ?? "";
  const targetDeliveryWeek = mfgWeekProp
    ?? ((planWeek > week || !planWeek) ? planWeek || nextIsoWeek(week) : nextIsoWeek(week));

  const deliveryWeekMonday = useMemo(() => isoWeekToMondayUTC(targetDeliveryWeek), [targetDeliveryWeek]);

  const deliveryRecipes = useMemo(
    () => data.weekRecipes.filter(r => r.hfWeek === targetDeliveryWeek),
    [data.weekRecipes, targetDeliveryWeek]
  );

  const planRows: RecipePlanRow[] = useMemo(() => {
    return deliveryRecipes.map(wr => {
      const split = runSplitForRecipeLike({ verdenVolume: wr.verdenVolume });

      const woEntries = data.productionPlan?.rows.filter(e => e.recipeCode === wr.code) ?? [];
      const kitchenDays = [...new Set(woEntries.map(e => e.kitchenDay).filter(Boolean))].sort();
      const workOrders  = [...new Set(woEntries.map(e => e.workOrder))];
      const plannedMealsFromSheet = woEntries.reduce((s, e) => s + e.plannedMeals, 0);
      const totalStagingKg = woEntries.reduce((s, e) => s + e.stagingKg, 0);

      const kpRows = (data.kitchenPriority ?? []).filter(kp => workOrders.includes(kp.workOrder));
      const deboxDay          = kpRows.find(k => k.deboxDay)?.deboxDay;
      const hotKitchenWeekday = kpRows.find(k => k.hotKitchenWeekday)?.hotKitchenWeekday;
      const woReady           = kpRows.some(k => k.woReady);
      const priority          = kpRows.length ? Math.min(...kpRows.map(k => k.priority)) : null;

      const recipe = data.recipes[wr.code];
      const market = (wr.verdenVolume.DE ?? 0) > 0 ? "DE" as const
                   : (wr.verdenVolume.BENL ?? 0) > 0 ? "BENL" as const : "DKSE" as const;
      const subRecipes = recipe?.markets[market]?.subRecipes ?? [];
      const specs = subRecipes
        .map(sr => data.processSpecs?.[sr.id])
        .filter((ps): ps is NonNullable<typeof ps> => !!ps && (ps.batchSizeKg ?? 0) > 0);
      const primarySpec = specs.find(s => s.primaryStation) ?? specs[0] ?? null;
      const batchSizeKg = primarySpec?.batchSizeKg;
      const estimatedBatches = (batchSizeKg && totalStagingKg > 0)
        ? Math.ceil(totalStagingKg / batchSizeKg)
        : null;

      const platingDate = derivePlatingDate(kitchenDays, deliveryWeekMonday);
      const runDates    = computeRunDates(platingDate, split.runCount);

      return {
        wr, split, kitchenDays, workOrders,
        plannedMealsFromSheet, totalStagingKg,
        deboxDay, hotKitchenWeekday, woReady, priority,
        primaryStation: primarySpec?.primaryStation,
        batchSizeKg, estimatedBatches,
        platingDate, runDates,
      };
    }).sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || b.split.upliftTotal - a.split.upliftTotal);
  }, [deliveryRecipes, data, deliveryWeekMonday]);

  // Calendar: collect all event dates, build a Mon–Sun window that covers all of them
  const calendarDays = useMemo(() => {
    const allDates = new Set<string>();
    for (const row of planRows) {
      const effectivePlating = platingOverrides[row.wr.code] ?? row.platingDate;
      const runs = computeRunDates(effectivePlating, row.split.runCount);
      runs.forEach(d => allDates.add(d));
      allDates.add(effectivePlating);
    }

    if (allDates.size === 0) {
      // Fallback: Mon–Fri of cook week
      const cookMon = new Date(deliveryWeekMonday);
      cookMon.setUTCDate(cookMon.getUTCDate() - 7);
      return Array.from({ length: 5 }, (_, i) => {
        const d = new Date(cookMon);
        d.setUTCDate(cookMon.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
      });
    }

    const sorted = [...allDates].sort();
    const start = sorted[0];
    const end   = sorted[sorted.length - 1];

    // Expand to the Monday of start week
    const startDate = new Date(start + "T00:00:00Z");
    const dow = (startDate.getUTCDay() + 6) % 7; // 0=Mon
    startDate.setUTCDate(startDate.getUTCDate() - dow);

    const endDate   = new Date(end + "T00:00:00Z");
    const days: string[] = [];
    const cur = new Date(startDate);
    while (cur <= endDate || days.length < 5) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
      if (days.length > 14) break; // safety cap
    }
    return days;
  }, [planRows, platingOverrides, deliveryWeekMonday]);

  // Build event map: dateStr → CalendarEvent[]
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const date of calendarDays) map.set(date, []);

    for (const row of planRows) {
      const effectivePlating = platingOverrides[row.wr.code] ?? row.platingDate;
      const runs = computeRunDates(effectivePlating, row.split.runCount);
      const runTypes: CalendarEventType[] = ["run1", "run2", "run3"];
      const runPortions = [row.split.firstRun.total, row.split.secondRun, row.split.thirdRun];

      runs.forEach((date, i) => {
        if (!map.has(date)) map.set(date, []);
        map.get(date)!.push({ row, type: runTypes[i], portions: runPortions[i] });
      });

      if (!map.has(effectivePlating)) map.set(effectivePlating, []);
      map.get(effectivePlating)!.push({ row, type: "plating", portions: row.split.upliftTotal });
    }

    return map;
  }, [planRows, platingOverrides, calendarDays]);

  // Drag-and-drop handlers
  function handleDragStart(e: React.DragEvent, code: string) {
    e.dataTransfer.setData("recipeCode", code);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDrop(e: React.DragEvent, newDate: string) {
    e.preventDefault();
    const code = e.dataTransfer.getData("recipeCode");
    if (!code) return;
    setPlatingOverrides(prev => ({ ...prev, [code]: newDate }));
    setDragOver(null);
  }

  const totalUplift = planRows.reduce((s, r) => s + r.split.upliftTotal, 0);
  const totalRun1   = planRows.reduce((s, r) => s + r.split.firstRun.total, 0);
  const totalRun2   = planRows.reduce((s, r) => s + r.split.secondRun, 0);
  const totalRun3   = planRows.reduce((s, r) => s + r.split.thirdRun, 0);
  const totalWOs    = new Set(planRows.flatMap(r => r.workOrders)).size;
  const hasOverrides = Object.keys(platingOverrides).length > 0;

  // Cooking week label from calendar days
  const cookingWeek = calendarDays.length > 0 ? dateToIsoWeek(calendarDays[0]) : "";

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-indigo-50 via-white to-emerald-50 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">Manufacturing Planning Calendar</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Lieferwoche <span className="font-semibold text-slate-700">{targetDeliveryWeek}</span>
              {cookingWeek && cookingWeek !== targetDeliveryWeek && (
                <> · Küchenwoche <span className="font-semibold text-slate-700">{cookingWeek}</span></>
              )}
              {!data.productionPlan?.rows.length && (
                <span className="ml-2 text-amber-600 font-semibold">
                  [Nur Ramp-Up — Sheet 6 noch nicht geladen]
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-300">
              {planRows.length} Rezepte · {totalWOs} WOs
            </span>
            <span className="rounded-full bg-indigo-50 px-3 py-1 ring-1 ring-indigo-300 text-indigo-800">
              Run 1: {totalRun1.toLocaleString("de-DE")}
            </span>
            <span className="rounded-full bg-teal-50 px-3 py-1 ring-1 ring-teal-300 text-teal-800">
              Run 2: {totalRun2.toLocaleString("de-DE")}
            </span>
            {totalRun3 > 0 && (
              <span className="rounded-full bg-violet-50 px-3 py-1 ring-1 ring-violet-300 text-violet-800">
                Run 3: {totalRun3.toLocaleString("de-DE")}
              </span>
            )}
            <span className="rounded-full bg-emerald-50 px-3 py-1 ring-1 ring-emerald-300 text-emerald-800">
              Σ+10%: {totalUplift.toLocaleString("de-DE")}
            </span>
          </div>
        </div>

        {/* Legend + actions */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex-1 rounded-xl bg-white/70 px-3 py-2 text-[11px] text-slate-600 ring-1 ring-slate-200 space-y-0.5">
            <div>
              <span className="inline-block w-2 h-2 rounded-full bg-indigo-400 mr-1" />Run 1 = BNL×100% + DKSE×100% + DE×70% (≤4500 Port.) oder DE×35% (≥4500)
            </div>
            <div>
              <span className="inline-block w-2 h-2 rounded-full bg-teal-400 mr-1" />Run 2 = Restmenge DE ·
              <span className="inline-block w-2 h-2 rounded-full bg-violet-400 mx-1" />Run 3 nur ab 4500+ Portionen ·
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mx-1" />Plating = Assembly-Tag (ziehbar)
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {hasOverrides && (
              <button
                onClick={() => setPlatingOverrides({})}
                className="text-[11px] text-amber-700 hover:text-amber-900 font-semibold"
              >
                {Object.keys(platingOverrides).length} Überschreibung(en) zurücksetzen
              </button>
            )}
            <button
              onClick={() => {
                try {
                  const count = buildAndSaveSnapshot(planRows, targetDeliveryWeek, platingOverrides);
                  setSnapStatus("saved");
                  if (count > 0) onRequestLinesSection?.();
                } catch {
                  setSnapStatus("error");
                }
              }}
              disabled={planRows.length === 0}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Linienplanung vorbereiten →
            </button>
            {snapStatus === "saved" && (
              <span className="text-[11px] font-semibold text-emerald-600">
                Snapshot für {targetDeliveryWeek} gespeichert
              </span>
            )}
            {snapStatus === "error" && (
              <span className="text-[11px] font-semibold text-red-600">Fehler beim Speichern</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Weekly Calendar ── */}
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
          Wochenkalender · Plating-Tag per Drag &amp; Drop verschieben
        </h4>
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${calendarDays.length}, minmax(0, 1fr))` }}
        >
          {calendarDays.map(date => {
            const events = eventsByDate.get(date) ?? [];
            const isToday = date === new Date().toISOString().slice(0, 10);
            const isDragTarget = dragOver === date;
            const isDeliveryWeek = date >= deliveryWeekMonday.toISOString().slice(0, 10);

            return (
              <div
                key={date}
                className={`rounded-xl border p-2 min-h-[80px] transition-all ${
                  isDragTarget
                    ? "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-300"
                    : isDeliveryWeek
                    ? "border-amber-100 bg-amber-50/40"
                    : events.length > 0
                    ? "border-indigo-100 bg-slate-50"
                    : "border-slate-100 bg-slate-50/50"
                } ${isToday ? "ring-2 ring-inset ring-slate-300" : ""}`}
                onDragOver={e => { e.preventDefault(); setDragOver(date); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => handleDrop(e, date)}
              >
                <div className={`text-[10px] font-bold mb-1 ${isDeliveryWeek ? "text-amber-700" : "text-slate-600"}`}>
                  {weekdayShort(date)}
                </div>
                <div className="text-[9px] text-slate-400 mb-2">{fmtDate(date)}</div>

                {events.length === 0 ? (
                  <div className="text-[9px] text-slate-300 italic">frei</div>
                ) : (
                  <div className="space-y-1">
                    {events.map((ev, i) => {
                      const st = EVENT_STYLE[ev.type];
                      const isPlating = ev.type === "plating";
                      return (
                        <div
                          key={`${ev.row.wr.code}-${ev.type}-${i}`}
                          draggable={isPlating}
                          onDragStart={isPlating ? e => handleDragStart(e, ev.row.wr.code) : undefined}
                          onClick={() => onSelectRecipe?.(ev.row.wr.code)}
                          className={`rounded-lg px-2 py-1.5 text-left w-full transition-all cursor-pointer ${st.pill} ${isPlating ? "cursor-grab active:cursor-grabbing" : ""}`}
                          title={isPlating ? `${ev.row.wr.code} — Plating-Tag (ziehen zum Verschieben)` : `${ev.row.wr.code} — ${EVENT_LABEL[ev.type]}`}
                        >
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
                            <span className={`text-[9px] font-bold truncate ${st.label}`}>
                              {EVENT_LABEL[ev.type]}
                              {isPlating && (platingOverrides[ev.row.wr.code] ? " ✎" : "")}
                            </span>
                          </div>
                          <div className="font-mono text-[9px] font-bold text-slate-700 truncate">{ev.row.wr.code}</div>
                          <div className={`text-[9px] tabular-nums font-semibold ${st.label}`}>
                            {ev.portions.toLocaleString("de-DE")} Port.
                          </div>
                          {isPlating && ev.row.split.runCount > 1 && (
                            <div className="text-[8px] text-slate-400 mt-0.5">
                              {ev.row.split.runCount} Runs · {ev.row.split.runCount === 3 ? "D-3/D-2/D-1" : "D-2/D-1"}
                            </div>
                          )}
                          {ev.type === "run1" && ev.row.split.firstRun.bnl > 0 && (
                            <div className="text-[8px] text-indigo-400 mt-0.5">
                              BNL:{ev.row.split.firstRun.bnl.toLocaleString("de-DE")} NOR:{ev.row.split.firstRun.nordics.toLocaleString("de-DE")} DE:{ev.row.split.firstRun.de.toLocaleString("de-DE")}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] text-slate-400">
          Lieferwoche-Tage <span className="bg-amber-50 ring-1 ring-amber-100 rounded px-1">leicht gelb</span> · Grüner Rahmen beim Hover = gültiges Drop-Ziel für Plating-Pill
        </p>
      </div>

      {/* ── Detailed Recipe Table ── */}
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Detailplanung je Rezept</h4>
        <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-sm">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2 text-left">Prio</th>
                <th className="px-2 py-2 text-left">Rezept</th>
                <th className="px-2 py-2 text-right">Basis</th>
                <th className="px-2 py-2 text-right">+10% Buf</th>
                <th className="px-2 py-2 text-center">Runs</th>
                <th className="px-2 py-2 text-right text-indigo-700">Run 1</th>
                <th className="px-2 py-2 text-right text-teal-700">Run 2</th>
                <th className="px-2 py-2 text-right text-violet-700">Run 3</th>
                <th className="px-2 py-2 text-center text-emerald-700">Plating</th>
                <th className="px-2 py-2 text-center">Debox</th>
                <th className="px-2 py-2 text-right">Batches</th>
                <th className="px-2 py-2 text-center">Station</th>
                <th className="px-2 py-2 text-center">WO ✓</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map(r => {
                const effectivePlating = platingOverrides[r.wr.code] ?? r.platingDate;
                const isOverridden = !!platingOverrides[r.wr.code];
                return (
                  <tr
                    key={r.wr.code}
                    onClick={() => onSelectRecipe?.(r.wr.code)}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${r.priority === 1 ? "bg-amber-50" : ""}`}
                  >
                    <td className="px-2 py-2 text-center">
                      {r.priority != null ? (
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${r.priority <= 3 ? "bg-amber-400 text-white" : "bg-slate-200 text-slate-600"}`}>
                          {r.priority}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2">
                      <div className="font-mono font-bold text-slate-700">{r.wr.code}</div>
                      <div className="text-slate-500 truncate max-w-[160px]" title={r.wr.recipeName}>
                        {r.wr.recipeName.replace(/\s*\[.*?\]\s*$/, "") || r.wr.code}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                      {r.split.baseTotal.toLocaleString("de-DE")}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums font-semibold text-slate-800">
                      {r.split.upliftTotal.toLocaleString("de-DE")}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        r.split.runCount === 3 ? "bg-violet-100 text-violet-700" :
                        r.split.runCount === 2 ? "bg-teal-100 text-teal-700" :
                        "bg-slate-100 text-slate-600"
                      }`}>
                        {r.split.runCount}×
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-bold text-indigo-700 tabular-nums">
                        {r.split.firstRun.total.toLocaleString("de-DE")}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      {r.split.secondRun > 0 ? (
                        <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 font-bold text-teal-700 tabular-nums">
                          {r.split.secondRun.toLocaleString("de-DE")}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {r.split.thirdRun > 0 ? (
                        <span className="inline-flex rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 font-bold text-violet-700 tabular-nums">
                          {r.split.thirdRun.toLocaleString("de-DE")}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isOverridden ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-400" : "bg-emerald-50 text-emerald-700"}`}>
                        {weekdayShort(effectivePlating)} {fmtDate(effectivePlating)}
                        {isOverridden && " ✎"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center text-[10px] font-semibold text-slate-600">
                      {r.deboxDay ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {r.estimatedBatches != null ? (
                        <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700 ring-1 ring-violet-200">
                          {r.estimatedBatches}×
                          {r.batchSizeKg != null && <span className="ml-1 font-normal text-violet-500">{r.batchSizeKg}kg</span>}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-2 py-2 text-center text-[10px] text-slate-500">
                      {r.primaryStation ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {r.workOrders.length > 0 ? (
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${r.woReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                          {r.woReady ? "✓" : "!"}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t-2 border-slate-200 bg-slate-50 text-[10px] font-semibold">
              <tr>
                <td colSpan={3} className="px-2 py-2 text-slate-700">Gesamt ({planRows.length} Rezepte)</td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-800">
                  {totalUplift.toLocaleString("de-DE")}
                </td>
                <td />
                <td className="px-2 py-2 text-right text-indigo-700 tabular-nums">{totalRun1.toLocaleString("de-DE")}</td>
                <td className="px-2 py-2 text-right text-teal-700 tabular-nums">{totalRun2.toLocaleString("de-DE")}</td>
                <td className="px-2 py-2 text-right text-violet-700 tabular-nums">{totalRun3 > 0 ? totalRun3.toLocaleString("de-DE") : "—"}</td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
