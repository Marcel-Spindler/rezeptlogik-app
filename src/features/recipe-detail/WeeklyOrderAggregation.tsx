import { useMemo, useState } from "react";
import type { DataBundle, Market } from "../../core/types";
import {
  adjustedPortions, fmtNum, isProducedInVerden, MARKETS, MARKET_LABEL,
  resolveRecipeByCode, scaleQty,
} from "../../lib/helpers";
import { exportWeeklyOrderXlsx, type WeeklyOrderRow } from "./weeklyOrderExport";

interface Props {
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
}

type MarketFilter = Market | "ALL";
const DISPLAY_LIMIT = 100;

export function WeeklyOrderAggregation({ data, selectedWeek, upliftPercent }: Props) {
  const [market, setMarket] = useState<MarketFilter>("ALL");
  const [sortBy, setSortBy] = useState<"qty" | "name" | "category">("qty");
  const [downloading, setDownloading] = useState(false);

  const weekRecipes = useMemo(() => {
    const seen = new Set<string>();
    return data.weekRecipes
      .filter(r => r.hfWeek === selectedWeek && isProducedInVerden(r))
      .filter(r => (seen.has(r.code) ? false : (seen.add(r.code), true)));
  }, [data.weekRecipes, selectedWeek]);

  // Volle Per-Markt-Aggregation über alle Rezepte der Woche. Portionen kommen
  // pro Markt aus wr.verdenVolume[markt]; die Brutto-Zeilen aus dem passenden
  // Markt-Export (Fallback: erster Markt mit Daten, da Rezepte meist identisch).
  const allAggregated = useMemo(() => {
    const map = new Map<string, WeeklyOrderRow>();

    for (const wr of weekRecipes) {
      const recipe = resolveRecipeByCode(data.recipes, wr.code);
      if (!recipe) continue;

      const marketsWithGross = MARKETS.filter(m => (recipe.grossIngredients[m]?.length ?? 0) > 0);
      if (marketsWithGross.length === 0) continue;
      const fallbackList = recipe.grossIngredients[marketsWithGross[0]] ?? [];

      for (const m of MARKETS) {
        const portions = adjustedPortions(wr.verdenVolume[m] ?? 0, upliftPercent);
        if (portions <= 0) continue;
        const grossList = recipe.grossIngredients[m]?.length ? recipe.grossIngredients[m]! : fallbackList;

        for (const g of grossList) {
          const key = `${g.ingredientId}::${g.uom}`;
          let entry = map.get(key);
          if (!entry) {
            entry = {
              ingredientId: g.ingredientId,
              name: g.ingredient,
              category: g.ingredientCategory ?? "",
              uom: g.uom,
              perMarket: { BENL: 0, DKSE: 0, DE: 0 },
              totalQty: 0,
              recipeCount: 0,
              recipes: [],
            };
            map.set(key, entry);
          }
          entry.perMarket[m] += g.grossQuantityPerPortion * portions;
          if (!entry.recipes.includes(wr.code)) {
            entry.recipes.push(wr.code);
            entry.recipeCount++;
          }
        }
      }
    }

    return [...map.values()];
  }, [weekRecipes, data.recipes, upliftPercent]);

  // Markt-Filter + Sortierung: totalQty = Summe der gewählten Märkte.
  const aggregated = useMemo(() => {
    const scope: Market[] = market === "ALL" ? MARKETS : [market];
    const rows = allAggregated
      .map(a => ({ ...a, totalQty: scope.reduce((s, m) => s + a.perMarket[m], 0) }))
      .filter(a => a.totalQty > 0);

    if (sortBy === "qty") rows.sort((a, b) => b.totalQty - a.totalQty);
    else if (sortBy === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    else rows.sort((a, b) => a.category.localeCompare(b.category) || b.totalQty - a.totalQty);
    return rows;
  }, [allAggregated, market, sortBy]);

  const totalKg = aggregated.filter(a => a.uom.toLowerCase().includes("gram")).reduce((s, a) => s + a.totalQty / 1000, 0);
  const uniqueIngredients = aggregated.length;
  const categories = [...new Set(aggregated.map(a => a.category).filter(Boolean))];
  const showSplit = market === "ALL";

  async function handleDownload() {
    if (downloading || aggregated.length === 0) return;
    setDownloading(true);
    try {
      await exportWeeklyOrderXlsx(aggregated, {
        week: selectedWeek,
        marketFilter: market,
        upliftPercent,
        recipeCount: weekRecipes.length,
        generatedAt: data.generatedAt,
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="card p-4 border border-teal-200 bg-gradient-to-r from-teal-50 via-white to-emerald-50">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Wochenbestellung — {selectedWeek}</h3>
          <div className="text-xs text-slate-500">
            Aggregierte Brutto-Zutaten ueber alle {weekRecipes.length} Rezepte · {market === "ALL" ? "Alle Märkte (Summe)" : MARKET_LABEL[market]}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={market} onChange={e => setMarket(e.target.value as MarketFilter)}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1 text-xs">
            <option value="ALL">Alle Märkte (Summe)</option>
            {MARKETS.map(m => <option key={m} value={m}>{MARKET_LABEL[m]}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1 text-xs">
            <option value="qty">Nach Menge</option>
            <option value="name">Nach Name</option>
            <option value="category">Nach Kategorie</option>
          </select>
          <button
            className="btn text-xs bg-emerald-600 text-white ring-emerald-700 disabled:opacity-50"
            onClick={handleDownload}
            disabled={downloading || aggregated.length === 0}
          >
            {downloading ? "Erzeuge Excel …" : "⬇ Als Excel (volle Summe)"}
          </button>
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
              {showSplit && <th className="text-right py-2 pr-2">BENL</th>}
              {showSplit && <th className="text-right py-2 pr-2">DK/SE</th>}
              {showSplit && <th className="text-right py-2 pr-2">DE</th>}
              <th className="text-right py-2 pr-2">Menge gesamt</th>
              <th className="text-right py-2 pr-3">In # Rezepten</th>
            </tr>
          </thead>
          <tbody>
            {aggregated.slice(0, DISPLAY_LIMIT).map((a, i) => (
              <tr key={`${a.ingredientId}-${a.uom}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/80">
                <td className="py-1.5 pl-3 pr-2">
                  <div className="font-medium text-slate-800">{a.name}</div>
                  <div className="font-mono text-[10px] text-slate-400">{a.ingredientId || "ohne SKU"}</div>
                </td>
                <td className="py-1.5 pr-2"><span className="pill bg-slate-100 text-slate-700 text-[10px]">{a.category || "-"}</span></td>
                {showSplit && <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">{a.perMarket.BENL > 0 ? scaleQty(a.perMarket.BENL, 1, a.uom) : "–"}</td>}
                {showSplit && <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">{a.perMarket.DKSE > 0 ? scaleQty(a.perMarket.DKSE, 1, a.uom) : "–"}</td>}
                {showSplit && <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">{a.perMarket.DE > 0 ? scaleQty(a.perMarket.DE, 1, a.uom) : "–"}</td>}
                <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{scaleQty(a.totalQty, 1, a.uom)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{a.recipeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {aggregated.length > DISPLAY_LIMIT && (
          <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
            +{aggregated.length - DISPLAY_LIMIT} weitere Zutaten (Top {DISPLAY_LIMIT} angezeigt) — der Excel-Download enthält alle {aggregated.length}.
          </div>
        )}
      </div>
    </div>
  );
}
