import type { MealCatalogEntry } from "../../core/types";
import { label, metric, titleOf, subtitleOf, tagsOf, field } from "./catalog-utils";

interface CompareViewProps {
  meals: MealCatalogEntry[];
  onClose: () => void;
  onRemove: (id: string) => void;
}

const NUTRITION_ROWS = [
  { key: "MEAL WEIGHT (g)", label: "Gewicht", unit: "g" },
  { key: "CALORIES", label: "Kalorien", unit: "kcal" },
  { key: "PROTEIN (g)", label: "Protein", unit: "g" },
  { key: "CARBS (g)", label: "Kohlenhydrate", unit: "g" },
  { key: "FAT (g)", label: "Fett", unit: "g" },
  { key: "FIBER (g)", label: "Ballaststoffe", unit: "g" },
  { key: "SUGAR (g)", label: "Zucker", unit: "g" },
  { key: "SALT (g)", label: "Salz", unit: "g" },
];

const INFO_ROWS = [
  { sheet: "Meal DB_Culinary", key: "CUISINE", label: "Küche" },
  { sheet: "Meal DB_Culinary", key: "PROTEIN TYPE", label: "Protein-Typ" },
  { sheet: "Meal DB_Culinary", key: "MEAL TYPE", label: "Meal-Typ" },
  { sheet: "Meal DB_Culinary", key: "FORMAT", label: "Format" },
  { sheet: "Meal DB_Culinary", key: "BASE", label: "Basis" },
  { sheet: "Meal DB_Culinary", key: "SIDE 1", label: "Beilage 1" },
  { sheet: "Meal DB_Culinary", key: "SIDE 2", label: "Beilage 2" },
];

export function CompareView({ meals, onClose, onRemove }: CompareViewProps) {
  if (meals.length === 0) return null;

  return (
    <div className="border border-slate-200 bg-white shadow-lg">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3">
        <h3 className="text-sm font-bold text-slate-800">Vergleich ({meals.length} Meals)</h3>
        <button type="button" className="btn text-xs" onClick={onClose}>Schliessen</button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-2 text-left text-[11px] font-bold uppercase text-slate-500 w-36"></th>
              {meals.map(meal => (
                <th key={meal.mealId} className="px-4 py-2 text-left min-w-[12rem]">
                  <div className="font-semibold text-slate-900">{titleOf(meal)}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">{meal.mealId}</div>
                  {subtitleOf(meal) && <div className="mt-0.5 text-[11px] text-slate-500">{subtitleOf(meal)}</div>}
                  <button type="button" onClick={() => onRemove(meal.mealId)} className="mt-1 text-[10px] text-red-500 hover:text-red-700">Entfernen</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100 bg-cyan-50/50">
              <td className="px-4 py-1.5 text-[11px] font-bold uppercase text-slate-500">Tags</td>
              {meals.map(meal => (
                <td key={meal.mealId} className="px-4 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {tagsOf(meal).map(t => <span key={t} className="border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-800">{label(t)}</span>)}
                    {tagsOf(meal).length === 0 && <span className="text-slate-400">–</span>}
                  </div>
                </td>
              ))}
            </tr>

            {NUTRITION_ROWS.map(row => (
              <tr key={row.key} className="border-b border-slate-100">
                <td className="px-4 py-1.5 text-[11px] font-bold uppercase text-slate-500">{row.label}</td>
                {meals.map(meal => {
                  const val = metric(meal, row.key);
                  return <td key={meal.mealId} className="px-4 py-1.5 font-mono text-slate-800">{val ? `${val} ${row.unit}` : "–"}</td>;
                })}
              </tr>
            ))}

            <tr className="border-b border-slate-200 bg-slate-50">
              <td colSpan={meals.length + 1} className="px-4 py-1.5 text-[11px] font-bold uppercase text-slate-500">Küchenprofil</td>
            </tr>

            {INFO_ROWS.map(row => (
              <tr key={row.key} className="border-b border-slate-100">
                <td className="px-4 py-1.5 text-[11px] font-bold uppercase text-slate-500">{row.label}</td>
                {meals.map(meal => (
                  <td key={meal.mealId} className="px-4 py-1.5 text-slate-800">{field(meal, row.sheet, row.key) || "–"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
