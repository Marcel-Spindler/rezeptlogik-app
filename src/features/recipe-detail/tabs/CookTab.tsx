import { useMemo } from "react";
import type { CookSchedule, Market, ProcessSpec, Recipe, WeekRecipe } from "../../../core/types";
import { getSubRecipeMassProfile, workflowSteps } from "../../../lib/equipment";
import {
  fmtMin, fmtNum, getFulfillmentSplit, ingredientSectionTone, isPreproductionRecommended,
  matchedScheduleSteps, matchesNeedle, oneShiftLabel, resolveCookSchedule,
} from "../../../lib/helpers";
import { SHIFT_RANGE } from "../shared";

interface Props {
  wr: WeekRecipe;
  md: NonNullable<Recipe["markets"][Market]>;
  cookSchedules: Record<string, CookSchedule>;
  portionsTotal: number;
  recipe: Recipe;
  processSpecs: Record<string, ProcessSpec>;
  detailSearch: string;
}

function Timeline({ cs }: { cs: CookSchedule }) {
  const stepsByShift = new Map(cs.steps.map(s => [s.shiftsBefore, s.label]));
  return (
    <div className="grid grid-cols-5 gap-2">
      {SHIFT_RANGE.map(n => {
        const lbl = stepsByShift.get(n);
        return (
          <div key={n} className={`rounded-lg p-3 ring-1 ${lbl ? (n === 0 ? "bg-verden-600 text-white ring-verden-700" : "bg-slate-100 ring-slate-200") : "bg-slate-50 ring-slate-100 text-slate-300"}`}>
            <div className="text-[10px] uppercase tracking-wide opacity-80">{oneShiftLabel(n)}</div>
            <div className="text-sm font-semibold mt-1 leading-tight">{lbl ?? "—"}</div>
          </div>
        );
      })}
    </div>
  );
}

