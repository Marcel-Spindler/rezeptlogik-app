import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MealCatalogEntry } from "../../core/types";
import { field, label, titleOf, type CatalogScope, type SortKey } from "./catalog-utils";
import { LiveDot } from "../redzone-live/LiveBadge";

interface CatalogBrowserProps {
  meals: MealCatalogEntry[];
  scopedMeals: MealCatalogEntry[];
  filtered: MealCatalogEntry[];
  selectedId: string | null;
  selectedWeek: string;
  scope: CatalogScope;
  query: string;
  activeTags: string[];
  tags: string[];
  cups: string[];
  cupFilter: string;
  sortKey: SortKey;
  isFavorite: (id: string) => boolean;
  onSetQuery: (q: string) => void;
  onSetScope: (s: CatalogScope) => void;
  onToggleTag: (t: string) => void;
  onClearTags: () => void;
  onSetCupFilter: (c: string) => void;
  onSetSortKey: (k: SortKey) => void;
  onSelect: (id: string) => void;
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "calories", label: "Kalorien" },
  { key: "weight", label: "Gewicht" },
  { key: "cuisine", label: "Küche" },
];

export function CatalogBrowser({
  filtered, selectedId, selectedWeek, scope, query, activeTags, tags, cups, cupFilter, sortKey, scopedMeals,
  isFavorite, onSetQuery, onSetScope, onToggleTag, onClearTags, onSetCupFilter, onSetSortKey, onSelect,
}: CatalogBrowserProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  const selectedIndex = filtered.findIndex(m => m.mealId === selectedId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target !== searchRef.current) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const offset = e.key === "ArrowDown" ? 1 : -1;
        const next = (selectedIndex + offset + filtered.length) % filtered.length;
        onSelect(filtered[next].mealId);
        virtualizer.scrollToIndex(next, { align: "auto" });
      }
      if (e.key === "Escape") {
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [filtered, selectedIndex, onSelect, virtualizer]);

  return (
    <aside className="catalog-browser">
      <label className="sr-only" htmlFor="catalog-search">Meal suchen</label>
      <input
        ref={searchRef}
        id="catalog-search"
        type="search"
        value={query}
        onChange={e => onSetQuery(e.target.value)}
        placeholder="Meal, ID, Küche, Tag suchen"
        className="catalog-search"
        aria-label="Meal suchen"
      />

      <div className="mt-3 grid grid-cols-3 gap-1 border border-slate-300 bg-slate-50 p-1">
        <button type="button" onClick={() => onSetScope("week")} className={`catalog-scope ${scope === "week" ? "is-active" : ""}`}>KW {selectedWeek}</button>
        <button type="button" onClick={() => onSetScope("future")} className={`catalog-scope ${scope === "future" ? "is-active" : ""}`}>Ab KW</button>
        <button type="button" onClick={() => onSetScope("all")} className={`catalog-scope ${scope === "all" ? "is-active" : ""}`}>Alle Meals</button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select
          value={sortKey}
          onChange={e => onSetSortKey(e.target.value as SortKey)}
          className="border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600"
          aria-label="Sortierung"
        >
          {SORT_OPTIONS.map(opt => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
        </select>
        {cups.length > 0 && (
          <select
            value={cupFilter}
            onChange={e => onSetCupFilter(e.target.value)}
            className="border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600"
            aria-label="Cup-Filter"
          >
            <option value="">Alle Cups</option>
            {cups.map(cup => <option key={cup} value={cup}>{cup}</option>)}
          </select>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Tag-Filter">
        {activeTags.length > 0 && (
          <button type="button" onClick={onClearTags} className="catalog-filter is-active" aria-pressed={true}>
            ✕ Alle
          </button>
        )}
        {tags.filter(t => t !== "Alle").map(item => (
          <button key={item} type="button" onClick={() => onToggleTag(item)} className={`catalog-filter ${activeTags.includes(item) ? "is-active" : ""}`} aria-pressed={activeTags.includes(item)}>
            {label(item)}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-baseline justify-between text-xs text-slate-500" aria-live="polite">
        <span>{filtered.length} von {scopedMeals.length} Treffer</span>
        <span>{scope === "all" ? "Gesamtkatalog" : scope === "future" ? `ab ${selectedWeek}` : selectedWeek}</span>
      </div>

      <div ref={listRef} className="catalog-list mt-2" role="listbox" aria-label="Meal-Liste">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map(virtualRow => {
            const meal = filtered[virtualRow.index];
            return (
              <button
                key={meal.mealId}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                type="button"
                role="option"
                aria-selected={selectedId === meal.mealId}
                onClick={() => onSelect(meal.mealId)}
                className={`catalog-row ${selectedId === meal.mealId ? "is-selected" : ""}`}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              >
                <span className="catalog-row-mark">{titleOf(meal).slice(0, 1)}</span>
                <span className="min-w-0 text-left">
                  <span className="block truncate text-sm font-semibold">{isFavorite(meal.mealId) && <span className="mr-1 text-amber-500">&#9733;</span>}{titleOf(meal)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500 flex items-center gap-1">
                    {meal.mealId} · {field(meal, "Meal DB_Culinary", "CUISINE") || "Meal"}
                    <LiveDot recipeCode={meal.mealId} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
