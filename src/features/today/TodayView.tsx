// „Heute" — Morgen-Digest / Startseite. Bündelt die Live-Signale aus Plan,
// WO-Abgleich, Backfills und Lager in eine glanceable Liste. Jede Zeile
// springt ins Detail; nicht verbundene Quellen (nur lokaler Server) werden
// als „offline" markiert statt verschwiegen.
import { useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { useAppState } from "../../app/AppContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { useShortsTrackerMonitor } from "../gsheet-monitor/useGSheetMonitor";
import { adjustedPortions } from "../../lib/helpers";
import { currentHfWeek } from "../../lib/hfWeek";
import {
  computeWeekLoad,
  computeWeeklyStationLoads,
  loadStationDeviceCounts,
  loadStationPools,
  DEFAULT_SHIFT_MIN,
  type WeeklyStationLoad,
} from "../../lib/equipment";
import { analyzePlan, getActiveScenario, loadPlannerStorage, type PlannerWeekAnalysis } from "../../lib/planner";
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

function usePlanSignals(data: DataBundle | null, week: string, upliftPercent: number) {
  return useMemo(() => {
    if (!data || !week) return { analysis: null as PlannerWeekAnalysis | null, loads: [] as WeeklyStationLoad[] };
    const mult = adjustedPortions(1, upliftPercent);
    let analysis: PlannerWeekAnalysis | null = null;
    let loads: WeeklyStationLoad[] = [];
    try {
      const scenario = getActiveScenario(loadPlannerStorage(), week);
      analysis = analyzePlan(data, week, scenario, {
        portionMultiplier: mult,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts: loadStationDeviceCounts(),
        stationPools: loadStationPools(),
      });
    } catch { /* Planner-Analyse optional */ }
    try {
      loads = computeWeeklyStationLoads(computeWeekLoad(data, week, { portionMultiplier: mult }), loadStationDeviceCounts());
    } catch { /* Kapazität optional */ }
    return { analysis, loads };
  }, [data, week, upliftPercent]);
}

export function TodayView({ data, week }: { data: DataBundle; week: string }) {
  const { upliftPercent, setView, setSelectedRecipe } = useAppState();
  const recon = useWoReconciliation();
  const backfills = useBackfillsOptional();
  const shorts = useShortsTrackerMonitor();

  const { analysis, loads } = usePlanSignals(data, week, upliftPercent);
  const now = new Date();

  const sections = useMemo<DigestSection[]>(() => {
    const bfConnected =
      !!backfills &&
      (backfills.postblastConnected || backfills.rtiConnected || backfills.linePlaitingConnected);
    return [
      buildPlanSection(analysis, loads),
      buildReconSection(recon?.bySeverityRecipe ?? null),
      buildBackfillSection({
        alerts: backfills?.alerts ?? [],
        isStaleWeek: backfills?.isStaleWeek ?? false,
        selectedWeekNum: backfills?.selectedWeekNum ?? null,
        connected: bfConnected,
      }),
      buildStockSection({ shortages: shorts.data?.entries ?? null }),
    ];
  }, [analysis, loads, recon?.bySeverityRecipe, backfills, shorts.data]);

  const summary = useMemo(() => summarizeDigest(sections), [sections]);
  const realWeek = currentHfWeek();

  const openRecipe = (code: string) => { setSelectedRecipe(code); setView("recipe"); };

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
              KW {week}{week !== realWeek ? ` (aktuell ${realWeek})` : ""}
            </span>
            {upliftPercent !== 0 && (
              <span className="rounded bg-verden-50 px-2 py-1 font-semibold text-verden-700">
                Uplift {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
              </span>
            )}
          </div>
        </div>

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

      {sections.map((s) => (
        <SectionCard key={s.key} section={s} onOpenView={() => setView(s.view)} onOpenRecipe={openRecipe} />
      ))}
    </div>
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
            <DigestRow key={item.id} item={item} onClick={() => (item.recipeCode ? onOpenRecipe(item.recipeCode) : onOpenView())} />
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
