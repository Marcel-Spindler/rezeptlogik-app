import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle, MealCatalogEntry } from "../../core/types";
import { buildWeekIndex, field, sortMeals, subtitleOf, tagsOf, titleOf, type CatalogScope, type SortKey } from "./catalog-utils";
import { CatalogBrowser } from "./CatalogBrowser";
import { CatalogDetail } from "./CatalogDetail";
import { CompareView } from "./CompareView";
import { exportCatalogXlsx } from "./catalog-export";
import { useFavorites } from "./useFavorites";
import { useImageOverrides } from "./useImageOverrides";

type Catalog = Record<string, MealCatalogEntry>;

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function readUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    meal: params.get("meal") ?? null,
    q: params.get("q") ?? "",
    tags: params.get("tags")?.split(",").filter(Boolean) ?? [],
    scope: (params.get("scope") as CatalogScope) ?? null,
    sort: (params.get("sort") as SortKey) ?? null,
    cup: params.get("cup") ?? "",
  };
}

export function MealCatalogView({
  catalog, data, selectedWeek, upliftPercent, onSelectWeek, onOpenRecipe, onOpenPlanning, onOpenWms,
}: {
  catalog: Catalog;
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
  onSelectWeek: (week: string) => void;
  onOpenRecipe: (code: string) => void;
  onOpenPlanning: (code: string) => void;
  onOpenWms: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [cupFilter, setCupFilter] = useState("");
  const [scope, setScope] = useState<CatalogScope>("week");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { toggle: toggleFavorite, isFavorite } = useFavorites();
  const { confirm: confirmImage, reject: rejectImage, reset: resetImage, getOverride: getImageOverride } = useImageOverrides();
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const initialized = useRef(false);

  // Read URL params on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = readUrlParams();
    if (url.q) setQuery(url.q);
    if (url.tags.length > 0) setActiveTags(url.tags);
    if (url.scope) setScope(url.scope);
    if (url.sort) setSortKey(url.sort);
    if (url.cup) setCupFilter(url.cup);
    if (url.meal) setSelectedId(url.meal);
  }, []);

  // Sync state to URL
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (selectedId) params.set("meal", selectedId);
    if (query) params.set("q", query);
    if (activeTags.length > 0) params.set("tags", activeTags.join(","));
    if (scope !== "week") params.set("scope", scope);
    if (sortKey !== "name") params.set("sort", sortKey);
    if (cupFilter) params.set("cup", cupFilter);
    const search = params.toString();
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [selectedId, query, activeTags, scope, sortKey, cupFilter]);

  const debouncedQuery = useDebounce(query, 200);

  const meals = useMemo(
    () => sortMeals(Object.values(catalog), sortKey),
    [catalog, sortKey],
  );

  const weekIndex = useMemo(() => buildWeekIndex(meals, data), [meals, data]);

  const weekMeals = useMemo(
    () => meals.filter(meal => weekIndex.get(meal.mealId)?.has(selectedWeek)),
    [meals, weekIndex, selectedWeek],
  );

  const futureWeeks = useMemo(() => {
    const selectedIndex = data.weeks.indexOf(selectedWeek);
    return selectedIndex >= 0 ? data.weeks.slice(selectedIndex) : data.weeks;
  }, [data.weeks, selectedWeek]);

  const futureMeals = useMemo(
    () => meals.filter(meal => {
      const weeks = weekIndex.get(meal.mealId);
      return weeks && futureWeeks.some(w => weeks.has(w));
    }),
    [meals, weekIndex, futureWeeks],
  );

  const scopedMeals = scope === "all" ? meals : scope === "future" ? futureMeals : weekMeals;

  const tags = useMemo(
    () => ["Alle", ...Array.from(new Set(scopedMeals.flatMap(tagsOf))).sort()],
    [scopedMeals],
  );

  const cups = useMemo(
    () => Array.from(new Set(scopedMeals.map(m => field(m, "Meal DB_Culinary", "Cup")).filter(Boolean))).sort(),
    [scopedMeals],
  );

  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return scopedMeals.filter(meal => {
      const text = `${meal.mealId} ${titleOf(meal)} ${subtitleOf(meal)} ${Object.values(meal.sheets?.["Meal DB_Culinary"] ?? {}).join(" ")}`.toLowerCase();
      if (needle && !text.includes(needle)) return false;
      if (activeTags.length > 0) {
        const mealTags = tagsOf(meal);
        if (!activeTags.every(t => mealTags.includes(t))) return false;
      }
      if (cupFilter && field(meal, "Meal DB_Culinary", "Cup") !== cupFilter) return false;
      return true;
    });
  }, [scopedMeals, debouncedQuery, activeTags, cupFilter]);

  // Sync selection with filtered list
  useEffect(() => {
    if (!selectedId || !filtered.some(m => m.mealId === selectedId)) {
      setSelectedId(filtered[0]?.mealId ?? null);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find(m => m.mealId === selectedId) ?? filtered[0] ?? null;
  const index = selected ? filtered.findIndex(m => m.mealId === selected.mealId) : -1;

  const selectRelative = useCallback((offset: number) => {
    if (index < 0 || filtered.length === 0) return;
    setSelectedId(filtered[(index + offset + filtered.length) % filtered.length].mealId);
  }, [index, filtered]);

  if (meals.length === 0) {
    return (
      <div className="card p-8 text-slate-500">
        Der Meal-Katalog ist noch nicht geladen. Führe <code>npm run import:meal-database</code> aus.
      </div>
    );
  }

  return (
    <div className="meal-catalog space-y-4">
      <header className="meal-catalog-header">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-800">Verden Meal Database</div>
          <h1 className="mt-1 text-2xl font-bold text-slate-950">Meal Katalog</h1>
          <p className="mt-1 text-sm text-slate-600">
            {scope === "all"
              ? `${meals.length} Meals im Gesamtkatalog`
              : scope === "future"
                ? `${futureMeals.length} Meals ab ${selectedWeek}`
                : `${weekMeals.length} produzierte Meals in ${selectedWeek}`}
            {" "}mit Produktdaten, Nährwerten, Küchenprofil und Markttexten.
          </p>
        </div>
        <div className="flex items-end gap-4">
          <button type="button" className="btn text-xs" onClick={() => exportCatalogXlsx(filtered, `meal-katalog-${selectedWeek}.xlsx`)}>
            Export XLSX ({filtered.length})
          </button>
          <div className="catalog-stat"><span>{meals.filter(m => m.photoUrl).length}</span> Bildquellen verknüpft</div>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <CatalogBrowser
          meals={meals}
          scopedMeals={scopedMeals}
          filtered={filtered}
          selectedId={selectedId}
          selectedWeek={selectedWeek}
          scope={scope}
          query={query}
          activeTags={activeTags}
          tags={tags}
          cups={cups}
          cupFilter={cupFilter}
          sortKey={sortKey}
          isFavorite={isFavorite}
          onSetQuery={setQuery}
          onSetScope={setScope}
          onToggleTag={(t: string) => setActiveTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
          onClearTags={() => setActiveTags([])}
          onSetCupFilter={setCupFilter}
          onSetSortKey={setSortKey}
          onSelect={setSelectedId}
        />

        {selected ? (
          <CatalogDetail
            selected={selected}
            data={data}
            selectedWeek={selectedWeek}
            upliftPercent={upliftPercent}
            index={index}
            total={filtered.length}
            isFavorite={isFavorite(selected.mealId)}
            isInCompare={compareIds.includes(selected.mealId)}
            imageOverride={getImageOverride(selected.mealId)}
            onConfirmImage={() => { if (selected.photoUrl) confirmImage(selected.mealId, selected.photoUrl); }}
            onRejectImage={() => rejectImage(selected.mealId)}
            onResetImage={() => resetImage(selected.mealId)}
            onPickImage={(url) => confirmImage(selected.mealId, url)}
            onToggleFavorite={() => toggleFavorite(selected.mealId)}
            onToggleCompare={() => setCompareIds(prev => prev.includes(selected.mealId) ? prev.filter(id => id !== selected.mealId) : prev.length < 3 ? [...prev, selected.mealId] : prev)}
            onSelectRelative={selectRelative}
            onSelectWeek={onSelectWeek}
            onOpenRecipe={onOpenRecipe}
            onOpenPlanning={onOpenPlanning}
            onOpenWms={onOpenWms}
          />
        ) : (
          <main className="catalog-detail flex min-h-[20rem] items-center justify-center p-8 text-center text-slate-500">
            {debouncedQuery || activeTags.length > 0
              ? "Keine Treffer für den aktuellen Filter."
              : `Für ${selectedWeek} wurden keine katalogisierten Meals gefunden.`}
          </main>
        )}
      </div>

      {compareIds.length > 0 && (
        <CompareView
          meals={compareIds.map(id => catalog[id]).filter(Boolean)}
          onClose={() => setCompareIds([])}
          onRemove={id => setCompareIds(prev => prev.filter(x => x !== id))}
        />
      )}
    </div>
  );
}
