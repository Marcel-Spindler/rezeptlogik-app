import { useMemo } from "react";
import type { Market, ProcessSpec, Recipe, WeekRecipe } from "../../../core/types";
import { getBaseVerdenVolume, getSubRecipeMassProfile, workflowSteps } from "../../../lib/equipment";
import { fmtMin, fmtNum, matchesNeedle } from "../../../lib/helpers";
import { Stat } from "../shared";

interface Props {
  wr: WeekRecipe;
  recipe: Recipe;
  md: NonNullable<Recipe["markets"][Market]>;
  processSpecs: Record<string, ProcessSpec>;
  detailSearch: string;
}

function buildWorkflowRows(md: Props["md"], processSpecs: Record<string, ProcessSpec>, recipe: Recipe, portions: number) {
  return md.subRecipes.map(sub => {
    const spec = processSpecs[sub.id];
    const steps = workflowSteps(sub, spec);
    const mass = getSubRecipeMassProfile(sub, recipe);
    const gpp = mass.planningGramsPerPortion;
    const totalKg = portions * gpp / 1000;
    const batchSize = spec?.batchSizeKg ?? 0;
    const batches = batchSize > 0 ? Math.max(1, Math.ceil(totalKg / batchSize)) : (totalKg > 0 ? 1 : 0);
    const outputKg = portions * mass.outputGramsPerPortion / 1000;
    return { sub, spec, steps, gpp, totalKg, outputKg, batches, mass };
  });
}

export function WorkflowTab({ wr, recipe, md, processSpecs, detailSearch }: Props) {
  const portions = getBaseVerdenVolume(wr);
  const needle = detailSearch.trim().toLowerCase();

  const rows = useMemo(
    () => buildWorkflowRows(md, processSpecs, recipe, portions)
      .filter(row => matchesNeedle([row.sub.id, row.sub.name, row.sub.category, row.spec?.primaryStation, row.spec?.productFamily, ...row.steps.flatMap(step => [step.station ?? undefined, step.rawLabel])], needle)),
    [md, processSpecs, recipe, portions, needle]
  );

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Reihenfolge aus <code>Sub-Rezept-Cook-Method</code>, Equipment-Zeiten aus PFEI (gerechnet auf <b>{fmtNum(portions)}</b> Portionen Verden gesamt).
      </div>
      {rows.map(({ sub, spec, steps, gpp, totalKg, outputKg, batches, mass }) => (
        <div key={sub.id} className="card p-4">
          <div className="flex flex-wrap items-baseline gap-2 mb-2">
            <span className="font-mono text-xs text-slate-500">{sub.id}</span>
            <h4 className="font-semibold">{sub.name}</h4>
            {sub.category && <span className="pill bg-slate-100 text-slate-700">{sub.category}</span>}
            {!spec && <span className="pill bg-amber-100 text-amber-800">keine PFEI-Daten</span>}
            {spec?.primaryStation && <span className="pill bg-verden-100 text-verden-700">Constraint: {spec.primaryStation}</span>}
            {spec?.hygienic && <span className="pill bg-rose-100 text-rose-800">hygienic</span>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 text-xs mb-3">
            <Stat label="Input g / Portion" value={gpp ? fmtNum(gpp, 1) : "—"} />
            <Stat label="Output g / Portion" value={mass.outputGramsPerPortion ? fmtNum(mass.outputGramsPerPortion, 1) : "—"} />
            <Stat label="Input kg gesamt" value={totalKg ? fmtNum(totalKg, 1) : "—"} accent />
            <Stat label="Output kg gesamt" value={outputKg ? fmtNum(outputKg, 1) : "—"} />
            <Stat label="Verlust" value={mass.lossPercent !== undefined ? `${fmtNum(mass.lossPercent, 1)} %` : "—"} />
            <Stat label="Batches" value={batches ? fmtNum(batches) : "—"} accent />
          </div>
          {steps.length === 0 ? <div className="text-sm text-slate-500">Keine Cook-Method-Schritte hinterlegt.</div> : (
            <ol className="space-y-1.5">
              {steps.map(st => (
                <li key={st.index} className="flex items-center gap-3 rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-white text-xs font-bold tabular-nums">{st.index}</div>
                  <div className="flex-1">
                    <div className="text-sm font-semibold">
                      {st.station ?? st.rawLabel}
                      {st.station == null && <span className="ml-2 pill bg-amber-100 text-amber-800">unbekannte Station</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {st.minutesPerBatch ? `${fmtMin(st.minutesPerBatch)} / Batch` : "keine Zeit hinterlegt"}
                      {st.holdMin ? ` · Hold: ${fmtMin(st.holdMin)}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-500">Σ aktiv</div>
                    <div className="text-sm font-bold tabular-nums">{fmtMin((st.minutesPerBatch ?? 0) * batches)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}
