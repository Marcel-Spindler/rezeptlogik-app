// Übergeordnete Suche — gemeinsame Typen.
// Bewusst getrennt von der In-Rezept-Suche (lib/helpers.searchMatchReason) und
// der KET-Plan-eigenen WO-Liste: diese Suche ist app-weit, startet aus dem
// Kopfbereich und führt IMMER auf die grafische Flow-/Verlaufs-Ansicht einer
// oder mehrerer Work Orders.

export type SearchEntryKind = "wo" | "submeal" | "sku" | "meal";

export interface SearchEntry {
  kind: SearchEntryKind;
  /** Anzeigetitel (WO-Nummer, Sub-Rezept-Name, SKU-Code, Meal-Name). */
  title: string;
  /** Zweitzeile (Rezept, Kategorie, …). */
  subtitle: string;
  /** Rezept-Code, über den die zugehörigen WOs aufgelöst werden. */
  recipeCode: string;
  /** WO-Nummer (nur kind === "wo"). */
  woNumber?: string;
  /** Sub-Rezept-Name (kind === "submeal"). */
  subRecipe?: string;
  /** SKU-Code (kind === "sku"). */
  sku?: string;
  /** Vorberechneter, kleingeschriebener Suchtext. */
  haystack: string;
  /** Tokens für Präfix-/Wortgrenzen-Treffer. */
  tokens: string[];
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
}

// ─── Flow-Modell einer Work Order ──────────────────────────────────────────

export type WoStageKey = "created" | "staging" | "kitchen" | "blast" | "plating" | "sleeving" | "done";
export type WoStageStatus = "done" | "active" | "pending" | "blocked" | "unknown";

export interface WoFlowStage {
  key: WoStageKey;
  label: string;
  icon: string;
  status: WoStageStatus;
  /** Datum / Uhrzeit-Label, falls bekannt. */
  when: string | null;
  metrics: { label: string; value: string }[];
  notes: string[];
}

export interface WoFlowSubmeal {
  name: string;
  cookMethods: string[];
  stagingKg: number;
  kitchenKg: number;
  postKg: number;
  yieldPct: number | null;
  chillerKey: string | null;
  chillerLabel: string | null;
  allergen: string | null;
  allergenUnknown: boolean;
}

export interface WoFlow {
  woNumber: string;
  recipeCode: string;
  recipeName: string;
  weekLabel: string | null;
  weekNum: number | null;
  kitchenDay: string | null;
  targetPortions: number | null;
  cookedPortions: number | null;
  progressPct: number | null;
  severity: "ok" | "warn" | "critical" | null;
  sources: string[];
  hasPlanRows: boolean;
  stages: WoFlowStage[];
  submeals: WoFlowSubmeal[];
  cookMethods: string[];
  allergens: string[];
  weighingCount: number;
  lastWeighing: string | null;
  platingNow: boolean;
  platingDone: boolean;
  comments: string[];
  eta: string | null;
}
