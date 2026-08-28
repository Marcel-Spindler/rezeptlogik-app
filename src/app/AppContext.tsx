// Zentraler App-State als React Context. Lädt Daten über useAppData, leitet
// Rezeptlisten/Summen über useRecipeSelection ab und hält die persistenten
// Nutzer-Einstellungen (KW, Rezept, View, Uplift).
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePersistent } from "../lib/helpers";
import { useAppData } from "./useAppData";
import { useRecipeSelection, type RecipeSelection } from "./useRecipeSelection";
import type { DataBundle } from "../core/types";

export type AppView = "recipe" | "catalog" | "planning" | "wo" | "pet" | "whatif" | "rundmail" | "import" | "wms" | "blast-chiller" | "allergen-plating" | "postblast-live" | "backfills" | "redzone-live" | "transparency-plan" | "artikel-woche" | "full-inventory";
export type AppSurface = "full" | "kitchen" | "rundmail" | "redzone" | "shopfloor";

export const ALL_VIEWS: readonly AppView[] = ["recipe", "catalog", "planning", "wo", "pet", "whatif", "rundmail", "import", "wms", "blast-chiller", "allergen-plating", "postblast-live", "backfills", "redzone-live", "transparency-plan", "artikel-woche", "full-inventory"];

export interface AppState extends RecipeSelection {
  surface: AppSurface;
  kitchenMode: boolean;
  rundmailMode: boolean;
  data: DataBundle | null;
  error: string | null;
  selectedWeek: string;
  selectedRecipe: string | null;
  view: AppView;
  upliftPercent: number;
  searchText: string;
  kitchenLinkCopied: boolean;
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
  if (s === "redzone") return "redzone";
  if (s === "shopfloor") return "shopfloor";
  return "full";
}

/** URL-Parameter (?view=, ?week=) überschreiben einmalig beim Mount die localStorage-Werte. */
function useUrlOverrides(
  kitchenMode: boolean,
  surface: AppSurface,
  setView: (v: AppView) => void,
  setSelectedWeek: (w: string) => void,
  setSelectedRecipe: (code: string | null) => void,
  setSearchText: (t: string) => void,
) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    const weekParam = params.get("week");

    if (kitchenMode) {
      setView("recipe");
    } else if (viewParam === "breakdown") {
      // Legacy-Deep-Link: die frühere Breakdown-View mappt heute auf KET Plan / WO.
      setView("wo");
    } else if ((ALL_VIEWS as readonly string[]).includes(viewParam ?? "")) {
      setView(viewParam as AppView);
    }

    if (weekParam) {
      setSelectedWeek(weekParam);
      setSelectedRecipe(null);
      setSearchText("");
    } else if (surface === "shopfloor") {
      // Kiosk-Laptops sollen IMMER die aktuelle Woche zeigen (via currentHfWeek()-
      // Fallback in useKetRowsData), nicht einen veralteten localStorage-Wert.
      setSelectedWeek("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitchenMode]);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const surface = useMemo<AppSurface>(resolveSurface, []);
  const kitchenMode = surface === "kitchen";
  const rundmailMode = surface === "rundmail";

  const [selectedWeek, setSelectedWeekRaw] = usePersistent<string>("week", "");
  const [selectedRecipe, setSelectedRecipe] = usePersistent<string | null>("recipe", null);
  const [view, setView] = usePersistent<AppView>("view", "recipe");
  const [upliftPercent, setUpliftPercent] = usePersistent<number>("uplift", 0);
  const [searchText, setSearchText] = useState("");
  const [kitchenLinkCopied, setKitchenLinkCopied] = useState(false);

  useUrlOverrides(kitchenMode, surface, setView, setSelectedWeekRaw, setSelectedRecipe, setSearchText);

  const { data, error } = useAppData(setSelectedWeekRaw);
  const selection = useRecipeSelection(data, selectedWeek, selectedRecipe, upliftPercent, searchText);

  const setSelectedWeek = (w: string) => {
    setSelectedWeekRaw(w);
    setSelectedRecipe(null);
    setSearchText("");
  };

  const value: AppState = {
    surface, kitchenMode, rundmailMode,
    data, error,
    selectedWeek, selectedRecipe, view, upliftPercent, searchText, kitchenLinkCopied,
    ...selection,
    setSelectedWeek, setSelectedRecipe, setView, setUpliftPercent, setSearchText, setKitchenLinkCopied,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used inside AppProvider");
  return ctx;
}
