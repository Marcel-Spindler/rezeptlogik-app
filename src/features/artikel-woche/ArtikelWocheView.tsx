import { useMemo, useState } from "react";
import type { DataBundle, Market } from "../../core/types";

interface Props {
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
}

interface AggRow {
  key: string;
  name: string;
  id: string;
  cat: string;
  uom: string;
  totalKg: number;
  recipes: Set<string>;
}

type SortKey = "kg" | "name" | "cat";

const MARKETS: Market[] = ["DE", "BENL", "DKSE"];

const MARKET_LABELS: Record<Market, string> = { DE: "DE", BENL: "BENL", DKSE: "DKSE" };

function formatKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  if (kg >= 10) return `${kg.toFixed(0)} kg`;
  return `${kg.toFixed(1)} kg`;
}

function catColor(cat: string): string {
  switch (cat.toUpperCase()) {
    case "PRO": return "bg-red-100 text-red-700";
    case "PHF": return "bg-orange-100 text-orange-700";
    case "SPI": return "bg-yellow-100 text-yellow-700";
    case "DRY": return "bg-amber-100 text-amber-700";
    case "DAI": return "bg-blue-100 text-blue-700";
    case "SUB": return "bg-purple-100 text-purple-700";
    case "PTN": return "bg-pink-100 text-pink-700";
    case "BEV": return "bg-cyan-100 text-cyan-700";
    case "SAU": return "bg-teal-100 text-teal-700";
    case "CON":
    case "PCK":
    case "LAB": return "bg-slate-100 text-slate-500";
    default: return "bg-slate-100 text-slate-600";
  }
}

