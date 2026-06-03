// Zentraler App-State als React Context.
// Enthält Datenladen, persistente Einstellungen und alle abgeleiteten Größen.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { loadData, refreshRampUpDataOnStart, refreshOperationalData, subscribeRampUpHashChanges } from "./dataSource";
import { adjustedPortions, isProducedInVerden, lsGet, usePersistent } from "./helpers";
import { getBaseVerdenVolume } from "./equipment";
import type { DataBundle, WeekRecipe, Recipe } from "./types";

export type AppView = "recipe" | "planning" | "packing" | "wo" | "whatif" | "rundmail" | "import";
export type AppSurface = "full" | "kitchen" | "rundmail";

export const ALL_VIEWS: readonly AppView[] = ["recipe", "planning", "packing", "wo", "whatif", "rundmail", "import"];

export interface WeekDelta {
  deltaPortions: number;
  newCodes: string[];
  droppedCodes: string[];
}

export interface AppState {
  // Surface
  surface: AppSurface;
  kitchenMode: boolean;
  rundmailMode: boolean;
  // Core state
  data: DataBundle | null;
  error: string | null;
  selectedWeek: string;
  selectedRecipe: string | null;
  view: AppView;
  upliftPercent: number;
  searchText: string;
  kitchenLinkCopied: boolean;
  // Derived
  weeks: string[];
  weekRecipes: WeekRecipe[];
  recipesByCode: Record<string, Recipe>;
  recipesOfWeek: WeekRecipe[];
  filteredRecipes: WeekRecipe[];
  activeRecipe: WeekRecipe | undefined;
  totals: { BENL: number; DKSE: number; DE: number; base: number };
  plannedTotal: number;
  prevWeek: string | null;
  prevWeekRecipes: WeekRecipe[];
  weekDelta: WeekDelta | null;
  // Actions
  setSelectedWeek: (w: string) => void;
  setSelectedRecipe: (code: string | null) => void;
  setView: (v: AppView) => void;
  setUpliftPercent: (pct: number) => void;
  setSearchText: (t: string) => void;
  setKitchenLinkCopied: (v: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

function resolveSurface(): AppSurface {
  const s = new URLSearchParams(window.location.search).get("surface");
  if (s === "kitchen") return "kitchen";
  if (s === "rundmail") return "rundmail";
  return "full";
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const surface = useMemo<AppSurface>(resolveSurface, []);
  const kitchenMode  = surface === "kitchen";
  const rundmailMode = surface === "rundmail";

  const [data, setData]   = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWeek, setSelectedWeek]     = usePersistent<string>("week", "");
  const [selectedRecipe, setSelectedRecipe] = usePersistent<string | null>("recipe", null);
  const [view, setView]                     = usePersistent<AppView>("view", "recipe");
  const [upliftPercent, setUpliftPercent]   = usePersistent<number>("uplift", 0);
  const [searchText, setSearchText]         = useState<string>("");
  const [kitchenLinkCopied, setKitchenLinkCopied] = useState(false);

  // URL params override localStorage (runs once on mount)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    const weekParam = params.get("week");
    if (kitchenMode) {
      setView("recipe");
    } else if (viewParam === "breakdown") {
      // Legacy deep-link fallback: old breakdown view now maps to WO output.
      setView("wo");
    } else if ((ALL_VIEWS as readonly string[]).includes(viewParam ?? "")) {
      setView(viewParam as AppView);
    }
    if (weekParam) {
      setSelectedWeek(weekParam);
      setSelectedRecipe(null);
      setSearchText("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitchenMode]);

  // Data loading + live refresh
  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | null = null;
    let unsubscribeRampUp = () => {};

    const loadLatestData = async () => {
      const d = await loadData();
      if (disposed) return;
      setData(d);
      const saved = lsGet<string>("week", "");
      if (!saved || !d.weeks.includes(saved)) {
        const firstWithRecipes = d.weeks.find(w => d.weekRecipes.some(r => r.hfWeek === w));
        setSelectedWeek(firstWithRecipes ?? d.weeks[0] ?? "");
      }
    };

    (async () => {
      try {
        await refreshRampUpDataOnStart();
        void refreshOperationalData();
        await loadLatestData();
        refreshTimer = window.setInterval(() => { void refreshRampUpDataOnStart(); }, 60_000);
        unsubscribeRampUp = subscribeRampUpHashChanges(() => { void loadLatestData(); });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!disposed) setError(msg);
      }
    })();

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
      unsubscribeRampUp();
    };
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const weeks        = data?.weeks ?? [];
  const weekRecipes  = data?.weekRecipes ?? [];
  const recipesByCode = data?.recipes ?? {};

  const recipesOfWeek = useMemo(() =>
    weekRecipes
      .filter(r => r.hfWeek === selectedWeek)
      .filter(isProducedInVerden)
      .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
      .sort((a, b) =>
        adjustedPortions(getBaseVerdenVolume(b), upliftPercent) -
        adjustedPortions(getBaseVerdenVolume(a), upliftPercent)
      ),
    [weekRecipes, selectedWeek, upliftPercent]
  );

  const searchNeedle = searchText.trim().toLowerCase();
  const filteredRecipes = useMemo(() => {
    if (!searchNeedle) return recipesOfWeek;
    return recipesOfWeek.filter(r => {
      // Import recipeSearchText lazily to avoid circular dep at module level
      const parts: string[] = [r.code, r.recipeName, r.preference];
      const recipe = recipesByCode[r.code];
      if (recipe) {
        parts.push(recipe.baseName);
        for (const md of Object.values(recipe.markets)) {
          parts.push(md.recipeNameLocal, md.msku, md.allergens ?? "");
          for (const sub of md.subRecipes) parts.push(sub.id, sub.name);
          for (const ing of md.ingredients) parts.push(ing.ingredientId, ing.name);
        }
        for (const grossRows of Object.values(recipe.grossIngredients)) {
          for (const g of grossRows ?? []) parts.push(g.ingredientId, g.ingredient);
        }
      }
      return parts.join(" ").toLowerCase().includes(searchNeedle);
    });
  }, [recipesOfWeek, searchNeedle, recipesByCode]);

  const totals = useMemo(() =>
    recipesOfWeek.reduce(
      (acc, r) => {
        acc.BENL += r.verdenVolume.BENL;
        acc.DKSE += r.verdenVolume.DKSE;
        acc.DE   += r.verdenVolume.DE;
        acc.base += getBaseVerdenVolume(r);
        return acc;
      },
      { BENL: 0, DKSE: 0, DE: 0, base: 0 }
    ),
    [recipesOfWeek]
  );

  const plannedTotal = adjustedPortions(totals.base, upliftPercent);

  const prevWeek = useMemo(() => {
    const idx = weeks.indexOf(selectedWeek);
    return idx > 0 ? weeks[idx - 1] : null;
  }, [weeks, selectedWeek]);

  const prevWeekRecipes = useMemo(() =>
    prevWeek
      ? weekRecipes
          .filter(r => r.hfWeek === prevWeek)
          .filter(isProducedInVerden)
          .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
      : [],
    [weekRecipes, prevWeek]
  );

  const weekDelta = useMemo<WeekDelta | null>(() => {
    if (!prevWeekRecipes.length) return null;
    const prevCodes = new Set(prevWeekRecipes.map(r => r.code));
    const currCodes = new Set(recipesOfWeek.map(r => r.code));
    const prevBase  = prevWeekRecipes.reduce((s, r) => s + getBaseVerdenVolume(r), 0);
    return {
      deltaPortions: totals.base - prevBase,
      newCodes:      recipesOfWeek.filter(r => !prevCodes.has(r.code)).map(r => r.code),
      droppedCodes:  prevWeekRecipes.filter(r => !currCodes.has(r.code)).map(r => r.code),
    };
  }, [recipesOfWeek, prevWeekRecipes, totals.base]);

  const activeRecipe: WeekRecipe | undefined =
    filteredRecipes.find(r => r.code === selectedRecipe)
    ?? filteredRecipes[0]
    ?? recipesOfWeek.find(r => r.code === selectedRecipe)
    ?? recipesOfWeek[0];

  const value: AppState = {
    surface, kitchenMode, rundmailMode,
    data, error,
    selectedWeek, selectedRecipe, view, upliftPercent, searchText, kitchenLinkCopied,
    weeks, weekRecipes, recipesByCode, recipesOfWeek, filteredRecipes, activeRecipe,
    totals, plannedTotal, prevWeek, prevWeekRecipes, weekDelta,
    setSelectedWeek: (w) => { setSelectedWeek(w); setSelectedRecipe(null); setSearchText(""); },
    setSelectedRecipe,
    setView,
    setUpliftPercent,
    setSearchText,
    setKitchenLinkCopied,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used inside AppProvider");
  return ctx;
}
