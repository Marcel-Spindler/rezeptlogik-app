import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "./usePlatingWeekPlan";
import { buildDefaultParams, computeDayLoads, DEFAULT_DAY_CAPACITY } from "./platingPlanLogic";
import { PLATING_OPTIMIZE_EVENT } from "../plan-assistant/PlanAssistant";
import {
  PLATING_DAYS, PRODUCTION_SHIFT_HOURS,
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
      {runs.map(r => {
        const shiftTone = r.shift === "spät" ? "bg-amber-50 border-amber-200" : r.shift === "früh" ? "bg-blue-50 border-blue-200" : "bg-blue-50";
        return (
          <div key={r.runIndex} className={`mb-0.5 flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] ${shiftTone}`}>
            <span className="text-[8px] font-bold text-blue-400">R{r.runIndex}</span>
            {r.shift && <span className={`text-[7px] font-bold ${r.shift === "spät" ? "text-amber-500" : "text-blue-400"}`}>{r.shift === "früh" ? "F" : "S"}</span>}
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
        );
      })}
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
  const { plan, loading, dirty, update, moveRun, regenerate } = usePlatingWeekPlan(data, week);
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
    setDraftCap(c => {
      const next: PlatingDayCapacity = { lines: c[d]?.lines ?? 0, hours: c[d]?.hours ?? 0, shifts: c[d]?.shifts ?? 1, [k]: v };
      // 2 Schichten = fix 2×7,5h — das Stundenfeld wird dafür nicht mehr frei getippt.
      if (k === "shifts" && v === 2) next.hours = 2 * PRODUCTION_SHIFT_HOURS;
      return { ...c, [d]: next };
    });
  const applyParams = () => regenerate({ params: draftParams, dayCapacity: draftCap });

  const loads = useMemo(() => (plan ? computeDayLoads(plan) : []), [plan]);
  const activeDays = useMemo(
    () => PLATING_DAYS.filter(d => plan?.dayCapacity[d]?.lines || plan?.meals.some(m => m.runs.some(r => r.day === d))),
    [plan],
  );

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

  const triggerAI = useCallback((mode: "fill" | "optimize") => {
    const p = plan?.params ?? draftParams;
    const paramInfo = `Parameter: First Run ${Math.round(p.firstRunPct * 100)}%, Puffer 1-Run +${Math.round(p.singleRunBuffer * 100)}%, Puffer 2-Runs +${Math.round(p.multiRunBuffer * 100)}%, Rate ${p.platingRatePerLineHour}/L/h.`;
    const shiftInfo = Object.entries(plan?.dayCapacity ?? draftCap)
      .filter(([, c]) => c && (c.shifts ?? 1) >= 2)
      .map(([d]) => d);
    const shiftNote = shiftInfo.length ? ` Tage mit 2 Schichten: ${shiftInfo.join(", ")}.` : "";

    const prompt = mode === "fill"
      ? `Erstelle den vollständigen Wochen-Plating-Plan für ${week}. ${paramInfo}${shiftNote} `
        + `Gehe systematisch vor: 1) generate_plating_plan aufrufen, 2) das Ergebnis auf ALLE Regeln prüfen `
        + `(Seafood so spät wie möglich, komplexe Meals früh, Tage gleichmäßig, keine Überkapazität, Schichtbalance), `
        + `3) simulate_plating_change mit Verbesserungen wo nötig, 4) propose_plating_plan mit detaillierter Zusammenfassung. `
        + `Der Plan muss 100% regelkonform sein.`
      : `Optimiere den bestehenden Wochen-Plating-Plan für ${week}. ${paramInfo}${shiftNote} `
        + `Prüfe den aktuellen Plan auf: 1) Tagesverteilung balanciert? 2) Seafood so spät wie möglich? `
        + `3) Komplexe Meals (cx≥1.15) früh genug? 4) Keine Überkapazität pro Schicht? 5) Alle Meals verplant? `
        + `Simuliere Verbesserungen und schlage den optimierten Plan vor.`;

    window.dispatchEvent(new CustomEvent(PLATING_OPTIMIZE_EVENT, { detail: prompt }));
  }, [plan, draftParams, draftCap, week]);

  // KPI summaries
  const kpiTotalMeals = plan?.meals.length ?? 0;
  const kpiTotalPortions = plan?.meals.reduce((s, m) => s + m.bufferedTotal, 0) ?? 0;
  const kpiSeafood = plan?.meals.filter(m => m.seafood).length ?? 0;
  const kpiOverDays = loads.filter(l => l.overCapacity).length;
  const kpi2Shifts = loads.filter(l => l.shifts > 1).length;

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
          <button
            type="button"
            onClick={() => triggerAI(plan ? "optimize" : "fill")}
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            {plan ? "KI optimieren" : "KI befüllen"}
          </button>
          {dirty && <span className="text-amber-600">speichert…</span>}
        </div>
      </div>

      {/* ── Kennzahlen-Dashboard (immer sichtbar) ── */}
      {plan && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-slate-400">Meals</div>
            <div className="font-mono font-bold text-slate-800">{kpiTotalMeals}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-slate-400">Portionen</div>
            <div className="font-mono font-bold text-slate-800">{fmtNum(kpiTotalPortions)}</div>
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-blue-500">First Run</div>
            <div className="font-mono font-bold text-blue-800">{Math.round(plan.params.firstRunPct * 100)}%</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-slate-400">Puffer 1R</div>
            <div className="font-mono font-bold text-slate-800">+{Math.round(plan.params.singleRunBuffer * 100)}%</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-slate-400">Puffer 2R</div>
            <div className="font-mono font-bold text-slate-800">+{Math.round(plan.params.multiRunBuffer * 100)}%</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase text-slate-400">Rate/L/h</div>
            <div className="font-mono font-bold text-slate-800">{fmtNum(plan.params.platingRatePerLineHour)}</div>
          </div>
          {kpiSeafood > 0 && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5">
              <div className="text-[9px] font-bold uppercase text-sky-500">Seafood</div>
              <div className="font-mono font-bold text-sky-800">{kpiSeafood} Meals</div>
            </div>
          )}
          {kpi2Shifts > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5">
              <div className="text-[9px] font-bold uppercase text-amber-500">2 Schichten</div>
              <div className="font-mono font-bold text-amber-800">{kpi2Shifts} Tage</div>
            </div>
          )}
          {kpiOverDays > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5">
              <div className="text-[9px] font-bold uppercase text-rose-500">Über Kapazität</div>
              <div className="font-mono font-bold text-rose-800">{kpiOverDays} Tage</div>
            </div>
          )}
        </div>
      )}

      {showParams && (
        <div className="card space-y-3 border-cyan-200 bg-cyan-50/40 p-3 text-[11px]">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ParamNum label="First Run %" value={Math.round(draftParams.firstRunPct * 100)} step={1} onCommit={v => setParam("firstRunPct", v / 100)} />
            <ParamNum label="Schwelle 1→2 Runs" value={draftParams.singleRunMaxDemand} step={50} onCommit={v => setParam("singleRunMaxDemand", v)} />
            <ParamNum label="Puffer 1 Run %" value={Math.round(draftParams.singleRunBuffer * 100)} step={1} onCommit={v => setParam("singleRunBuffer", v / 100)} />
            <ParamNum label="Puffer 2 Runs %" value={Math.round(draftParams.multiRunBuffer * 100)} step={1} onCommit={v => setParam("multiRunBuffer", v / 100)} />
            <ParamNum label="Rate P/Linie/h" value={draftParams.platingRatePerLineHour} step={25} onCommit={v => setParam("platingRatePerLineHour", v)} />
            <ParamNum label="Easy Changeover (min)" value={draftParams.changeoverEasyMin} step={5} onCommit={v => setParam("changeoverEasyMin", v)} />
            <ParamNum label="Reinigung Allergen (min)" value={draftParams.changeoverAllergenMin} step={5} onCommit={v => setParam("changeoverAllergenMin", v)} />
            <ParamNum label="Plater je Sub-Meal" value={draftParams.platerFactor} step={0.1} onCommit={v => setParam("platerFactor", v)} />
            <ParamNum label="Helfer je Linie" value={draftParams.platingHelpers} step={1} onCommit={v => setParam("platingHelpers", v)} />
          </div>
          <div>
            <div className="mb-1 font-semibold text-slate-600">Kapazität je Tag (Linien · Stunden gesamt · Schichten)</div>
            <div className="flex flex-wrap gap-2">
              {PARAM_DAYS.map(d => (
                <div key={d} className="rounded border border-slate-200 bg-white px-2 py-1">
                  <div className="text-center text-[10px] font-bold text-slate-500">{d}</div>
                  <div className="flex items-center gap-1">
                    <input type="number" min={0} value={draftCap[d]?.lines ?? 0}
                      onChange={e => setCap(d, "lines", Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      className="w-9 rounded border border-slate-200 px-1 text-right font-mono" title="Linien" />
                    <span className="text-slate-300">·</span>
                    {(draftCap[d]?.shifts ?? 1) === 2 ? (
                      <span className="w-16 text-right font-mono text-[10px] font-bold text-amber-700"
                        title="2 Schichten à fix 7,5h — Produktionsmitarbeiter-Schichtlänge, nicht editierbar">
                        2×7,5h
                      </span>
                    ) : (
                      <input type="number" min={0} value={draftCap[d]?.hours ?? 0}
                        onChange={e => setCap(d, "hours", Math.max(0, Number(e.target.value) || 0))}
                        className="w-9 rounded border border-slate-200 px-1 text-right font-mono" title="Stunden gesamt" />
                    )}
                    <span className="text-slate-300">·</span>
                    <select value={draftCap[d]?.shifts ?? 1}
                      onChange={e => setCap(d, "shifts", Number(e.target.value) as 1 | 2)}
                      className={`w-10 rounded border px-0.5 text-right font-mono text-[10px] ${(draftCap[d]?.shifts ?? 1) === 2 ? "border-amber-300 bg-amber-50 font-bold text-amber-700" : "border-slate-200"}`}
                      title="Schichten (1=nur Früh, 2=Früh+Spät)">
                      <option value={1}>1S</option>
                      <option value={2}>2S</option>
                    </select>
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
        <div className="card space-y-3 p-8 text-center">
          <div className="text-slate-500">
            Noch kein Plating-Plan für {week}.
          </div>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={applyParams}
              className="rounded-lg bg-verden-600 px-4 py-2 text-sm font-semibold text-white hover:bg-verden-500"
            >
              Plan generieren (Algorithmus)
            </button>
            <button
              type="button"
              onClick={() => triggerAI("fill")}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              KI befüllen (Gemini)
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            „Plan generieren" nutzt den Algorithmus (schnell). „KI befüllen" lässt Gemini den Plan erstellen, prüfen und optimieren (gründlicher).
          </p>
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
                  return <td key={d} className="px-1 py-1 text-center text-[9px] text-slate-500">{l?.lines ?? 0}·{l?.availableHours ?? 0}h·{fmtNum(l?.perHourPerLine ?? 0)}{l?.overCapacity ? " ⚠" : ""}</td>;
                })}
                <td />
              </tr>
              {loads.some(l => l.shiftLoads) && (
                <>
                  <tr className="border-t border-amber-200 bg-amber-50/40">
                    <td colSpan={10} className="px-2 py-1 text-right font-semibold text-blue-600">Frühschicht</td>
                    {activeDays.map(d => {
                      const l = loads.find(x => x.day === d);
                      const sl = l?.shiftLoads?.find(s => s.shift === "früh");
                      if (!sl) return <td key={d} className="px-1 py-1 text-center text-[9px] text-slate-400">—</td>;
                      return <td key={d} className={`px-1 py-1 text-center text-[9px] font-mono ${sl.overCapacity ? "font-bold text-rose-600" : "text-blue-700"}`}>{fmtNum(sl.portions)} · {sl.neededHours}/{sl.availableHours}h</td>;
                    })}
                    <td />
                  </tr>
                  <tr className="bg-amber-50/40">
                    <td colSpan={10} className="px-2 py-1 text-right font-semibold text-amber-600">Spätschicht</td>
                    {activeDays.map(d => {
                      const l = loads.find(x => x.day === d);
                      const sl = l?.shiftLoads?.find(s => s.shift === "spät");
                      if (!sl) return <td key={d} className="px-1 py-1 text-center text-[9px] text-slate-400">—</td>;
                      return <td key={d} className={`px-1 py-1 text-center text-[9px] font-mono ${sl.overCapacity ? "font-bold text-rose-600" : sl.portions > 0 ? "text-amber-700" : "text-slate-400"}`}>{sl.portions > 0 ? `${fmtNum(sl.portions)} · ${sl.neededHours}/${sl.availableHours}h` : "—"}</td>;
                    })}
                    <td />
                  </tr>
                </>
              )}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
