import { useEffect, useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "./usePlatingWeekPlan";
import { buildDefaultParams, computeDayLoads, DEFAULT_DAY_CAPACITY } from "./platingPlanLogic";
import {
  PLATING_DAYS,
  type PlatingDay, type PlatingDayCapacity, type PlatingMealPlan, type PlatingPlanParams,
} from "./platingPlanTypes";

const DAY_LABEL: Record<PlatingDay, string> = {
  Mo: "Mo", Di: "Di", Mi: "Mi", Do: "Do", Fr: "Fr", Sa: "Sa", So: "So",
};

function ParamNum({ label, value, step, onCommit }: {
  label: string; value: number; step: number; onCommit: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
      <span className="text-slate-600">{label}</span>
      <input
        key={value}
        type="number"
        defaultValue={value}
        step={step}
        onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== value) onCommit(v); }}
        className="w-16 rounded border border-slate-200 px-1 text-right font-mono font-semibold"
      />
    </label>
  );
}

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

const PARAM_DAYS: PlatingDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Complexity Score als farbiger Chip (Median-Meal = 1.0). */
function CxChip({ cx }: { cx: number | null }) {
  if (cx == null) return <span className="text-[9px] text-slate-300">–</span>;
  const tone = cx >= 1.15 ? "bg-rose-100 text-rose-700"
    : cx <= 0.80 ? "bg-emerald-100 text-emerald-700"
    : "bg-slate-100 text-slate-600";
  const title = cx >= 1.15 ? "komplex → 1. Run früh" : cx <= 0.80 ? "einfach → flexibel / Montag" : "mittel";
  return <span className={`rounded px-1 py-0.5 text-[9px] font-semibold ${tone}`} title={title}>{cx.toFixed(2)}</span>;
}

