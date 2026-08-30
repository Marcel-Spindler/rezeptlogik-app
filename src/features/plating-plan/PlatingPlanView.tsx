import { useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "./usePlatingWeekPlan";
import { computeDayLoads } from "./platingPlanLogic";
import { PLATING_DAYS, type PlatingDay, type PlatingMealPlan } from "./platingPlanTypes";

const DAY_LABEL: Record<PlatingDay, string> = {
  Mo: "Mo", Di: "Di", Mi: "Mi", Do: "Do", Fr: "Fr", Sa: "Sa", So: "So",
};

const PREF_TONE: Record<string, string> = {
  Keto: "bg-purple-100 text-purple-800",
  CS: "bg-sky-100 text-sky-800",
  "P+": "bg-emerald-100 text-emerald-800",
  Perf: "bg-emerald-100 text-emerald-800",
  Veggie: "bg-lime-100 text-lime-800",
  Flexible: "bg-slate-100 text-slate-700",
};

function RunCell({ meal, day, onMove, onEdit }: {
  meal: PlatingMealPlan;
  day: PlatingDay;
  onMove: (runIndex: number, toDay: PlatingDay) => void;
  onEdit: (runIndex: number, portions: number) => void;
}) {
  const runs = meal.runs.filter(r => r.day === day && r.portions > 0);
  if (!runs.length) return <td className="border-b border-slate-100 px-1 py-1" />;
  return (
    <td className="border-b border-slate-100 px-1 py-1 align-top">
      {runs.map(r => (
        <div key={r.runIndex} className="mb-0.5 flex items-center gap-0.5 rounded bg-blue-50 px-1 py-0.5 text-[10px]">
          <span className="text-[8px] font-bold text-blue-400">R{r.runIndex}</span>
          <input
            type="number"
            defaultValue={r.portions}
            onBlur={e => { const v = Math.round(Number(e.target.value) || 0); if (v !== r.portions) onEdit(r.runIndex, v); }}
            className="w-12 bg-transparent text-right font-mono font-semibold text-blue-900 focus:outline-none"
          />
          <select
            value={day}
            onChange={e => onMove(r.runIndex, e.target.value as PlatingDay)}
            className="bg-transparent text-[9px] text-blue-500"
            title="Tag ändern"
          >
            {PLATING_DAYS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      ))}
    </td>
  );
}

export function PlatingPlanView({ data, week }: { data: DataBundle; week: string }) {
  const { plan, loading, dirty, update, regenerate } = usePlatingWeekPlan(data, week);
  const [firstRunPct, setFirstRunPct] = useState(70);

  const loads = useMemo(() => (plan ? computeDayLoads(plan) : []), [plan]);
  const activeDays = useMemo(
    () => PLATING_DAYS.filter(d => plan?.dayCapacity[d]?.lines || plan?.meals.some(m => m.runs.some(r => r.day === d))),
    [plan],
  );

  const moveRun = (code: string, runIndex: number, toDay: PlatingDay) => {
    update(prev => ({
      ...prev,
      meals: prev.meals.map(m => m.code !== code ? m : {
        ...m, runs: m.runs.map(r => r.runIndex === runIndex ? { ...r, day: toDay } : r),
      }),
    }));
  };
  const editRun = (code: string, runIndex: number, portions: number) => {
    update(prev => ({
      ...prev,
      meals: prev.meals.map(m => m.code !== code ? m : {
        ...m, runs: m.runs.map(r => r.runIndex === runIndex ? { ...r, portions } : r),
      }),
    }));
  };
  const setNote = (code: string, note: string) => {
    update(prev => ({ ...prev, meals: prev.meals.map(m => m.code === code ? { ...m, note } : m) }));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-cyan-800">Wochen-Plating-Plan</div>
          <h1 className="text-xl font-bold text-slate-950">Plating-Plan {week}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            First Run
            <select value={firstRunPct} onChange={e => setFirstRunPct(Number(e.target.value))} className="rounded border border-slate-300 px-1 py-0.5">
              {[62, 65, 66, 68, 70, 72].map(p => <option key={p} value={p}>{p}%</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={() => regenerate({ firstRunPct: firstRunPct / 100 })}
            className="rounded-lg bg-verden-600 px-3 py-1.5 font-semibold text-white hover:bg-verden-500"
          >
            {plan ? "Neu generieren" : "Plan generieren"}
          </button>
          {dirty && <span className="text-amber-600">speichert…</span>}
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Regeln: Demand = BENL+NORD+DE · ≤ 2250 → 1 Run (+10%) · &gt; 2250 → 2 Runs (+5%), Run 1 = {plan ? Math.round(plan.firstRunPct * 100) : firstRunPct}%.
        Seafood 1. Run ≥ Mittwoch · bis Do jedes Meal 1× · Fr/Sa reduziert. Zellen editierbar, „Frag den Plan" kann den Plan füllen/ändern.
      </p>

      {loading && <div className="card p-8 text-center text-slate-400">Lädt Plating-Plan…</div>}

      {!loading && !plan && (
        <div className="card p-8 text-center text-slate-500">
          Noch kein Plating-Plan für {week}. „Plan generieren" erzeugt den Rohbau aus dem Ramp-Up.
        </div>
      )}

      {plan && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-50 text-left text-[10px] uppercase text-slate-500">
                <th className="px-2 py-1.5">Code</th>
                <th className="px-2 py-1.5">Pref</th>
                <th className="px-2 py-1.5">Meal</th>
                <th className="px-1 py-1.5 text-right">BENL</th>
                <th className="px-1 py-1.5 text-right">NORD</th>
                <th className="px-1 py-1.5 text-right">DE</th>
                <th className="px-1 py-1.5 text-right">Total</th>
                <th className="px-1 py-1.5 text-right">+Buffer</th>
                <th className="px-1 py-1.5 text-center">Runs</th>
                {activeDays.map(d => <th key={d} className="px-1 py-1.5 text-center">{DAY_LABEL[d]}</th>)}
                <th className="px-2 py-1.5">Notiz</th>
              </tr>
            </thead>
            <tbody>
              {plan.meals.map(m => (
                <tr key={m.code} className="hover:bg-slate-50/60">
                  <td className="border-b border-slate-100 px-2 py-1 font-mono font-semibold">{m.code}</td>
                  <td className="border-b border-slate-100 px-2 py-1">
                    <span className={`rounded px-1 py-0.5 text-[9px] ${PREF_TONE[m.preference] ?? "bg-slate-100 text-slate-600"}`}>{m.preference}</span>
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1">
                    {m.name}
                    {m.seafood && <span className="ml-1 text-[9px] text-sky-600">🐟</span>}
                  </td>
                  <td className="border-b border-slate-100 px-1 py-1 text-right font-mono text-slate-500">{fmtNum(m.demand.benl)}</td>
                  <td className="border-b border-slate-100 px-1 py-1 text-right font-mono text-slate-500">{fmtNum(m.demand.nord)}</td>
                  <td className="border-b border-slate-100 px-1 py-1 text-right font-mono text-slate-500">{fmtNum(m.demand.de)}</td>
                  <td className="border-b border-slate-100 px-1 py-1 text-right font-mono font-semibold">{fmtNum(m.totalDemand)}</td>
                  <td className="border-b border-slate-100 px-1 py-1 text-right font-mono text-slate-600">{fmtNum(m.bufferedTotal)}</td>
                  <td className="border-b border-slate-100 px-1 py-1 text-center">
                    <span className={`rounded-full px-1.5 text-[9px] font-bold ${m.runCount === 1 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{m.runCount}×</span>
                  </td>
                  {activeDays.map(d => (
                    <RunCell key={d} meal={m} day={d}
                      onMove={(ri, to) => moveRun(m.code, ri, to)}
                      onEdit={(ri, p) => editRun(m.code, ri, p)}
                    />
                  ))}
                  <td className="border-b border-slate-100 px-2 py-1">
                    <input
                      defaultValue={m.note ?? ""}
                      onBlur={e => { if (e.target.value !== (m.note ?? "")) setNote(m.code, e.target.value); }}
                      placeholder="…"
                      className="w-32 bg-transparent text-[10px] text-slate-500 focus:outline-none"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 text-[10px]">
              <tr>
                <td colSpan={9} className="px-2 py-1 text-right font-semibold text-slate-500">Portionen / Tag</td>
                {activeDays.map(d => {
                  const l = loads.find(x => x.day === d);
                  return <td key={d} className={`px-1 py-1 text-center font-mono font-bold ${l?.overCapacity ? "text-rose-600" : "text-slate-700"}`}>{fmtNum(l?.portions ?? 0)}</td>;
                })}
                <td />
              </tr>
              <tr>
                <td colSpan={9} className="px-2 py-1 text-right text-slate-400">Linien · Std · ~/h/Linie</td>
                {activeDays.map(d => {
                  const l = loads.find(x => x.day === d);
                  return <td key={d} className="px-1 py-1 text-center text-[9px] text-slate-500">{l?.lines ?? 0}·{l?.hours ?? 0}h·{fmtNum(l?.perHourPerLine ?? 0)}{l?.overCapacity ? " ⚠" : ""}</td>;
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