export function ArtikelWocheView({ data, selectedWeek, upliftPercent }: Props) {
  const [kw, setKw] = useState(selectedWeek);
  const [marketFilter, setMarketFilter] = useState<"all" | Market>("all");
  const [catFilter, setCatFilter] = useState<Set<string>>(new Set());
  const [prefFilter, setPrefFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("kg");
  const [sortAsc, setSortAsc] = useState(false);
  const [minKg, setMinKg] = useState(0);

  const upliftFactor = 1 + upliftPercent / 100;

  // Alle Rezepte der gewählten KW
  const weekRecs = useMemo(
    () => data.weekRecipes.filter(wr => wr.hfWeek === kw),
    [data.weekRecipes, kw],
  );

  // Alle Preferences die in der KW vorkommen
  const allPreferences = useMemo(() => {
    const prefs = new Set<string>();
    for (const wr of weekRecs) if (wr.preference) prefs.add(wr.preference);
    return [...prefs].sort();
  }, [weekRecs]);

  // Aggregation
  const allRows = useMemo(() => {
    const agg = new Map<string, AggRow>();

    for (const wr of weekRecs) {
      if (prefFilter.size > 0 && !prefFilter.has(wr.preference)) continue;

      const recipe = data.recipes[wr.code];
      if (!recipe) continue;

      // Pro Markt einzeln — so sind die marktspezifischen Portionen korrekt
      const marktsToUse = marketFilter === "all" ? MARKETS : [marketFilter as Market];
      for (const m of marktsToUse) {
        const volume = wr.verdenVolume[m] ?? 0;
        if (volume === 0) continue;

        // Gross-Zutaten: nehme marktspezifisch, fallback auf anderen Markt
        const grossIngs =
          recipe.grossIngredients[m] ??
          recipe.grossIngredients["DE"] ??
          recipe.grossIngredients["BENL"] ??
          recipe.grossIngredients["DKSE"] ??
          [];

        // Dedupe pro Rezept+Markt: ein Artikel kann in mehreren Sub-Rezepten stehen
        const seenInRecipeMarket = new Map<string, number>();
        for (const ing of grossIngs) {
          const key = ing.ingredientId || ing.ingredient;
          seenInRecipeMarket.set(key, (seenInRecipeMarket.get(key) ?? 0) + ing.grossQuantityPerPortion);
          // letztes cat/uom gewinnt — realistisch immer gleich
          const row = agg.get(key) ?? {
            key,
            name: ing.ingredient,
            id: ing.ingredientId ?? "",
            cat: ing.ingredientCategory ?? "",
            uom: ing.uom,
            totalKg: 0,
            recipes: new Set<string>(),
          };
          agg.set(key, row);
        }

        // Jetzt kg aufaddieren
        for (const [key, qtyPerPortion] of seenInRecipeMarket) {
          const row = agg.get(key)!;
          row.totalKg += (volume * upliftFactor * qtyPerPortion) / 1000;
          row.recipes.add(wr.code);
        }
      }
    }

    return [...agg.values()];
  }, [weekRecs, marketFilter, prefFilter, data.recipes, upliftFactor]);

  // Alle Kategorien die in der Woche vorkommen
  const allCats = useMemo(() => {
    const cats = new Set<string>();
    for (const r of allRows) if (r.cat) cats.add(r.cat.toUpperCase());
    return [...cats].sort();
  }, [allRows]);

  // Gefiltert + sortiert
  const rows = useMemo(() => {
    let list = allRows;

    if (catFilter.size > 0) {
      list = list.filter(r => catFilter.has(r.cat.toUpperCase()));
    }
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      list = list.filter(r =>
        r.name.toLowerCase().includes(needle) ||
        r.id.toLowerCase().includes(needle),
      );
    }
    if (minKg > 0) {
      list = list.filter(r => r.totalKg >= minKg);
    }

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "kg") cmp = a.totalKg - b.totalKg;
      else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "cat") cmp = a.cat.localeCompare(b.cat) || b.totalKg - a.totalKg;
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [allRows, catFilter, search, minKg, sortKey, sortAsc]);

  const totalKg = useMemo(() => rows.reduce((s, r) => s + r.totalKg, 0), [rows]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(key === "name" || key === "cat"); }
  }

  function toggleCat(cat: string) {
    setCatFilter(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function togglePref(pref: string) {
    setPrefFilter(prev => {
      const next = new Set(prev);
      if (next.has(pref)) next.delete(pref);
      else next.add(pref);
      return next;
    });
  }

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="card p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Kalenderwoche</label>
          <select
            value={kw}
            onChange={e => setKw(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-verden-500"
          >
            {data.weeks.map(w => {
              const count = data.weekRecipes.filter(r => r.hfWeek === w).length;
              return (
                <option key={w} value={w}>
                  {w} ({count} Rezepte)
                </option>
              );
            })}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Markt</label>
          <div className="flex gap-1">
            {(["all", ...MARKETS] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMarketFilter(m)}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                  marketFilter === m
                    ? "bg-verden-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {m === "all" ? "Alle" : MARKET_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Min. kg</label>
          <select
            value={minKg}
            onChange={e => setMinKg(Number(e.target.value))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-verden-500"
          >
            {[0, 1, 5, 10, 50, 100, 500].map(v => (
              <option key={v} value={v}>{v === 0 ? "Alles" : `≥ ${v} kg`}</option>
            ))}
          </select>
        </div>

        <div className="ml-auto text-right">
          <div className="text-xs text-slate-500">{rows.length} Artikel · {weekRecs.length} Rezepte</div>
          <div className="text-lg font-semibold text-slate-800">{formatKg(totalKg)} gesamt</div>
          {upliftPercent > 0 && (
            <div className="text-xs text-amber-600">inkl. {upliftPercent}% Uplift</div>
          )}
        </div>
      </div>

      {/* Filter-Leiste */}
      <div className="card p-3 space-y-2">
        {/* Suche */}
        <input
          type="search"
          placeholder="Artikel suchen…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-verden-500"
        />

        {/* Kategorie-Chips */}
        {allCats.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 mr-1">Kategorie:</span>
            {allCats.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCat(cat)}
                className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                  catFilter.has(cat)
                    ? catColor(cat) + " ring-2 ring-offset-1 ring-current"
                    : catColor(cat) + " opacity-60 hover:opacity-100"
                }`}
              >
                {cat}
              </button>
            ))}
            {catFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setCatFilter(new Set())}
                className="px-2 py-0.5 text-xs rounded text-slate-400 hover:text-slate-600"
              >
                ✕ zurücksetzen
              </button>
            )}
          </div>
        )}

        {/* Preference-Chips */}
        {allPreferences.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-slate-400 mr-1">Preference:</span>
            {allPreferences.map(pref => (
              <button
                key={pref}
                type="button"
                onClick={() => togglePref(pref)}
                className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                  prefFilter.has(pref)
                    ? "bg-verden-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {pref}
              </button>
            ))}
            {prefFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setPrefFilter(new Set())}
                className="px-2 py-0.5 text-xs rounded text-slate-400 hover:text-slate-600"
              >
                ✕ zurücksetzen
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tabelle */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500 w-8">#</th>
                <th
                  className="text-left px-3 py-2 text-xs font-medium text-slate-500 cursor-pointer hover:text-slate-800 select-none"
                  onClick={() => toggleSort("name")}
                >
                  Artikel{sortIcon("name")}
                </th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">SKU / ID</th>
                <th
                  className="text-left px-3 py-2 text-xs font-medium text-slate-500 cursor-pointer hover:text-slate-800 select-none"
                  onClick={() => toggleSort("cat")}
                >
                  Kategorie{sortIcon("cat")}
                </th>
                <th
                  className="text-right px-3 py-2 text-xs font-medium text-slate-500 cursor-pointer hover:text-slate-800 select-none"
                  onClick={() => toggleSort("kg")}
                >
                  kg gesamt{sortIcon("kg")}
                </th>
                <th className="text-right px-3 py-2 text-xs font-medium text-slate-500"># Rezepte</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-slate-400 text-sm">
                    Keine Artikel gefunden — Filter anpassen oder andere KW wählen.
                  </td>
                </tr>
              )}
              {rows.map((row, i) => (
                <tr
                  key={row.key}
                  className="border-b border-slate-50 hover:bg-slate-50 transition-colors"
                >
                  <td className="px-3 py-2 text-xs text-slate-400">{i + 1}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">{row.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 font-mono">{row.id || "—"}</td>
                  <td className="px-3 py-2">
                    {row.cat ? (
                      <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${catColor(row.cat.toUpperCase())}`}>
                        {row.cat}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-slate-800 tabular-nums">
                    {formatKg(row.totalKg)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500 tabular-nums">
                    {row.recipes.size}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-slate-200 bg-slate-50">
                  <td colSpan={4} className="px-3 py-2 text-xs text-slate-500 font-medium">
                    Gesamt ({rows.length} Artikel)
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums">
                    {formatKg(totalKg)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
