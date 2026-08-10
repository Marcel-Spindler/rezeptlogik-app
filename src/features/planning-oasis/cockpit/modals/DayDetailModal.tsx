// Modal: kompletter Küchenplan für einen Tag (Hauptrezepte + Sub-Rezepte, Allergen-Check).
import type { DataBundle } from "../../../../core/types";
import type { analyzePlan, PlannerDay } from "../../../../lib/planner";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

const DAY_LABELS: Record<PlannerDay, string> = { Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag", Fr: "Freitag", Sa: "Samstag", So: "Sonntag" };

function allergensForRecipe(data: DataBundle, code: string): string[] {
  const recipe = data.recipes?.[code];
  if (!recipe) return [];
  return [...new Set(Object.values(recipe.markets)
    .flatMap(m => (m?.allergens ?? "").split(/[,;/]/).map(a => a.trim()).filter(Boolean)))];
}

interface Props {
  day: PlannerDay;
  week: string;
  data: DataBundle;
  analysisRecipes: ReturnType<typeof analyzePlan>["recipes"];
  onClose: () => void;
  onExport: (day: PlannerDay) => void;
}

export function DayDetailModal({ day, week, data, analysisRecipes, onClose, onExport }: Props) {
  const dayLabel = DAY_LABELS[day] ?? day;
  const mainRecipes = analysisRecipes
    .filter(r => r.assigned?.day === day)
    .sort((a, b) => (a.assigned!.order ?? 999) - (b.assigned!.order ?? 999));
  const subsToday = analysisRecipes.flatMap(r =>
    r.subRecipes.filter(s => s.assigned?.day === day).map(s => ({ code: r.recipeCode, sub: s }))
  );

  const allAllergens = [...new Set(mainRecipes.flatMap(r => allergensForRecipe(data, r.recipeCode)))];
  const alarms: string[] = [];
  let prevAllergens: string[] = [];
  for (const r of mainRecipes) {
    const cur = allergensForRecipe(data, r.recipeCode);
    const removed = prevAllergens.filter(a => !cur.includes(a));
    if (removed.length > 0 && prevAllergens.length > 0) {
      alarms.push(`Linie reinigen vor ${r.recipeName}: ${removed.join(", ")} entfernt`);
    }
    prevAllergens = cur;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl ring-1 ring-slate-300" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between rounded-t-xl bg-slate-800 px-4 py-2 text-white">
          <div className="text-sm font-semibold">Küchenplan: {dayLabel} · {week}</div>
          <div className="flex items-center gap-2">
            <button className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700" onClick={() => onExport(day)}>Drucken / Export</button>
            <button className="text-lg leading-none" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {allAllergens.length > 0 && (
            <div className="rounded bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
              <div className="text-xs font-bold text-amber-800 mb-1">Allergene heute</div>
              <div className="flex flex-wrap gap-1">
                {allAllergens.map(a => <span key={a} className="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-900">{a}</span>)}
              </div>
            </div>
          )}
          {alarms.length > 0 && (
            <div className="space-y-1">
              {alarms.map((alarm, i) => <div key={i} className="rounded bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-800 ring-1 ring-rose-200">⚠ {alarm}</div>)}
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Hauptrezepte ({mainRecipes.length})</div>
            {mainRecipes.length === 0 && <div className="text-xs text-slate-400">Keine Hauptrezepte für diesen Tag verplant.</div>}
            <div className="space-y-2">
              {mainRecipes.map((r, i) => {
                const allergens = allergensForRecipe(data, r.recipeCode);
                return (
                  <div key={r.recipeCode} className="rounded border border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="mr-1 text-[10px] font-black text-slate-400">{i + 1}.</span>
                        <span className="font-semibold text-slate-900">{r.recipeCode}</span>
                        <span className="ml-1 text-sm text-slate-600">{r.recipeName}</span>
                      </div>
                      <div className="text-right text-xs text-slate-500">
                        <div className="font-bold">{fmtNum(Math.round(r.assigned?.targetPortions ?? 0))} Port.</div>
                        <div>{r.assigned?.shift ?? "-"}</div>
                      </div>
                    </div>
                    {allergens.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {allergens.map(a => <span key={a} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">{a}</span>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Sub-Rezepte heute ({subsToday.length})</div>
            {subsToday.length === 0 && <div className="text-xs text-slate-400">Keine Sub-Rezepte für diesen Tag verplant.</div>}
            <div className="space-y-1">
              {subsToday.map(({ code, sub }, i) => {
                const subDef = Object.values(data.recipes?.[code]?.markets ?? {})
                  .flatMap(m => m?.subRecipes ?? []).find(s => s.id === sub.subRecipeId);
                return (
                  <div key={`${code}-${sub.subRecipeId}-${i}`} className="rounded border border-slate-100 bg-slate-50 px-3 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-[10px] font-semibold text-slate-500">{code} · </span>
                        <span className="text-xs font-semibold text-slate-800">{sub.subRecipeName}</span>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {sub.category.split(/[/,]/).map(m => <span key={m} className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-800">{m.trim()}</span>)}
                        </div>
                        {subDef?.instructions && <div className="mt-0.5 text-[10px] italic text-slate-500">{subDef.instructions}</div>}
                      </div>
                      <div className="shrink-0 text-right text-xs text-slate-500">
                        <div className="font-bold">{fmtNum(Math.round(sub.assigned?.targetPortions ?? 0))}</div>
                        <div>{sub.assigned?.shift ?? "-"}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
