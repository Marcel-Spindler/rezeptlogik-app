import type { WeekRecipe, Recipe } from "../core/types";
import { getRampUpHistory } from "../lib/rampUpHistory";
import { RampHistorySparkline } from "../features/recipe-detail/shared";
import {
  adjustedPortions, fmtNum,
  MARKETS, MARKET_COLOR, MARKET_LABEL,
  recipeListTone, stripMarketTag,
  resolveRecipeByCode, searchMatchReason,
} from "../lib/helpers";
import { getBaseVerdenVolume } from "../lib/equipment";

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

function RecipeListItem({ wr, recipe, isActive, week, upliftPercent, searchNeedle, onClick }: {
  wr: WeekRecipe;
  recipe: Recipe | undefined;
  isActive: boolean;
  week: string;
  upliftPercent: number;
  searchNeedle: string;
  onClick: () => void;
}) {
  const tone = recipeListTone(wr.code);
  const portions = adjustedPortions(getBaseVerdenVolume(wr), upliftPercent);
  const sparkValues = getRampUpHistory(week).map(s => s.volumes[wr.code] ?? 0).filter(v => v > 0);
  const matchReason = searchNeedle ? searchMatchReason(searchNeedle, wr, recipe) : null;

  return (
    <button
      type="button" onClick={onClick}
      className="w-full text-left px-3 py-2.5 rounded-xl transition-all"
      style={isActive ? tone.active : tone.base}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs mt-0.5" style={tone.code}>{wr.code}</span>
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
  recipes, allRecipesCount, recipesByCode, activeCode, selectedWeek, upliftPercent,
  searchText, onSearchChange, onSelect,
}: Props) {
  const searchNeedle = searchText.trim().toLowerCase();

  return (
    <div className="card p-2">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Rezepte in {selectedWeek}
      </div>
      <SearchBar searchText={searchText} resultCount={recipes.length} totalCount={allRecipesCount} onSearchChange={onSearchChange} />
      <ul className="divide-y divide-slate-100 space-y-0.5">
        {recipes.map(r => (
          <li key={r.code}>
            <RecipeListItem
              wr={r}
              recipe={resolveRecipeByCode(recipesByCode, r.code)}
              isActive={activeCode === r.code}
              week={selectedWeek}
              upliftPercent={upliftPercent}
              searchNeedle={searchNeedle}
              onClick={() => onSelect(r.code)}
            />
          </li>
        ))}
        <EmptyState hasResults={recipes.length > 0} hasAnyRecipes={allRecipesCount > 0} />
      </ul>
    </div>
  );
}
