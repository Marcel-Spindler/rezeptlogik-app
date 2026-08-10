import type { WeekRecipe } from "../core/types";
import { fmtNum, isProducedInVerden, MARKETS, MARKET_LABEL } from "../lib/helpers";

interface WeekDelta {
  deltaPortions: number;
  newCodes: string[];
  droppedCodes: string[];
}

interface Totals {
  BENL: number;
  DKSE: number;
  DE: number;
  base: number;
}

interface Props {
  weeks: string[];
  selectedWeek: string;
  onWeekChange: (week: string) => void;
  weekRecipes: WeekRecipe[];
  upliftPercent: number;
  onUpliftChange: (pct: number) => void;
  totals: Totals;
  plannedTotal: number;
  prevWeek: string | null;
  weekDelta: WeekDelta | null;
}

const UPLIFT_MIN = -10;
const UPLIFT_MAX = 30;
const UPLIFT_STEP = 5;

function countProducedRecipes(weekRecipes: WeekRecipe[], week: string): number {
  return weekRecipes.filter(r => r.hfWeek === week && isProducedInVerden(r)).length;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${accent ? "bg-verden-50 ring-1 ring-verden-300" : "bg-slate-50 ring-1 ring-slate-200"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ? "text-verden-700" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}

function WeekPicker({ weeks, selectedWeek, weekRecipes, onWeekChange }: {
  weeks: string[];
  selectedWeek: string;
  weekRecipes: WeekRecipe[];
  onWeekChange: (week: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Kalenderwoche</label>
      <select
        className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
        value={selectedWeek}
        onChange={e => onWeekChange(e.target.value)}
      >
        {weeks.map(w => (
          <option key={w} value={w}>{w}  ({countProducedRecipes(weekRecipes, w)} Rezepte)</option>
        ))}
      </select>
    </div>
  );
}

function WeekStatsGrid({ weekRecipes, selectedWeek, totals, plannedTotal, upliftPercent }: {
  weekRecipes: WeekRecipe[];
  selectedWeek: string;
  totals: Totals;
  plannedTotal: number;
  upliftPercent: number;
}) {
  const upliftLabel = upliftPercent !== 0 ? ` (${upliftPercent > 0 ? "+" : ""}${upliftPercent}%)` : "";
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <Stat label="Produzierte Rezepte" value={fmtNum(countProducedRecipes(weekRecipes, selectedWeek))} />
      <Stat label="Verden Basis" value={fmtNum(totals.base)} />
      <Stat label={`Verden Plan${upliftLabel}`} value={fmtNum(plannedTotal)} accent />
      {MARKETS.map(m => totals[m] > 0 && <Stat key={m} label={MARKET_LABEL[m]} value={fmtNum(totals[m])} />)}
    </div>
  );
}

function WeekDeltaCard({ prevWeek, weekDelta }: { prevWeek: string | null; weekDelta: WeekDelta }) {
  return (
    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-700">Δ vs. {prevWeek}</div>
        <span className={`text-xs font-bold tabular-nums ${weekDelta.deltaPortions >= 0 ? "text-emerald-700" : "text-red-600"}`}>
          {weekDelta.deltaPortions > 0 ? "+" : ""}{fmtNum(weekDelta.deltaPortions)}
        </span>
      </div>
      {weekDelta.newCodes.length > 0 && (
        <div className="text-[11px] text-emerald-700">
          <span className="font-semibold">+{weekDelta.newCodes.length} neu:</span>{" "}
          {weekDelta.newCodes.slice(0, 4).join(" · ")}
          {weekDelta.newCodes.length > 4 ? ` +${weekDelta.newCodes.length - 4}` : ""}
        </div>
      )}
      {weekDelta.droppedCodes.length > 0 && (
        <div className="text-[11px] text-red-600">
          <span className="font-semibold">−{weekDelta.droppedCodes.length} weg:</span>{" "}
          {weekDelta.droppedCodes.slice(0, 4).join(" · ")}
          {weekDelta.droppedCodes.length > 4 ? ` +${weekDelta.droppedCodes.length - 4}` : ""}
        </div>
      )}
    </div>
  );
}

function UpliftControl({ upliftPercent, onUpliftChange }: { upliftPercent: number; onUpliftChange: (pct: number) => void }) {
  const clamp = (pct: number) => Math.max(UPLIFT_MIN, Math.min(UPLIFT_MAX, pct));
  return (
    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700">Verden Uplift</div>
        <div className="rounded-lg bg-white px-2 py-1 text-xs font-bold ring-1 ring-slate-300 tabular-nums">
          {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
        </div>
      </div>
      <input
        className="mt-2 w-full accent-verden-600"
        type="range" min={UPLIFT_MIN} max={UPLIFT_MAX} step={1}
        value={upliftPercent}
        onChange={e => onUpliftChange(Number(e.target.value))}
      />
      <div className="mt-2 flex gap-2">
        <button className="btn flex-1 text-xs" onClick={() => onUpliftChange(clamp(upliftPercent - UPLIFT_STEP))}>−5%</button>
        <button className="btn flex-1 text-xs" onClick={() => onUpliftChange(0)}>Reset</button>
        <button className="btn btn-primary flex-1 text-xs" onClick={() => onUpliftChange(clamp(upliftPercent + UPLIFT_STEP))}>+5%</button>
      </div>
    </div>
  );
}

export function WeekSelector({
  weeks, selectedWeek, onWeekChange, weekRecipes, upliftPercent, onUpliftChange,
  totals, plannedTotal, prevWeek, weekDelta,
}: Props) {
  return (
    <div className="card p-4 space-y-3">
      <WeekPicker weeks={weeks} selectedWeek={selectedWeek} weekRecipes={weekRecipes} onWeekChange={onWeekChange} />
      <WeekStatsGrid weekRecipes={weekRecipes} selectedWeek={selectedWeek} totals={totals} plannedTotal={plannedTotal} upliftPercent={upliftPercent} />
      {weekDelta && <WeekDeltaCard prevWeek={prevWeek} weekDelta={weekDelta} />}
      <UpliftControl upliftPercent={upliftPercent} onUpliftChange={onUpliftChange} />
    </div>
  );
}
