import { useMemo, useState } from "react";
import type { DataBundle, Market } from "../../core/types";
import { fmtNum, isProducedInVerden, MARKETS, MARKET_LABEL, scaleQty } from "../../lib/helpers";
import { adjustedPortions } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";

interface Props {
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
}

interface AggregatedIngredient {
  ingredientId: string;
  name: string;
  category: string;
  uom: string;
  totalQty: number;
  recipeCount: number;
  recipes: string[];
}

export function WeeklyOrderAggregation({ data, selectedWeek, upliftPercent }: Props) {
  const [market, setMarket] = useState<Market>("BENL");
  const [sortBy, setSortBy] = useState<"qty" | "name" | "category">("qty");

  const weekRecipes = useMemo(() => {
    const seen = new Set<string>();
    return data.weekRecipes
      .filter(r => r.hfWeek === selectedWeek && isProducedInVerden(r))
      .filter(r => (seen.has(r.code) ? false : (seen.add(r.code), true)));
  }, [data.weekRecipes, selectedWeek]);

  const aggregated = useMemo(() => {
    const map = new Map<string, AggregatedIngredient>();

    for (const wr of weekRecipes) {
      const recipe = data.recipes[wr.code];
      if (!recipe) continue;
      const portions = adjustedPortions(getBaseVerdenVolume(wr), upliftPercent);
      const grossList = recipe.grossIngredients[market] ?? [];

      for (const g of grossList) {
        const key = `${g.ingredientId}::${g.uom}`;
        const existing = map.get(key);
        const qty = g.grossQuantityPerPortion * portions;
        if (existing) {
          existing.totalQty += qty;
          existing.recipeCount++;
          if (!existing.recipes.includes(wr.code)) existing.recipes.push(wr.code);
        } else {
          map.set(key, {
            ingredientId: g.ingredientId,
            name: g.ingredient,
            category: g.ingredientCategory ?? "",
            uom: g.uom,
            totalQty: qty,
            recipeCount: 1,
            recipes: [wr.code],
          });
        }
      }
    }

    const result = [...map.values()];
    if (sortBy === "qty") result.sort((a, b) => b.totalQty - a.totalQty);
    else if (sortBy === "name") result.sort((a, b) => a.name.localeCompare(b.name));
    else result.sort((a, b) => a.category.localeCompare(b.category) || b.totalQty - a.totalQty);
    return result;
  }, [weekRecipes, data.recipes, market, upliftPercent, sortBy]);

  const totalKg = aggregated.filter(a => a.uom.toLowerCase().includes("gram")).reduce((s, a) => s + a.totalQty / 1000, 0);
  const uniqueIngredients = aggregated.length;
  const categories = [...new Set(aggregated.map(a => a.category).filter(Boolean))];

  return (
    <div className="card p-4 border border-teal-200 bg-gradient-to-r from-teal-50 via-white to-emerald-50">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Wochenbestellung — {selectedWeek}</h3>
          <div className="text-xs text-slate-500">Aggregierte Brutto-Zutaten ueber alle {weekRecipes.length} Rezepte</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={market} onChange={e => setMarket(e.target.value as Market)}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1 text-xs">
            {MARKETS.map(m => <option key={m} value={m}>{MARKET_LABEL[m]}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1 text-xs">
            <option value="qty">Nach Menge</option>
            <option value="name">Nach Name</option>
            <option value="category">Nach Kategorie</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Zutaten</div>
          <div className="text-lg font-bold tabular-nums">{fmtNum(uniqueIngredients)}</div>
        </div>
        <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Kategorien</div>
          <div className="text-lg font-bold tabular-nums">{fmtNum(categories.length)}</div>
        </div>
        <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Gesamt kg (Gramm-Zutaten)</div>
          <div className="text-lg font-bold tabular-nums">{fmtNum(totalKg, 0)}</div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500 bg-slate-50">
            <tr>
              <th className="text-left py-2 pl-3 pr-2">Zutat</th>
              <th className="text-left py-2 pr-2">Kategorie</th>
              <th className="text-right py-2 pr-2">Menge gesamt</th>
              <th className="text-right py-2 pr-3">In # Rezepten</th>
            </tr>
          </thead>
          <tbody>
            {aggregated.slice(0, 100).map((a, i) => (
              <tr key={`${a.ingredientId}-${a.uom}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/80">
                <td className="py-1.5 pl-3 pr-2">
                  <div className="font-medium text-slate-800">{a.name}</div>
                  <div className="font-mono text-[10px] text-slate-400">{a.ingredientId || "ohne SKU"}</div>
                </td>
                <td className="py-1.5 pr-2"><span className="pill bg-slate-100 text-slate-700 text-[10px]">{a.category || "-"}</span></td>
                <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{scaleQty(a.totalQty, 1, a.uom)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{a.recipeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {aggregated.length > 100 && (
          <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
            +{aggregated.length - 100} weitere Zutaten (Top 100 angezeigt)
          </div>
        )}
      </div>
    </div>
  );
}
