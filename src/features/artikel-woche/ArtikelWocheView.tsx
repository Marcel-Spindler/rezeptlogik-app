import { useMemo, useState } from "react";
import type { DataBundle, Market, Recipe } from "../../core/types";

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

interface TagAggRow extends AggRow {
  submeal: string;
  station: "Braiser" | "Andere";
}

type SortKey = "kg" | "name" | "cat";
type ViewMode = "uebersicht" | "tagessplit";
type StationFilter = "all" | "braiser" | "andere";

const MARKETS: Market[] = ["DE", "BENL", "DKSE"];
const MARKET_LABELS: Record<Market, string> = { DE: "DE", BENL: "BENL", DKSE: "DKSE" };

const DAYS = ["Mo", "Di", "Mi", "Do", "Fr"] as const;
type Day = typeof DAYS[number];

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

function detectStation(subRecipeName: string | undefined, recipe: Recipe, market: Market): "Braiser" | "Andere" {
  if (!subRecipeName) return "Andere";
  const mDetails = recipe.markets[market] ?? recipe.markets["DE"] ?? recipe.markets["BENL"] ?? recipe.markets["DKSE"];
  if (!mDetails) return "Andere";
  const sub = mDetails.subRecipes.find(s => s.name === subRecipeName);
  if (!sub) return "Andere";
  const cat = (sub.category || "").toUpperCase();
  return cat.includes("BRAISER") ? "Braiser" : "Andere";
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

  // Tagessplit state
  const [viewMode, setViewMode] = useState<ViewMode>("uebersicht");
  const [stationFilter, setStationFilter] = useState<StationFilter>("all");
  const [dayVolumes, setDayVolumes] = useState<Record<Day, number>>({
    Mo: 22000, Di: 22000, Mi: 22000, Do: 15000, Fr: 0,
  });

  const upliftFactor = 1 + upliftPercent / 100;

  const weekRecs = useMemo(
    () => data.weekRecipes.filter(wr => wr.hfWeek === kw),
    [data.weekRecipes, kw],
  );

  const totalWeekPortions = useMemo(
    () => weekRecs.reduce((s, wr) => s + wr.totalVerdenVolume, 0),
    [weekRecs],
  );

  // Fr = Rest aus Gesamtvolumen, außer der User überschreibt es manuell
  const frAuto = Math.max(0, totalWeekPortions - (dayVolumes.Mo + dayVolumes.Di + dayVolumes.Mi + dayVolumes.Do));
  const effectiveFr = dayVolumes.Fr > 0 ? dayVolumes.Fr : frAuto;
  const totalDayPortions = dayVolumes.Mo + dayVolumes.Di + dayVolumes.Mi + dayVolumes.Do + effectiveFr;

  function dayKg(totalKg: number, day: Day): number {
    if (totalDayPortions === 0) return 0;
    const vol = day === "Fr" ? effectiveFr : dayVolumes[day];
    return totalKg * vol / totalDayPortions;
  }

  const allPreferences = useMemo(() => {
    const prefs = new Set<string>();
    for (const wr of weekRecs) if (wr.preference) prefs.add(wr.preference);
    return [...prefs].sort();
  }, [weekRecs]);

  // ── Übersicht-Aggregation (unverändert, dedupliziert über Submeals) ──────────
  const allRows = useMemo(() => {
    const agg = new Map<string, AggRow>();

    for (const wr of weekRecs) {
      if (prefFilter.size > 0 && !prefFilter.has(wr.preference)) continue;

      const recipe = data.recipes[wr.code];
      if (!recipe) continue;

      const marktsToUse = marketFilter === "all" ? MARKETS : [marketFilter as Market];
      for (const m of marktsToUse) {
        const volume = wr.verdenVolume[m] ?? 0;
        if (volume === 0) continue;

        const grossIngs =
          recipe.grossIngredients[m] ??
          recipe.grossIngredients["DE"] ??
          recipe.grossIngredients["BENL"] ??
          recipe.grossIngredients["DKSE"] ??
          [];

        const seenInRecipeMarket = new Map<string, number>();
        for (const ing of grossIngs) {
          const key = ing.ingredientId || ing.ingredient;
          seenInRecipeMarket.set(key, (seenInRecipeMarket.get(key) ?? 0) + ing.grossQuantityPerPortion);
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

        for (const [key, qtyPerPortion] of seenInRecipeMarket) {
          const row = agg.get(key)!;
          row.totalKg += (volume * upliftFactor * qtyPerPortion) / 1000;
          row.recipes.add(wr.code);
        }
      }
    }

    return [...agg.values()];
  }, [weekRecs, marketFilter, prefFilter, data.recipes, upliftFactor]);

  // ── Tagessplit-Aggregation (behält Submeal-Granularität) ─────────────────────
  const tagAllRows = useMemo(() => {
    const agg = new Map<string, TagAggRow>();

    for (const wr of weekRecs) {
      if (prefFilter.size > 0 && !prefFilter.has(wr.preference)) continue;

      const recipe = data.recipes[wr.code];
      if (!recipe) continue;

      const marktsToUse = marketFilter === "all" ? MARKETS : [marketFilter as Market];
      for (const m of marktsToUse) {
        const volume = wr.verdenVolume[m] ?? 0;
        if (volume === 0) continue;

        const grossIngs =
          recipe.grossIngredients[m] ??
          recipe.grossIngredients["DE"] ??
          recipe.grossIngredients["BENL"] ??
          recipe.grossIngredients["DKSE"] ??
          [];

        // Key = ingredientId|subRecipe1 → gleicher Artikel in anderem Submeal = eigene Zeile
        const seenInRecipeMarket = new Map<string, number>();
        for (const ing of grossIngs) {
          const ingKey = ing.ingredientId || ing.ingredient;
          const submeal = ing.subRecipe1 || "—";
          const rowKey = `${ingKey}|${submeal}`;

          seenInRecipeMarket.set(rowKey, (seenInRecipeMarket.get(rowKey) ?? 0) + ing.grossQuantityPerPortion);

          if (!agg.has(rowKey)) {
            const station = detectStation(ing.subRecipe1, recipe, m);
            agg.set(rowKey, {
              key: rowKey,
              name: ing.ingredient,
              id: ing.ingredientId ?? "",
              cat: ing.ingredientCategory ?? "",
              uom: ing.uom,
              submeal,
              station,
              totalKg: 0,
              recipes: new Set<string>(),
            });
          }
        }

        for (const [rowKey, qty] of seenInRecipeMarket) {
          const row = agg.get(rowKey)!;
          row.totalKg += (volume * upliftFactor * qty) / 1000;
          row.recipes.add(wr.code);
        }
      }
    }

    return [...agg.values()];
  }, [weekRecs, marketFilter, prefFilter, data.recipes, upliftFactor]);

  const allCats = useMemo(() => {
    const src = viewMode === "tagessplit" ? tagAllRows : allRows;
    const cats = new Set<string>();
    for (const r of src) if (r.cat) cats.add(r.cat.toUpperCase());
    return [...cats].sort();
  }, [allRows, tagAllRows, viewMode]);

  // ── Übersicht: gefiltert + sortiert ─────────────────────────────────────────
  const rows = useMemo(() => {
    let list = allRows;

    if (catFilter.size > 0) list = list.filter(r => catFilter.has(r.cat.toUpperCase()));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      list = list.filter(r =>
        r.name.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle),
      );
    }
    if (minKg > 0) list = list.filter(r => r.totalKg >= minKg);

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "kg") cmp = a.totalKg - b.totalKg;
      else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "cat") cmp = a.cat.localeCompare(b.cat) || b.totalKg - a.totalKg;
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [allRows, catFilter, search, minKg, sortKey, sortAsc]);

  // ── Tagessplit: gefiltert + sortiert ────────────────────────────────────────
  const tagRows = useMemo(() => {
    let list = tagAllRows;

    if (stationFilter === "braiser") list = list.filter(r => r.station === "Braiser");
    else if (stationFilter === "andere") list = list.filter(r => r.station === "Andere");

    if (catFilter.size > 0) list = list.filter(r => catFilter.has(r.cat.toUpperCase()));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      list = list.filter(r =>
        r.name.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle),
      );
    }
    if (minKg > 0) list = list.filter(r => r.totalKg >= minKg);

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "kg") cmp = a.totalKg - b.totalKg;
      else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "cat") cmp = a.cat.localeCompare(b.cat) || b.totalKg - a.totalKg;
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [tagAllRows, stationFilter, catFilter, search, minKg, sortKey, sortAsc]);

  const totalKg = useMemo(() => rows.reduce((s, r) => s + r.totalKg, 0), [rows]);
  const tagTotalKg = useMemo(() => tagRows.reduce((s, r) => s + r.totalKg, 0), [tagRows]);

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

  function setDay(day: Day, val: string) {
    const n = parseInt(val.replace(/\D/g, ""), 10);
    setDayVolumes(prev => ({ ...prev, [day]: isNaN(n) ? 0 : n }));
  }

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  const activeCount = viewMode === "tagessplit" ? tagRows.length : rows.length;
  const activeTotalKg = viewMode === "tagessplit" ? tagTotalKg : totalKg;

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Ansicht</label>
          <div className="flex gap-1">
            {(["uebersicht", "tagessplit"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                  viewMode === mode
                    ? "bg-verden-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {mode === "uebersicht" ? "Übersicht" : "Tagessplit"}
              </button>
            ))}
          </div>
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
          <div className="text-xs text-slate-500">
            {activeCount} {viewMode === "tagessplit" ? "Positionen" : "Artikel"} · {weekRecs.length} Rezepte
          </div>
          <div className="text-lg font-semibold text-slate-800">{formatKg(activeTotalKg)} gesamt</div>
          {upliftPercent > 0 && (
            <div className="text-xs text-amber-600">inkl. {upliftPercent}% Uplift</div>
          )}
          {viewMode === "tagessplit" && totalWeekPortions > 0 && (
            <div className="text-xs text-slate-400">{totalWeekPortions.toLocaleString("de")} Portionen/Woche</div>
          )}
        </div>
      </div>

      {/* ── Tagessplit: Tagesvolumen-Eingabe ── */}
      {viewMode === "tagessplit" && (
        <div className="card p-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Tagesverteilung (Portionen)</div>
              <div className="flex gap-2 flex-wrap">
                {(["Mo", "Di", "Mi", "Do"] as const).map(day => (
                  <div key={day} className="flex flex-col items-center gap-1">
                    <label className="text-xs text-slate-500 font-medium">{day}</label>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={dayVolumes[day]}
                      onChange={e => setDay(day, e.target.value)}
                      className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-verden-500"
                    />
                  </div>
                ))}
                <div className="flex flex-col items-center gap-1">
                  <label className="text-xs text-slate-500 font-medium">Fr (Rest)</label>
                  <div className="w-24 border border-slate-100 rounded-lg px-2 py-1.5 text-sm text-center bg-slate-50 text-slate-600 tabular-nums">
                    {effectiveFr > 0
                      ? effectiveFr.toLocaleString("de")
                      : <span className="text-slate-300">—</span>
                    }
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Station</div>
              <div className="flex gap-1">
                {([["all", "Alle"], ["braiser", "Braiser"], ["andere", "Andere"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setStationFilter(val as StationFilter)}
                    className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                      stationFilter === val
                        ? val === "braiser"
                          ? "bg-orange-500 text-white"
                          : "bg-verden-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {totalWeekPortions > 0 && (dayVolumes.Mo + dayVolumes.Di + dayVolumes.Mi + dayVolumes.Do) > totalWeekPortions && (
              <div className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg">
                Mo–Do ({(dayVolumes.Mo + dayVolumes.Di + dayVolumes.Mi + dayVolumes.Do).toLocaleString("de")}) &gt; Wochenvolumen ({totalWeekPortions.toLocaleString("de")}) — Fr = 0
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Filter-Leiste ── */}
      <div className="card p-3 space-y-2">
        <input
          type="search"
          placeholder="Artikel suchen…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-verden-500"
        />

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

      {/* ── Übersicht-Tabelle ── */}
      {viewMode === "uebersicht" && (
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
      )}

      {/* ── Tagessplit-Tabelle ── */}
      {viewMode === "tagessplit" && (
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
                  <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">SKU</th>
                  <th
                    className="text-left px-3 py-2 text-xs font-medium text-slate-500 cursor-pointer hover:text-slate-800 select-none"
                    onClick={() => toggleSort("cat")}
                  >
                    Kat{sortIcon("cat")}
                  </th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Submeal</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Station</th>
                  {DAYS.map(d => (
                    <th key={d} className="text-right px-2 py-2 text-xs font-medium text-slate-500 whitespace-nowrap">
                      {d}
                      <span className="block text-slate-400 font-normal">
                        {d === "Fr"
                          ? formatKg(effectiveFr)
                          : formatKg(dayVolumes[d])}
                      </span>
                    </th>
                  ))}
                  <th
                    className="text-right px-3 py-2 text-xs font-medium text-slate-500 cursor-pointer hover:text-slate-800 select-none"
                    onClick={() => toggleSort("kg")}
                  >
                    Gesamt{sortIcon("kg")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tagRows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-slate-400 text-sm">
                      Keine Positionen gefunden — Filter anpassen oder andere KW wählen.
                    </td>
                  </tr>
                )}
                {tagRows.map((row, i) => (
                  <tr
                    key={row.key}
                    className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${
                      row.station === "Braiser" ? "bg-orange-50/30" : ""
                    }`}
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
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[180px] truncate" title={row.submeal}>
                      {row.submeal}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${
                        row.station === "Braiser"
                          ? "bg-orange-100 text-orange-700"
                          : "bg-slate-100 text-slate-600"
                      }`}>
                        {row.station}
                      </span>
                    </td>
                    {DAYS.map(d => (
                      <td key={d} className="px-2 py-2 text-right text-xs text-slate-700 tabular-nums">
                        {formatKg(dayKg(row.totalKg, d))}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-medium text-slate-800 tabular-nums">
                      {formatKg(row.totalKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {tagRows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td colSpan={6} className="px-3 py-2 text-xs text-slate-500 font-medium">
                      Gesamt ({tagRows.length} Positionen)
                    </td>
                    {DAYS.map(d => (
                      <td key={d} className="px-2 py-2 text-right text-xs font-semibold text-slate-700 tabular-nums">
                        {formatKg(tagRows.reduce((s, r) => s + dayKg(r.totalKg, d), 0))}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums">
                      {formatKg(tagTotalKg)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
