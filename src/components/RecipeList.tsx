import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WeekRecipe, Recipe, MealCatalogEntry } from "../core/types";
import { getRampUpHistory } from "../lib/rampUpHistory";
import { RampHistorySparkline } from "../features/recipe-detail/shared";
import { LiveDot } from "../features/redzone-live/LiveBadge";
import { useWoReconciliation } from "../features/wo-reconciliation/WoReconciliationContext";
import {
  adjustedPortions, codeDigits, fmtNum,
  MARKETS, MARKET_COLOR, MARKET_LABEL,
  recipeListTone, stripMarketTag,
  resolveRecipeByCode, searchMatchReason,
} from "../lib/helpers";
import { getBaseVerdenVolume } from "../lib/equipment";

const FAVORITES_KEY = "rezeptlogik-favorites-v1";

function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")); } catch { return new Set(); }
  });

  const toggle = useCallback((code: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return next;
    });
  }, []);

  return { favorites, toggle };
}

const MATCH_ICON: Record<string, string> = {
  ingredient: "🥩",
  subrecipe: "⚙",
  sku: "🏷",
  allergen: "⚠",
};

interface Props {
  recipes: WeekRecipe[];
  allRecipesCount: number;
  recipesByCode: Record<string, Recipe>;
  mealCatalog?: Record<string, MealCatalogEntry>;
  activeCode: string | undefined;
  selectedWeek: string;
  upliftPercent: number;
  searchText: string;
  onSearchChange: (text: string) => void;
  onSelect: (code: string) => void;
}

function SearchBar({ searchText, resultCount, totalCount, onSearchChange }: {
  searchText: string;
  resultCount: number;
  totalCount: number;
  onSearchChange: (text: string) => void;
}) {
  return (
    <div className="px-2 pb-2">
      <input
        type="search" value={searchText}
        onChange={e => onSearchChange(e.target.value)}
        placeholder="Meal, Code, SKU, Zutat, Allergen ..."
        className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
      />
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
        <span>{fmtNum(resultCount)} von {fmtNum(totalCount)}</span>
        {searchText && (
          <button type="button" className="hover:text-slate-800" onClick={() => onSearchChange("")}>leeren</button>
        )}
      </div>
    </div>
  );
}

function MarketPills({ wr }: { wr: WeekRecipe }) {
  return (
    <>
      {MARKETS.map(m => wr.verdenVolume[m] > 0 && (
        <span key={m} className={`pill text-[10px] ${MARKET_COLOR[m]}`}>
          {MARKET_LABEL[m]} {fmtNum(wr.verdenVolume[m])}
        </span>
      ))}
    </>
  );
}

// WO-Unstimmigkeit (App-Plan/KET/PET/Postblast weichen voneinander ab, siehe
// WoReconciliationContext) — "auf einen Blick" schon in der Liste sichtbar,
// bevor man das Rezept überhaupt öffnet.
function MismatchBadge({ code }: { code: string }) {
  const reconciliation = useWoReconciliation();
  const entry = reconciliation?.bySeverityRecipe.get(code);
  if (!entry) return null;
  const isCritical = entry.severity === "critical";
  return (
    <span
      title={`${entry.count} WO${entry.count === 1 ? "" : "s"} mit Unstimmigkeit (App-Plan/KET/PET/Postblast) — ${isCritical ? "kritisch" : "Abweichung"}`}
      className={`text-[10px] leading-none ${isCritical ? "text-red-500" : "text-amber-500"}`}
    >
      {isCritical ? "❗" : "⚠"}
    </span>
  );
}

