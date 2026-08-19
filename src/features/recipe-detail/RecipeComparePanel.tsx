import { useMemo, useState } from "react";
import type { Market, Recipe, WeekRecipe } from "../../core/types";
import { adjustedPortions, fmtNum, MARKETS, MARKET_LABEL, resolveRecipeByCode } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";

interface Props {
  currentWr: WeekRecipe;
  currentRecipe: Recipe | undefined;
  allRecipes: WeekRecipe[];
  recipesByCode: Record<string, Recipe>;
  upliftPercent: number;
  market: Market;
  onClose: () => void;
}

function DiffRow({ label, left, right }: { label: string; left: string; right: string }) {
  const isDiff = left !== right;
  return (
    <tr className={`border-b border-slate-100 ${isDiff ? "bg-amber-50" : ""}`}>
      <td className="py-1.5 pr-2 text-xs font-medium text-slate-600">{label}</td>
      <td className="py-1.5 pr-2 text-xs tabular-nums">{left}</td>
      <td className="py-1.5 text-xs tabular-nums">{right}</td>
    </tr>
  );
}

function IngredientDiff({ left, right, market }: { left: Recipe; right: Recipe; market: Market }) {
  const leftIngs = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; uom: string }>();
    for (const g of left.grossIngredients[market] ?? []) {
      const existing = map.get(g.ingredientId);
      if (existing) existing.qty += g.grossQuantityPerPortion;
      else map.set(g.ingredientId, { name: g.ingredient, qty: g.grossQuantityPerPortion, uom: g.uom });
    }
    return map;
  }, [left, market]);

  const rightIngs = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; uom: string }>();
    for (const g of right.grossIngredients[market] ?? []) {
      const existing = map.get(g.ingredientId);
      if (existing) existing.qty += g.grossQuantityPerPortion;
      else map.set(g.ingredientId, { name: g.ingredient, qty: g.grossQuantityPerPortion, uom: g.uom });
    }
    return map;
  }, [right, market]);

  const allIds = [...new Set([...leftIngs.keys(), ...rightIngs.keys()])].sort();

  const added = allIds.filter(id => !leftIngs.has(id));
  const removed = allIds.filter(id => !rightIngs.has(id));
  const changed = allIds.filter(id => leftIngs.has(id) && rightIngs.has(id) && leftIngs.get(id)!.qty !== rightIngs.get(id)!.qty);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return <div className="text-xs text-slate-500">Brutto-Zutaten identisch.</div>;
  }

  return (
    <div className="space-y-2">
      {added.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Neu im Vergleichsrezept</div>
          {added.map(id => {
            const ing = rightIngs.get(id)!;
            return <div key={id} className="text-xs text-emerald-800">+ {ing.name} ({fmtNum(ing.qty, 2)} {ing.uom})</div>;
          })}
        </div>
      )}
      {removed.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-rose-700">Nicht mehr enthalten</div>
          {removed.map(id => {
            const ing = leftIngs.get(id)!;
            return <div key={id} className="text-xs text-rose-800">- {ing.name} ({fmtNum(ing.qty, 2)} {ing.uom})</div>;
          })}
        </div>
      )}
      {changed.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Mengen geändert</div>
          {changed.map(id => {
            const l = leftIngs.get(id)!;
            const r = rightIngs.get(id)!;
            const delta = r.qty - l.qty;
            return (
              <div key={id} className="text-xs text-amber-800">
                {l.name}: {fmtNum(l.qty, 2)} {"→"} {fmtNum(r.qty, 2)} {l.uom} ({delta > 0 ? "+" : ""}{fmtNum(delta, 2)})
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RecipeComparePanel({ currentWr, currentRecipe, allRecipes, recipesByCode, upliftPercent, market, onClose }: Props) {
  const [compareCode, setCompareCode] = useState<string>("");

  const compareWr = allRecipes.find(r => r.code === compareCode);
  const compareRecipe = compareCode ? resolveRecipeByCode(recipesByCode, compareCode) : undefined;

  const currentPortions = adjustedPortions(getBaseVerdenVolume(currentWr), upliftPercent);
  const comparePortions = compareWr ? adjustedPortions(getBaseVerdenVolume(compareWr), upliftPercent) : 0;

  return (
    <div className="card p-4 border border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Rezeptvergleich</h3>
        <button onClick={onClose} className="btn text-xs">Schließen</button>
      </div>

      <div className="mb-3">
        <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Vergleichen mit:</label>
        <select
          value={compareCode}
          onChange={e => setCompareCode(e.target.value)}
          className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">Rezept wählen …</option>
          {allRecipes.filter(r => r.code !== currentWr.code).map(r => (
            <option key={r.code} value={r.code}>{r.code} - {recipesByCode[r.code]?.baseName ?? r.recipeName}</option>
          ))}
        </select>
      </div>

      {compareWr && (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-1 text-xs text-slate-500 w-32" />
                <th className="text-left py-1 text-xs text-slate-500">{currentWr.code}</th>
                <th className="text-left py-1 text-xs text-slate-500">{compareWr.code}</th>
              </tr>
            </thead>
            <tbody>
              <DiffRow label="Name" left={currentRecipe?.baseName ?? currentWr.recipeName} right={compareRecipe?.baseName ?? compareWr.recipeName} />
              <DiffRow label="Portionen" left={fmtNum(currentPortions)} right={fmtNum(comparePortions)} />
              <DiffRow label="Preference" left={currentWr.preference} right={compareWr.preference} />
              {MARKETS.map(m => (
                <DiffRow key={m} label={MARKET_LABEL[m]} left={fmtNum(currentWr.verdenVolume[m])} right={fmtNum(compareWr.verdenVolume[m])} />
              ))}
              <DiffRow
                label="Allergene"
                left={currentRecipe?.markets[market]?.allergens ?? "-"}
                right={compareRecipe?.markets[market]?.allergens ?? "-"}
              />
              <DiffRow
                label="Sub-Rezepte"
                left={String(currentRecipe?.markets[market]?.subRecipes.length ?? 0)}
                right={String(compareRecipe?.markets[market]?.subRecipes.length ?? 0)}
              />
            </tbody>
          </table>

          {currentRecipe && compareRecipe && (
            <div className="rounded-xl bg-white ring-1 ring-slate-200 p-3">
              <div className="text-xs font-semibold text-slate-700 mb-2">Zutaten-Diff ({MARKET_LABEL[market]})</div>
              <IngredientDiff left={currentRecipe} right={compareRecipe} market={market} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
