// Command-Palette (⌘K) — gemeinsame Typen.
//
// Die Palette löst die frühere Inline-Suchleiste (features/global-search/
// GlobalSearch.tsx) ab: EIN Einstieg für View-Sprünge, Rezepte, Kalenderwochen,
// App-Kommandos UND die bestehende WO/Submeal/SKU-Suche (→ Flow-Overlay).
import type { SearchEntry } from "../global-search/searchTypes";

export type PaletteGroup = "command" | "view" | "week" | "recipe" | "wo" | "submeal" | "sku";

/** Was beim Auswählen eines Eintrags passiert. */
export type PaletteAction =
  /** Eine Funktion ausführen. Gibt sie einen String zurück, wird der kurz als
   *  Bestätigung in der Palette gezeigt, bevor sie schließt. */
  | { type: "run"; run: () => void | string | Promise<void | string> }
  /** Das grafische Flow-Overlay einer/mehrerer Work Orders öffnen. */
  | { type: "flow"; entry: SearchEntry };

export interface PaletteItem {
  /** Stabiler, eindeutiger Schlüssel (React-key + Dedupe). */
  key: string;
  group: PaletteGroup;
  title: string;
  subtitle?: string;
  /** Rechtsbündiger Hinweis-Chip (z.B. "Ansicht", "KW"). */
  hint?: string;
  icon: string;
  /** Kleingeschriebener Matchtext (Titel + Untertitel + Aliase). */
  search: string;
  /** Basisgewicht — Tiebreak + Reihenfolge ohne Suchbegriff. */
  priority: number;
  action: PaletteAction;
}

/** Nach Gruppen sortiertes Suchergebnis. */
export interface PaletteResultGroup {
  group: PaletteGroup;
  label: string;
  items: PaletteItem[];
}

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  command: "Kommandos",
  view: "Ansichten",
  week: "Kalenderwochen",
  recipe: "Rezepte",
  wo: "Work Orders",
  submeal: "Submeals",
  sku: "SKU-Codes",
};

export const GROUP_ICON: Record<PaletteGroup, string> = {
  command: "⚡",
  view: "🧭",
  week: "🗓️",
  recipe: "🍽️",
  wo: "📋",
  submeal: "🧩",
  sku: "🏷️",
};
