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

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${accent ? "bg-verden-50 ring-1 ring-verden-300" : "bg-slate-50 ring-1 ring-slate-200"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ? "text-verden-700" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}

export function WeekSelector({ weeks, selectedWeek, onWeekChange, weekRecipes, upliftPercent, onUpliftChange, totals, plannedTotal, prevWeek, weekDelta }: Props) {
  return (
    <div className="card p-4 space-y-3">
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Kalenderwoche</label>
        <select
          className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
          value={selectedWeek}
          onChange={e => onWeekChange(e.target.value)}
        >
          {weeks.map(w => {
            const n = weekRecipes.filter(r => r.hfWeek === w && isProducedInVerden(r)).length;
            return <option key={w} value={w}>{w}  ({n} Rezepte)</option>;
          })}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Produzierte Rezepte" value={fmtNum(weekRecipes.filter(r => r.hfWeek === selectedWeek && isProducedInVerden(r)).length)} />
        <Stat label="Verden Basis" value={fmtNum(totals.base)} />
        <Stat
          label={`Verden Plan${upliftPercent !== 0 ? ` (${upliftPercent > 0 ? "+" : ""}${upliftPercent}%)` : ""}`}
          value={fmtNum(plannedTotal)} accent />
        {MARKETS.map(m => totals[m] > 0 && (
          <Stat key={m} label={MARKET_LABEL[m]} value={fmtNum(totals[m])} />
        ))}
      </div>

      {weekDelta && (
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
      )}

      <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-700">Verden Uplift</div>
          <div className="rounded-lg bg-white px-2 py-1 text-xs font-bold ring-1 ring-slate-300 tabular-nums">
            {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
          </div>
        </div>
        <input
          className="mt-2 w-full accent-verden-600"
          type="range" min={-10} max={30} step={1}
          value={upliftPercent}
          onChange={e => onUpliftChange(Number(e.target.value))}
        />
        <div className="mt-2 flex gap-2">
          <button className="btn flex-1 text-xs" onClick={() => onUpliftChange(Math.max(-10, upliftPercent - 5))}>−5%</button>
          <button className="btn flex-1 text-xs" onClick={() => onUpliftChange(0)}>Reset</button>
          <button className="btn btn-primary flex-1 text-xs" onClick={() => onUpliftChange(Math.min(30, upliftPercent + 5))}>+5%</button>
        </div>
      </div>
    </div>
  );
}
