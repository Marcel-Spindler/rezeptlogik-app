import type { ProductionPlan, WorkOrderEntry } from "./types";

interface Props {
  plan: ProductionPlan;
  onRecipeClick?: (code: string) => void;
}

function yieldColor(pct: number): string {
  if (pct <= 0) return "text-gray-400";
  if (pct >= 80) return "text-green-700";
  if (pct >= 60) return "text-yellow-700";
  return "text-red-600";
}

function WORow({ entry, onRecipeClick }: { entry: WorkOrderEntry; onRecipeClick?: (code: string) => void }) {
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors text-xs">
      <td className="px-2 py-1.5 text-gray-500 font-mono">{entry.kitchenDay}</td>
      <td className="px-2 py-1.5 font-mono text-gray-700">{entry.workOrder}</td>
      <td className="px-2 py-1.5">
        <button
          onClick={() => entry.recipeCode && onRecipeClick?.(entry.recipeCode)}
          className="font-mono text-verde-700 hover:underline text-left leading-tight"
        >
          {entry.recipeCode}
        </button>
        <div className="text-gray-500 truncate max-w-[200px]" title={entry.recipeName}>
          {entry.recipeName.replace(entry.recipeCode + " - ", "").replace(/\s*\[.*?\]\s*$/, "")}
        </div>
      </td>
      <td className="px-2 py-1.5 text-gray-600 max-w-[160px] truncate" title={entry.subRecipe}>
        {entry.subRecipe}
      </td>
      <td className="px-2 py-1.5 text-right font-semibold">{entry.plannedMeals.toLocaleString("de-DE")}</td>
      <td className="px-2 py-1.5 text-right text-gray-600">{entry.stagingKg.toLocaleString("de-DE", { maximumFractionDigits: 1 })}</td>
      <td className="px-2 py-1.5 text-right text-gray-600">{entry.kitchenKg.toLocaleString("de-DE", { maximumFractionDigits: 1 })}</td>
      <td className={`px-2 py-1.5 text-right font-mono ${yieldColor(entry.yieldPct)}`}>
        {entry.yieldPct > 0 ? `${entry.yieldPct.toFixed(1)}%` : "—"}
      </td>
    </tr>
  );
}

function DayGroup({ day, entries, onRecipeClick }: { day: string; entries: WorkOrderEntry[]; onRecipeClick?: (code: string) => void }) {
  const totalMeals = entries.reduce((s, e) => s + e.plannedMeals, 0);
  const uniqueWOs = new Set(entries.map(e => e.workOrder)).size;
  const uniqueRecipes = new Set(entries.map(e => e.recipeCode)).size;

  return (
    <>
      <tr className="bg-slate-100 border-t-2 border-slate-300">
        <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold text-slate-700">
          {day}
          <span className="ml-3 font-normal text-slate-500">
            {uniqueRecipes} Rezepte · {uniqueWOs} WOs · {totalMeals.toLocaleString("de-DE")} Portionen
          </span>
        </td>
      </tr>
      {entries.map((e, i) => (
        <WORow key={`${e.workOrder}-${i}`} entry={e} onRecipeClick={onRecipeClick} />
      ))}
    </>
  );
}

export function PackingScheduleView({ plan, onRecipeClick }: Props) {
  const byDay = new Map<string, WorkOrderEntry[]>();
  for (const row of plan.rows) {
    const key = row.kitchenDay || "Unbekannt";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(row);
  }
  const days = [...byDay.keys()].sort();

  const totalMeals  = plan.rows.reduce((s, e) => s + e.plannedMeals, 0);
  const uniqueWOs   = new Set(plan.rows.map(e => e.workOrder)).size;

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Produktionsplan (Fertigstellungszeitplan)</h2>
          <p className="text-xs text-gray-500">
            {plan.week} · Stand {new Date(plan.generatedAt).toLocaleString("de-DE")} ·{" "}
            {uniqueWOs} Work Orders · {totalMeals.toLocaleString("de-DE")} Portionen geplant
          </p>
        </div>
      </div>

      {plan.rows.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Keine Work-Order-Daten gefunden. Tab-Struktur prüfen oder <code>npm run import:gsheet</code> erneut ausführen.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-gray-700">
              <tr>
                <th className="px-2 py-2 text-left font-medium text-xs">Küchentag</th>
                <th className="px-2 py-2 text-left font-medium text-xs">WO</th>
                <th className="px-2 py-2 text-left font-medium text-xs">Rezept</th>
                <th className="px-2 py-2 text-left font-medium text-xs">Sub-Rezept</th>
                <th className="px-2 py-2 text-right font-medium text-xs">Portionen</th>
                <th className="px-2 py-2 text-right font-medium text-xs">Staging kg</th>
                <th className="px-2 py-2 text-right font-medium text-xs">Küche kg</th>
                <th className="px-2 py-2 text-right font-medium text-xs">Yield</th>
              </tr>
            </thead>
            <tbody>
              {days.map(day => (
                <DayGroup
                  key={day}
                  day={day}
                  entries={byDay.get(day)!}
                  onRecipeClick={onRecipeClick}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
