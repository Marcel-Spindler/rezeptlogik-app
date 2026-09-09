// „Heute" — Morgen-Digest / Startseite. Bündelt die Live-Signale aus Plan,
// WO-Abgleich, Backfills und Lager in eine glanceable Liste. Jede Zeile
// springt ins Detail; nicht verbundene Quellen (nur lokaler Server) werden
// als „offline" markiert statt verschwiegen.
import { useEffect, useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { useAppState } from "../../app/AppContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { useShortsTrackerMonitor } from "../gsheet-monitor/useGSheetMonitor";
import { adjustedPortions } from "../../lib/helpers";
import { currentHfWeek } from "../../lib/hfWeek";
import { codeDigits } from "../../lib/helpers";
import {
  computeWeekLoad,
  computeWeeklyStationLoads,
  loadStationDeviceCounts,
  type WeeklyStationLoad,
} from "../../lib/equipment";
import {
  buildBackfillSection,
  buildPlanSection,
  buildReconSection,
  buildStockSection,
  summarizeDigest,
  type DigestItem,
  type DigestSection,
  type DigestSeverity,
} from "./todayDigest";
import { buildOperationsTasks, buildTaskEscalations, type OperationsTask, type OperationsTaskState } from "./operationsTasks";
import { buildTodayTrust } from "./todayTrust";
import { useOperationsTaskState } from "./useOperationsTaskState";
import { severityByRecipe } from "../wo-reconciliation/reconcileWorkOrders";
import { filterReconciliationRowsForWeek } from "./todayDigest";

type TaskState = Record<string, OperationsTaskState>;

const SEV_DOT: Record<DigestSeverity, string> = {
  critical: "bg-rose-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};
const SEV_RING: Record<DigestSeverity, string> = {
  critical: "ring-rose-200 bg-rose-50",
  warning: "ring-amber-200 bg-amber-50",
  info: "ring-sky-200 bg-sky-50",
};

function useStationLoads(data: DataBundle | null, week: string, upliftPercent: number) {
  return useMemo<WeeklyStationLoad[]>(() => {
    if (!data || !week) return [];
    const mult = adjustedPortions(1, upliftPercent);
    try {
      return computeWeeklyStationLoads(computeWeekLoad(data, week, { portionMultiplier: mult }), loadStationDeviceCounts());
    } catch {
      return [];
    }
  }, [data, week, upliftPercent]);
}

export function TodayView({ data }: { data: DataBundle }) {
  const { upliftPercent, setView, setSelectedRecipe, setSelectedWeek, source } = useAppState();
  const recon = useWoReconciliation();
  const backfills = useBackfillsOptional();
  const shorts = useShortsTrackerMonitor();
  const { taskState, updateTask, syncError, teamSynced } = useOperationsTaskState();
  const realWeek = currentHfWeek();
  const realWeekNum = Number(realWeek.match(/-W(\d{2})$/)?.[1] ?? NaN) || null;
  const todayRecipeCodes = useMemo(
    () => new Set(data.weekRecipes.filter(recipe => recipe.hfWeek === realWeek).map(recipe => codeDigits(recipe.code))),
    [data.weekRecipes, realWeek],
  );

  const loads = useStationLoads(data, realWeek, upliftPercent);
  const now = new Date();
  const todayReconRows = useMemo(
    () => filterReconciliationRowsForWeek(recon?.rows ?? [], realWeekNum)
      .filter(row => todayRecipeCodes.has(codeDigits(row.recipeCode))),
    [recon?.rows, realWeekNum, todayRecipeCodes],
  );
  const todayReconByRecipe = useMemo(
    () => severityByRecipe(todayReconRows) as Map<string, { severity: "warn" | "critical"; count: number }>,
    [todayReconRows],
  );
  const todayBackfills = backfills && !backfills.isStaleWeek
    ? backfills
    : null;

  const sections = useMemo<DigestSection[]>(() => {
    const bfConnected =
      !!todayBackfills &&
      (todayBackfills.postblastConnected || todayBackfills.rtiConnected || todayBackfills.linePlaitingConnected);
    return [
      buildPlanSection(loads),
      buildReconSection(todayReconByRecipe),
      buildBackfillSection({
        alerts: todayBackfills?.alerts ?? [],
        isStaleWeek: false,
        selectedWeekNum: todayBackfills?.selectedWeekNum ?? null,
        connected: bfConnected,
      }),
      buildStockSection({ shortages: shorts.data?.entries ?? null }),
    ];
  }, [loads, todayReconByRecipe, todayBackfills, shorts.data]);

  const summary = useMemo(() => summarizeDigest(sections), [sections]);
  const tasks = useMemo(
    () => buildOperationsTasks(
      todayBackfills?.combined.filter(item => todayRecipeCodes.has(codeDigits(item.recipeCode))) ?? [],
      todayBackfills?.feasibilityByMeal ?? new Map(),
      todayReconRows,
    ),
    [todayBackfills?.combined, todayBackfills?.feasibilityByMeal, todayReconRows, todayRecipeCodes],
  );
  const trust = useMemo(
    () => buildTodayTrust(source, {
      postblast: backfills?.postblastConnected ?? false,
      preblast: backfills?.preblastConnected ?? false,
      rti: backfills?.rtiConnected ?? false,
      linePlating: backfills?.linePlaitingConnected ?? false,
      wmsHolding: backfills?.wmsHoldingConnected ?? false,
    }),
    [source, backfills?.postblastConnected, backfills?.preblastConnected, backfills?.rtiConnected, backfills?.linePlaitingConnected, backfills?.wmsHoldingConnected],
  );
  const openRecipe = (code: string) => {
    setSelectedWeek(realWeek);
    setSelectedRecipe(code);
    setView("recipe");
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-slate-900">Heute</h1>
            <div className="text-xs text-slate-500">
              {now.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" })} · Stand{" "}
              {now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-600">
              KW {realWeek}
            </span>
            {upliftPercent !== 0 && (
              <span className="rounded bg-verden-50 px-2 py-1 font-semibold text-verden-700">
                Uplift {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
              </span>
            )}
            <span
              title={trust.detail}
              className={`rounded px-2 py-1 font-semibold ${
                trust.level === "trusted"
                  ? "bg-emerald-50 text-emerald-700"
                  : trust.level === "limited"
                    ? "bg-amber-50 text-amber-700"
                    : "bg-rose-50 text-rose-700"
              }`}
            >
              {trust.level === "trusted" ? "●" : trust.level === "limited" ? "●" : "○"} {trust.label}
            </span>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">{trust.detail}</div>

        <div className="mt-3">
          {summary.allClear ? (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
              ✓ Alles ruhig — keine offenen Signale
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              {summary.critical > 0 && (
                <span className="rounded-lg bg-rose-50 px-2.5 py-1 text-rose-800 ring-1 ring-rose-200">🔴 {summary.critical} kritisch</span>
              )}
              {summary.warning > 0 && (
                <span className="rounded-lg bg-amber-50 px-2.5 py-1 text-amber-800 ring-1 ring-amber-200">🟠 {summary.warning} Warnung{summary.warning > 1 ? "en" : ""}</span>
              )}
              {summary.info > 0 && (
                <span className="rounded-lg bg-sky-50 px-2.5 py-1 text-sky-800 ring-1 ring-sky-200">🔵 {summary.info} Hinweis{summary.info > 1 ? "e" : ""}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <OperationsBoard
        tasks={tasks}
        taskState={taskState}
        onChange={(task, patch) => void updateTask(task.id, patch)}
        onOpenTask={(task) => (task.source === "backfill" ? setView("backfills") : openRecipe(task.recipeCode))}
        teamSynced={teamSynced}
        syncError={syncError}
      />

      {sections.map((s) => (
        <SectionCard key={s.key} section={s} onOpenView={() => setView(s.view)} onOpenRecipe={openRecipe} />
      ))}
    </div>
  );
}

function OperationsBoard({
  tasks,
  taskState,
  onChange,
  onOpenTask,
  teamSynced,
  syncError,
}: {
  tasks: OperationsTask[];
  taskState: TaskState;
  onChange: (task: OperationsTask, patch: Partial<TaskState[string]>) => void;
  onOpenTask: (task: OperationsTask) => void;
  teamSynced: boolean;
  syncError: string | null;
}) {
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const visibleTasks = tasks.filter((task) => showDone || taskState[task.id]?.status !== "done");
  const openCount = tasks.filter((task) => taskState[task.id]?.status !== "done").length;
  const escalations = useMemo(() => buildTaskEscalations(tasks, taskState, now), [tasks, taskState, now]);

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden>⚑</span>
          <h2 className="text-sm font-bold text-slate-800">Operative Vorgänge</h2>
          {openCount > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">{openCount} offen</span>}
          <span className={`text-[10px] font-semibold ${teamSynced && !syncError ? "text-emerald-700" : "text-slate-400"}`} title={syncError ?? undefined}>
            {teamSynced && !syncError ? "● Team-sync" : "○ Lokal"}
          </span>
        </div>
        <button type="button" onClick={() => setShowDone((value) => !value)} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800">
          {showDone ? "Erledigte ausblenden" : "Erledigte zeigen"}
        </button>
      </div>

      {escalations.length > 0 && (
        <div className="mt-3 border-l-4 border-rose-500 bg-rose-50 p-3">
          <div className="text-xs font-bold text-rose-800">Eskalation erforderlich: {escalations.length}</div>
          <div className="mt-1 space-y-1">
            {escalations.slice(0, 4).map((escalation) => (
              <div key={escalation.taskId} className="text-[11px] text-rose-700">
                <span className="font-semibold">{escalation.title}</span> · {escalation.detail}
              </div>
            ))}
          </div>
        </div>
      )}

      {visibleTasks.length === 0 ? (
        <div className="mt-2 text-xs text-emerald-700">✓ Keine offenen Vorgänge</div>
      ) : (
        <div className="mt-3 space-y-2">
          {visibleTasks.map((task) => {
            const state = taskState[task.id] ?? { status: "open", owner: "" };
            const tone = task.severity === "critical" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50";
            return (
              <div key={task.id} className={`grid gap-2 border-l-4 p-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem] sm:items-center ${tone}`}>
                <button type="button" onClick={() => onOpenTask(task)} className="min-w-0 text-left">
                  <div className="text-xs font-semibold text-slate-800">{task.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-600">{task.detail}</div>
                </button>
                <input
                  value={state.owner}
                  onChange={(event) => onChange(task, { owner: event.target.value })}
                  placeholder="Verantwortlich"
                  aria-label={`Verantwortlich für ${task.title}`}
                  className="w-full border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-verden-600 focus:ring-2 focus:ring-verden-100"
                />
                <select
                  value={state.status}
                  onChange={(event) => onChange(task, { status: event.target.value as OperationsTaskState["status"] })}
                  aria-label={`Status für ${task.title}`}
                  className="w-full border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-verden-600 focus:ring-2 focus:ring-verden-100"
                >
                  <option value="open">Offen</option>
                  <option value="in-progress">In Arbeit</option>
                  <option value="done">Erledigt</option>
                </select>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SectionCard({
  section,
  onOpenView,
  onOpenRecipe,
}: {
  section: DigestSection;
  onOpenView: () => void;
  onOpenRecipe: (code: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 8;
  const shown = expanded ? section.items : section.items.slice(0, LIMIT);
  const crit = section.items.filter((i) => i.severity === "critical").length;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onOpenView} className="flex items-center gap-2 text-left">
          <span className="text-base" aria-hidden>{section.icon}</span>
          <span className="text-sm font-bold text-slate-800">{section.label}</span>
          {section.items.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${crit > 0 ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>
              {section.items.length}
            </span>
          )}
        </button>
        <button type="button" onClick={onOpenView} className="shrink-0 text-[11px] font-semibold text-slate-400 hover:text-slate-700">
          Alle ansehen →
        </button>
      </div>

      {section.offline && (
        <div className="mt-2 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500 ring-1 ring-slate-200">
          ⚠ {section.offline}
        </div>
      )}

      {section.items.length === 0 ? (
        !section.offline && <div className="mt-2 text-xs text-emerald-700">✓ nichts offen</div>
      ) : (
        <div className="mt-2 space-y-1">
          {shown.map((item) => (
            <DigestRow
              key={item.id}
              item={item}
              onClick={() => (item.stayInSection || !item.recipeCode ? onOpenView() : onOpenRecipe(item.recipeCode))}
            />
          ))}
          {section.items.length > LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800"
            >
              {expanded ? "weniger" : `+${section.items.length - LIMIT} weitere`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DigestRow({ item, onClick }: { item: DigestItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left ring-1 hover:brightness-[0.98] ${SEV_RING[item.severity]}`}
    >
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[item.severity]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-slate-800">{item.text}</span>
        {item.sub && <span className="block truncate text-[11px] text-slate-500">{item.sub}</span>}
      </span>
    </button>
  );
}