function RecipeListItem({ wr, recipe, catalogEntry, isActive, week, upliftPercent, searchNeedle, isFavorite, onToggleFavorite, onClick }: {
  wr: WeekRecipe;
  recipe: Recipe | undefined;
  catalogEntry: MealCatalogEntry | undefined;
  isActive: boolean;
  week: string;
  upliftPercent: number;
  searchNeedle: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onClick: () => void;
}) {
  const tone = recipeListTone(wr.code);
  const portions = adjustedPortions(getBaseVerdenVolume(wr), upliftPercent);
  const sparkValues = getRampUpHistory(week).map(s => s.volumes[wr.code] ?? 0).filter(v => v > 0);
  const matchReason = searchNeedle ? searchMatchReason(searchNeedle, wr, recipe) : null;
  const cup = catalogEntry?.sheets?.["Meal DB_Culinary"]?.["Cup"];
  const photoUrl = catalogEntry?.photoUrl && (catalogEntry.photoUrl.startsWith("/data/meal-images/") || /\.(png|jpe?g|webp)(\?|$)/i.test(catalogEntry.photoUrl)) ? catalogEntry.photoUrl : undefined;

  return (
    <button
      type="button" onClick={onClick}
      className="w-full text-left px-3 py-2.5 rounded-xl transition-all"
      style={isActive ? tone.active : tone.base}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {photoUrl && <img src={photoUrl} alt="" className="h-8 w-8 rounded object-cover shrink-0" />}
          <span
            role="button"
            className={`text-sm cursor-pointer select-none ${isFavorite ? "text-amber-400" : "text-slate-300 hover:text-amber-300"}`}
            onClick={e => { e.stopPropagation(); onToggleFavorite(); }}
            title={isFavorite ? "Favorit entfernen" : "Als Favorit markieren"}
          >
            {isFavorite ? "\u2605" : "\u2606"}
          </span>
          <span className="font-mono text-xs mt-0.5" style={tone.code}>{wr.code}</span>
          <LiveDot recipeCode={wr.code} />
          <MismatchBadge code={wr.code} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sparkValues.length >= 2 && <RampHistorySparkline values={sparkValues} width={56} height={18} />}
          <span className="text-sm font-bold tabular-nums">{fmtNum(portions)}</span>
        </div>
      </div>
      <div className="text-sm font-medium mt-0.5 leading-tight" style={tone.title}>
        {recipe?.baseName || stripMarketTag(wr.recipeName)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="pill text-[10px]" style={tone.preference}>{wr.preference}</span>
        {cup && <span className="pill text-[10px] bg-sky-100 text-sky-800">{cup}</span>}
        <MarketPills wr={wr} />
        {matchReason && (
          <span className="pill text-[10px] bg-violet-100 text-violet-800 max-w-[14rem] truncate" title={matchReason.label}>
            {MATCH_ICON[matchReason.kind] ?? "🔍"} {matchReason.label}
          </span>
        )}
      </div>
    </button>
  );
}

function EmptyState({ hasResults, hasAnyRecipes }: { hasResults: boolean; hasAnyRecipes: boolean }) {
  if (hasResults) return null;
  return (
    <li className="px-3 py-4 text-sm text-slate-500">
      {hasAnyRecipes ? "Keine Treffer für diese Suche." : "Keine Rezepte in dieser Woche."}
    </li>
  );
}

export function RecipeList({
  recipes, allRecipesCount, recipesByCode, mealCatalog, activeCode, selectedWeek, upliftPercent,
  searchText, onSearchChange, onSelect,
}: Props) {
  const searchNeedle = searchText.trim().toLowerCase();
  const parentRef = useRef<HTMLDivElement>(null);
  const { favorites, toggle: toggleFavorite } = useFavorites();

  const sortedRecipes = useMemo(() => {
    return [...recipes].sort((a, b) => {
      const aFav = favorites.has(a.code) ? 0 : 1;
      const bFav = favorites.has(b.code) ? 0 : 1;
      return aFav - bFav;
    });
  }, [recipes, favorites]);

  const virtualizer = useVirtualizer({
    count: sortedRecipes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  const activeIndex = sortedRecipes.findIndex(r => r.code === activeCode);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const nextIndex = e.key === "ArrowDown"
        ? Math.min(activeIndex + 1, sortedRecipes.length - 1)
        : Math.max(activeIndex - 1, 0);
      if (nextIndex !== activeIndex && sortedRecipes[nextIndex]) {
        onSelect(sortedRecipes[nextIndex].code);
        virtualizer.scrollToIndex(nextIndex, { align: "auto" });
      }
    }
  }, [activeIndex, sortedRecipes, onSelect, virtualizer]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="card p-2">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Rezepte in {selectedWeek}
      </div>
      <SearchBar searchText={searchText} resultCount={recipes.length} totalCount={allRecipesCount} onSearchChange={onSearchChange} />
      <div ref={parentRef} className="overflow-auto" style={{ maxHeight: "calc(100vh - 200px)" }}>
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map(virtualRow => {
            const r = sortedRecipes[virtualRow.index];
            return (
              <div
                key={r.code}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
              >
                <RecipeListItem
                  wr={r}
                  recipe={resolveRecipeByCode(recipesByCode, r.code)}
                  catalogEntry={mealCatalog?.[r.code] ?? (mealCatalog ? Object.values(mealCatalog).find(e => codeDigits(e.mealId) === codeDigits(r.code)) : undefined)}
                  isActive={activeCode === r.code}
                  week={selectedWeek}
                  upliftPercent={upliftPercent}
                  searchNeedle={searchNeedle}
                  isFavorite={favorites.has(r.code)}
                  onToggleFavorite={() => toggleFavorite(r.code)}
                  onClick={() => onSelect(r.code)}
                />
              </div>
            );
          })}
        </div>
      </div>
      {recipes.length === 0 && <EmptyState hasResults={false} hasAnyRecipes={allRecipesCount > 0} />}
    </div>
  );
}