function CookMethodCard({ methodName, index, subs, cookSchedules, processSpecs, recipe, portionsTotal }: {
  methodName: string;
  index: number;
  subs: NonNullable<Recipe["markets"][Market]>["subRecipes"];
  cookSchedules: Record<string, CookSchedule>;
  processSpecs: Record<string, ProcessSpec>;
  recipe: Recipe;
  portionsTotal: number;
}) {
  const resolved = resolveCookSchedule(methodName, cookSchedules);
  const cs = resolved.schedule;
  const tone = ingredientSectionTone(index);

  return (
    <div className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${tone.frame}`}>
      <div className={`px-4 py-3 ${tone.header}`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 className={`font-semibold ${tone.headerText}`}>{methodName}</h4>
          {cs
            ? <span className="pill bg-verden-100 text-verden-700">VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>
            : <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule definiert</span>}
        </div>
        <div className="text-xs text-slate-600">Sub-Rezepte: {subs.map(s => s.name).join(" · ")}</div>
      </div>
      <div className="p-4">
        {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
          <div className="mb-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 ring-1 ring-blue-200">
            VF-Schedule gematcht über <b>{resolved.matchedMethod}</b>.
          </div>
        )}
        {cs && <Timeline cs={cs} />}
        {cs && (
          <div className="mt-3 space-y-3">
            {subs.map(sub => {
              const spec = processSpecs[sub.id];
              const steps = workflowSteps(sub, spec);
              const mass = getSubRecipeMassProfile(sub, recipe);
              const grossKg = (portionsTotal * (mass.grossInputGramsPerPortion || mass.planningGramsPerPortion)) / 1000;
              const outputKg = (portionsTotal * mass.outputGramsPerPortion) / 1000;
              const batches = spec?.batchSizeKg && spec.batchSizeKg > 0 ? Math.max(1, Math.ceil(grossKg / spec.batchSizeKg)) : (grossKg > 0 ? 1 : 0);
              const recommendPreproduction = isPreproductionRecommended(spec) && /blast chiller/i.test(sub.category);

              return (
                <div key={sub.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-3">
                    <div className="font-semibold text-slate-800">{sub.name}</div>
                    <div className="font-mono text-[10px] text-slate-400">{sub.id}</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Input {grossKg ? fmtNum(grossKg, 1) : "—"} kg · Output {outputKg ? fmtNum(outputKg, 1) : "—"} kg
                      {mass.lossPercent !== undefined ? ` · Verlust ${fmtNum(mass.lossPercent, 1)}%` : ""}
                      {batches > 0 ? ` · ${fmtNum(batches)} Batch` : ""}
                    </div>
                  </div>
                  {recommendPreproduction && (
                    <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900 ring-1 ring-amber-200">
                      Empfehlung: spätestens <b>am Vortag (D-1)</b> abschliessen.
                    </div>
                  )}
                  <div className="grid gap-2 md:grid-cols-5">
                    {SHIFT_RANGE.map(n => {
                      const scheduleLabel = cs.steps.find(step => step.shiftsBefore === n)?.label;
                      const matches = scheduleLabel ? matchedScheduleSteps(scheduleLabel, steps) : [];
                      return (
                        <div key={n} className={`rounded-lg ring-1 p-2 ${matches.length > 0 ? "bg-white ring-verden-200" : "bg-slate-100 ring-slate-200"}`}>
                          <div className="text-[10px] uppercase tracking-wide text-slate-500">{scheduleLabel ?? "—"}</div>
                          <div className="text-[10px] text-slate-400">{oneShiftLabel(n)}</div>
                          <div className="mt-1 space-y-1">
                            {matches.length === 0 && <div className="text-[11px] text-slate-400">kein direkter Step-Match</div>}
                            {matches.map(step => (
                              <div key={`${step.index}-${step.rawLabel}`} className="rounded bg-white px-2 py-1 text-[11px] ring-1 ring-slate-200">
                                <div className="font-semibold text-slate-700">#{step.index} {step.station ?? step.rawLabel}</div>
                                <div className="text-slate-500">
                                  {step.minutesPerBatch ? `${fmtMin(step.minutesPerBatch)} / Batch` : "ohne Zeit"}
                                  {step.holdMin ? ` · Hold ${fmtMin(step.holdMin)}` : ""}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const GANTT_COLORS = [
  "#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#ec4899", "#14b8a6",
];

function GanttTimeline({ md, cookSchedules, processSpecs, recipe, portionsTotal }: Omit<Props, "wr" | "detailSearch">) {
  const bars = useMemo(() => {
    const result: { name: string; startShift: number; durationShifts: number; color: string; totalMin: number }[] = [];
    const categories = [...new Set(md.subRecipes.map(s => s.category).filter(Boolean))];

    categories.forEach((cat, catIdx) => {
      const resolved = resolveCookSchedule(cat, cookSchedules);
      const cs = resolved.schedule;
      if (!cs) return;

      const subs = md.subRecipes.filter(s => s.category === cat);
      for (const sub of subs) {
        const spec = processSpecs[sub.id];
        const steps = workflowSteps(sub, spec);
        const mass = getSubRecipeMassProfile(sub, recipe);
        const grossKg = (portionsTotal * (mass.grossInputGramsPerPortion || mass.planningGramsPerPortion)) / 1000;
        const batches = spec?.batchSizeKg && spec.batchSizeKg > 0 ? Math.max(1, Math.ceil(grossKg / spec.batchSizeKg)) : 1;
        const totalMin = steps.reduce((s, st) => s + (st.minutesPerBatch ?? 0) * batches, 0);

        result.push({
          name: sub.name,
          startShift: cs.cookShifts,
          durationShifts: Math.max(1, Math.ceil(cs.cookShifts / 2)),
          color: GANTT_COLORS[catIdx % GANTT_COLORS.length],
          totalMin,
        });
      }
    });
    return result;
  }, [md, cookSchedules, processSpecs, recipe, portionsTotal]);

  if (bars.length === 0) return null;

  const barHeight = 28;
  const barGap = 4;
  const headerH = 30;
  const leftPad = 160;
  const shiftWidth = 100;
  const svgW = leftPad + SHIFT_RANGE.length * shiftWidth;
  const svgH = headerH + bars.length * (barHeight + barGap) + 10;

  return (
    <div className="card p-4 overflow-x-auto">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Zeitstrahl (Gantt)</h3>
      <svg width={svgW} height={svgH} style={{ minWidth: svgW }}>
        {SHIFT_RANGE.map((n, i) => (
          <g key={n}>
            <rect x={leftPad + i * shiftWidth} y={0} width={shiftWidth} height={svgH} fill={i % 2 === 0 ? "#f8fafc" : "#fff"} />
            <text x={leftPad + i * shiftWidth + shiftWidth / 2} y={18} textAnchor="middle" className="text-[10px] fill-slate-500">
              {oneShiftLabel(n)}
            </text>
          </g>
        ))}
        {bars.map((bar, idx) => {
          const y = headerH + idx * (barHeight + barGap);
          const shiftIdx = SHIFT_RANGE.indexOf(bar.startShift as typeof SHIFT_RANGE[number]);
          const x = leftPad + (shiftIdx >= 0 ? shiftIdx : 0) * shiftWidth;
          const w = bar.durationShifts * shiftWidth - 4;
          return (
            <g key={`${bar.name}-${idx}`}>
              <text x={leftPad - 8} y={y + barHeight / 2 + 4} textAnchor="end" className="text-[10px] fill-slate-600" style={{ fontSize: 10 }}>
                {bar.name.length > 20 ? bar.name.slice(0, 18) + "..." : bar.name}
              </text>
              <rect x={x + 2} y={y} width={w} height={barHeight} rx={6} fill={bar.color} opacity={0.8} />
              <text x={x + 8} y={y + barHeight / 2 + 4} className="text-[9px] fill-white font-semibold" style={{ fontSize: 9 }}>
                {bar.totalMin > 0 ? fmtMin(bar.totalMin) : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function CookTab({ wr, md, cookSchedules, portionsTotal, recipe, processSpecs, detailSearch }: Props) {
  const needle = detailSearch.trim().toLowerCase();
  const split = getFulfillmentSplit(wr);
  const methods = [...new Set(md.subRecipes.map(s => s.category).filter(Boolean))].filter(m => {
    const subs = md.subRecipes.filter(s => s.category === m);
    return matchesNeedle([m, ...subs.flatMap(s => [s.id, s.name, s.category, s.instructions])], needle);
  });

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Plan für <b>Verden (VF)</b> · gesamt <b>{fmtNum(portionsTotal)}</b> Portionen. Einschicht-Modell: 1 Shift = 1 Tag.
      </div>
      <GanttTimeline md={md} cookSchedules={cookSchedules} processSpecs={processSpecs} recipe={recipe} portionsTotal={portionsTotal} />
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Wochenlogik ab Donnerstag</h3>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          {[
            { label: "Donnerstag", color: "bg-slate-50 ring-slate-200", text: "text-slate-500", title: "Wochenstart Produktion", desc: "Vorproduktion und chilled Prep für alles, was Freitag ins Fulfillment muss." },
            { label: "Freitag", color: "bg-verden-50 ring-verden-200", text: "text-verden-700", title: "Fulfillment-Tag 1", desc: `DK/SE komplett: ${fmtNum(split.dkseFriday)} · DE Split 1: ${fmtNum(split.deFriday)}` },
            { label: "Samstag", color: "bg-slate-50 ring-slate-200", text: "text-slate-500", title: "Zwischenlauf / Vorproduktion", desc: "Vorbereitung für den Sonntagssplit Deutschland." },
            { label: "Sonntag", color: "bg-blue-50 ring-blue-200", text: "text-blue-700", title: "Fulfillment-Tag 2", desc: `DE Split 2: ${fmtNum(split.deSunday)}${split.benl > 0 ? ` · BENL: ${fmtNum(split.benl)}` : ""}` },
          ].map(d => (
            <div key={d.label} className={`rounded-xl ${d.color} ring-1 p-3`}>
              <div className={`text-[10px] uppercase tracking-wide ${d.text}`}>{d.label}</div>
              <div className="mt-1 font-semibold">{d.title}</div>
              <div className="mt-1 text-xs text-slate-600">{d.desc}</div>
            </div>
          ))}
        </div>
      </div>
      {methods.map((m, index) => (
        <CookMethodCard
          key={m} methodName={m} index={index}
          subs={md.subRecipes.filter(s => s.category === m)}
          cookSchedules={cookSchedules} processSpecs={processSpecs} recipe={recipe} portionsTotal={portionsTotal}
        />
      ))}
      {methods.length === 0 && <div className="card p-4 text-slate-500">Keine Cook-Methoden in den Sub-Rezepten.</div>}
    </div>
  );
}