export function PlatingPlanView({ data, week }: { data: DataBundle; week: string }) {
  const { plan, loading, dirty, update, regenerate } = usePlatingWeekPlan(data, week);
  const [showParams, setShowParams] = useState(false);
  const [draftParams, setDraftParams] = useState<PlatingPlanParams>(() => buildDefaultParams(week));
  const [draftCap, setDraftCap] = useState<Partial<Record<PlatingDay, PlatingDayCapacity>>>(() => ({ ...DEFAULT_DAY_CAPACITY }));

  useEffect(() => {
    setDraftParams(plan?.params ?? buildDefaultParams(week));
    setDraftCap(plan?.dayCapacity ?? { ...DEFAULT_DAY_CAPACITY });
  }, [plan, week]);

  const paramsDirty = useMemo(() => {
    if (!plan) return false;
    return JSON.stringify([draftParams, draftCap]) !== JSON.stringify([plan.params, plan.dayCapacity]);
  }, [plan, draftParams, draftCap]);

  const setParam = (k: keyof PlatingPlanParams, v: number) => setDraftParams(p => ({ ...p, [k]: v }));
  const setCap = (d: PlatingDay, k: keyof PlatingDayCapacity, v: number) =>
    setDraftCap(c => ({ ...c, [d]: { lines: c[d]?.lines ?? 0, hours: c[d]?.hours ?? 0, [k]: v } }));
  const applyParams = () => regenerate({ params: draftParams, dayCapacity: draftCap });

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
          <button
            type="button"
            onClick={() => setShowParams(s => !s)}
            className={`rounded-lg border px-2 py-1.5 font-semibold ${showParams || paramsDirty ? "border-cyan-400 bg-cyan-50 text-cyan-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
          >
            ⚙ Parameter{paramsDirty ? " •" : ""}
          </button>
          <button
            type="button"
            onClick={applyParams}
            className="rounded-lg bg-verden-600 px-3 py-1.5 font-semibold text-white hover:bg-verden-500"
          >
            {plan ? "Neu generieren" : "Plan generieren"}
          </button>
          {dirty && <span className="text-amber-600">speichert…</span>}
        </div>
      </div>

      {showParams && (
        <div className="card space-y-3 border-cyan-200 bg-cyan-50/40 p-3 text-[11px]">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ParamNum label="First Run %" value={Math.round(draftParams.firstRunPct * 100)} step={1} onCommit={v => setParam("firstRunPct", v / 100)} />
            <ParamNum label="Schwelle 1→2 Runs" value={draftParams.singleRunMaxDemand} step={50} onCommit={v => setParam("singleRunMaxDemand", v)} />
            <ParamNum label="Puffer 1 Run %" value={Math.round(draftParams.singleRunBuffer * 100)} step={1} onCommit={v => setParam("singleRunBuffer", v / 100)} />
            <ParamNum label="Puffer 2 Runs %" value={Math.round(draftParams.multiRunBuffer * 100)} step={1} onCommit={v => setParam("multiRunBuffer", v / 100)} />
            <ParamNum label="Rate P/Linie/h" value={draftParams.platingRatePerLineHour} step={25} onCommit={v => setParam("platingRatePerLineHour", v)} />
          </div>
          <div>
            <div className="mb-1 font-semibold text-slate-600">Kapazität je Tag (Linien · Stunden)</div>
            <div className="flex flex-wrap gap-2">
              {PARAM_DAYS.map(d => (
                <div key={d} className="rounded border border-slate-200 bg-white px-2 py-1">
                  <div className="text-center text-[10px] font-bold text-slate-500">{d}</div>
                  <div className="flex items-center gap-1">
                    <input type="number" min={0} value={draftCap[d]?.lines ?? 0}
                      onChange={e => setCap(d, "lines", Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      className="w-9 rounded border border-slate-200 px-1 text-right font-mono" />
                    <span className="text-slate-300">·</span>
                    <input type="number" min={0} value={draftCap[d]?.hours ?? 0}
                      onChange={e => setCap(d, "hours", Math.max(0, Number(e.target.value) || 0))}
                      className="w-9 rounded border border-slate-200 px-1 text-right font-mono" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[10px] text-slate-500">
            Änderungen greifen erst mit „{plan ? "Neu generieren" : "Plan generieren"}". Sheet-Referenz je KW: First Run 62 % (W29/30) · 66 % (W31) · sonst 70 %; Kapazität So 0 / Di–Do 3·22 / Fr 2·14 / Sa 2·10.
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        Regeln: Demand = BENL+NORD+DE · ≤ {fmtNum(draftParams.singleRunMaxDemand)} → 1 Run (+{Math.round(draftParams.singleRunBuffer * 100)}%) · &gt; {fmtNum(draftParams.singleRunMaxDemand)} → 2 Runs (+{Math.round(draftParams.multiRunBuffer * 100)}%), Run 1 = {Math.round((plan?.params.firstRunPct ?? draftParams.firstRunPct) * 100)}%.
        Seafood 1. Run so spät wie möglich (Do), möglichst 1 Tag · bis Do jedes Meal 1× · Fr/Sa reduziert · Cx (Complexity Score, Median = 1.0): komplex → 1. Run früh, einfach → flexibel/Montag. Zellen editierbar, „Frag den Plan" kann den Plan füllen/ändern.
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
                <th className="px-1 py-1.5 text-center" title="Complexity Score (Median-Meal = 1.0)">Cx</th>
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
                  <td className="border-b border-slate-100 px-1 py-1 text-center"><CxChip cx={m.complexity} /></td>
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
                <td colSpan={10} className="px-2 py-1 text-right font-semibold text-slate-500">Portionen / Tag</td>
                {activeDays.map(d => {
                  const l = loads.find(x => x.day === d);
                  return <td key={d} className={`px-1 py-1 text-center font-mono font-bold ${l?.overCapacity ? "text-rose-600" : "text-slate-700"}`}>{fmtNum(l?.portions ?? 0)}</td>;
                })}
                <td />
              </tr>
              <tr>
                <td colSpan={10} className="px-2 py-1 text-right text-slate-400">Linien · Std · ~/h/Linie</td>
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
